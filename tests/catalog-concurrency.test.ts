import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { test } from "node:test";
import { acquireDatabase, databaseTurnChannel, withDatabase, type DatabaseTurnTiming } from "../src/database/access.ts";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { createAccount } from "../src/auth/accounts.ts";
import { buildApp } from "../src/server/app.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { attachSyntheticRetention } from "../src/catalog/retention.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { distribution, observeDatabaseTiming } from "../scripts/benchmarks/database-timing.ts";

function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

test("DB timing preserves FIFO, isolates concurrent scopes and releases failed/idempotent turns without publishing private data", async (t) => {
  const db = openDatabase(":memory:"), observer = observeDatabaseTiming(), messages: DatabaseTurnTiming[] = [], order: number[] = [];
  const receive = (value: unknown) => { messages.push(value as DatabaseTurnTiming); };
  databaseTurnChannel.subscribe(receive);
  t.after(() => { observer.close(); databaseTurnChannel.unsubscribe(receive); db.close(); });
  const held = gate(), entered = gate();
  const first = observer.measure(() => withDatabase(db, async () => { order.push(1); entered.release(); await held.promise; return "one"; }));
  await entered.promise;
  const second = observer.measure(() => withDatabase(db, async () => { order.push(2); return "two"; }));
  const third = observer.measure(() => withDatabase(db, async () => { order.push(3); throw new Error("deliberate"); }));
  const rejection = assert.rejects(third, /deliberate/u);
  await immediate(); assert.deepEqual(order, [1]); held.release();
  const [a, b] = await Promise.all([first, second]); await rejection;
  assert.deepEqual(order, [1, 2, 3]); assert.equal(a.value, "one"); assert.equal(b.value, "two");
  assert.equal(a.timing.turns, 1); assert.equal(b.timing.turns, 1); assert.ok(b.timing.waitMs > 0);
  const before = messages.length, unlock = await acquireDatabase(db); unlock(); unlock();
  assert.equal(messages.length, before + 1);
  for (const row of messages) { assert.deepEqual(Object.keys(row).sort(), ["heldMs", "waitMs"]); assert.ok(row.waitMs >= 0 && row.heldMs >= 0); }
  observer.close(); databaseTurnChannel.unsubscribe(receive); assert.equal(databaseTurnChannel.hasSubscribers, false);
  assert.equal(await withDatabase(db, async () => "unobserved"), "unobserved"); assert.equal(messages.length, before + 1);
});

test("timing aggregation uses nearest-rank percentiles and rejects missing or invalid measurements", () => {
  assert.deepEqual(distribution([3, 1, 2, 8, 4]), { p50Ms: 3, p95Ms: 8, maxMs: 8 });
  for (const invalid of [[], [NaN], [-1], [Infinity]]) assert.throws(() => distribution(invalid));
});

test("queued mixed reads and writes recheck expiry, removal, ownership and revoked real sessions with timing enabled", async (t) => {
  const db = openDatabase(":memory:"); migrate(db);
  const config = { baseURL: "http://127.0.0.1:3000", secret: "concurrency-test-only-at-least-32-characters" }, password = "concurrency-test-password-123";
  const owner = await createAccount(db, config, { name: "Owner", email: "owner@example.test", password });
  const other = await createAccount(db, config, { name: "Other", email: "other@example.test", password });
  const catalog = new CatalogStore(db), library = new CatalogLibraryStore(db), [saved] = await catalog.ingestSynthetic(syntheticAlbum(0, 4));
  const [fresh] = await catalog.ingestSynthetic(syntheticAlbum(2, 4));
  const album = await catalog.getAlbum(saved!.albumId), item = library.create(owner.id, { entityId: album.id, note: "preserve-private", favorite: true }).item;
  const app = await buildApp(db, config), observer = observeDatabaseTiming();
  t.after(async () => { observer.close(); await app.close(); db.close(); });
  const base = { host: "127.0.0.1:3000", origin: config.baseURL };
  async function login(email: string) {
    const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: base, payload: { email, password } }); assert.equal(response.statusCode, 200);
    const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = await app.inject({ url: "/api/auth/get-session", headers: { ...base, cookie } }); assert.equal(session.statusCode, 200);
    return { ...base, cookie, "x-loopshelf-session": session.json().session.id as string };
  }
  const own = await login(owner.email), foreign = await login(other.email);
  const initial = await app.inject({ url: "/api/catalog/tracks?q=Synthetic&limit=1", headers: own }); assert.equal(initial.statusCode, 200);
  const continuation = `/api/catalog/tracks?${new URLSearchParams({ q: "Synthetic", limit: "1", cursor: initial.json().nextCursor as string })}`;
  const hold = gate(), entered = gate();
  const blocker = withDatabase(db, async () => {
    entered.release(); await hold.promise;
    db.transaction(() => attachSyntheticRetention(db, saved!.observationId, "concurrency-test", new Date(Date.now() - 1000).toISOString())).immediate();
  });
  await entered.promise;
  const jobs = [
    { url: continuation, headers: own },
    { url: `/api/catalog/albums/${album.id}`, headers: own },
    { url: `/api/library/catalog/${item.id}`, headers: own },
    { method: "PATCH" as const, url: `/api/library/catalog/${item.id}`, headers: foreign, payload: { version: item.version, note: "must-not-write" } },
    { url: "/api/auth/get-session", headers: own },
  ].map((options) => observer.measure(() => app.inject(options)));
  await immediate(); hold.release(); await blocker;
  const results = await Promise.all(jobs);
  assert.deepEqual(results.map((r) => r.value.statusCode), [409, 404, 200, 404, 200]);
  assert.equal(results[0]!.value.json().code, "cursor_invalidated");
  const preserved = results[2]!.value.json(); assert.equal(preserved.id, item.id); assert.equal(preserved.version, item.version);
  assert.equal(preserved.note, item.note); assert.equal(preserved.favorite, true); assert.equal(preserved.entity.contentState, "expired");
  for (const result of results) { assert.equal(result.timing.turns, 1); assert.ok(result.timing.waitMs > 0); assert.equal(result.value.headers["cache-control"], "no-store"); }
  const freshPage = await app.inject({ url: "/api/catalog/tracks?q=Synthetic&limit=1", headers: own });
  assert.equal(freshPage.statusCode, 200); assert.equal(freshPage.json().items[0].album.id, fresh!.albumId);
  const removalGate = gate(), removalBlock = withDatabase(db, async () => { await removalGate.promise; });
  const removal = catalog.removeSource({ sourceEntityId: fresh!.sourceEntityId, reason: "rights_request" });
  const afterRemoval = observer.measure(() => app.inject({ url: `/api/catalog/tracks?${new URLSearchParams({ q: "Synthetic", limit: "1", cursor: freshPage.json().nextCursor as string })}`, headers: own }));
  await immediate(); removalGate.release(); await Promise.all([removalBlock, removal]);
  const removed = await afterRemoval; assert.equal(removed.value.statusCode, 409); assert.equal(removed.value.json().code, "cursor_invalidated");
  assert.equal(removed.timing.turns, 1); assert.ok(removed.timing.waitMs > 0);
  const revoke = gate(), revoking = withDatabase(db, async () => { await revoke.promise; db.prepare("DELETE FROM session WHERE id=?").run(own["x-loopshelf-session"]); });
  const pending = observer.measure(() => app.inject({ url: "/api/catalog/tracks?q=Synthetic", headers: own }));
  await immediate(); revoke.release(); await revoking;
  assert.equal((await pending).value.statusCode, 401);
  assert.equal(library.get(owner.id, item.id).note, "preserve-private");
});

test("concurrency CLI keeps its DB disposable, uses real session scopes, reports every sample and refuses existing outputs/DB paths", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-concurrency-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, "do-not-open.sqlite"); writeFileSync(sentinel, "untouched");
  const output = join(dir, "report.json"), args = ["scripts/bench-catalog-concurrency.ts", "--albums", "20", "--tracks", "3", "--samples", "3", "--output", output];
  const env = { ...process.env, TMPDIR: dir, DATABASE_PATH: sentinel };
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 30000 }); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.fixture.albums, 20); assert.equal(report.fixture.tracks, 60); assert.equal(report.method.layer, "authenticated-inject");
  assert.deepEqual(report.method.levels, [1, 4, 8]); assert.equal(report.method.samplesPerKind, 3); assert.equal(report.measurements.length, 3);
  for (const measurement of report.measurements) {
    assert.equal(measurement.samples.length, 18); assert.equal(measurement.byKind.length, 6);
    for (const kind of measurement.byKind) { assert.equal(kind.count, 3); assert.ok(kind.total.p95Ms >= kind.total.p50Ms); }
    for (const row of measurement.samples) { assert.equal(row.turns, 1); assert.ok(row.totalMs >= 0 && row.waitMs >= 0 && row.heldMs >= 0 && row.outsideMs >= 0); assert.ok(Math.abs(row.totalMs - row.waitMs - row.heldMs - row.outsideMs) < .01); }
    assert.ok(measurement.requestsPerSecond > 0);
  }
  assert.equal(report.passed, report.measurements.every((m: { byKind: { total: { p95Ms: number } }[] }) => m.byKind.every((k) => k.total.p95Ms <= report.targetMs)));
  assert.ok(Object.values(report.checks).every((value) => value === true));
  const source = readFileSync(output, "utf8"); assert.ok(!source.includes("session_token")); assert.ok(!source.includes("owner@example.test")); assert.ok(!source.includes("must-not-write"));
  assert.deepEqual(readdirSync(dir).sort(), ["do-not-open.sqlite", "report.json"]); assert.equal(readFileSync(sentinel, "utf8"), "untouched");
  const repeated = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 30000 }); assert.notEqual(repeated.status, 0);
  assert.equal(readFileSync(output, "utf8"), source); assert.deepEqual(readdirSync(dir).sort(), ["do-not-open.sqlite", "report.json"]);
  for (const invalid of [["--database", sentinel], ["--samples", "31"]]) {
    const bad = spawnSync(process.execPath, ["scripts/bench-catalog-concurrency.ts", ...invalid], { env, encoding: "utf8", timeout: 30000 }); assert.notEqual(bad.status, 0);
  }
  assert.equal(readFileSync(sentinel, "utf8"), "untouched");
});
