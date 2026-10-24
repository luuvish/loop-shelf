import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { test as nodeTest, type TestContext } from "node:test";
import { createAccount, resetAccountPassword } from "../src/auth/accounts.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { acquireDatabase, withDatabase } from "../src/database/access.ts";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { getSourceAlbumService } from "../src/source-album.ts";
import { createSourceAlbumService } from "../src/source-album/service.ts";
import { getSearchService } from "../src/search.ts";
import { buildApp } from "../src/server/app.ts";
import { SOURCE_READ_HTTP_LIMITS as limits } from "../src/server/source-read.ts";
import type { SourceAlbumResult } from "../src/shared/source-album.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { Clock, allowed, deferred, delivery, envelope, input, tick } from "./helpers/source-album.ts";

const config = { baseURL: "http://127.0.0.1:3000", secret: "album-api-test-secret-at-least-32-characters-long" };
const base = { host: "127.0.0.1:3000", origin: config.baseURL }, password = "test-only-password-123";
const path = "/api/source-album";
const test = (name: string, action: (t: TestContext) => Promise<void>) => nodeTest(name, { timeout: 10000 }, action);
async function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db);
  const a = await createAccount(db, config, { name: "Alice", email: "alice@example.test", password });
  const b = await createAccount(db, config, { name: "Bob", email: "bob@example.test", password });
  const app = await buildApp(db, config); t.after(async () => { await app.close(); db.close(); });
  async function login(email = a.email) {
    const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: base, payload: { email, password } });
    assert.equal(response.statusCode, 200);
    const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = (await app.inject({ url: "/api/auth/get-session", headers: { ...base, cookie } })).json().session.id as string;
    return { ...base, cookie, "x-loopshelf-session": session };
  }
  const own = await login(), other = await login(b.email), service = getSourceAlbumService(db), baseline = await service.getAlbum(input);
  const read = (headers = own, payload: unknown = input, url = path) => app.inject({ method: "POST", url, headers, payload: payload as object });
  function hold() {
    const entered = deferred<AbortSignal>(), result = deferred<SourceAlbumResult>();
    const mock = t.mock.method(service, "getAlbum", async (_input: unknown, signal?: AbortSignal) => { assert.ok(signal); entered.resolve(signal); return result.promise; });
    return { entered: entered.promise, result, mock };
  }
  function synthetic() {
    // Internal method replacement only: actual cookie authentication is unchanged; no HTTP/env test switch.
    const clock = new Clock(), policy = allowed();
    const adapter = { getAlbum: async () => delivery(clock.now()) };
    const offline = createSourceAlbumService(db, { sampleKind: "synthetic", clock, policy: () => policy, adapters: { khinsider: adapter, zophar: adapter } });
    const readMock = t.mock.method(service, "getAlbum", offline.getAlbum);
    t.mock.method(service, "recheck", offline.recheck);
    return { clock, policy, offline, readMock };
  }
  return { db, app, a, b, own, other, login, service, baseline, read, hold, synthetic };
}
function noStore(response: { headers: Record<string, unknown> }) { assert.equal(response.headers["cache-control"], "no-store"); }

test("album API uses real sessions and policy-disabled product detail without exposing private or synthetic catalog data", async (t) => {
  const h = await fixture(t), [saved] = await new CatalogStore(h.db).ingestSynthetic(syntheticAlbum(1, 4));
  const bookmark = await h.app.inject({ method: "POST", url: "/api/bookmarks", headers: h.own, payload: { title: "PRIVATE TITLE", note: "PRIVATE NOTE", url: "https://www.zophar.net/music/nes/private.html" } });
  const dns = t.mock.method(Resolver.prototype, "resolve4", () => { throw new Error("No external network"); });
  for (const [headers, user] of [[h.own, h.a], [h.other, h.b]] as const) {
    const result = await h.read(headers); assert.equal(result.statusCode, 200); noStore(result);
    assert.equal(result.headers["x-loopshelf-user"], user.id); assert.equal(result.headers["x-loopshelf-session"], headers["x-loopshelf-session"]);
    assert.equal(result.headers.vary, "Cookie, X-LoopShelf-Session"); assert.equal(result.json().result.code, "policy_disabled"); assert.equal(result.json().sampleKind, "live-capture");
    for (const secret of [saved!.albumId, bookmark.json().item.id, "PRIVATE TITLE", "PRIVATE NOTE", "Synthetic"]) assert.ok(!result.body.includes(secret));
  }
  assert.equal(dns.mock.callCount(), 0); assert.deepEqual(h.db.prepare("SELECT * FROM source_metadata_cache").all(), []);
});

test("album API requires cookie, current session precondition and exact Host/Origin before calling detail", async (t) => {
  const h = await fixture(t), spy = t.mock.method(h.service, "getAlbum");
  for (const cookie of ["", "better-auth.session_token=forged"]) assert.equal((await h.read({ ...h.own, cookie })).statusCode, 401);
  const { "x-loopshelf-session": ignored, ...missing } = h.own; void ignored;
  assert.equal((await h.app.inject({ method: "POST", url: path, headers: missing, payload: input })).statusCode, 428);
  assert.equal((await h.read({ ...h.other, "x-loopshelf-session": h.own["x-loopshelf-session"] })).statusCode, 401);
  for (const origin of ["", "null", "https://attacker.test"]) assert.equal((await h.read({ ...h.own, origin })).statusCode, 403);
  assert.equal((await h.read({ ...h.own, host: "attacker.test" })).statusCode, 400); assert.equal(spy.mock.callCount(), 0);
  const current = await h.read({ ...h.own, "x-user-id": h.b.id } as typeof h.own); assert.equal(current.headers["x-loopshelf-user"], h.a.id);
});

test("album API is POST/JSON only with strict source-key input, no query injection and a four-KiB byte limit", async (t) => {
  const h = await fixture(t), spy = t.mock.method(h.service, "getAlbum");
  for (const payload of [{}, { ...input, sourceId: "unknown" }, { ...input, externalKey: "https://evil.test/a" }, { ...input, externalKey: "nes/../secret" },
    { ...input, url: "https://evil.test" }, { ...input, userId: h.b.id }, { ...input, sampleKind: "synthetic" }, { ...input, policy: "allowed" },
    { ...input, externalKey: "nes/a%2fb" }, { ...input, externalKey: "nes/a\nb" }]) {
    const result = await h.read(h.own, payload); assert.equal(result.statusCode, 400); noStore(result);
  }
  assert.equal((await h.read(h.own, input, `${path}?url=https://evil.test`)).statusCode, 400);
  for (const method of ["GET", "HEAD", "OPTIONS"] as const) assert.equal((await h.app.inject({ method, url: path, headers: h.own })).statusCode, 404);
  assert.equal((await h.app.inject({ method: "POST", url: path, headers: { ...h.own, "content-type": "text/plain" }, payload: JSON.stringify(input) })).statusCode, 415);
  assert.equal((await h.app.inject({ method: "POST", url: path, headers: { ...h.own, "content-type": "application/json" }, payload: '{"sourceId":' })).statusCode, 400);
  assert.equal((await h.read(h.own, { ...input, externalKey: "星".repeat(1500) })).statusCode, 413); assert.equal(spy.mock.callCount(), 0);
});

test("search and album share a per-IP quota that cookie changes and proxy spoofing cannot bypass", async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < limits.perMinute; i++) {
    const result = i % 2 ? await h.read(h.other) : await h.app.inject({ method: "POST", url: "/api/search", headers: h.own, payload: { q: "Album" } });
    assert.equal(result.statusCode, 200);
  }
  for (const [url, payload] of [[path, input], ["/api/search", { q: "Album" }]] as const) {
    const result = await h.app.inject({ method: "POST", url, headers: { ...h.own, "x-forwarded-for": "192.0.2.1" }, payload });
    assert.equal(result.statusCode, 429); assert.equal(result.json().code, "rate_limited"); assert.ok(Number(result.headers["retry-after"]) > 0); noStore(result);
  }
  assert.equal((await h.app.inject({ url: "/api/bookmarks", headers: h.own })).statusCode, 200);
});

test("search and album share active admission including authentication waits", async (t) => {
  const h = await fixture(t), held = h.hold(), search = getSearchService(h.db), waiting = deferred<void>();
  const original = search.search; t.mock.method(search, "search", async (value: unknown, signal?: AbortSignal) => { await waiting.promise; return original(value, signal); });
  const reads = Array.from({ length: limits.maxActive / 2 }, () => h.read().then((r) => r));
  const searches = Array.from({ length: limits.maxActive / 2 }, () => h.app.inject({ method: "POST", url: "/api/search", headers: h.other, payload: { q: "Album" } }).then((r) => r));
  for (let i = 0; i < 100; i++) await tick();
  const overflow = await h.read(); assert.equal(overflow.statusCode, 429); assert.equal(overflow.json().code, "queue_full");
  held.result.resolve(h.baseline); waiting.resolve();
  for (const result of await Promise.all([...reads, ...searches])) assert.equal(result.statusCode, 200);
  assert.equal((await h.read()).statusCode, 200);
});

test("private writes and logout work while detail waits, and revoked sessions cannot receive held albums", async (t) => {
  const h = await fixture(t), held = h.hold(), pending = h.read(); await held.entered;
  assert.equal((await h.app.inject({ method: "POST", url: "/api/bookmarks", headers: h.own, payload: { title: "During detail", url: "https://www.zophar.net/music/nes/during.html" } })).statusCode, 201);
  assert.equal((await h.app.inject({ method: "POST", url: "/api/auth/sign-out", headers: h.own, payload: {} })).statusCode, 200);
  held.result.resolve(h.baseline); const result = await pending; assert.equal(result.statusCode, 401); noStore(result);
  assert.equal(result.headers["x-loopshelf-user"], undefined); assert.equal(result.headers["x-loopshelf-session"], undefined);
  const changed = await h.login(h.b.email); assert.equal((await h.read({ ...changed, "x-loopshelf-session": h.own["x-loopshelf-session"] })).statusCode, 401);
});

test("expiry and password reset during detail are detected without refreshing session lifetime", async (t) => {
  const h = await fixture(t), held = h.hold(), before = h.db.prepare('SELECT "expiresAt" FROM session WHERE id=?').get(h.own["x-loopshelf-session"]);
  const pending = h.read(); await held.entered;
  assert.deepEqual(h.db.prepare('SELECT "expiresAt" FROM session WHERE id=?').get(h.own["x-loopshelf-session"]), before);
  await withDatabase(h.db, async () => { h.db.prepare('UPDATE session SET "expiresAt"=0 WHERE id=?').run(h.own["x-loopshelf-session"]); });
  held.result.resolve(h.baseline); assert.equal((await pending).statusCode, 401); held.mock.mock.restore();
  const otherHold = h.hold(), otherPending = h.read(h.other); await otherHold.entered;
  await resetAccountPassword(h.db, config, { email: h.b.email, password: "changed-password-123" });
  otherHold.result.resolve(h.baseline); assert.equal((await otherPending).statusCode, 401);
});

test("another login does not implicitly revoke an existing valid request cookie; response retains its original session", async (t) => {
  const h = await fixture(t), held = h.hold(), pending = h.read(); await held.entered;
  const next = await h.login(h.b.email); assert.notEqual(next["x-loopshelf-session"], h.own["x-loopshelf-session"]);
  held.result.resolve(h.baseline); const result = await pending; assert.equal(result.statusCode, 200);
  assert.equal(result.headers["x-loopshelf-user"], h.a.id); assert.equal(result.headers["x-loopshelf-session"], h.own["x-loopshelf-session"]);
  assert.equal((await h.read({ ...next, "x-loopshelf-session": h.own["x-loopshelf-session"] })).statusCode, 401);
});

test("HTTP album deadline aborts non-cooperative work and never rechecks its late reply", async (t) => {
  const h = await fixture(t), held = h.hold(), verify = t.mock.method(h.service, "recheck");
  t.mock.timers.enable({ apis: ["setTimeout"] }); const pending = h.read(), signal = await held.entered;
  t.mock.timers.tick(limits.deadlineMs); const result = await pending;
  assert.equal(result.statusCode, 504); assert.equal(result.json().code, "album_timeout"); noStore(result); assert.ok(signal.aborted);
  held.result.resolve(h.baseline); await tick(); assert.equal(verify.mock.callCount(), 0); t.mock.timers.reset();
});

test("detail deadline includes initial and final authentication queues, with no delayed database access", async (t) => {
  const h = await fixture(t), release = await acquireDatabase(h.db), scheduled = deferred<void>();
  t.mock.timers.enable({ apis: ["setTimeout"] }); const schedule = globalThis.setTimeout;
  const timer = t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => { const handle = schedule(callback, ms); if (ms === limits.deadlineMs) scheduled.resolve(); return handle; });
  const prepare = t.mock.method(h.db, "prepare"), read = t.mock.method(h.service, "getAlbum");
  const pending = h.read(); await scheduled.promise; t.mock.timers.tick(limits.deadlineMs); assert.equal((await pending).statusCode, 504);
  const count = prepare.mock.callCount(); release(); await tick(); assert.equal(prepare.mock.callCount(), count); assert.equal(read.mock.callCount(), 0);
  timer.mock.restore(); prepare.mock.restore(); read.mock.restore(); t.mock.timers.reset();
  let unlock = () => {}; const entered = deferred<void>();
  t.mock.method(h.service, "getAlbum", async () => { unlock = await acquireDatabase(h.db); entered.resolve(); return h.baseline; });
  const verify = t.mock.method(h.service, "recheck"); t.mock.timers.enable({ apis: ["setTimeout"] });
  const final = h.read(); await entered.promise; await tick(); t.mock.timers.tick(limits.deadlineMs);
  assert.equal((await final).statusCode, 504); unlock(); await tick(); assert.equal(verify.mock.callCount(), 0); t.mock.timers.reset();
});

test("source detail shutdown and internal failures return no held metadata or private exceptions", async (t) => {
  const h = await fixture(t); const broken = t.mock.method(h.service, "getAlbum", async () => { throw new Error("PRIVATE exception"); });
  const error = await h.read(); assert.equal(error.statusCode, 500); assert.deepEqual(error.json(), { code: "internal_error" }); noStore(error); broken.mock.restore();
  const held = h.hold(), pending = h.read(), signal = await held.entered, closing = h.app.close();
  const result = await pending; await closing; assert.equal(result.statusCode, 503); assert.equal(result.json().code, "server_closing"); assert.ok(signal.aborted); held.result.resolve(h.baseline);
});

test("product recheck rejects a synthetic envelope or different source locator accidentally returned by detail", async (t) => {
  const h = await fixture(t), original = envelope(h.baseline);
  for (const value of [{ ...original, sampleKind: "synthetic" }, { ...original, ref: { ...original.ref, externalKey: "nes/other" } }]) {
    const changed = t.mock.method(h.service, "getAlbum", async () => value as SourceAlbumResult);
    const result = await h.read(); assert.equal(result.statusCode, 500); assert.deepEqual(result.json(), { code: "internal_error" }); changed.mock.restore();
  }
});

test("authenticated synthetic detail delivers tracks without ingestion, then final recheck hides newly removed metadata", async (t) => {
  const h = await fixture(t), s = h.synthetic(), catalog = new CatalogStore(h.db);
  const success = await h.read(); assert.equal(success.statusCode, 200); assert.equal(success.json().sampleKind, "synthetic"); assert.equal(success.json().result.data.tracks.length, 4);
  assert.equal((h.db.prepare("SELECT count(*) AS n FROM album").get() as { n: number }).n, 0);
  const [saved] = await catalog.ingestSynthetic(syntheticAlbum(1, 4)); s.readMock.mock.restore();
  t.mock.method(h.service, "getAlbum", async () => {
    const result = await s.offline.getAlbum(input); await catalog.removeSource({ sourceEntityId: saved!.sourceEntityId, reason: "rights_request" }); return result;
  });
  const removed = await h.read(); assert.equal(removed.statusCode, 200); assert.equal(removed.json().result.code, "content_removed"); assert.ok(!removed.body.includes("tracks"));
});

test("final authenticated detail recheck rejects policy changes and expiry after service completion", async (t) => {
  const h = await fixture(t), s = h.synthetic(); s.readMock.mock.restore();
  const expires = t.mock.method(h.service, "getAlbum", async () => { const result = await s.offline.getAlbum(input); s.clock.time += 120_000; return result; });
  assert.equal((await h.read()).json().result.code, "result_expired"); expires.mock.restore();
  t.mock.method(h.service, "getAlbum", async () => { const result = await s.offline.getAlbum(input); s.policy.display = { allowed: false, code: "blocked" }; return result; });
  const result = await h.read(); assert.equal(result.json().result.code, "blocked"); assert.ok(!result.body.includes("tracks"));
});

test("real HTTP body completion leaves detail active; disconnect cancels only that subscriber", async (t) => {
  const h = await fixture(t); await h.app.listen({ host: "127.0.0.1", port: 0 });
  const address = h.app.server.address(); assert.ok(address && typeof address === "object");
  function wire() {
    const payload = JSON.stringify(input), received = deferred<{ status: number; body: string }>();
    const request = httpRequest({ hostname: "127.0.0.1", port: (address as { port: number }).port, path, method: "POST",
      headers: { ...h.own, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
      let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => received.resolve({ status: response.statusCode!, body }));
    }); request.on("error", () => {}); request.end(payload); return { request, received: received.promise };
  }
  const held = h.hold(), client = wire(), signal = await held.entered; await tick(); assert.ok(!signal.aborted);
  held.result.resolve(h.baseline); assert.equal((await client.received).status, 200); held.mock.mock.restore();
  const stopped = h.hold(), other = wire(), otherSignal = await stopped.entered, verify = t.mock.method(h.service, "recheck");
  const aborted = new Promise<void>((resolve) => otherSignal.addEventListener("abort", () => resolve(), { once: true }));
  other.request.destroy(); await aborted; stopped.result.resolve(h.baseline); await tick(); assert.equal(verify.mock.callCount(), 0);
});
