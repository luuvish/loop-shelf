import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resolver } from "node:dns/promises";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { assertMigrated, loadMigrations, migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { withDatabase } from "../src/database/access.ts";
import { createAccount } from "../src/auth/accounts.ts";
import { buildApp } from "../src/server/app.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogTrackSearchStore } from "../src/catalog/track-search.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { attachSyntheticRetention, reconcileCatalogRetention } from "../src/catalog/retention.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { queryPlans } from "../scripts/benchmarks/query-plans.ts";
import { simulateLiveCatalog } from "./helpers/catalog-live.ts";

const config = { baseURL: "http://127.0.0.1:3000", secret: "track-search-test-only-secret-at-least-32-characters" };
const base = { host: "127.0.0.1:3000", origin: config.baseURL }, password = "track-search-test-password-123";
function input(index = 0, count = 5) {
  const value = syntheticAlbum(index, count);
  if (value.data.kind !== "album") throw new Error("Expected synthetic album");
  return { ...value, data: value.data };
}
async function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const catalog = new CatalogStore(db), search = new CatalogTrackSearchStore(db), library = new CatalogLibraryStore(db);
  async function add(value = input()) {
    const [saved] = await catalog.ingestSynthetic(value); return { saved: saved!, album: await catalog.getAlbum(saved!.albumId), value };
  }
  return { db, catalog, search, library, add };
}
function owner(db: ReturnType<typeof openDatabase>) {
  const id = randomUUID(); db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,\'Test\',?,0,\'now\',\'now\')').run(id, `${id}@example.test`); return id;
}
async function http(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db);
  const a = await createAccount(db, config, { name: "Alice", email: "alice@example.test", password });
  const b = await createAccount(db, config, { name: "Bob", email: "bob@example.test", password });
  const catalog = new CatalogStore(db), [saved] = await catalog.ingestSynthetic(input());
  const album = await catalog.getAlbum(saved!.albumId), app = await buildApp(db, config);
  t.after(async () => { await app.close(); db.close(); });
  async function login(email: string) {
    const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: base, payload: { email, password } });
    assert.equal(response.statusCode, 200);
    const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = (await app.inject({ url: "/api/auth/get-session", headers: { ...base, cookie } })).json().session.id as string;
    return { ...base, cookie, "x-loopshelf-session": session };
  }
  const own = await login(a.email), other = await login(b.email);
  const read = (query = "q=Synthetic", headers = own) => app.inject({ url: `/api/catalog/tracks?${query}`, headers });
  return { db, app, a, b, own, other, album, catalog, read };
}

test("track title search supports literal NFKC substrings, one/two-character Korean and Japanese without inferred aliases", async (t) => {
  const f = await fixture(t); await f.add();
  for (const q of ["숲", "기억", "星", "記憶", "ＦＡＮＴＡＳＹ", "fantasy", "%_", "기억의   숲"]) assert.equal(f.search.search({ q }).items.length, 1, q);
  assert.equal(f.search.search({ q: "  ＳＹＮＴＨＥＴＩＣ  " }).query, "synthetic");
  assert.equal(f.search.search({ q: "기억" }).items.length, 1);
  assert.equal(f.search.search({ q: "memory" }).items.length, 0);
  for (const q of ["%", "_", "100%_"]) assert.equal(f.search.search({ q }).items.length, 1);
  for (const q of ["% OR 1=1 --", '" OR *', "absent-title"]) assert.deepEqual(f.search.search({ q }).items, []);
});

test("track search refuses missing/empty/control/oversized queries and invalid filters/pagination without writing", async (t) => {
  const f = await fixture(t); await f.add(); const before = f.db.serialize();
  for (const value of [{}, null, { q: "" }, { q: "　 " }, { q: "x\n" }, { q: "x\u200b" }, { q: "x".repeat(201) }, { q: "ﷺ".repeat(200) },
    { q: "x", sourceId: "all" }, { q: "x", limit: 0 }, { q: "x", limit: 101 }, { q: "x", offset: -1 }, { q: "x", offset: 100001 },
    { q: "x", offset: 1.5 }, { q: ["x"] }, { q: "x", userId: randomUUID() }, { q: "x", sampleKind: "live-capture" }]) assert.throws(() => f.search.search(value));
  assert.deepEqual(f.db.serialize(), before);
});

test("results retain repeated display labels, zero/unknown lengths, stable track UUIDs and album-specific provenance", async (t) => {
  const f = await fixture(t), value = input(0, 3);
  value.data.tracks.forEach((row) => { row.title = "同じ曲"; row.displayNumber = "1"; row.discLabel = null; });
  value.data.tracks[0]!.durationSeconds = null; value.data.tracks[0]!.durationLabel = null; value.data.tracks[1]!.durationSeconds = 0;
  const first = await f.add(value), secondValue = input(1, 1); secondValue.data.tracks[0]!.title = "同じ曲"; await f.add(secondValue);
  const page = f.search.search({ q: "同じ" }); assert.equal(page.sampleKind, "synthetic"); assert.equal(page.identity, "source-provisional");
  assert.equal(page.items.length, 4); assert.equal(new Set(page.items.map((row) => row.id)).size, 4);
  assert.deepEqual(page.items.slice(0, 3).map((row) => row.id), first.album.tracks.map((row) => row.id));
  assert.deepEqual(page.items.slice(0, 3).map((row) => row.durationMs), [null, 0, 120000]);
  for (const row of page.items.slice(0, 3)) {
    assert.equal(row.displayNumber, "1"); assert.equal(row.discLabel, null); assert.equal(row.album.id, first.album.id);
    assert.equal(row.album.sourceEntityId, first.album.sourceEntityId); assert.equal(row.album.externalKey, value.data.externalKey);
    assert.equal(row.provenance.observationId, first.saved.observationId); assert.equal(row.provenance.capturedAt, value.provenance.capturedAt);
    assert.equal(row.album.provenance.observationId, first.saved.observationId); assert.equal(row.album.trackState, "unchanged");
  }
});

test("track search matches no album names or personal fields and does not read personal search tables", async (t) => {
  const f = await fixture(t), a = owner(f.db), value = input(); value.data.title = "OnlyAlbumName";
  const first = await f.add(value); f.library.create(a, { entityId: first.album.tracks[0]!.id, titleOverride: "PrivateOverride", note: "OnlyPrivateNote", favorite: true });
  for (const q of ["OnlyAlbumName", "PrivateOverride", "OnlyPrivateNote"]) assert.equal(f.search.search({ q }).items.length, 0);
  const plans = queryPlans(f.db, () => f.search.search({ q: "Synthetic" }));
  for (const query of plans) assert.doesNotMatch(query.sql, /\b(library_item|catalog_detached_item|bookmark|user_source_link)\b/u);
  const body = JSON.stringify(f.search.search({ q: "Synthetic" }));
  for (const text of [a, "PrivateOverride", "OnlyPrivateNote", "savedItemId", "titleOverride", "favorite", '"note"']) assert.ok(!body.includes(text));
});

test("track search checks albums once and bounds track reads by current observation before projecting a page", async (t) => {
  const f = await fixture(t); await f.add();
  const query = queryPlans(f.db, () => f.search.search({ q: "Synthetic", limit: 2 })).find((row) => row.sql.startsWith("WITH track_window"))!;
  const plans = query.plan.map((row) => (row as { detail: string }).detail);
  assert.ok(plans.some((row) => /SEARCH a .*\(id=\?\)/u.test(row)), plans.join("\n"));
  assert.ok(plans.some((row) => /SEARCH b .*observation_id=/u.test(row)), plans.join("\n"));
  assert.ok(plans.some((row) => /SCAN t USING (?:COVERING )?INDEX catalog_track_search_title_idx/u.test(row)), plans.join("\n"));
  assert.ok(!plans.some((row) => /^SCAN (track_entity|album_entity)(?:\s|$)/u.test(row)), plans.join("\n"));
  assert.equal(query.calls, 1);
});

test("stable title/source/key/current-position paging neither merges equal names nor crosses source filters", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) { const v = input(i, 3); v.data.tracks.forEach((row) => { row.title = i % 2 ? "ABC" : "ＡＢＣ"; }); await f.add(v); }
  const all = f.search.search({ q: "abc", limit: 100 }).items, ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) { const page = f.search.search({ q: "abc", limit: 2, offset }); ids.push(...page.items.map((row) => row.id)); offset = page.nextOffset; }
  assert.deepEqual(ids, all.map((row) => row.id)); assert.equal(new Set(ids).size, 12);
  const only = f.search.search({ q: "abc", sourceId: "zophar", limit: 100 }); assert.equal(only.sourceId, "zophar"); assert.equal(only.items.length, 6);
  assert.ok(only.items.every((row) => row.album.sourceId === "zophar"));
  const end = f.search.search({ q: "abc", offset: 100000 }); assert.deepEqual(end.items, []); assert.equal(end.nextOffset, null);
});

test("pending observations keep adopted titles; explicit adoption changes positions and removes missing tracks from search", async (t) => {
  const f = await fixture(t), first = await f.add(input(0, 3)), value = structuredClone(first.value);
  value.provenance.capturedAt = "2026-10-24T00:01:00.000Z"; value.data.title = "Latest album title";
  value.data.tracks = [value.data.tracks[2]!, value.data.tracks[0]!];
  value.data.tracks.forEach((row, i) => { row.title = `New adopted ${i + 1}`; row.position = i + 1; });
  const [next] = await f.catalog.ingestSynthetic(value);
  assert.equal(f.search.search({ q: "New adopted" }).items.length, 0);
  const pending = f.search.search({ q: "Synthetic" }); assert.equal(pending.items.length, 3);
  for (const row of pending.items) { assert.equal(row.album.trackState, "review_required"); assert.equal(row.album.title, value.data.title);
    assert.equal(row.album.provenance.observationId, next!.observationId); assert.equal(row.provenance.observationId, first.saved.observationId); }
  await f.catalog.adoptTrackList({ requestId: randomUUID(), albumId: first.album.id, expectedTracksObservationId: first.saved.observationId,
    observationId: next!.observationId, assignments: [first.album.tracks[2]!, first.album.tracks[0]!].map((row, i) => ({ position: i + 1, trackId: row.id })), missingTrackIds: [first.album.tracks[1]!.id] });
  const adopted = f.search.search({ q: "New adopted" }); assert.deepEqual(adopted.items.map((row) => [row.id, row.position]), [[first.album.tracks[2]!.id, 1], [first.album.tracks[0]!.id, 2]]);
  assert.ok(adopted.items.every((row) => row.album.trackState === "unchanged" && row.provenance.observationId === next!.observationId));
  assert.equal(f.search.search({ q: "Synthetic" }).items.length, 0);
  assert.equal((f.db.prepare("SELECT position FROM track WHERE id=?").get(first.album.tracks[2]!.id) as { position: number }).position, 3);
});

test("paging limit reports remaining results without returning an unusable next offset", async (t) => {
  const f = await fixture(t); await f.add(input(0, 20));
  // Simulate a populated deep page using the same real query rows; do not seed 100,000 rows in ordinary CI.
  const prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, "prepare", ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes("@offset")) return statement;
    return new Proxy(statement, { get(target, key) {
      if (key === "all") return (params: Record<string, unknown>) => target.all({ ...params, offset: 0 });
      return Reflect.get(target, key);
    } });
  }) as typeof f.db.prepare);
  const last = f.search.search({ q: "Synthetic", offset: 100000 });
  assert.equal(last.items.length, 12); assert.equal(last.nextOffset, null); assert.equal(last.paginationLimited, true);
  assert.equal(typeof last.nextCursor, "string", "offset cap still offers a usable cursor continuation");
  const previous = f.search.search({ q: "Synthetic", offset: 99988 });
  assert.equal(previous.nextOffset, 100000); assert.equal(previous.paginationLimited, false);
});

test("blocked/unavailable sources, inactive albums/tracks and rights removals cannot appear in public track search", async (t) => {
  const f = await fixture(t), entries: Awaited<ReturnType<typeof f.add>>[] = [];
  for (let i = 0; i < 7; i++) entries.push(await f.add(input(i, 1)));
  for (const [i, status] of ["blocked", "not_found", "removed"].entries()) f.db.prepare("UPDATE source_entity SET availability=? WHERE id=?").run(status, entries[i]!.saved.sourceEntityId);
  f.db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=?").run(entries[3]!.album.id);
  f.db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=?").run(entries[4]!.album.tracks[0]!.id);
  await f.catalog.removeSource({ sourceEntityId: entries[5]!.saved.sourceEntityId, reason: "rights_request" });
  assert.deepEqual(f.search.search({ q: "Synthetic" }).items.map((row) => row.id), [entries[6]!.album.tracks[0]!.id]);
});

test("expired titles and baselines disappear before reads while a fresh re-adoption can use an expired first origin", async (t) => {
  const f = await fixture(t), first = await f.add(input(0, 2)), value = structuredClone(first.value);
  const expiresAt = new Date(Date.now() - 1000).toISOString();
  value.provenance.capturedAt = new Date(Date.now() - 5000).toISOString(); value.data.tracks[0]!.title = "Fresh adopted title";
  const [next] = await f.catalog.ingestSynthetic(value);
  await f.catalog.adoptTrackList({ requestId: randomUUID(), albumId: first.album.id, expectedTracksObservationId: first.saved.observationId, observationId: next!.observationId,
    assignments: first.album.tracks.map((row, i) => ({ position: i + 1, trackId: row.id })), missingTrackIds: [] });
  f.db.transaction(() => attachSyntheticRetention(f.db, first.saved.observationId, "synthetic-expiry", expiresAt)).immediate();
  const current = f.search.search({ q: "Fresh adopted" }); assert.equal(current.items.length, 1);
  assert.equal(current.items[0]!.provenance.observationId, next!.observationId);
  assert.equal((f.db.prepare("SELECT content_state AS state FROM catalog_observation WHERE id=?").get(first.saved.observationId) as { state: string }).state, "expired");
  f.db.transaction(() => attachSyntheticRetention(f.db, next!.observationId, "synthetic-expiry", expiresAt)).immediate();
  assert.equal(f.search.search({ q: "Fresh adopted" }).items.length, 0);
});

test("fresh album metadata does not resurrect an expired unadopted track baseline", async (t) => {
  const f = await fixture(t), first = await f.add(input(0, 2));
  f.db.transaction(() => attachSyntheticRetention(f.db, first.saved.observationId, "synthetic-expiry", new Date(Date.now() - 1000).toISOString())).immediate();
  reconcileCatalogRetention(f.db);
  const value = structuredClone(first.value); value.provenance.capturedAt = new Date().toISOString();
  await f.catalog.ingestSynthetic(value); assert.equal(f.search.search({ q: "Synthetic" }).items.length, 0);
});

test("live schema simulations are excluded and current policy revocation keeps only personal IDs/content", async (t) => {
  const f = await fixture(t), a = owner(f.db), live = simulateLiveCatalog(f.db, a); await f.add();
  const result = f.search.search({ q: "Synthetic" }); assert.equal(result.items.length, 5);
  const json = JSON.stringify(result); assert.ok(!json.includes(live.title)); assert.ok(!json.includes(live.sourceId));
  assert.equal((f.db.prepare("SELECT content_state AS state FROM catalog_observation WHERE id=?").get(live.observationId) as { state: string }).state, "policy_revoked");
  assert.equal(f.library.get(a, live.itemIds[0]!).entity.contentState, "expired");
});

test("authenticated track search returns public data equally to both real accounts with session-bound no-store headers", async (t) => {
  const f = await http(t), dns = t.mock.method(Resolver.prototype, "resolve4", () => { throw new Error("No external network"); });
  const personal = new CatalogLibraryStore(f.db).create(f.a.id, { entityId: f.album.tracks[0]!.id, note: "private-search-note", titleOverride: "secret-title", favorite: true }).item;
  const pages = [];
  for (const [headers, user] of [[f.own, f.a], [f.other, f.b]] as const) {
    const response = await f.read("q=Synthetic", headers); assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.headers.vary, "Cookie, X-LoopShelf-Session");
    assert.equal(response.headers["x-loopshelf-user"], user.id); assert.equal(response.headers["x-loopshelf-session"], headers["x-loopshelf-session"]);
    for (const secret of [f.a.id, f.b.id, personal.id, personal.note, personal.titleOverride!]) assert.ok(!response.body.includes(secret));
    pages.push(response.json().items);
  }
  assert.deepEqual(pages[0], pages[1]); assert.equal(dns.mock.callCount(), 0);
  assert.deepEqual(f.db.prepare("SELECT * FROM source_metadata_cache").all(), []);
});

test("track HTTP reads require real cookies and a matching required session condition, including after logout/expiry", async (t) => {
  const f = await http(t);
  for (const cookie of ["", "better-auth.session_token=forged"]) assert.equal((await f.read("q=Synthetic", { ...f.own, cookie })).statusCode, 401);
  const { "x-loopshelf-session": ignored, ...missing } = f.own; void ignored;
  assert.equal((await f.app.inject({ url: "/api/catalog/tracks?q=Synthetic", headers: missing })).statusCode, 428);
  assert.equal((await f.read("q=Synthetic", { ...f.other, "x-loopshelf-session": f.own["x-loopshelf-session"] })).statusCode, 401);
  f.db.prepare('UPDATE session SET "expiresAt"=0 WHERE id=?').run(f.own["x-loopshelf-session"]);
  assert.equal((await f.read()).statusCode, 401);
  await f.app.inject({ method: "POST", url: "/api/auth/sign-out", headers: f.other, payload: {} });
  assert.equal((await f.read("q=Synthetic", f.other)).statusCode, 401);
});

test("track HTTP validation rejects extra fields, invalid inputs and non-GET operations while preserving valid no-match pages", async (t) => {
  const f = await http(t);
  for (const query of ["", "q=", "q=%20", "q=x%00", "q=x&q=y", "q=x&limit=101", "q=x&offset=-1", "q=x&sourceId=other", "q=x&userId=foreign", "q=x&sampleKind=live-capture"])
    assert.equal((await f.read(query)).statusCode, 400, query);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/catalog/tracks", headers: f.own, payload: { q: "Synthetic" } })).statusCode, 404);
  const empty = await f.read("q=absent&limit=100&offset=100000"); assert.equal(empty.statusCode, 200); assert.deepEqual(empty.json().items, []); assert.equal(empty.json().nextOffset, null);
});

test("queued track reads authenticate after the database turn and do not return data from a revoked session", async (t) => {
  const f = await http(t); let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const blocker = withDatabase(f.db, async () => { await hold; f.db.prepare("DELETE FROM session WHERE id=?").run(f.own["x-loopshelf-session"]); });
  const pending = f.read().then((response) => response); await new Promise((resolve) => setImmediate(resolve)); release(); await blocker;
  const response = await pending; assert.equal(response.statusCode, 401); assert.ok(!response.body.includes(f.album.title));
});

test("retention conflicts fail closed through HTTP instead of returning stale titles or a successful empty result", async (t) => {
  const f = await http(t);
  const observation = f.album.tracksObservationId!;
  f.db.transaction(() => attachSyntheticRetention(f.db, observation, "synthetic-expiry", new Date(Date.now() - 1000).toISOString())).immediate();
  f.db.prepare("INSERT INTO assertion(id,entity_id,field,value_json,observed_at,method) VALUES (?,?,'title','\"curated\"','now','curated')").run(randomUUID(), f.album.id);
  const response = await f.read(); assert.equal(response.statusCode, 409); assert.equal(response.json().code, "removal_conflict");
  assert.ok(!response.body.includes(f.album.title));
});

test("0014 builds the derived title index without changing IDs/content and rolls back a failed upgrade", async (t) => {
  const db = openDatabase(":memory:"); t.after(() => db.close()); const migrations = loadMigrations().slice(0, 14);
  assert.equal(migrations.at(-1)!.name, "0014_catalog_track_search.sql"); migrate(db, migrations.slice(0, -1));
  const a = owner(db), catalog = new CatalogStore(db), [first] = await catalog.ingestSynthetic(input());
  const album = await catalog.getAlbum(first!.albumId);
  new CatalogLibraryStore(db).create(a, { entityId: album.tracks[0]!.id, note: "upgrade-preserved", favorite: true });
  const tables = ["entity", "album", "track", "catalog_observation", "catalog_track_binding", "library_item"];
  const contents = () => tables.map((name) => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
  const before = contents(), history = db.prepare("SELECT name,sha256 FROM schema_migration ORDER BY name").all();
  assert.throws(() => migrate(db, [...migrations.slice(0, -1), { ...migrations.at(-1)!, sql: migrations.at(-1)!.sql + "\nSELECT * FROM deliberately_missing_table;" }]));
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalog_track_search_title_idx'").get(), undefined);
  assert.deepEqual(contents(), before); assert.deepEqual(db.prepare("SELECT name,sha256 FROM schema_migration ORDER BY name").all(), history);
  migrate(db); assertMigrated(db); verifyDatabase(db); assert.deepEqual(contents(), before);
  assert.deepEqual(db.prepare("SELECT name,sha256 FROM schema_migration ORDER BY name LIMIT 13").all(), history);
  assert.equal(new CatalogTrackSearchStore(db).search({ q: "ＦＡＮＴＡＳＹ" }).items.length, 1);
  assert.throws(() => migrate(db, migrations.slice(0, -1)), /Migration history mismatch/);
});

test("indexed search survives verified backup/new-path restore with private IDs intact and old sessions removed", async (t) => {
  const f = await http(t), library = new CatalogLibraryStore(f.db);
  const firstPage = (await f.read("q=Synthetic&limit=1")).json();
  const cursorQuery = `q=Synthetic&limit=1&cursor=${firstPage.nextCursor}`;
  const expectedNext = (await f.read(cursorQuery)).json().items;
  const saved = library.create(f.a.id, { entityId: f.album.tracks[0]!.id, note: "restore-preserved", favorite: true }).item;
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-track-search-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backup = join(dir, "backup.sqlite"), restored = join(dir, "restored.sqlite");
  await withDatabase(f.db, () => backupDatabase(f.db, backup));
  const checksum = () => createHash("sha256").update(readFileSync(backup)).digest("hex"), original = checksum();
  await restoreDatabase(backup, restored); assert.equal(checksum(), original);
  const db = openDatabase(restored); const app = await buildApp(db, config);
  try {
    verifyDatabase(db); assertMigrated(db); assert.deepEqual(new CatalogLibraryStore(db).get(f.a.id, saved.id), saved);
    assert.equal((await app.inject({ url: "/api/catalog/tracks?q=Synthetic", headers: f.own })).statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: base, payload: { email: f.a.email, password } });
    assert.equal(login.statusCode, 200); const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = (await app.inject({ url: "/api/auth/get-session", headers: { ...base, cookie } })).json().session.id;
    const response = await app.inject({ url: "/api/catalog/tracks?q=Synthetic", headers: { ...base, cookie, "x-loopshelf-session": session } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().items.length, 5);
    assert.ok(response.json().items.some((row: { id: string }) => row.id === saved.entity.id));
    const continued = await app.inject({ url: `/api/catalog/tracks?${cursorQuery}`, headers: { ...base, cookie, "x-loopshelf-session": session } });
    assert.equal(continued.statusCode, 200); assert.deepEqual(continued.json().items, expectedNext);
    await new CatalogStore(db).removeSource({ sourceEntityId: f.album.sourceEntityId, reason: "rights_request" });
    assert.equal(new CatalogTrackSearchStore(db).search({ q: "Synthetic" }).items.length, 0); verifyDatabase(db);
    assert.equal((db.prepare("SELECT count(*) AS n FROM track INDEXED BY catalog_track_search_title_idx WHERE instr(normalize_search(title),'synthetic')>0").get() as { n: number }).n, 0);
    assert.equal(new CatalogLibraryStore(db).get(f.a.id, saved.id).note, saved.note);
    assert.equal(checksum(), original); assert.equal((await f.read()).json().items.length, 5);
  } finally { await app.close(); db.close(); }
});

test("cursor traversal matches offset ordering across equal titles, sources, positions and Unicode without duplicate IDs", async (t) => {
  const f = await fixture(t);
  const titles = ["Same ＡＢＣ", "same abc", "same 記憶", "same 기억", "same 🦊", "same %_", "same ' quote"];
  for (let i = 0; i < 6; i++) {
    const value = input(i, titles.length); value.data.tracks.forEach((row, n) => { row.title = titles[n]!; row.displayNumber = "1"; });
    await f.add(value);
  }
  for (const source of [undefined, "khinsider", "zophar"] as const) {
    const filter = source ? { sourceId: source } : {}, expected = f.search.search({ q: "same", ...filter, limit: 100 }).items;
    for (const limit of [1, 2, 7]) {
      const rows = []; let page = f.search.search({ q: "same", ...filter, limit });
      for (let count = 0; ; count++) {
        assert.ok(count < 50, "cursor must advance"); rows.push(...page.items);
        if (!page.nextCursor) break;
        // Re-create the store too: continuation needs no in-memory registry.
        page = new CatalogTrackSearchStore(f.db).search({ q: "ＳＡＭＥ", ...filter, limit, cursor: page.nextCursor });
        assert.equal(page.nextOffset, null); assert.equal(page.paginationLimited, false);
      }
      assert.deepEqual(rows, expected); assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
    }
  }
});

test("cursor input binds normalized query/source/limit, rejects malformed values before writes and contains no copied metadata", async (t) => {
  const f = await fixture(t); await f.add(input(0, 3));
  const page = f.search.search({ q: "Synthetic", limit: 1 }), cursor = page.nextCursor!;
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(decoded).sort(), ["anchor", "context", "id", "v"]);
  const json = JSON.stringify(decoded);
  for (const value of [page.items[0]!.title, page.items[0]!.album.externalKey, page.query, "note", "userId", "sessionId"]) assert.ok(!json.includes(value));
  const before = f.db.serialize();
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const bad of ["", "a".repeat(385), "!", "e30", cursor + "=", "e30\n", encode({ ...decoded, v: 2 }), encode({ ...decoded, id: "invalid" }),
    encode({ ...decoded, anchor: "bad" }), encode({ ...decoded, extra: true }), encode([]), encode(null), [cursor, cursor]])
    assert.throws(() => f.search.search({ q: "Synthetic", limit: 1, cursor: bad }));
  for (const change of [{ q: "Track" }, { sourceId: "khinsider" }, { limit: 2 }, { offset: 0 }, { offset: 1 }])
    assert.throws(() => f.search.search({ q: "Synthetic", limit: 1, cursor, ...change }));
  assert.deepEqual(f.db.serialize(), before);
  assert.ok(f.search.search({ q: "  ＳＹＮＴＨＥＴＩＣ  ", limit: 1, cursor }).items.length);
  const forged = encode({ ...decoded, id: randomUUID() });
  assert.throws(() => f.search.search({ q: "Synthetic", limit: 1, cursor: forged }), { code: "cursor_invalidated" });
  assert.throws(() => f.search.search({ q: "Synthetic", limit: 1, cursor: encode({ ...decoded, anchor: "0".repeat(64) }) }), { code: "cursor_invalidated" });
});

test("cursor cannot continue from a removed, blocked, missing, inactive or expired anchor", async (t) => {
  for (const state of ["removed", "blocked", "not_found", "inactive-track", "inactive-album", "expired"] as const) {
    const f = await fixture(t); const entry = await f.add(input(0, 3));
    const first = f.search.search({ q: "Synthetic", limit: 1 }), id = first.items[0]!.id;
    if (state === "removed") await f.catalog.removeSource({ sourceEntityId: entry.saved.sourceEntityId, reason: "rights_request" });
    else if (state === "blocked" || state === "not_found") f.db.prepare("UPDATE source_entity SET availability=? WHERE id=?").run(state, entry.saved.sourceEntityId);
    else if (state === "expired") f.db.transaction(() => attachSyntheticRetention(f.db, entry.saved.observationId, "cursor-expiry", new Date(Date.now() - 1000).toISOString())).immediate();
    else f.db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=?").run(state === "inactive-track" ? id : entry.album.id);
    assert.throws(() => f.search.search({ q: "Synthetic", limit: 1, cursor: first.nextCursor }), { code: "cursor_invalidated" }, state);
  }
});

test("pending observations preserve cursor order but explicit adoption invalidates the former anchor even when its ID survives", async (t) => {
  const f = await fixture(t), value = input(0, 3); value.data.tracks.forEach((row) => { row.title = "Same"; });
  const first = await f.add(value), page = f.search.search({ q: "Same", limit: 1 });
  const changed = structuredClone(value); changed.provenance.capturedAt = new Date(Date.now() + 1000).toISOString();
  changed.data.tracks[2]!.title = "Same new observation";
  const [pending] = await f.catalog.ingestSynthetic(changed);
  const next = f.search.search({ q: "Same", limit: 1, cursor: page.nextCursor });
  assert.equal(next.items[0]!.id, first.album.tracks[1]!.id); assert.equal(next.items[0]!.album.trackState, "review_required");
  await f.catalog.adoptTrackList({ requestId: randomUUID(), albumId: first.album.id, expectedTracksObservationId: first.saved.observationId,
    observationId: pending!.observationId, assignments: first.album.tracks.map((row, i) => ({ position: i + 1, trackId: row.id })), missingTrackIds: [] });
  assert.throws(() => f.search.search({ q: "Same", limit: 1, cursor: page.nextCursor }), { code: "cursor_invalidated" });
  assert.equal(f.search.search({ q: "Same", limit: 1 }).items[0]!.id, page.items[0]!.id);
});

test("cursor rejects a changed anchor sort tuple and excludes unavailable non-anchor rows on every continuation", async (t) => {
  const f = await fixture(t);
  const entries = [];
  for (let i = 0; i < 4; i++) { const v = input(i, 1); v.data.tracks[0]!.title = `Same ${i}`; entries.push(await f.add(v)); }
  const first = f.search.search({ q: "Same", limit: 1 });
  await f.catalog.removeSource({ sourceEntityId: entries[1]!.saved.sourceEntityId, reason: "rights_request" });
  f.db.prepare("UPDATE source_entity SET availability='blocked' WHERE id=?").run(entries[2]!.saved.sourceEntityId);
  let page = f.search.search({ q: "Same", limit: 1, cursor: first.nextCursor });
  assert.deepEqual(page.items.map((row) => row.id), [entries[3]!.album.tracks[0]!.id]); assert.equal(page.nextCursor, null);
  f.db.prepare("UPDATE source_entity SET availability='blocked' WHERE id=?").run(entries[3]!.saved.sourceEntityId);
  page = f.search.search({ q: "Same", limit: 1, cursor: first.nextCursor });
  assert.deepEqual(page.items, []); assert.equal(page.nextCursor, null);
  f.db.prepare("UPDATE track SET title='Same renamed' WHERE id=?").run(first.items[0]!.id);
  assert.throws(() => f.search.search({ q: "Same", limit: 1, cursor: first.nextCursor }), { code: "cursor_invalidated" });
});

test("cursor continuation reflects new rows after its anchor without pretending to be a frozen snapshot", async (t) => {
  const f = await fixture(t), value = input(0, 2); value.data.tracks[0]!.title = "Same M"; value.data.tracks[1]!.title = "Same Z";
  await f.add(value); const first = f.search.search({ q: "Same", limit: 1 });
  for (const [i, title] of ["Same A", "Same T"].entries()) { const v = input(i + 1, 1); v.data.tracks[0]!.title = title; await f.add(v); }
  const second = f.search.search({ q: "Same", limit: 1, cursor: first.nextCursor }); assert.equal(second.items[0]!.title, "Same T");
  const last = f.search.search({ q: "Same", limit: 1, cursor: second.nextCursor }); assert.equal(last.items[0]!.title, "Same Z"); assert.equal(last.nextCursor, null);
  assert.equal(f.search.search({ q: "Same", limit: 1 }).items[0]!.title, "Same A");
});

test("cursor uses a title-index range without OFFSET and keeps anchor/page SQL outside personal tables", async (t) => {
  const f = await fixture(t), entry = await f.add(), a = owner(f.db);
  const first = f.search.search({ q: "Synthetic", limit: 1 });
  f.library.create(a, { entityId: entry.album.tracks[0]!.id, titleOverride: "private", note: "private" });
  const plans = queryPlans(f.db, () => f.search.search({ q: "Synthetic", limit: 1, cursor: first.nextCursor }));
  for (const query of plans) assert.doesNotMatch(query.sql, /\b(library_item|catalog_detached_item|bookmark|user_source_link)\b/u);
  const page = plans.find((row) => row.sql.startsWith("WITH track_window") && row.sql.includes("@afterTitle"))!; assert.ok(page); assert.doesNotMatch(page.sql, /\bOFFSET\b/u);
  const details = page.plan.map((row) => (row as { detail: string }).detail);
  assert.ok(details.some((row) => /SEARCH t USING (?:COVERING )?INDEX catalog_track_search_title_idx \(<expr>>\?\)/u.test(row)), details.join("\n"));
  const anchor = plans.find((row) => row.sql.includes("@anchorId"))!; assert.ok(anchor);
  assert.ok(!anchor.plan.some((row) => /SCAN (a|t)(?:\s|$)/u.test((row as { detail: string }).detail)));
});

test("cursor HTTP replies preserve real session requirements and distinguish malformed from changed continuation", async (t) => {
  const f = await http(t), first = await f.read("q=Synthetic&limit=1"); assert.equal(first.statusCode, 200);
  const cursor = first.json().nextCursor as string, query = `q=Synthetic&limit=1&cursor=${cursor}`;
  const own = await f.read(query); assert.equal(own.statusCode, 200); assert.equal(own.json().nextOffset, null);
  const other = await f.read(query, f.other); assert.equal(other.statusCode, 200); assert.deepEqual(other.json().items, own.json().items);
  assert.equal(other.headers["cache-control"], "no-store"); assert.equal(other.headers["x-loopshelf-session"], f.other["x-loopshelf-session"]);
  assert.equal((await f.read(query, { ...f.own, cookie: "" })).statusCode, 401);
  assert.equal((await f.read(query, { ...f.other, "x-loopshelf-session": f.own["x-loopshelf-session"] })).statusCode, 401);
  for (const q of [`${query}&offset=0`, `${query}&cursor=${cursor}`, `q=Synthetic&limit=2&cursor=${cursor}`, "q=Synthetic&cursor=invalid"])
    assert.equal((await f.read(q)).statusCode, 400);
  await f.catalog.removeSource({ sourceEntityId: f.album.sourceEntityId, reason: "rights_request" });
  const stale = await f.read(query); assert.equal(stale.statusCode, 409); assert.deepEqual(stale.json(), { code: "cursor_invalidated" });
  assert.equal(stale.headers["cache-control"], "no-store"); assert.ok(!stale.body.includes(f.album.title));
  await f.app.inject({ method: "POST", url: "/api/auth/sign-out", headers: f.own, payload: {} });
  assert.equal((await f.read(query)).statusCode, 401);
});

test("cursor filters newly expired non-anchor observations and fails closed when expiry cleanup conflicts", async (t) => {
  const f = await fixture(t), entries: Awaited<ReturnType<typeof f.add>>[] = [];
  for (let i = 0; i < 3; i++) { const value = input(i, 1); value.data.tracks[0]!.title = `Same ${i}`; entries.push(await f.add(value)); }
  const page = f.search.search({ q: "Same", limit: 1 });
  f.db.transaction(() => attachSyntheticRetention(f.db, entries[1]!.saved.observationId, "cursor-expiry", new Date(Date.now() - 1000).toISOString())).immediate();
  const next = f.search.search({ q: "Same", limit: 1, cursor: page.nextCursor });
  assert.deepEqual(next.items.map((row) => row.id), [entries[2]!.album.tracks[0]!.id]);
  f.db.transaction(() => attachSyntheticRetention(f.db, entries[2]!.saved.observationId, "cursor-expiry", new Date(Date.now() - 1000).toISOString())).immediate();
  f.db.prepare("INSERT INTO assertion(id,entity_id,field,value_json,observed_at,method) VALUES (?,?,'title','\"curated\"','now','curated')").run(randomUUID(), entries[2]!.album.id);
  assert.throws(() => f.search.search({ q: "Same", limit: 1, cursor: page.nextCursor }), { code: "removal_conflict" });
});

test("queued cursor requests recheck anchor availability after the DB turn before returning a continuation", async (t) => {
  const f = await http(t), first = (await f.read("q=Synthetic&limit=1")).json(); let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const blocker = withDatabase(f.db, async () => {
    await hold; f.db.prepare("UPDATE source_entity SET availability='blocked' WHERE id=?").run(f.album.sourceEntityId);
  });
  const pending = f.read(`q=Synthetic&limit=1&cursor=${first.nextCursor}`).then((response) => response);
  await new Promise((resolve) => setImmediate(resolve)); release(); await blocker;
  const response = await pending; assert.equal(response.statusCode, 409); assert.deepEqual(response.json(), { code: "cursor_invalidated" });
  assert.ok(!response.body.includes(f.album.title));
});
