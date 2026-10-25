import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as immediate } from "node:timers/promises";
import { test } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { assertMigrated, loadMigrations, migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { withDatabase } from "../src/database/access.ts";
import { createAccount } from "../src/auth/accounts.ts";
import { buildApp } from "../src/server/app.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogTrackSearchStore } from "../src/catalog/track-search.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { rebuildCatalogSearchIndex, verifyCatalogSearchIndex } from "../src/catalog/search-index.ts";
import { attachSyntheticRetention } from "../src/catalog/retention.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { profileAlbum, referenceItems, referenceTracks } from "../scripts/benchmarks/search-profiles.ts";
import { queryPlans } from "../scripts/benchmarks/query-plans.ts";

type Ingested = Awaited<ReturnType<CatalogStore["ingestSynthetic"]>>[number];
const config = { baseURL: "http://127.0.0.1:3000", secret: "index-test-only-secret-at-least-32-characters" };
function owner(db: ReturnType<typeof openDatabase>) {
  const id = randomUUID(); db.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'Test',?,0,'now','now')`).run(id, `${id}@example.test`); return id;
}

test("0016 backfills exact current rows, preserves identities, rolls back failures and survives verified restore/removal", async (t) => {
  const db = openDatabase(":memory:"), all = loadMigrations().slice(0, 16), prior = all.slice(0, 15); migrate(db, prior); t.after(() => db.close());
  assert.equal(all.at(-1)!.name, "0016_catalog_track_search_projection.sql");
  const user = owner(db), catalog = new CatalogStore(db), library = new CatalogLibraryStore(db), saved: Ingested[] = [];
  for (let i = 0; i < 4; i++) saved.push((await catalog.ingestSynthetic(syntheticAlbum(i, 5)))[0]!);
  const item = library.create(user, { entityId: saved[0]!.albumId, note: "private-survives", favorite: true }).item;
  db.prepare("UPDATE source_entity SET availability='blocked' WHERE id=?").run(saved[1]!.sourceEntityId);
  await catalog.removeSource({ sourceEntityId: saved[3]!.sourceEntityId, reason: "rights_request" });
  const tables = ["entity", "album", "track", "source_entity", "catalog_album_state", "catalog_observation", "catalog_track_binding", "library_item", "catalog_removal"];
  const contents = () => tables.map((name) => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
  const before = contents(), history = db.prepare("SELECT * FROM schema_migration ORDER BY name").all(), last = all.at(-1)!;
  assert.throws(() => migrate(db, [...prior, { ...last, sql: `${last.sql}\nSELECT deliberately_missing_function();` }]));
  assert.deepEqual(contents(), before); assert.deepEqual(db.prepare("SELECT * FROM schema_migration ORDER BY name").all(), history);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalog_track_search_index'").get(), undefined);
  migrate(db); assertMigrated(db); verifyDatabase(db); assert.deepEqual(contents(), before);
  assert.throws(() => migrate(db, prior), /history mismatch/u);
  assert.equal((db.prepare("SELECT count(*) AS n FROM catalog_track_search_index").get() as { n: number }).n, 10);
  const search = new CatalogTrackSearchStore(db);
  assert.deepEqual(search.search({ q: "Synthetic", offset: 2, limit: 100 }).items, referenceItems(referenceTracks(db, "Synthetic").slice(2)));
  const plan = queryPlans(db, () => search.search({ q: "Synthetic", offset: 2, limit: 100 }));
  const first = plan.find((p) => p.sql.startsWith("SELECT s.track_id"))!;
  assert.ok(first.plan.some((p) => (p as { detail: string }).detail.includes("catalog_track_search_order_idx")));
  assert.ok(!first.plan.some((p) => (p as { detail: string }).detail.includes("TEMP B-TREE")));
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-index-migration-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backup = join(dir, "backup.sqlite"), restored = join(dir, "restored.sqlite"); await backupDatabase(db, backup);
  const hash = () => createHash("sha256").update(readFileSync(backup)).digest("hex"), initial = hash();
  await restoreDatabase(backup, restored); const copy = openDatabase(restored);
  try {
    verifyDatabase(copy); assertMigrated(copy);
    assert.deepEqual(new CatalogTrackSearchStore(copy).search({ q: "Synthetic", offset: 2 }).items, search.search({ q: "Synthetic", offset: 2 }).items);
    const copied = new CatalogLibraryStore(copy).get(user, item.id); assert.equal(copied.note, item.note); assert.equal(copied.version, item.version);
    await new CatalogStore(copy).removeSource({ sourceEntityId: saved[0]!.sourceEntityId, reason: "rights_request" });
    assert.equal((copy.prepare("SELECT count(*) AS n FROM catalog_track_search_index WHERE album_id=?").get(saved[0]!.albumId) as { n: number }).n, 0);
    await rebuildCatalogSearchIndex(copy); verifyDatabase(copy);
    assert.equal((copy.prepare("SELECT count(*) AS n FROM catalog_track_search_index").get() as { n: number }).n, 5);
  } finally { copy.close(); }
  assert.equal(hash(), initial); assert.deepEqual(contents(), before);
});

test("indexed offsets follow Unicode, source filters, adoption, visibility, expiration and rollback without changing private contents", async (t) => {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const catalog = new CatalogStore(db), search = new CatalogTrackSearchStore(db), library = new CatalogLibraryStore(db), user = owner(db), saved: Ingested[] = [];
  for (let i = 0; i < 30; i++) saved.push((await catalog.ingestSynthetic(profileAlbum("unique", 30)(i, 3)))[0]!);
  const personal = library.create(user, { entityId: saved[0]!.albumId, note: "private-only", favorite: true }).item;
  function check() {
    verifyCatalogSearchIndex(db);
    for (const sourceId of [undefined, "khinsider", "zophar"] as const) for (const q of ["Synthetic", "記憶", "%_", "private-only"]) {
      const expected = referenceItems(referenceTracks(db, q, sourceId));
      for (const offset of [1, 12, 50, 100000]) {
        const page = search.search({ q, offset, limit: 12, ...(sourceId ? { sourceId } : {}) });
        assert.deepEqual(page.items, expected.slice(offset, offset + 12));
        assert.equal(page.nextOffset, expected.length > offset + 12 && offset + 12 <= 100000 ? offset + 12 : null);
      }
    }
  }
  check();
  const original = await catalog.getAlbum(saved[0]!.albumId), changed = syntheticAlbum(0, 2); assert.equal(changed.data.kind, "album");
  if (changed.data.kind === "album") changed.data.tracks.forEach((row) => { row.title = "ＳＡＭＥ 記憶 %_"; row.displayNumber = "1"; });
  changed.provenance.capturedAt = "2026-10-25T01:00:00.000Z";
  const [observed] = await catalog.ingestSynthetic(changed); check(); // Unadopted metadata cannot change search order.
  await catalog.adoptTrackList({ requestId: randomUUID(), albumId: original.id, expectedTracksObservationId: original.tracksObservationId,
    observationId: observed!.observationId, assignments: [original.tracks[2]!, original.tracks[0]!].map((row, i) => ({ position: i + 1, trackId: row.id })), missingTrackIds: [original.tracks[1]!.id] });
  check();
  for (const availability of ["blocked", "not_found", "available"]) { db.prepare("UPDATE source_entity SET availability=? WHERE id=?").run(availability, saved[1]!.sourceEntityId); check(); }
  for (const id of [saved[2]!.albumId, original.tracks[0]!.id]) {
    db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=?").run(id); check();
    db.prepare("UPDATE entity SET lifecycle='active' WHERE id=?").run(id); check();
  }
  const indexBefore = db.prepare("SELECT * FROM catalog_track_search_index ORDER BY track_id").all();
  assert.throws(() => db.transaction(() => { db.prepare("UPDATE track SET title='rolled-back-title' WHERE id=?").run(original.tracks[0]!.id); throw new Error("deliberate"); })());
  assert.deepEqual(db.prepare("SELECT * FROM catalog_track_search_index ORDER BY track_id").all(), indexBefore);
  db.transaction(() => attachSyntheticRetention(db, saved[4]!.observationId, "index-expiry", new Date(Date.now() - 1000).toISOString())).immediate();
  search.search({ q: "Synthetic", offset: 1 }); check();
  await catalog.removeSource({ sourceEntityId: saved[5]!.sourceEntityId, reason: "policy_change" }); check();
  await rebuildCatalogSearchIndex(db); check();
  const kept = library.get(user, personal.id); assert.equal(kept.note, personal.note); assert.equal(kept.version, personal.version); assert.equal(kept.favorite, true);
});

test("projection corruption fails page/startup/snapshot checks and operator rebuild is atomic and preserves original tables", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-index-rebuild-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "catalog.sqlite"), db = openDatabase(filename); migrate(db); t.after(() => db.close());
  const catalog = new CatalogStore(db), search = new CatalogTrackSearchStore(db), user = owner(db);
  for (let i = 0; i < 4; i++) await catalog.ingestSynthetic(syntheticAlbum(i, 5));
  const rows = referenceTracks(db, "Synthetic"), item = new CatalogLibraryStore(db).create(user, { entityId: rows[2]!.id, note: "keep-me" }).item;
  db.prepare("UPDATE catalog_track_search_index SET position=4999 WHERE track_id=?").run(rows[2]!.id);
  assert.throws(() => search.search({ q: "Synthetic", offset: 1, limit: 100 }), /does not match current evidence/u);
  assert.throws(() => verifyDatabase(db), /search index verification failed/u);
  await assert.rejects(buildApp(db, config), /search index verification failed/u);
  const badBackup = join(dir, "bad.sqlite"); await assert.rejects(backupDatabase(db, badBackup), /search index verification failed/u); assert.ok(!existsSync(badBackup));
  const repaired = await rebuildCatalogSearchIndex(db); assert.equal(repaired.indexedTracks, 20); verifyDatabase(db);
  assert.deepEqual(search.search({ q: "Synthetic", offset: 1, limit: 100 }).items, referenceItems(rows.slice(1)));
  const before = db.prepare("SELECT * FROM catalog_track_search_index ORDER BY track_id").all();
  db.exec("CREATE TEMP TRIGGER reject_rebuild BEFORE INSERT ON catalog_track_search_index BEGIN SELECT RAISE(ABORT,'deliberate rebuild failure'); END;");
  await assert.rejects(rebuildCatalogSearchIndex(db), /deliberate rebuild failure/u);
  assert.deepEqual(db.prepare("SELECT * FROM catalog_track_search_index ORDER BY track_id").all(), before); db.exec("DROP TRIGGER reject_rebuild");
  db.prepare("DELETE FROM catalog_track_search_index WHERE track_id=?").run(rows[2]!.id);
  assert.throws(() => verifyCatalogSearchIndex(db), /verification failed/u);
  const result = spawnSync(process.execPath, ["scripts/catalog.ts", "reindex"], { encoding: "utf8", env: { ...process.env, DATABASE_PATH: filename }, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { indexedTracks: 20 });
  verifyDatabase(db); assert.equal(new CatalogLibraryStore(db).get(user, item.id).note, item.note);
  const invalid = spawnSync(process.execPath, ["scripts/catalog.ts", "reindex", "--album-id", rows[0]!.albumId], { encoding: "utf8", env: { ...process.env, DATABASE_PATH: filename }, timeout: 30000 });
  assert.notEqual(invalid.status, 0); assert.deepEqual(db.prepare("SELECT * FROM catalog_track_search_index ORDER BY track_id").all(), before);
});

test("authenticated offset pages recheck real sessions and current indexed visibility after queueing", async (t) => {
  const db = openDatabase(":memory:"); migrate(db);
  const password = "index-real-session-password", users = [];
  for (const name of ["one", "two"]) users.push(await createAccount(db, config, { name, email: `${name}@example.test`, password }));
  const catalog = new CatalogStore(db), saved: Ingested[] = [];
  for (let i = 0; i < 8; i++) saved.push((await catalog.ingestSynthetic(syntheticAlbum(i, 5)))[0]!);
  const app = await buildApp(db, config); t.after(async () => { await app.close(); db.close(); });
  const base = { host: "127.0.0.1:3000", origin: config.baseURL }, headers = [];
  for (const user of users) {
    const login = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: base, payload: { email: user.email, password } }); assert.equal(login.statusCode, 200);
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = (await app.inject({ url: "/api/auth/get-session", headers: { ...base, cookie } })).json().session.id as string;
    headers.push({ ...base, cookie, "x-loopshelf-session": session });
  }
  const url = "/api/catalog/tracks?q=Synthetic&offset=1&limit=12";
  for (const own of headers) {
    const response = await app.inject({ url, headers: own }); assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.headers["x-loopshelf-session"], own["x-loopshelf-session"]);
    assert.deepEqual(response.json().items, referenceItems(referenceTracks(db, "Synthetic").slice(1, 13)));
  }
  assert.equal((await app.inject({ url, headers: base })).statusCode, 401);
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  const blocker = withDatabase(db, async () => { await hold; db.prepare("UPDATE source_entity SET availability='blocked' WHERE id=?").run(saved[0]!.sourceEntityId); });
  const pending = app.inject({ url, headers: headers[0]! }); await immediate(); release(); await blocker;
  const response = await pending; assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items, referenceItems(referenceTracks(db, "Synthetic").slice(1, 13)));
  db.prepare("DELETE FROM session WHERE id=?").run(headers[0]!["x-loopshelf-session"]);
  assert.equal((await app.inject({ url, headers: headers[0]! })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: headers[1]! })).statusCode, 200);
});

test("offset SQL probe remains disposable and reports exact baseline comparisons without installing experimental indexes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-offset-probe-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "report.json"), result = spawnSync(process.execPath, ["scripts/bench-catalog-offset-plans.ts", "--albums", "20", "--samples", "3", "--output", output], { encoding: "utf8", env: { ...process.env, TMPDIR: dir }, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output, "utf8")); assert.equal(report.method.preliminary, true); assert.equal(report.measurements.length, 12);
  assert.equal(report.measurements.at(-1).name, "materialized-search");
  for (const row of report.measurements) { assert.equal(row.samplesMs.length, 3); assert.ok(row.plan.length); }
  assert.deepEqual(readdirSync(dir), ["report.json"]);
});
