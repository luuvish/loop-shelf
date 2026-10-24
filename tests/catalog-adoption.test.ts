import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database/connection.ts";
import { assertMigrated, loadMigrations, migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { withDatabase } from "../src/database/access.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogError } from "../src/catalog/input.ts";
import { MAX_ADOPTION_INPUT_BYTES } from "../src/catalog/adoption.ts";
import { inspectCapturedPage } from "../src/sources/parsers.ts";
import type { AlbumDetail, ParseResult } from "../src/sources/types.ts";

function detail(minute = 0) {
  const result = inspectCapturedPage({ sourceId: "zophar", kind: "album", status: 200, sampleKind: "synthetic",
    capturedAt: new Date(Date.parse("2026-10-18T14:00:00Z") + minute * 60000).toISOString(),
    url: "https://www.zophar.net/music/nintendo-snes-spc/sample.html",
    html: readFileSync(new URL("./fixtures/zophar-album.html", import.meta.url), "utf8"), headers: { "content-type": "text/html" } });
  assert.ok(result.ok); return result as Extract<ParseResult, { ok: true }> & { data: AlbumDetail };
}
const hasCode = (code: CatalogError["code"]) => (error: unknown) => error instanceof CatalogError && error.code === code;
const tables = ["entity", "album", "track", "source_entity", "catalog_observation", "catalog_album_state", "catalog_track_origin",
  "catalog_track_binding", "catalog_track_adoption", "assertion", "library_item", "user_source_link"];
const rows = (db: Database.Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = (db: Database.Database) => tables.map((table) => rows(db, table));
async function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const store = new CatalogStore(db), [first] = await store.ingestSynthetic(detail()), initial = await store.getAlbum(first!.albumId);
  const next = detail(1);
  // Reorder two existing tracks, omit one, and add a genuinely separate row with identical metadata.
  next.data.tracks = [next.data.tracks[2]!, next.data.tracks[0]!, { ...next.data.tracks[0]!, snapshotLocator: "new-copy" }, next.data.tracks[3]!];
  next.data.tracks.forEach((row, index) => { row.position = index + 1; });
  next.data.tracks[0]!.title = "Reviewed title"; next.data.tracks[0]!.durationSeconds = 0;
  const [pending] = await store.ingestSynthetic(next);
  const plan = { requestId: randomUUID(), albumId: initial.id, expectedTracksObservationId: first!.observationId, observationId: pending!.observationId,
    assignments: [initial.tracks[2]!.id, initial.tracks[0]!.id, null, initial.tracks[3]!.id].map((trackId, index) => ({ position: index + 1, trackId })),
    missingTrackIds: [initial.tracks[1]!.id] };
  return { db, store, initial, next, plan };
}
function personal(db: Database.Database, albumId: string, trackIds: string[], sourceId: string) {
  for (const index of [1, 2]) {
    const userId = randomUUID();
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,\'Test\',?,0,\'now\',\'now\')').run(userId, `adoption-${index}@example.test`);
    const ids = [albumId, ...trackIds];
    for (const entityId of ids) {
      const id = randomUUID();
      db.prepare("INSERT INTO library_item(id,user_id,entity_id,title_override,note,favorite,created_at,updated_at) VALUES (?,?,?,'내 제목','내 메모',1,'now','now')").run(id, userId, entityId);
      if (entityId === albumId) db.prepare("INSERT INTO user_source_link VALUES (?,?,?,'now')").run(userId, id, sourceId);
    }
  }
}

test("review is read-only and separates incoming rows from current and retained identities without suggested matches", async (t) => {
  const { db, store, initial, next, plan } = await fixture(t), before = snapshot(db);
  const review = await store.getTrackReview(initial.id);
  assert.equal(review.expectedTracksObservationId, plan.expectedTracksObservationId); assert.equal(review.observationId, plan.observationId);
  assert.equal(review.sampleKind, "synthetic"); assert.deepEqual(review.incomingTracks, next.data.tracks);
  assert.deepEqual(review.existingTracks.map((row) => row.id), initial.tracks.map((row) => row.id));
  assert.deepEqual(review.existingTracks.map((row) => row.currentPosition), [1, 2, 3, 4]);
  assert.deepEqual(snapshot(db), before);
  await assert.rejects(store.getTrackReview("not-a-uuid"), hasCode("invalid_input"));
  await assert.rejects(store.getTrackReview(randomUUID()), hasCode("not_found"));
});

test("explicit adoption reorders, adds and retires tracks while retaining both users' IDs, private fields and original provenance", async (t) => {
  const { db, store, initial, next, plan } = await fixture(t);
  personal(db, initial.id, initial.tracks.map((row) => row.id), initial.sourceEntityId);
  const privateRows = rows(db, "library_item"), links = rows(db, "user_source_link"), origins = rows(db, "catalog_track_origin");
  const result = await store.adoptTrackList(plan), current = await store.getAlbum(initial.id);
  assert.equal(result.applied, true); assert.equal(current.trackState, "unchanged"); assert.equal(current.tracksObservationId, plan.observationId);
  assert.deepEqual(current.tracks.map((row) => row.id), result.assignments.map((row) => row.trackId));
  assert.deepEqual(current.tracks.map((row) => row.position), [1, 2, 3, 4]);
  assert.deepEqual(current.tracks.map((row) => row.title), next.data.tracks.map((row) => row.title));
  assert.equal(current.tracks[0]!.durationMs, 0); assert.equal(current.tracks[3]!.durationMs, null);
  assert.equal(current.tracks[0]!.originObservationId, initial.tracks[2]!.originObservationId);
  assert.equal(current.tracks[0]!.adoptedObservationId, plan.observationId);
  assert.equal(current.tracks[2]!.originObservationId, plan.observationId);
  assert.notEqual(current.tracks[1]!.id, current.tracks[2]!.id); // Identical values are not merged.
  assert.equal(rows(db, "track").length, 5); assert.deepEqual(rows(db, "catalog_track_origin").slice(0, 4), origins);
  assert.deepEqual(rows(db, "library_item"), privateRows); assert.deepEqual(rows(db, "user_source_link"), links);
  const missing = db.prepare("SELECT t.title,e.lifecycle FROM track t JOIN entity e ON e.id=t.id WHERE t.id=?").get(plan.missingTrackIds[0]!) as { title: string; lifecycle: string };
  assert.equal(missing.title, initial.tracks[1]!.title); assert.equal(missing.lifecycle, "unavailable");
  assert.equal((db.prepare("SELECT position FROM track WHERE id=?").get(current.tracks[0]!.id) as { position: number }).position, 3);
  const claims = db.prepare("SELECT observed_at FROM assertion WHERE observation_id=? AND field='track'").all(plan.observationId) as { observed_at: string }[];
  assert.equal(claims.length, 4); assert.ok(claims.every((row) => row.observed_at === next.provenance.capturedAt));
  await assert.rejects(store.getTrackReview(initial.id), hasCode("review_not_required")); verifyDatabase(db);
});

test("retries do not allocate UUIDs or replay an old selection after subsequent observations and adoptions", async (t) => {
  const { db, store, initial, plan } = await fixture(t), first = await store.adoptTrackList(plan), after = snapshot(db);
  assert.deepEqual(await store.adoptTrackList(plan), { ...first, applied: false }); assert.deepEqual(snapshot(db), after);
  await assert.rejects(store.adoptTrackList({ ...plan, missingTrackIds: [] }), hasCode("adoption_conflict"));
  const next = detail(2), [pending] = await store.ingestSynthetic(next), review = await store.getTrackReview(initial.id);
  const secondPlan = { ...plan, requestId: randomUUID(), expectedTracksObservationId: review.expectedTracksObservationId, observationId: pending!.observationId,
    assignments: initial.tracks.map((row, index) => ({ position: index + 1, trackId: row.id })), missingTrackIds: [first.assignments[2]!.trackId] };
  await store.adoptTrackList(secondPlan);
  const current = await store.getAlbum(initial.id), latest = snapshot(db);
  assert.deepEqual(current.tracks.map((row) => row.id), initial.tracks.map((row) => row.id)); // Explicitly restores a missing ID.
  assert.equal((db.prepare("SELECT lifecycle FROM entity WHERE id=?").get(plan.missingTrackIds[0]!) as { lifecycle: string }).lifecycle, "active");
  assert.deepEqual(await store.adoptTrackList(plan), { ...first, applied: false }); assert.deepEqual(snapshot(db), latest);
  await assert.rejects(store.adoptTrackList({ ...plan, requestId: randomUUID() }), hasCode("stale_review"));
});

test("new identical captures keep the adopted list and old captures cannot replace its baseline", async (t) => {
  const { db, store, initial, next, plan } = await fixture(t); await store.adoptTrackList(plan);
  const expected = (await store.getAlbum(initial.id)).tracks, count = rows(db, "track").length;
  const unchanged = structuredClone(next); unchanged.provenance.capturedAt = detail(3).provenance.capturedAt;
  unchanged.data.tracks.forEach((row, i) => { row.snapshotLocator = `changed-dom:${i}`; });
  await store.ingestSynthetic(unchanged);
  assert.equal((await store.getAlbum(initial.id)).trackState, "unchanged");
  assert.deepEqual((await store.getAlbum(initial.id)).tracks, expected);
  assert.equal((await store.ingestSynthetic(detail()))[0]!.outcome, "duplicate");
  assert.equal(rows(db, "track").length, count); assert.deepEqual((await store.getAlbum(initial.id)).tracks, expected);
});

test("newer detail invalidates review, while an unrelated newer search summary does not", async (t) => {
  const { db, store, initial, plan } = await fixture(t);
  const next = detail(2); next.data.tracks[0]!.title = "Newer incoming track";
  await store.ingestSynthetic(next); const before = snapshot(db);
  await assert.rejects(store.adoptTrackList(plan), hasCode("stale_review")); assert.deepEqual(snapshot(db), before);
  const review = await store.getTrackReview(initial.id);
  const summary = inspectCapturedPage({ sourceId: "zophar", kind: "search", status: 200, sampleKind: "synthetic", capturedAt: detail(3).provenance.capturedAt,
    url: "https://www.zophar.net/search?search=sample", headers: { "content-type": "text/html" },
    html: readFileSync(new URL("./fixtures/zophar-search.html", import.meta.url), "utf8") });
  await store.ingestSynthetic(summary);
  await store.adoptTrackList({ ...plan, requestId: randomUUID(), observationId: review.observationId,
    assignments: initial.tracks.map((row, i) => ({ position: i + 1, trackId: row.id })), missingTrackIds: [] });
  assert.equal((await store.getAlbum(initial.id)).tracks[0]!.title, "Newer incoming track");
});

test("strict plans reject partial, duplicate, unrelated, contradictory and oversized mappings before any writes", async (t) => {
  const { db, store, plan } = await fixture(t), before = snapshot(db);
  const malformed = [null, {}, { ...plan, userId: randomUUID() }, { ...plan, requestId: "bad" }, { ...plan, assignments: [] },
    { ...plan, missingTrackIds: "all" }, { huge: "x".repeat(MAX_ADOPTION_INPUT_BYTES) }];
  for (const input of malformed) await assert.rejects(store.adoptTrackList(input), hasCode("invalid_input"));
  const wrong = [
    { ...plan, assignments: plan.assignments.slice(1) },
    { ...plan, assignments: plan.assignments.map((row) => ({ ...row, position: 1 })) },
    { ...plan, assignments: plan.assignments.map((row) => ({ ...row, trackId: plan.assignments[0]!.trackId })) },
    { ...plan, assignments: plan.assignments.map((row) => ({ ...row, trackId: randomUUID() })) },
    { ...plan, missingTrackIds: [] }, { ...plan, missingTrackIds: [...plan.missingTrackIds, ...plan.missingTrackIds] },
    { ...plan, missingTrackIds: [randomUUID()] }, { ...plan, missingTrackIds: [plan.assignments[0]!.trackId] },
  ];
  for (const input of wrong) await assert.rejects(store.adoptTrackList(input), hasCode("invalid_mapping"));
  assert.deepEqual(snapshot(db), before);
});

test("manual or shared track metadata blocks adoption without changing its source or private identity", async (t) => {
  const { db, store, initial, plan } = await fixture(t), id = initial.tracks[0]!.id;
  const cases = [
    () => db.prepare("INSERT INTO assertion(id,entity_id,field,value_json,observed_at,method) VALUES (?,?,'track','{}','now','curated')").run(randomUUID(), id),
    () => db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,entity_id,page_url) VALUES (?,'zophar','track','manual',?,'https://www.zophar.net/')").run(randomUUID(), id),
    () => { const recording = randomUUID(); db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'recording','now')").run(recording);
      db.prepare("INSERT INTO recording(id,title) VALUES (?,'Manual recording')").run(recording); db.prepare("UPDATE track SET recording_id=? WHERE id=?").run(recording, id); },
  ];
  for (const setup of cases) {
    db.exec("SAVEPOINT conflict_case"); setup(); const before = snapshot(db);
    await assert.rejects(store.adoptTrackList(plan), hasCode("adoption_conflict")); assert.deepEqual(snapshot(db), before);
    db.exec("ROLLBACK TO conflict_case; RELEASE conflict_case");
  }
});

test("an injected failure after new track allocation rolls back identities, bindings, claims and selection", async (t) => {
  const { db, store, initial, plan } = await fixture(t);
  personal(db, initial.id, initial.tracks.map((row) => row.id), initial.sourceEntityId); const before = snapshot(db);
  db.exec("CREATE TRIGGER fail_adoption BEFORE INSERT ON catalog_track_binding WHEN NEW.position=3 BEGIN SELECT RAISE(ABORT,'injected adoption failure'); END");
  await assert.rejects(store.adoptTrackList(plan), /injected adoption failure/); assert.deepEqual(snapshot(db), before);
  db.exec("DROP TRIGGER fail_adoption"); assert.equal((await store.adoptTrackList(plan)).applied, true);
});

test("shared connection queue gives one winner to competing reviews and idempotent success to its retry", async (t) => {
  const { db, store, plan } = await fixture(t); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const occupied = withDatabase(db, async () => { await gate; });
  const winner = store.adoptTrackList(plan);
  const loser = assert.rejects(store.adoptTrackList({ ...plan, requestId: randomUUID() }), hasCode("stale_review"));
  const retry = store.adoptTrackList(plan);
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(rows(db, "catalog_track_adoption").length, 0);
  release(); await occupied; assert.equal((await winner).applied, true); await loser; assert.equal((await retry).applied, false);
  assert.equal(rows(db, "catalog_track_adoption").length, 1);
});

test("suppressed sources reject reviews and adoptions; removal purges binding history and receipts for active and missing tracks", async (t) => {
  const { db, store, initial, plan } = await fixture(t);
  for (const status of ["blocked", "not_found", "removed"]) {
    db.prepare("UPDATE source_entity SET availability=? WHERE id=?").run(status, initial.sourceEntityId);
    await assert.rejects(store.getTrackReview(initial.id), hasCode("source_suppressed"));
    await assert.rejects(store.adoptTrackList(plan), hasCode("source_suppressed"));
  }
  db.prepare("UPDATE source_entity SET availability='unverified' WHERE id=?").run(initial.sourceEntityId);
  await store.adoptTrackList(plan);
  const ids = (rows(db, "track") as { id: string }[]).map((row) => row.id);
  personal(db, initial.id, ids, initial.sourceEntityId); const privateRows = rows(db, "library_item");
  await store.removeSource({ sourceEntityId: initial.sourceEntityId, reason: "policy_change" });
  for (const table of ["catalog_track_binding", "catalog_track_adoption", "catalog_observation", "catalog_track_origin", "assertion"])
    assert.equal(rows(db, table).length, 0);
  assert.deepEqual((rows(db, "track") as { id: string }[]).map((row) => row.id), ids);
  assert.deepEqual(rows(db, "library_item"), privateRows);
  await assert.rejects(store.adoptTrackList(plan), hasCode("source_suppressed"));
  await assert.rejects(store.getTrackReview(initial.id), hasCode("source_suppressed")); verifyDatabase(db);
});

test("SQL rejects cross-album bindings, invented positions, history edits and adoption receipts for unadopted lists", async (t) => {
  const { db, store, initial, plan } = await fixture(t);
  assert.throws(() => db.prepare("INSERT INTO catalog_track_binding VALUES (?,?,?)").run(plan.observationId, 5, initial.tracks[0]!.id), /managed album observation row/);
  const other = randomUUID(); db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'album','now')").run(other);
  db.prepare("INSERT INTO album(id,title) VALUES (?,'Other')").run(other);
  const track = randomUUID(); db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'track','now')").run(track);
  db.prepare("INSERT INTO track(id,album_id,position,title) VALUES (?,?,1,'Other')").run(track, other);
  assert.throws(() => db.prepare("INSERT INTO catalog_track_binding VALUES (?,?,?)").run(plan.observationId, 1, track), /managed album observation row/);
  assert.throws(() => db.exec("UPDATE catalog_track_binding SET position=99"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM catalog_track_binding"), /only be purged/);
  assert.throws(() => db.prepare("INSERT INTO catalog_track_adoption VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), initial.sourceEntityId,
    initial.id, plan.expectedTracksObservationId, plan.observationId, "a".repeat(64), "{}", "now"), /active album detail/);
  await store.adoptTrackList(plan);
  assert.throws(() => db.exec("UPDATE catalog_track_adoption SET adopted_at='tomorrow'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM catalog_track_adoption"), /only be purged/);
});

test("0008 backfills current selection without changing 0007 IDs and backup/reopen retain adoption and missing tracks", async (t) => {
  const { db: seed, initial, plan } = await fixture(t);
  personal(seed, initial.id, initial.tracks.map((row) => row.id), initial.sourceEntityId);
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-adoption-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "old.sqlite"), db = openDatabase(path); t.after(() => { if (db.open) db.close(); });
  migrate(db, loadMigrations().slice(0, 7));
  const copied = ["user", ...tables.filter((table) => !["catalog_track_binding", "catalog_track_adoption"].includes(table))];
  // Copy and compare only columns present in the historical schema.
  const columns = new Map(copied.map((table) => [table, (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name)]));
  for (const table of copied) for (const original of rows(seed, table) as Record<string, string | number | null>[]) {
    const keys = columns.get(table)!, row = Object.fromEntries(keys.map((key) => [key, original[key]]));
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((key) => `@${key}`).join(",")})`).run(row);
  }
  const historical = () => copied.map((table) => db.prepare(`SELECT ${columns.get(table)!.join(",")} FROM ${table} ORDER BY rowid`).all());
  const before = historical(); migrate(db); assertMigrated(db);
  assert.deepEqual(historical(), before);
  const store = new CatalogStore(db); assert.deepEqual((await store.getAlbum(initial.id)).tracks, initial.tracks);
  const result = await store.adoptTrackList(plan), expected = snapshot(db);
  const backup = join(directory, "snapshot.sqlite"), restored = join(directory, "restored.sqlite");
  await backupDatabase(db, backup); await restoreDatabase(backup, restored); db.close();
  for (const file of [path, restored]) {
    const copy = openDatabase(file);
    try {
      assertMigrated(copy); verifyDatabase(copy); assert.deepEqual(snapshot(copy), expected);
      assert.deepEqual(await new CatalogStore(copy).adoptTrackList(plan), { ...result, applied: false });
    } finally { copy.close(); }
  }
});

test("operator CLI exposes read-only review and applies an explicit local JSON plan with safe retries", async (t) => {
  const { db: seed, initial, plan } = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-adoption-cli-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "main.sqlite"), input = join(directory, "plan.json"); await backupDatabase(seed, path);
  const run = (args: string[]) => spawnSync(process.execPath, ["scripts/catalog.ts", ...args],
    { env: { ...process.env, DATABASE_PATH: path }, encoding: "utf8", timeout: 15000 });
  const review = run(["review", "--album-id", initial.id]); assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(review.stdout).observationId, plan.observationId);
  writeFileSync(input, "{bad}"); assert.match(run(["adopt", "--input", input]).stderr, /invalid_input/);
  writeFileSync(input, JSON.stringify(plan)); const result = run(["adopt", "--input", input]); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).applied, true); assert.ok(!result.stdout.includes("Reviewed title"));
  assert.equal(JSON.parse(run(["adopt", "--input", input]).stdout).applied, false);
  assert.match(run(["review", "--album-id", initial.id]).stderr, /review_not_required/);
  assert.equal(run(["adopt", "--input", input, "--reason", "rights_request"]).status, 1);
});
