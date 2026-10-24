import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate, assertMigrated } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { withDatabase } from "../src/database/access.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogError } from "../src/catalog/input.ts";
import { REMOVED_ALBUM_TITLE, REMOVED_TRACK_TITLE } from "../src/catalog/removal.ts";
import { BookmarkStore } from "../src/library/bookmarks.ts";
import { inspectCapturedPage } from "../src/sources/parsers.ts";
import type { AlbumDetail, ParseResult } from "../src/sources/types.ts";

function sample(kind: "album" | "search" = "album") {
  const result = inspectCapturedPage({ sourceId: "zophar", kind, status: 200, sampleKind: "synthetic", capturedAt: "2026-10-18T14:00:00Z",
    url: kind === "album" ? "https://www.zophar.net/music/nintendo-snes-spc/sample.html" : "https://www.zophar.net/search?search=sample",
    html: readFileSync(new URL(`./fixtures/zophar-${kind}.html`, import.meta.url), "utf8"), headers: { "content-type": "text/html" } });
  assert.ok(result.ok); return result;
}
function detail() { return sample() as Extract<ParseResult, { ok: true }> & { data: AlbumDetail }; }
function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  return { db, store: new CatalogStore(db) };
}
const hasCode = (code: CatalogError["code"]) => (error: unknown) => error instanceof CatalogError && error.code === code;
const remove = (sourceEntityId: string) => ({ sourceEntityId, reason: "rights_request" });
const rows = (db: Database.Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const tables = ["entity", "album", "track", "source_entity", "source_url_history", "catalog_observation", "catalog_album_state",
  "catalog_track_origin", "assertion", "library_item", "user_source_link", "catalog_removal"];
const snapshot = (db: Database.Database) => tables.map((table) => rows(db, table));
function addPrivateData(db: Database.Database, albumId: string, trackId: string, sourceId: string) {
  for (const index of [1, 2]) {
    const user = randomUUID();
    db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)')
      .run(user, "Test", `removal-${index}@example.test`, "now", "now");
    for (const entityId of [albumId, trackId])
      db.prepare("INSERT INTO library_item(id,user_id,entity_id,title_override,note,favorite,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)")
        .run(randomUUID(), user, entityId, "내 제목", "내 메모", "now", "now");
    const bookmark = new BookmarkStore(db).create(user, { title: "개인 북마크", url: detail().data.pageUrl, note: "직접 입력한 내용" }).item;
    db.prepare("INSERT INTO user_source_link VALUES (?,?,?,?)").run(user, bookmark.id, sourceId, "now");
  }
}

test("removal purges every source observation and adopted value, retaining IDs and both users' private content", async (t) => {
  const { db, store } = fixture(t), summaries = await store.ingestSynthetic(sample("search"));
  const [saved] = await store.ingestSynthetic(detail()), before = await store.getAlbum(saved!.albumId);
  const pending = detail(); pending.provenance.capturedAt = "2026-10-18T14:01:00Z"; pending.data.tracks[0]!.title = "Pending mix";
  await store.ingestSynthetic(pending);
  const other = await store.getAlbum(summaries[1]!.albumId);
  addPrivateData(db, before.id, before.tracks[1]!.id, before.sourceEntityId);
  db.prepare("UPDATE source_entity SET page_url=page_url || '?old-location' WHERE id=?").run(before.sourceEntityId);
  db.prepare("UPDATE source_entity SET page_url=? WHERE id=?").run(before.pageUrl, before.sourceEntityId);
  const privateTables = ["library_item", "bookmark", "bookmark_search", "user_source_link"];
  const personal = privateTables.map((table) => rows(db, table));
  const observations = db.prepare("SELECT id FROM catalog_observation WHERE source_entity_id=?").all(before.sourceEntityId) as { id: string }[];
  assert.equal(observations.length, 3);
  const receipt = await store.removeSource(remove(before.sourceEntityId));
  assert.equal(receipt.removed, true); assert.equal(receipt.albumId, before.id);
  const after = await store.getAlbum(before.id);
  assert.equal(after.contentState, "removed"); assert.equal(after.availability, "removed");
  assert.equal(after.title, REMOVED_ALBUM_TITLE); assert.deepEqual(after.tracks, []);
  assert.equal(after.latestObservationId, null); assert.equal(after.titleObservationId, null);
  assert.equal(after.latestDetailObservationId, null); assert.equal(after.tracksObservationId, null);
  assert.deepEqual(privateTables.map((table) => rows(db, table)), personal);
  assert.deepEqual(await store.getAlbum(other.id), other);
  for (const { id } of observations) await assert.rejects(store.getObservation(id), hasCode("not_found"));
  for (const table of ["catalog_album_state", "catalog_observation", "assertion", "source_url_history"])
    assert.equal(db.prepare<[string], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE source_entity_id=?`).get(before.sourceEntityId)!.n, 0);
  assert.equal(db.prepare<[], { n: number }>("SELECT count(*) AS n FROM catalog_track_origin").get()!.n, 0);
  assert.deepEqual(db.prepare("SELECT title,album_kind,release_date,catalog_number FROM album WHERE id=?").get(before.id),
    { title: REMOVED_ALBUM_TITLE, album_kind: null, release_date: null, catalog_number: null });
  const tracks = db.prepare("SELECT id,position,title,disc_label,track_label,duration_ms,recording_id FROM track WHERE album_id=? ORDER BY position").all(before.id);
  assert.deepEqual(tracks, before.tracks.map((track) => ({ id: track.id, position: track.position, title: REMOVED_TRACK_TITLE,
    disc_label: null, track_label: null, duration_ms: null, recording_id: null })));
  for (const id of [before.id, ...before.tracks.map((track) => track.id)])
    assert.equal((db.prepare("SELECT lifecycle FROM entity WHERE id=?").get(id) as { lifecycle: string }).lifecycle, "unavailable");
  assert.deepEqual(db.prepare("SELECT fetched_at,parser_version FROM source_entity WHERE id=?").get(before.sourceEntityId), { fetched_at: null, parser_version: null });
  verifyDatabase(db);
});

test("removal is idempotent and both old retries and new captures stay suppressed", async (t) => {
  const { db, store } = fixture(t), [saved] = await store.ingestSynthetic(detail());
  const receipt = await store.removeSource(remove(saved!.sourceEntityId));
  const expected = snapshot(db);
  assert.deepEqual(await store.removeSource({ sourceEntityId: saved!.sourceEntityId, reason: "policy_change" }), { ...receipt, removed: false });
  const next = detail(); next.provenance.capturedAt = "2026-10-18T15:00:00Z";
  for (const input of [detail(), next, sample("search")])
    await assert.rejects(store.ingestSynthetic(input), hasCode("source_suppressed"));
  assert.deepEqual(snapshot(db), expected);
});

test("a search-only album can be removed without allocating tracks or erasing other search results", async (t) => {
  const { db, store } = fixture(t), [first, second] = await store.ingestSynthetic(sample("search"));
  const other = await store.getObservation(second!.observationId);
  await store.removeSource({ sourceEntityId: first!.sourceEntityId, reason: "policy_change" });
  assert.equal((await store.getAlbum(first!.albumId)).trackState, "removed");
  assert.deepEqual(await store.getObservation(second!.observationId), other);
  assert.equal(rows(db, "track").length, 0);
});

test("a mid-removal failure rolls back receipt, evidence, canonical metadata and private data together", async (t) => {
  const { db, store } = fixture(t), [saved] = await store.ingestSynthetic(detail()), album = await store.getAlbum(saved!.albumId);
  addPrivateData(db, album.id, album.tracks[0]!.id, album.sourceEntityId);
  const before = snapshot(db);
  db.exec("CREATE TRIGGER fail_removal BEFORE UPDATE ON track BEGIN SELECT RAISE(ABORT,'injected removal failure'); END");
  await assert.rejects(store.removeSource(remove(album.sourceEntityId)), /injected removal failure/);
  assert.deepEqual(snapshot(db), before); assert.deepEqual(await store.getAlbum(album.id), album);
  db.exec("DROP TRIGGER fail_removal");
  assert.equal((await store.removeSource(remove(album.sourceEntityId))).removed, true);
});

test("invalid, unknown and unmanaged removal targets leave the catalog intact", async (t) => {
  const { db, store } = fixture(t); await store.ingestSynthetic(detail());
  const unmanaged = randomUUID();
  db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,page_url) VALUES (?,'zophar','album','unmanaged','https://www.zophar.net/music/snes/unmanaged.html')").run(unmanaged);
  const before = snapshot(db);
  for (const invalid of [null, {}, remove("not-uuid"), { sourceEntityId: unmanaged, reason: "other" }, { ...remove(unmanaged), userId: randomUUID() }])
    await assert.rejects(store.removeSource(invalid), hasCode("invalid_input"));
  await assert.rejects(store.removeSource(remove(randomUUID())), hasCode("not_found"));
  await assert.rejects(store.removeSource(remove(unmanaged)), hasCode("unmanaged_source"));
  assert.deepEqual(snapshot(db), before);
});

test("shared mappings, curated claims and unmanaged tracks require review without partial removal", async (t) => {
  const { db, store } = fixture(t), [saved] = await store.ingestSynthetic(detail());
  const albumId = saved!.albumId, sourceId = saved!.sourceEntityId;
  const cases = [
    () => db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,entity_id,page_url) VALUES (?,'khinsider','album','other',?,'https://downloads.khinsider.com/game-soundtracks/album/other')").run(randomUUID(), albumId),
    () => db.prepare("INSERT INTO assertion(id,entity_id,field,value_json,observed_at,method) VALUES (?,?,'title','\"Curated title\"','now','curated')").run(randomUUID(), albumId),
    () => db.prepare("INSERT INTO assertion(id,entity_id,source_entity_id,field,value_json,observed_at,method) VALUES (?,?,?,'title','\"Manually sourced\"','now','source')").run(randomUUID(), albumId, sourceId),
    () => db.prepare("UPDATE album SET catalog_number='MANUAL-1' WHERE id=?").run(albumId),
    () => { const id = randomUUID(); db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'track','now')").run(id);
      db.prepare("INSERT INTO track(id,album_id,position,title) VALUES (?,?,50,'Manual track')").run(id, albumId); },
    () => { const id = randomUUID(); db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'game','now')").run(id);
      db.prepare("INSERT INTO game(id,title) VALUES (?,'Manual game')").run(id);
      db.prepare("INSERT INTO album_game VALUES (?,?)").run(albumId, id); },
  ];
  for (const setup of cases) {
    db.exec("SAVEPOINT conflict_fixture"); setup();
    const before = snapshot(db);
    await assert.rejects(store.removeSource(remove(sourceId)), hasCode("removal_conflict"));
    assert.deepEqual(snapshot(db), before);
    db.exec("ROLLBACK TO conflict_fixture; RELEASE conflict_fixture");
  }
  assert.equal((await store.removeSource(remove(sourceId))).removed, true);
});

test("SQL guards retain tombstones and track IDs and reject observation or metadata resurrection", async (t) => {
  const { db, store } = fixture(t), [saved] = await store.ingestSynthetic(detail()), album = await store.getAlbum(saved!.albumId);
  const observation = db.prepare("SELECT * FROM catalog_observation WHERE id=?").get(saved!.observationId) as Record<string, string | null>;
  const state = db.prepare("SELECT * FROM catalog_album_state WHERE album_id=?").get(album.id) as Record<string, string | null>;
  await store.removeSource(remove(album.sourceEntityId));
  for (const sql of [
    "DELETE FROM catalog_removal", "UPDATE catalog_removal SET reason='policy_change'",
    "UPDATE source_entity SET availability='available'", "UPDATE source_entity SET external_key='renamed'",
    "UPDATE source_entity SET page_url='https://www.zophar.net/music/snes/other.html'",
    "UPDATE album SET title='Restored original'", "UPDATE track SET duration_ms=12345", "UPDATE entity SET lifecycle='active'",
    "DELETE FROM track",
  ]) assert.throws(() => db.exec(sql), /immutable|cannot|retained/);
  for (const [table, row] of [["catalog_observation", observation], ["catalog_album_state", state]] as const)
    assert.throws(() => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(",")})`).run(row), /Removed source/);
  assert.throws(() => db.prepare("INSERT INTO assertion(id,entity_id,source_entity_id,field,value_json,observed_at,method) VALUES (?,?,?,'title','\"Restored\"','now','source')")
    .run(randomUUID(), album.id, album.sourceEntityId), /Removed content/);
  assert.throws(() => db.prepare("INSERT INTO source_url_history(source_entity_id,previous_url,changed_at) VALUES (?,'old-url','now')").run(album.sourceEntityId), /Removed source/);
  // Removing source content does not freeze allowed personal edits.
  addPrivateData(db, album.id, album.tracks[0]!.id, album.sourceEntityId);
  db.exec("UPDATE library_item SET note='수정한 개인 메모',favorite=0");
  verifyDatabase(db);
});

test("removal serializes with ingestion and simultaneous retries through the shared async boundary", async (t) => {
  const { db, store } = fixture(t), [saved] = await store.ingestSynthetic(detail());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const occupied = withDatabase(db, async () => { await gate; });
  const next = detail(); next.provenance.capturedAt = "2026-10-18T15:00:00Z";
  const ingestion = store.ingestSynthetic(next);
  const removals = [store.removeSource(remove(saved!.sourceEntityId)), store.removeSource(remove(saved!.sourceEntityId))];
  const rejectedIngest = assert.rejects(store.ingestSynthetic(detail()), hasCode("source_suppressed"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rows(db, "catalog_removal").length, 0); assert.equal(rows(db, "catalog_observation").length, 1);
  release(); await occupied; await ingestion;
  const receipts = await Promise.all(removals); await rejectedIngest;
  assert.deepEqual(receipts.map((receipt) => receipt.removed), [true, false]);
  assert.equal(rows(db, "catalog_observation").length, 0);
});

test("0007 preserves existing 0006 catalog and private rows, and post-removal backups retain suppression", async (t) => {
  const { db: seed, store: seedStore } = fixture(t), [saved] = await seedStore.ingestSynthetic(detail()), album = await seedStore.getAlbum(saved!.albumId);
  addPrivateData(seed, album.id, album.tracks[0]!.id, album.sourceEntityId);
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-removal-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "old.sqlite"), db = openDatabase(path); t.after(() => { if (db.open) db.close(); });
  migrate(db, loadMigrations().slice(0, 6));
  const copiedTables = ["user", "entity", "album", "track", "source_entity", "catalog_observation", "catalog_album_state", "catalog_track_origin", "assertion", "bookmark", "library_item", "user_source_link"];
  // Copy and compare only columns present in the historical schema.
  const columns = new Map(copiedTables.map((table) => [table, (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name)]));
  for (const table of copiedTables) for (const original of rows(seed, table) as Record<string, string | number | null>[]) {
    const keys = columns.get(table)!, row = Object.fromEntries(keys.map((key) => [key, original[key]]));
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((key) => `@${key}`).join(",")})`).run(row);
  }
  const historical = () => copiedTables.map((table) => db.prepare(`SELECT ${columns.get(table)!.join(",")} FROM ${table} ORDER BY rowid`).all());
  const before = historical(); migrate(db); assertMigrated(db);
  assert.deepEqual(historical(), before);
  const store = new CatalogStore(db); assert.deepEqual(await store.getAlbum(album.id), album);
  await store.removeSource(remove(album.sourceEntityId));
  const expected = snapshot(db), snapshotPath = join(directory, "snapshot.sqlite"), restoredPath = join(directory, "restored.sqlite");
  await backupDatabase(db, snapshotPath); await restoreDatabase(snapshotPath, restoredPath);
  db.close();
  for (const reopenedPath of [path, restoredPath]) {
    const reopened = openDatabase(reopenedPath);
    try {
      assertMigrated(reopened); verifyDatabase(reopened); assert.deepEqual(snapshot(reopened), expected);
      const copy = new CatalogStore(reopened);
      assert.equal((await copy.getAlbum(album.id)).contentState, "removed");
      await assert.rejects(copy.ingestSynthetic(detail()), hasCode("source_suppressed"));
    } finally { reopened.close(); }
  }
});

test("operator CLI removes only the named source, reports an ID-only receipt and refuses invalid or missing targets", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-removal-cli-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "main.sqlite"), db = openDatabase(path); migrate(db);
  const [saved] = await new CatalogStore(db).ingestSynthetic(detail()); db.close();
  const run = (args: string[], database = path) => spawnSync(process.execPath, ["scripts/catalog.ts", "remove", ...args],
    { env: { ...process.env, DATABASE_PATH: database }, encoding: "utf8", timeout: 15000 });
  const args = ["--source-entity-id", saved!.sourceEntityId, "--reason", "rights_request"];
  assert.equal(run([]).status, 1);
  assert.match(run(["--source-entity-id", saved!.sourceEntityId, "--reason", "invalid"]).stderr, /invalid_input/);
  const first = run(args); assert.equal(first.status, 0, first.stderr);
  const receipt = JSON.parse(first.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(receipt).sort(), ["albumId", "reason", "removed", "removedAt", "sourceEntityId"]);
  assert.equal(receipt.removed, true); assert.equal(receipt.albumId, saved!.albumId);
  const second = run(args); assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { ...receipt, removed: false });
  const missing = join(directory, "missing.sqlite");
  assert.match(run(args, missing).stderr, /does not exist/); assert.equal(existsSync(missing), false);
});
