import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate, assertMigrated } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { withDatabase } from "../src/database/access.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogError, MAX_CATALOG_INPUT_BYTES } from "../src/catalog/input.ts";
import { BookmarkStore } from "../src/library/bookmarks.ts";
import { inspectCapturedPage } from "../src/sources/parsers.ts";
import { productAccess } from "../src/sources/policies.ts";
import type { AlbumDetail, CapturedPage, ParseResult } from "../src/sources/types.ts";

type Success = Extract<ParseResult, { ok: true }>;
function sample(kind: "album" | "search" = "album", sourceId: "zophar" | "khinsider" = "zophar"): Success {
  const page: CapturedPage = { sourceId, kind, status: 200, sampleKind: "synthetic", capturedAt: "2026-10-18T14:00:00Z",
    url: kind === "album" ? "https://www.zophar.net/music/nintendo-snes-spc/sample.html"
      : `https://${sourceId === "zophar" ? "www.zophar.net" : "downloads.khinsider.com"}/search?search=sample`,
    html: readFileSync(new URL(`./fixtures/${sourceId}-${kind}.html`, import.meta.url), "utf8"), headers: { "content-type": "text/html" } };
  const result = inspectCapturedPage(page); assert.ok(result.ok); return result;
}
function detail() {
  const result = sample(); assert.equal(result.data.kind, "album");
  return result as Success & { data: AlbumDetail };
}
function later<T extends Success>(value: T, minute = 1): T {
  const result = structuredClone(value);
  result.provenance.capturedAt = new Date(Date.parse(value.provenance.capturedAt) + minute * 60000).toISOString();
  return result;
}
function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  return { db, store: new CatalogStore(db) };
}
const hasCode = (code: CatalogError["code"]) => (error: unknown) => error instanceof CatalogError && error.code === code;
const catalogTables = ["entity", "album", "track", "source_entity", "assertion", "catalog_album_state", "catalog_observation", "catalog_track_origin"];

test("parser DTOs create separate provisional source albums, then detail upgrades the same album with provenance", async (t) => {
  const { db, store } = fixture(t);
  const kh = await store.ingestSynthetic(sample("search", "khinsider"));
  const zophar = await store.ingestSynthetic(sample("search"));
  assert.equal(new Set([...kh, ...zophar].map((row) => row.albumId)).size, 4);
  const before = await store.getAlbum(zophar[0]!.albumId);
  assert.equal(before.titleKind, "source-display-label"); assert.equal(before.trackState, "not_loaded");
  assert.deepEqual((await store.getObservation(zophar[0]!.observationId)).pageContext,
    { kind: "search", reportedCount: 2, coverage: "reported-count-matches", nextPageUrl: null, resultLimit: null });
  const parsed = detail();
  const [ingested] = await store.ingestSynthetic(parsed);
  assert.equal(ingested!.albumId, before.id); assert.equal(ingested!.sourceEntityId, before.sourceEntityId);
  const album = await store.getAlbum(before.id);
  assert.equal(album.title, parsed.data.title); assert.equal(album.titleKind, "album-title");
  assert.equal(album.identity, "source-provisional"); assert.equal(album.sampleKind, "synthetic");
  assert.equal(album.availability, "unverified"); assert.equal(album.trackState, "unchanged");
  assert.equal(album.tracks.length, 4); assert.equal(new Set(album.tracks.map((row) => row.id)).size, 4);
  assert.equal(album.tracks[1]!.displayNumber, album.tracks[2]!.displayNumber);
  assert.equal(album.tracks[2]!.durationMs, 81000); assert.equal(album.tracks[3]!.durationMs, null);
  assert.ok(album.tracks.every((row) => row.recordingId === null && row.discLabel === null));
  const observation = await store.getObservation(ingested!.observationId);
  assert.equal(observation.pageContext, null);
  assert.deepEqual(observation.data, parsed.data); assert.deepEqual(observation.warnings, parsed.warnings);
  assert.deepEqual(observation.provenance, { ...parsed.provenance, capturedAt: "2026-10-18T14:00:00.000Z" });
  const raw = db.prepare("SELECT value_json FROM assertion WHERE observation_id=? AND field='sourceClaims'").get(observation.id) as { value_json: string };
  assert.deepEqual(JSON.parse(raw.value_json), parsed.data.sourceClaims);
  const canonical = db.prepare("SELECT release_date,album_kind FROM album WHERE id=?").get(album.id);
  assert.deepEqual(canonical, { release_date: null, album_kind: null });
  for (const table of ["game", "musical_work", "recording", "library_item"])
    assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM source_entity WHERE external_kind='track'").get() as { n: number }).n, 0);
  assert.equal(productAccess("zophar", "cache").allowed, false);
  verifyDatabase(db);
});

test("retries ignore parse time; unchanged full lists keep UUIDs despite new captures and document locators", async (t) => {
  const { db, store } = fixture(t); const input = detail();
  const [first] = await store.ingestSynthetic(input), initial = await store.getAlbum(first!.albumId);
  const counts = () => catalogTables.map((table) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  const originalCounts = counts(), retry = structuredClone(input);
  retry.provenance.parsedAt = "2026-10-22T15:00:00Z";
  assert.deepEqual(await store.ingestSynthetic(retry), [{ ...first!, outcome: "duplicate" }]);
  assert.deepEqual(counts(), originalCounts);
  const next = later(input);
  next.data.title = "Updated album claim"; next.provenance.parserVersion = "fixture-next";
  next.data.tracks.forEach((row, index) => { row.snapshotLocator = `new-dom:${index}`; });
  const [second] = await store.ingestSynthetic(next), current = await store.getAlbum(initial.id);
  assert.notEqual(second!.observationId, first!.observationId);
  assert.equal(current.title, next.data.title); assert.equal(current.titleObservationId, second!.observationId);
  assert.equal(current.tracksObservationId, initial.tracksObservationId);
  assert.equal(current.latestDetailObservationId, second!.observationId);
  assert.equal(current.trackState, "unchanged"); assert.deepEqual(current.tracks, initial.tracks);
});

test("every changed keyless tracklist requires review without changing previously saved track identities", async (t) => {
  const { db, store } = fixture(t), input = detail();
  const [first] = await store.ingestSynthetic(input), initial = await store.getAlbum(first!.albumId);
  const user = randomUUID();
  db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)').run(user, "Test", "catalog@example.test", "now", "now");
  for (const entity of [initial.id, initial.tracks[1]!.id])
    db.prepare("INSERT INTO library_item(id,user_id,entity_id,title_override,note,favorite,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)")
      .run(randomUUID(), user, entity, "내 제목", "내 메모", "now", "now");
  const bookmark = new BookmarkStore(db).create(user, { title: "개인 북마크", url: input.data.pageUrl, note: "개인 내용" }).item;
  const privateRows = db.prepare("SELECT * FROM library_item ORDER BY id").all();
  const changes: ((data: AlbumDetail) => void)[] = [
    (data) => { [data.tracks[0], data.tracks[1]] = [data.tracks[1]!, data.tracks[0]!]; },
    (data) => { data.tracks.splice(1, 1); },
    (data) => { data.tracks.push({ ...data.tracks[0]!, snapshotLocator: "added" }); },
    (data) => { data.tracks[0]!.title = "Different mix"; },
    (data) => { data.tracks[0]!.durationSeconds = 0; },
    (data) => { data.tracks[0]!.displayNumber = "1"; },
  ];
  for (const [index, change] of changes.entries()) {
    const next = later(input, index + 1); change(next.data);
    next.data.tracks.forEach((row, i) => { row.position = i + 1; });
    const [saved] = await store.ingestSynthetic(next), current = await store.getAlbum(initial.id);
    assert.equal(current.trackState, "review_required"); assert.equal(current.latestDetailObservationId, saved!.observationId);
    assert.deepEqual(current.tracks, initial.tracks);
    assert.deepEqual((await store.getObservation(saved!.observationId)).data, next.data);
  }
  // A later observation exactly returning to the baseline no longer has a pending list difference.
  await store.ingestSynthetic(later(input, 10));
  assert.equal((await store.getAlbum(initial.id)).trackState, "unchanged");
  assert.deepEqual(db.prepare("SELECT * FROM library_item ORDER BY id").all(), privateRows);
  assert.deepEqual(new BookmarkStore(db).get(user, bookmark.id), bookmark);
});

test("duplicate identical track rows remain distinct UUIDs and unknown duration differs from zero", async (t) => {
  const { store } = fixture(t), input = detail();
  input.data.tracks = [1, 2, 3].map((position) => ({ ...input.data.tracks[0]!, position, snapshotLocator: `row:${position}`, durationSeconds: position === 3 ? null : 0 }));
  const [row] = await store.ingestSynthetic(input), album = await store.getAlbum(row!.albumId);
  assert.equal(new Set(album.tracks.map((track) => track.id)).size, 3);
  assert.deepEqual(album.tracks.map((track) => track.durationMs), [0, 0, null]);
});

test("late search results cannot downgrade detailed titles; old observations cannot roll back current heads", async (t) => {
  const { store } = fixture(t), input = detail();
  const [first] = await store.ingestSynthetic(input);
  const next = later(input, 3); next.data.title = "Latest detail";
  const [latest] = await store.ingestSynthetic(next);
  const old = later(input, 1); old.data.title = "Delayed old detail"; old.data.tracks.reverse().forEach((row, i) => { row.position = i + 1; });
  assert.equal((await store.ingestSynthetic(old))[0]!.outcome, "historical");
  const search = later(sample("search"), 5), [searchSaved] = await store.ingestSynthetic(search);
  const current = await store.getAlbum(first!.albumId);
  assert.equal(current.title, "Latest detail"); assert.equal(current.titleObservationId, latest!.observationId);
  assert.equal(current.latestObservationId, searchSaved!.observationId); assert.equal(current.trackState, "unchanged");
  const conflict = structuredClone(next); conflict.data.title = "Same-time disagreement";
  await assert.rejects(store.ingestSynthetic(conflict), hasCode("observation_conflict"));
  assert.deepEqual(await store.getAlbum(first!.albumId), current);
  const historicalConflict = structuredClone(old); historicalConflict.data.title = "Disagreeing old capture";
  await assert.rejects(store.ingestSynthetic(historicalConflict), hasCode("observation_conflict"));
});

test("detail can arrive after a newer summary; empty searches and parse failures never erase the catalog", async (t) => {
  const { store } = fixture(t);
  const [summary] = await store.ingestSynthetic(later(sample("search"), 5));
  const [saved] = await store.ingestSynthetic(detail()), before = await store.getAlbum(summary!.albumId);
  assert.equal(before.titleObservationId, saved!.observationId); assert.equal(before.latestObservationId, summary!.observationId);
  const empty = sample("search"); assert.ok(empty.data.kind === "search");
  empty.data.albums = []; empty.data.reportedCount = 0;
  assert.deepEqual(await store.ingestSynthetic(empty), []);
  await assert.rejects(store.ingestSynthetic({ ok: false, code: "parse_changed", message: "fixture", httpStatus: 200 }), hasCode("parse_failure"));
  assert.deepEqual(await store.getAlbum(before.id), before);
});

test("live captures, malformed or mismatched DTOs and unsafe references are rejected without writes", async (t) => {
  const { db, store } = fixture(t);
  const live = detail(); live.provenance.sampleKind = "live-capture";
  await assert.rejects(store.ingestSynthetic(live), hasCode("policy_disabled"));
  const mutations: ((input: ReturnType<typeof detail>) => void)[] = [
    (v) => { v.data.externalKey = "wrong"; }, (v) => { v.provenance.sourceId = "khinsider"; },
    (v) => { v.provenance.pageUrl = "https://www.zophar.net/music/snes/other.html"; },
    (v) => { v.data.pageUrl = "https://evil.test/music/snes/example.html"; },
    (v) => { v.data.tracks[0]!.position = 2; }, (v) => { v.data.tracks[1]!.snapshotLocator = v.data.tracks[0]!.snapshotLocator; },
    (v) => { v.data.tracks = []; }, (v) => { v.data.tracks[0]!.durationSeconds = -1; },
    (v) => { v.provenance.capturedAt = "not-a-date"; }, (v) => { v.provenance.bodySha256 = "bad"; },
  ];
  for (const mutate of mutations) { const invalid = detail(); mutate(invalid); await assert.rejects(store.ingestSynthetic(invalid), hasCode("invalid_input")); }
  await assert.rejects(store.ingestSynthetic({ ...detail(), html: "<script>forbidden input</script>" }), hasCode("invalid_input"));
  await assert.rejects(store.ingestSynthetic({ ...detail(), userId: randomUUID() }), hasCode("invalid_input"));
  await assert.rejects(store.ingestSynthetic({ huge: "x".repeat(MAX_CATALOG_INPUT_BYTES) }), hasCode("invalid_input"));
  for (const table of catalogTables) assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
});

test("an entire search page rolls back if one source is unmanaged; suppressed sources cannot be resurrected", async (t) => {
  const { db, store } = fixture(t), input = sample("search"); assert.ok(input.data.kind === "search");
  const existing = input.data.albums[1]!;
  db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,page_url) VALUES (?,?,'album',?,?)")
    .run(randomUUID(), existing.sourceId, existing.externalKey, existing.pageUrl);
  await assert.rejects(store.ingestSynthetic(input), hasCode("unmanaged_source"));
  assert.equal((db.prepare("SELECT count(*) AS n FROM album").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM catalog_observation").get() as { n: number }).n, 0);
  const [saved] = await store.ingestSynthetic(detail());
  for (const availability of ["blocked", "not_found", "removed"]) {
    db.prepare("UPDATE source_entity SET availability=? WHERE id=?").run(availability, saved!.sourceEntityId);
    await assert.rejects(store.ingestSynthetic(later(detail())), hasCode("source_suppressed"));
    assert.equal((await store.getAlbum(saved!.albumId)).availability, availability);
  }
});

test("write failures roll back observations, assertions, state and initial entities together", async (t) => {
  const { db, store } = fixture(t);
  db.exec("CREATE TRIGGER fail_track BEFORE INSERT ON track WHEN NEW.position=3 BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(store.ingestSynthetic(detail()), /injected failure/);
  for (const table of catalogTables) assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  db.exec("DROP TRIGGER fail_track");
  const [first] = await store.ingestSynthetic(detail()), before = await store.getAlbum(first!.albumId);
  db.exec("CREATE TRIGGER fail_assertion BEFORE INSERT ON assertion BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(store.ingestSynthetic(later(detail())), /injected failure/);
  assert.deepEqual(await store.getAlbum(first!.albumId), before);
  assert.equal((db.prepare("SELECT count(*) AS n FROM catalog_observation").get() as { n: number }).n, 1);
});

test("catalog work waits for the shared async DB boundary and concurrent retries allocate one identity", async (t) => {
  const { db, store } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const occupied = withDatabase(db, async () => { await gate; });
  const pending = Array.from({ length: 4 }, () => store.ingestSynthetic(detail()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((db.prepare("SELECT count(*) AS n FROM album").get() as { n: number }).n, 0);
  release(); await occupied;
  const results = (await Promise.all(pending)).flat();
  assert.equal(new Set(results.map((row) => row.albumId)).size, 1);
  assert.equal(results.filter((row) => row.outcome === "applied").length, 1);
});

test("SQL rejects cross-source evidence, kind confusion, source identity changes and unrelated track origins", async (t) => {
  const { db, store } = fixture(t);
  const [one] = await store.ingestSynthetic(detail()), [two] = await store.ingestSynthetic(sample("search", "khinsider"));
  assert.throws(() => db.prepare("UPDATE catalog_album_state SET title_observation_id=? WHERE album_id=?").run(two!.observationId, one!.albumId), /FOREIGN KEY/);
  assert.throws(() => db.prepare("UPDATE catalog_album_state SET detail_observation_id=? WHERE album_id=?").run(two!.observationId, two!.albumId), /kind mismatch/);
  assert.throws(() => db.prepare("UPDATE source_entity SET external_key='other' WHERE id=?").run(one!.sourceEntityId), /immutable/);
  assert.throws(() => db.prepare("UPDATE source_entity SET entity_id=? WHERE id=?").run(two!.albumId, one!.sourceEntityId), /immutable/);
  assert.throws(() => db.prepare("UPDATE assertion SET observation_id=? WHERE entity_id=?").run(two!.observationId, one!.albumId), /source mismatch/);
  assert.throws(() => db.prepare("UPDATE assertion SET entity_id=? WHERE entity_id=?").run(two!.albumId, one!.albumId), /source mismatch/);
  const trackId = randomUUID();
  db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'track','now')").run(trackId);
  db.prepare("INSERT INTO track(id,album_id,position,title) VALUES (?,?,1,'Other')").run(trackId, two!.albumId);
  assert.throws(() => db.prepare("INSERT INTO catalog_track_origin VALUES (?,?,?)").run(trackId, one!.observationId, "unrelated"), /album baseline/);
});

test("0006 upgrades private data unchanged and backup recovery preserves catalog evidence and pending lists", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-catalog-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(join(directory, "original.sqlite")); t.after(() => { if (db.open) db.close(); });
  migrate(db, loadMigrations().slice(0, 5));
  const user = randomUUID();
  db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)').run(user, "Test", "migration@example.test", "now", "now");
  const bookmark = new BookmarkStore(db).create(user, { title: "Keep me", url: detail().data.pageUrl, note: "Private" }).item;
  migrate(db); assertMigrated(db);
  assert.deepEqual(new BookmarkStore(db).get(user, bookmark.id), bookmark);
  const store = new CatalogStore(db), [saved] = await store.ingestSynthetic(detail());
  const changed = later(detail()); changed.data.tracks[0]!.title = "Pending change";
  const [pending] = await store.ingestSynthetic(changed), expected = await store.getAlbum(saved!.albumId);
  const snapshot = join(directory, "snapshot.sqlite"), restoredPath = join(directory, "restored.sqlite");
  await backupDatabase(db, snapshot); await restoreDatabase(snapshot, restoredPath);
  const restored = openDatabase(restoredPath);
  try {
    const copy = new CatalogStore(restored); assertMigrated(restored); verifyDatabase(restored);
    assert.deepEqual(await copy.getAlbum(saved!.albumId), expected);
    assert.deepEqual(await copy.getObservation(pending!.observationId), await store.getObservation(pending!.observationId));
    assert.equal((await copy.ingestSynthetic(changed))[0]!.outcome, "duplicate");
    assert.deepEqual(new BookmarkStore(restored).get(user, bookmark.id), bookmark);
  } finally { restored.close(); }
});
