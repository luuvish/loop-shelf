import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database/connection.ts";
import { assertMigrated, loadMigrations, migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { withDatabase } from "../src/database/access.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogError, type CatalogInput } from "../src/catalog/input.ts";
import { CatalogBrowseStore } from "../src/catalog/browse.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { CatalogTransfer } from "../src/library/catalog-transfer.ts";
import { TransferError } from "../src/library/transfer.ts";
import { attachSyntheticRetention, reconcileCatalogRetention, EXPIRED_ALBUM_TITLE, EXPIRED_TRACK_TITLE } from "../src/catalog/retention.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";

const code = (value: CatalogError["code"]) => (error: unknown) => error instanceof CatalogError && error.code === value;
const rows = (db: Database.Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const secret = "retention-test-only-secret-at-least-32-characters";
function database(t: TestContext, version = loadMigrations().length) {
  const db = openDatabase(":memory:"); migrate(db, loadMigrations().slice(0, version)); t.after(() => db.close());
  const userId = randomUUID(), otherId = randomUUID();
  for (const id of [userId, otherId]) db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,\'Test\',?,0,\'now\',\'now\')').run(id, `${id}@example.test`);
  return { db, userId, otherId, store: new CatalogStore(db), library: new CatalogLibraryStore(db), browse: new CatalogBrowseStore(db), transfer: new CatalogTransfer(db, secret) };
}
function input(offset = 0, index = 1): CatalogInput {
  const value = syntheticAlbum(index, 3);
  value.provenance.capturedAt = new Date(Date.now() - 60000 + offset).toISOString();
  value.provenance.parsedAt = value.provenance.capturedAt;
  value.warnings = ["synthetic private capture warning"];
  return value;
}
async function retained(f: ReturnType<typeof database>, value = input(), ttl = 3600000) {
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  const result = await withDatabase(f.db, async () => f.db.transaction(() => f.store.ingestRetainedSyntheticInTransaction(value,
    { policyRevision: "offline-retention-v1", expiresAt })).immediate());
  return { value, expiresAt, saved: result[0]!, album: await f.store.getAlbum(result[0]!.albumId) };
}
const expire = (db: Database.Database, at: string) => withDatabase(db, async () => reconcileCatalogRetention(db, Date.parse(at)));

test("expiry erases external text and claims, but preserves identity, private contents, versions and links", async (t) => {
  const f = database(t), first = await retained(f), second = await retained(f, input(0, 3), 7200000);
  const albumSave = f.library.create(f.userId, { entityId: first.album.id, note: "내 기록", favorite: true }).item;
  const linked = f.library.connect(f.userId, albumSave.id, { version: albumSave.version, sourceEntityId: second.album.sourceEntityId });
  const trackSave = f.library.create(f.userId, { entityId: first.album.tracks[0]!.id, titleOverride: "개인 제목", note: "내 곡" }).item;
  const before = rows(f.db, "library_item"), links = rows(f.db, "user_source_link");
  assert.equal(await expire(f.db, first.expiresAt), 1);
  assert.deepEqual(rows(f.db, "library_item"), before); assert.deepEqual(rows(f.db, "user_source_link"), links);
  const saved = f.library.get(f.userId, linked.id), track = f.library.get(f.userId, trackSave.id);
  assert.equal(saved.title, EXPIRED_ALBUM_TITLE); assert.equal(saved.note, "내 기록"); assert.equal(saved.favorite, true);
  assert.equal(saved.entity.contentState, "expired"); assert.equal(saved.entity.id, first.album.id);
  assert.equal(track.title, "개인 제목"); assert.equal(track.entity.title, EXPIRED_TRACK_TITLE);
  assert.equal(track.entity.durationMs, null); assert.equal(track.entity.position, null); assert.equal(track.version, trackSave.version);
  const observation = f.db.prepare("SELECT data_json,warnings_json,content_state FROM catalog_observation WHERE id=?").get(first.saved.observationId);
  assert.deepEqual(observation, { data_json: "{}", warnings_json: "[]", content_state: "expired" });
  assert.equal(f.db.prepare("SELECT 1 FROM assertion WHERE observation_id=?").get(first.saved.observationId), undefined);
  assert.ok((rows(f.db, "catalog_track_origin") as { observation_id: string; snapshot_locator: string; track_id: string }[])
    .filter((row) => row.observation_id === first.saved.observationId).every((row) => row.snapshot_locator === row.track_id));
  assert.equal(f.library.list(f.userId, { q: first.album.title }).items.length, 0);
  assert.equal(f.browse.list(f.userId, { q: first.album.title }).items.length, 0);
  assert.throws(() => f.browse.detail(f.userId, first.album.id, {}));
  assert.throws(() => f.library.create(f.otherId, { entityId: first.album.id }));
  assert.deepEqual(f.library.connect(f.userId, linked.id, { version: linked.version, sourceEntityId: second.album.sourceEntityId }), saved);
  const edited = f.library.update(f.userId, linked.id, { version: linked.version, note: "수정한 개인 기록" });
  const disconnected = f.library.disconnect(f.userId, linked.id, { version: edited.version, sourceEntityId: second.album.sourceEntityId });
  assert.throws(() => f.library.connect(f.userId, linked.id, { version: disconnected.version, sourceEntityId: second.album.sourceEntityId }));
  f.library.delete(f.userId, linked.id, { version: disconnected.version });
  await assert.rejects(f.store.getObservation(first.saved.observationId), code("content_expired"));
  await assert.rejects(f.store.getAlbum(first.album.id), code("content_expired"));
  verifyDatabase(f.db);
});

test("fresh capture preserves album ID but identical keyless tracks after expiry require explicit adoption", async (t) => {
  const f = database(t), first = await retained(f), saved = f.library.create(f.userId, { entityId: first.album.tracks[0]!.id }).item;
  await expire(f.db, first.expiresAt);
  await assert.rejects(f.store.ingestSynthetic(first.value), code("content_expired"));
  const fresh = structuredClone(first.value); fresh.provenance.capturedAt = new Date(Date.parse(first.value.provenance.capturedAt) + 1000).toISOString();
  const next = await retained(f, fresh);
  assert.equal(next.album.id, first.album.id); assert.equal(next.album.trackState, "review_required"); assert.deepEqual(next.album.tracks, []);
  assert.equal(f.library.get(f.userId, saved.id).entity.contentState, "expired");
  const review = await f.store.getTrackReview(first.album.id);
  const plan = { requestId: randomUUID(), albumId: first.album.id, expectedTracksObservationId: review.expectedTracksObservationId,
    observationId: review.observationId, assignments: first.album.tracks.map((row, i) => ({ position: i + 1, trackId: row.id })), missingTrackIds: [] };
  await f.store.adoptTrackList(plan);
  const adopted = await f.store.getAlbum(first.album.id);
  assert.deepEqual(adopted.tracks.map((row) => row.id), first.album.tracks.map((row) => row.id));
  assert.ok(adopted.tracks.every((row) => row.originObservationId === first.saved.observationId));
  assert.equal(f.library.get(f.userId, saved.id).entity.contentState, "active");
  await expire(f.db, next.expiresAt);
  await assert.rejects(f.store.adoptTrackList(plan), code("content_expired"));
});

test("expiry uses the actually adopted metadata, preserving fresh reused tracks and redacting missing tracks", async (t) => {
  const f = database(t), first = await retained(f);
  const fresh = structuredClone(first.value); fresh.provenance.capturedAt = new Date(Date.parse(first.value.provenance.capturedAt) + 1000).toISOString();
  assert.equal(fresh.data.kind, "album"); if (fresh.data.kind !== "album") throw new Error();
  fresh.data.tracks = fresh.data.tracks.slice(0, 2); fresh.data.tracks[0]!.title = "Fresh adopted title";
  const next = await retained(f, fresh, 7200000);
  await f.store.adoptTrackList({ requestId: randomUUID(), albumId: first.album.id, expectedTracksObservationId: first.saved.observationId,
    observationId: next.saved.observationId, assignments: first.album.tracks.slice(0, 2).map((row, i) => ({ position: i + 1, trackId: row.id })), missingTrackIds: [first.album.tracks[2]!.id] });
  await expire(f.db, first.expiresAt);
  assert.equal((await f.store.getAlbum(first.album.id)).tracks[0]!.title, "Fresh adopted title");
  assert.deepEqual(f.db.prepare("SELECT title,duration_ms FROM track WHERE id=?").get(first.album.tracks[2]!.id), { title: EXPIRED_TRACK_TITLE, duration_ms: null });
  await expire(f.db, next.expiresAt);
  assert.equal((f.db.prepare("SELECT title FROM track WHERE id=?").get(first.album.tracks[0]!.id) as { title: string }).title, EXPIRED_TRACK_TITLE);
});

test("leases are validated, immutable on retry, and invalid attachment rolls back every catalog row", async (t) => {
  const f = database(t), value = input();
  for (const expiresAt of ["invalid", value.provenance.capturedAt, new Date(Date.now() + 31 * 86400000).toISOString()]) {
    await assert.rejects(withDatabase(f.db, async () => f.db.transaction(() => f.store.ingestRetainedSyntheticInTransaction(value,
      { policyRevision: "v1", expiresAt })).immediate()), code("invalid_input"));
    assert.deepEqual(rows(f.db, "album"), []); assert.deepEqual(rows(f.db, "catalog_source_kind"), []);
  }
  const first = await retained(f, value);
  await withDatabase(f.db, async () => f.db.transaction(() => {
    attachSyntheticRetention(f.db, first.saved.observationId, "offline-retention-v1", first.expiresAt);
    assert.throws(() => attachSyntheticRetention(f.db, first.saved.observationId, "new-policy", first.expiresAt), code("retention_conflict"));
    assert.throws(() => attachSyntheticRetention(f.db, first.saved.observationId, "offline-retention-v1", new Date(Date.parse(first.expiresAt) + 1).toISOString()), code("retention_conflict"));
  }).immediate());
  assert.throws(() => f.db.exec("UPDATE catalog_observation SET expires_at=NULL,retention_revision=NULL"), /immutable/);
  await expire(f.db, first.expiresAt);
  assert.throws(() => f.db.exec("UPDATE catalog_observation SET content_state='active'"), /immutable/);
  assert.throws(() => f.db.exec("UPDATE catalog_observation SET data_json='{\"title\":\"revived\"}'"), /retain metadata|CHECK/);
});

test("expiry is not a removal tombstone, but explicit rights removal still prevents recapture", async (t) => {
  const f = database(t), first = await retained(f);
  await expire(f.db, first.expiresAt); assert.deepEqual(rows(f.db, "catalog_removal"), []);
  const id = f.library.create(f.userId, { entityId: (await retained(f, input(0, 3))).album.id }).item.id;
  await f.store.removeSource({ sourceEntityId: first.saved.sourceEntityId, reason: "rights_request" });
  assert.equal((await f.store.getAlbum(first.album.id)).contentState, "removed");
  assert.equal(rows(f.db, "catalog_source_kind").length, 2);
  await assert.rejects(f.store.ingestSynthetic(input(1000)), code("source_suppressed"));
  assert.equal(f.library.get(f.userId, id).entity.contentState, "active"); verifyDatabase(f.db);
});

test("expiry refuses to erase shared/manual claims and rolls back earlier redactions in the batch", async (t) => {
  const f = database(t), first = await retained(f), second = await retained(f, input(0, 3));
  f.db.prepare("INSERT INTO assertion(id,entity_id,field,value_json,observed_at,method) VALUES (?,?,'title','\"manual\"','now','curated')").run(randomUUID(), second.album.id);
  const before = rows(f.db, "catalog_observation");
  await assert.rejects(expire(f.db, second.expiresAt), code("removal_conflict"));
  assert.deepEqual(rows(f.db, "catalog_observation"), before);
  await assert.rejects(withDatabase(f.db, async () => reconcileCatalogRetention(f.db, NaN)), code("invalid_input"));
  assert.equal((await f.store.getAlbum(first.album.id)).title, first.album.title);
});

test("private JSON remains minimal; expiry invalidates previews, and restored private IDs stay expired", async (t) => {
  const f = database(t), first = await retained(f), item = f.library.create(f.userId, { entityId: first.album.id, note: "personal only" }).item;
  const archive = f.transfer.export(f.userId), token = f.transfer.preview(f.userId, archive).token!;
  await expire(f.db, first.expiresAt);
  assert.throws(() => f.transfer.import(f.userId, archive, token), (e) => e instanceof TransferError && e.code === "preview_stale");
  assert.deepEqual(f.transfer.export(f.userId).items, archive.items);
  assert.ok(!JSON.stringify(archive).includes(first.album.title));
  f.library.delete(f.userId, item.id, { version: item.version });
  f.transfer.import(f.userId, archive, f.transfer.preview(f.userId, archive).token!);
  const restored = f.library.get(f.userId, item.id);
  assert.equal(restored.entity.id, first.album.id); assert.equal(restored.entity.contentState, "expired"); assert.equal(restored.note, item.note);
  assert.ok(restored.version > item.version); assert.equal(restored.title, EXPIRED_ALBUM_TITLE);
});

test("0012 upgrades adopted/missing tracks, private IDs and tombstones; failed migration rolls back fully", async (t) => {
  const f = database(t, 11), [first] = await f.store.ingestSynthetic(input()), original = await f.store.getAlbum(first!.albumId);
  f.library.create(f.userId, { entityId: original.tracks[2]!.id, note: "missing identity" });
  const fresh = input(1000); if (fresh.data.kind !== "album") throw new Error(); fresh.data.tracks = fresh.data.tracks.slice(0, 2);
  const [next] = await f.store.ingestSynthetic(fresh);
  await f.store.adoptTrackList({ requestId: randomUUID(), albumId: original.id, expectedTracksObservationId: first!.observationId, observationId: next!.observationId,
    assignments: original.tracks.slice(0, 2).map((row, i) => ({ position: i + 1, trackId: row.id })), missingTrackIds: [original.tracks[2]!.id] });
  const [removed] = await f.store.ingestSynthetic(input(0, 3)); await f.store.removeSource({ sourceEntityId: removed!.sourceEntityId, reason: "rights_request" });
  const tables = ["entity", "track", "album", "source_entity", "catalog_album_state", "catalog_track_origin", "catalog_track_binding", "catalog_track_adoption", "assertion", "library_item", "catalog_removal", "schema_migration"];
  const before = tables.map((table) => rows(f.db, table)), obs = rows(f.db, "catalog_observation");
  const migrations = loadMigrations(), last = migrations.at(-1)!;
  assert.throws(() => migrate(f.db, [...migrations.slice(0, -1), { ...last, sql: `${last.sql}\nSELECT fail_migration();` }]));
  assert.deepEqual(tables.map((table) => rows(f.db, table)), before); assert.deepEqual(rows(f.db, "catalog_observation"), obs);
  migrate(f.db); assertMigrated(f.db); verifyDatabase(f.db);
  assert.deepEqual(tables.slice(0, -1).map((table) => rows(f.db, table)), before.slice(0, -1));
  const restored = rows(f.db, "catalog_observation") as Record<string, unknown>[];
  assert.deepEqual(restored.map(({ retention_revision, expires_at, content_state, ...row }) => {
    assert.equal(retention_revision, null); assert.equal(expires_at, null); assert.equal(content_state, "active"); return row;
  }), obs);
  assert.equal(rows(f.db, "catalog_source_kind").length, 2);
});

test("backup and restore reconcile deadlines in the new copy, never modifying source or past snapshot", async (t) => {
  const f = database(t), first = await retained(f), saved = f.library.create(f.userId, { entityId: first.album.id, note: "preserve me" }).item;
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-retention-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const past = join(dir, "past.sqlite"), backup = join(dir, "expired.sqlite"), restored = join(dir, "restored.sqlite");
  await backupDatabase(f.db, past);
  t.mock.method(Date, "now", () => Date.parse(first.expiresAt));
  await backupDatabase(f.db, backup); await restoreDatabase(past, restored);
  assert.equal((f.db.prepare("SELECT content_state FROM catalog_observation").get() as { content_state: string }).content_state, "active");
  for (const path of [backup, restored]) {
    const copy = openDatabase(path);
    try { verifyDatabase(copy); assertMigrated(copy);
      const item = new CatalogLibraryStore(copy).get(f.userId, saved.id);
      assert.equal(item.entity.contentState, "expired"); assert.equal(item.note, saved.note); assert.equal(item.version, saved.version);
      assert.equal((copy.prepare("SELECT data_json FROM catalog_observation").get() as { data_json: string }).data_json, "{}");
    } finally { copy.close(); }
  }
  const unchanged = openDatabase(past); try { assert.equal((unchanged.prepare("SELECT content_state FROM catalog_observation").get() as { content_state: string }).content_state, "active"); } finally { unchanged.close(); }
  await assert.rejects(restoreDatabase(past, restored), /EEXIST/);
});

test("sample kind is frozen per source identity and synthetic ingestion never admits live DTOs", async (t) => {
  const f = database(t), first = await retained(f);
  assert.throws(() => f.db.exec("UPDATE catalog_source_kind SET sample_kind='live-capture'"), /immutable/);
  assert.throws(() => f.db.exec("DELETE FROM catalog_source_kind"), /survive removal/);
  assert.throws(() => f.db.prepare(`INSERT INTO catalog_observation(id,source_entity_id,kind,sample_kind,page_url,captured_at,parsed_at,parser_version,
    body_sha256,fingerprint,data_sha256,tracks_sha256,data_json,page_context_json,warnings_json,retention_revision,expires_at)
    SELECT ?,source_entity_id,kind,'live-capture',page_url,captured_at,parsed_at,parser_version,body_sha256,?,data_sha256,tracks_sha256,data_json,
      page_context_json,warnings_json,retention_revision,expires_at FROM catalog_observation WHERE id=?`).run(randomUUID(), "c".repeat(64), first.saved.observationId), /kind conflict/);
  assert.throws(() => f.db.exec("UPDATE catalog_observation SET sample_kind='live-capture'"), /immutable/);
  const live = structuredClone(first.value); live.provenance.sampleKind = "live-capture";
  await assert.rejects(f.store.ingestSynthetic(live), code("policy_disabled"));
  assert.equal(rows(f.db, "catalog_observation").length, 1);
});

test("simulated live rows require a lease and unknown product policy revokes them; private reads and v2 export preserve the kind", async (t) => {
  // Schema simulation only: no external capture, no policy injection and no product live writer.
  const f = database(t), value = input(), albumId = randomUUID(), sourceId = randomUUID(), observationId = randomUUID();
  if (value.data.kind !== "album") throw new Error();
  f.db.prepare("INSERT INTO entity VALUES (?,'album','active','now')").run(albumId);
  f.db.prepare("INSERT INTO album(id,title) VALUES (?,?)").run(albumId, value.data.title);
  f.db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,entity_id,page_url) VALUES (?,'zophar','album',?,?,?)")
    .run(sourceId, value.data.externalKey, albumId, value.data.pageUrl);
  const insert = f.db.prepare(`INSERT INTO catalog_observation(id,source_entity_id,kind,sample_kind,page_url,captured_at,parsed_at,parser_version,
    body_sha256,fingerprint,data_sha256,tracks_sha256,data_json,warnings_json,retention_revision,expires_at)
    VALUES (?,?,'album','live-capture',?,?,?,'schema-test',?,?,?,?,?,'[]',?,?)`);
  const args = [observationId, sourceId, value.data.pageUrl, value.provenance.capturedAt, value.provenance.parsedAt,
    ...Array.from({ length: 4 }, () => "f".repeat(64)), JSON.stringify(value.data)];
  assert.throws(() => insert.run(...args, null, null), /CHECK/);
  assert.deepEqual(rows(f.db, "catalog_source_kind"), []);
  insert.run(...args, "unrecognized-policy", new Date(Date.now() + 3600000).toISOString());
  f.db.prepare("INSERT INTO catalog_album_state VALUES (?,?,?,NULL,?,?,?)").run(albumId, sourceId, observationId, observationId, observationId, observationId);
  const id = randomUUID(); f.db.prepare("INSERT INTO library_item(id,user_id,entity_id,note,created_at,updated_at) VALUES (?,?,?,'preserved','now','now')").run(id, f.userId, albumId);
  assert.equal(await withDatabase(f.db, async () => reconcileCatalogRetention(f.db)), 1);
  assert.deepEqual(f.db.prepare("SELECT data_json,content_state FROM catalog_observation").get(), { data_json: "{}", content_state: "policy_revoked" });
  assert.deepEqual(f.browse.list(f.userId, {}).items, []);
  await assert.rejects(f.store.getAlbum(albumId), code("content_expired"));
  assert.equal(f.library.get(f.userId, id).entity.sampleKind, "live-capture");
  assert.equal(f.library.get(f.userId, id).entity.contentState, "expired");
  assert.equal(f.transfer.export(f.userId).items[0]!.reference.sampleKind, "live-capture");
  await assert.rejects(f.store.ingestSynthetic(value), code("sample_kind_conflict"));
  assert.equal((f.db.prepare("SELECT note FROM library_item WHERE id=?").get(id) as { note: string }).note, "preserved");
  await f.store.removeSource({ sourceEntityId: sourceId, reason: "policy_change" });
  assert.equal((rows(f.db, "catalog_source_kind")[0] as { sample_kind: string }).sample_kind, "live-capture");
  verifyDatabase(f.db);
});

test("expired latest adoption cannot fall back to an older still-retained track title", async (t) => {
  const f = database(t), first = await retained(f, input(), 7200000);
  const fresh = input(1000); if (fresh.data.kind !== "album") throw new Error(); fresh.data.tracks[0]!.title = "Newer canonical track";
  const next = await retained(f, fresh, 3600000);
  await f.store.adoptTrackList({ requestId: randomUUID(), albumId: first.album.id, expectedTracksObservationId: first.saved.observationId,
    observationId: next.saved.observationId, assignments: first.album.tracks.map((row, i) => ({ position: i + 1, trackId: row.id })), missingTrackIds: [] });
  const item = f.library.create(f.userId, { entityId: first.album.tracks[0]!.id }).item;
  await expire(f.db, next.expiresAt);
  assert.equal((await f.store.getObservation(first.saved.observationId)).data.title, first.album.title);
  assert.equal(f.library.get(f.userId, item.id).entity.title, EXPIRED_TRACK_TITLE);
  assert.equal(f.library.list(f.userId, { q: "Newer canonical track" }).items.length, 0);
});

test("new search summaries never replace expired detailed titles, and expired search context is erased", async (t) => {
  const f = database(t), first = await retained(f);
  await expire(f.db, first.expiresAt);
  const source = first.value.data; if (source.kind !== "album") throw new Error();
  const summary = { sourceId: source.sourceId, externalKey: source.externalKey, pageUrl: source.pageUrl, title: "New search display label",
    titleKind: "source-display-label" as const, platforms: source.platforms, sourceCategory: null, sourceYearLabel: null };
  const value: CatalogInput = { ...first.value, provenance: { ...first.value.provenance, pageUrl: "https://www.zophar.net/search?search=private-search",
    capturedAt: new Date(Date.parse(first.value.provenance.capturedAt) + 2000).toISOString() },
    data: { kind: "search", albums: [summary], reportedCount: 1, nextPageUrl: null, coverage: "reported-count-matches", resultLimit: null } };
  const [freshSummary] = await f.store.ingestSynthetic(value);
  await assert.rejects(f.store.getAlbum(first.album.id), code("content_expired"));
  assert.equal((f.db.prepare("SELECT title FROM album WHERE id=?").get(first.album.id) as { title: string }).title, EXPIRED_ALBUM_TITLE);
  const expiresAt = new Date(Date.now() + 1000).toISOString();
  await withDatabase(f.db, async () => f.db.transaction(() => attachSyntheticRetention(f.db, freshSummary!.observationId, "summary-test", expiresAt)).immediate());
  await expire(f.db, expiresAt);
  const row = f.db.prepare("SELECT data_json,page_context_json,warnings_json,page_url FROM catalog_observation WHERE id=?").get(freshSummary!.observationId) as Record<string, string>;
  assert.equal(row.data_json, "{}"); assert.equal(row.page_context_json, "{}"); assert.equal(row.warnings_json, "[]");
  assert.equal(row.page_url, source.pageUrl); assert.ok(!JSON.stringify(row).includes("private-search"));
});
