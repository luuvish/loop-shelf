import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, normalizeSearch } from "../src/database/connection.ts";
import { assertMigrated, loadMigrations, migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogTrackSearchStore } from "../src/catalog/track-search.ts";
import { CatalogBrowseStore } from "../src/catalog/browse.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { attachSyntheticRetention } from "../src/catalog/retention.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { queryPlans } from "../scripts/benchmarks/query-plans.ts";

const baseline = JSON.parse(readFileSync(new URL("../docs/evidence/2026-10-25-catalog-concurrency-final.json", import.meta.url), "utf8")) as { plans: { tracks: { sql: string }[] } };
// Independent 0014 SQL oracle: never routes through the optimized query generator.
const legacySql = baseline.plans.tracks.find((q) => q.sql.includes("@afterTitle"))!.sql
  .replace("AND normalize_search(t.title)>=@afterTitle\n    AND (normalize_search(t.title),e.sourceId,e.externalKey,b.position,t.id)>(@afterTitle,@afterSource,@afterKey,@afterPosition,@afterId)", "")
  .replace("LIMIT @limit ", "LIMIT @limit OFFSET @offset");
function user(db: ReturnType<typeof openDatabase>) {
  const id = randomUUID(); db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,\'Test\',?,0,\'now\',\'now\')').run(id, `${id}@example.test`); return id;
}
interface OracleRow { id: string; title: string; position: number; albumId: string; albumTitle: string; sourceId: string; externalKey: string; observationId: string; titleObservationId: string; capturedAt: string; titleCapturedAt: string; trackState: string }

test("bounded source windows equal the previous full query across pages, source filters, hidden prefixes, sparse titles and expiry", async (t) => {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const owner = user(db), catalog = new CatalogStore(db), search = new CatalogTrackSearchStore(db), library = new CatalogLibraryStore(db);
  let first!: Awaited<ReturnType<typeof catalog.ingestSynthetic>>[number];
  for (let i = 0; i < 280; i++) {
    const input = syntheticAlbum(i, 2); assert.equal(input.data.kind, "album");
    if (input.data.kind === "album") input.data.tracks.forEach((row, n) => { row.title = (n ? "same" : "ＳＡＭＥ") + (i < 275 ? " 記憶" : " 記憶 z"); row.displayNumber = "1"; });
    const [saved] = await catalog.ingestSynthetic(input); if (!i) first = saved!;
  }
  const personal = library.create(owner, { entityId: first.albumId, note: "never-in-public-search", favorite: true }).item;
  function oracle(q: string, sourceId?: "khinsider" | "zophar") {
    const sql = sourceId ? legacySql.replace("r.album_id=a.id)", "r.album_id=a.id) AND s.source_id=@sourceId") : legacySql;
    return db.prepare(sql).all({ q: normalizeSearch(q), limit: 10000, offset: 0, ...(sourceId ? { sourceId } : {}) }) as OracleRow[];
  }
  function check(q: string, sourceId?: "khinsider" | "zophar") {
    const expected = oracle(q, sourceId), actual = []; let cursor: string | null = null, pages = 0;
    do {
      const page = search.search({ q, limit: 23, ...(sourceId ? { sourceId } : {}), ...(cursor ? { cursor } : {}) });
      actual.push(...page.items.map((row) => [row.id, row.title, row.position, row.album.id, row.album.title, row.album.sourceId, row.album.externalKey,
        row.provenance.observationId, row.album.provenance.observationId, row.provenance.capturedAt, row.album.provenance.capturedAt, row.album.trackState]));
      cursor = page.nextCursor; assert.ok(++pages < 40);
    } while (cursor);
    assert.deepEqual(actual, expected.map((row) => [row.id, row.title, row.position, row.albumId, row.albumTitle, row.sourceId, row.externalKey,
      row.observationId, row.titleObservationId, row.capturedAt, row.titleCapturedAt, row.trackState]));
  }
  const fast = queryPlans(db, () => search.search({ q: "same", limit: 23 }));
  assert.ok(fast.some((row) => row.sql.includes("WITH source_window")));
  assert.ok(!fast.some((row) => row.sql.startsWith("WITH eligible")));
  const plan = fast.find((row) => row.sql.includes("WITH source_window"))!.plan.map((r) => (r as { detail: string }).detail);
  assert.ok(plan.some((r) => /SEARCH t USING .*catalog_track_search_title_idx .*<expr>=\? AND album_id=\?/u.test(r)), plan.join("\n"));
  for (const source of [undefined, "khinsider", "zophar"] as const) check("same", source);
  db.exec("UPDATE source_entity SET availability='blocked' WHERE id IN (SELECT id FROM source_entity ORDER BY source_id,external_key LIMIT 256)");
  const ordered = queryPlans(db, () => search.search({ q: "same", limit: 23 }));
  assert.ok(ordered.some((row) => row.sql.includes("WITH source_window"))); assert.ok(ordered.some((row) => row.sql.startsWith("WITH track_window")));
  assert.ok(!ordered.some((row) => row.sql.startsWith("WITH eligible")));
  check("same"); check("same", "zophar");
  db.exec("UPDATE source_entity SET availability='unverified'");
  // Lightweight candidates deliberately do not equate availability with the full evidence check.
  // Both prefixes can contain only ineligible rows: the third/full query must still find later rows.
  db.exec("UPDATE entity SET lifecycle='unavailable' WHERE id IN (SELECT entity_id FROM source_entity ORDER BY source_id,external_key LIMIT 256)");
  const fallback = queryPlans(db, () => search.search({ q: "same", limit: 23 }));
  assert.ok(fallback.some((row) => row.sql.startsWith("WITH track_window")));
  assert.ok(fallback.some((row) => row.sql.startsWith("WITH eligible")));
  check("same"); check("same", "zophar");
  db.exec("UPDATE entity SET lifecycle='active'");
  check("same 記憶 z"); check("absent-title"); check("never-in-public-search");
  // A last source's unique title lies outside the initial bounded prefix; fallback must find it.
  db.prepare("UPDATE track SET title='same needle' WHERE album_id=(SELECT entity_id FROM source_entity ORDER BY source_id DESC,external_key DESC LIMIT 1)").run();
  check("needle");
  db.transaction(() => attachSyntheticRetention(db, first.observationId, "window-expiry", new Date(Date.now() - 1000).toISOString())).immediate();
  search.search({ q: "same" }); check("same");
  assert.equal(library.get(owner, personal.id).note, personal.note); assert.equal(library.get(owner, personal.id).version, personal.version);
  verifyDatabase(db);
});

test("0015 preserves IDs/content on upgrade and rollback, and its title order survives updates, removal and a new-path restore", async (t) => {
  const db = openDatabase(":memory:"), migrations = loadMigrations().slice(0, 15), prior = migrations.slice(0, 14); migrate(db, prior); t.after(() => db.close());
  assert.equal(migrations.at(-1)!.name, "0015_catalog_album_search.sql"); assert.throws(() => assertMigrated(db));
  const owner = user(db), catalog = new CatalogStore(db), [saved] = await catalog.ingestSynthetic(syntheticAlbum(0, 3));
  const item = new CatalogLibraryStore(db).create(owner, { entityId: saved!.albumId, note: "preserve-id-content", favorite: true }).item;
  const tables = ["entity", "album", "track", "source_entity", "catalog_observation", "catalog_album_state", "catalog_track_binding", "library_item"];
  const contents = () => tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = contents(), history = db.prepare("SELECT * FROM schema_migration ORDER BY name").all(), last = migrations.at(-1)!;
  assert.throws(() => migrate(db, [...prior, { ...last, sql: `${last.sql}\nSELECT deliberate_missing_function();` }]));
  assert.deepEqual(contents(), before); assert.deepEqual(db.prepare("SELECT * FROM schema_migration ORDER BY name").all(), history);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalog_album_search_title_idx'").get(), undefined);
  migrate(db); assertMigrated(db); verifyDatabase(db); assert.deepEqual(contents(), before); assert.throws(() => migrate(db, prior), /history mismatch/u);
  const browse = new CatalogBrowseStore(db);
  const plans = queryPlans(db, () => browse.list(owner, { q: "Synthetic" })).flatMap((q) => q.plan.map((r) => (r as { detail: string }).detail));
  assert.ok(plans.some((p) => /SCAN a USING (?:COVERING )?INDEX catalog_album_search_title_idx/u.test(p)), plans.join("\n"));
  const changed = syntheticAlbum(0, 3); assert.equal(changed.data.kind, "album");
  if (changed.data.kind === "album") changed.data.title = "ＦＡＮＴＡＳＹ 記憶 %_";
  changed.provenance.capturedAt = "2026-10-24T01:00:00.000Z"; await catalog.ingestSynthetic(changed);
  assert.equal(browse.list(owner, { q: "fantasy" }).items[0]!.entity.id, saved!.albumId);
  assert.equal(browse.list(owner, { q: "Synthetic" }).items.length, 0);
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-album-index-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backup = join(dir, "backup.sqlite"), restored = join(dir, "restored.sqlite"); await backupDatabase(db, backup);
  const hash = () => createHash("sha256").update(readFileSync(backup)).digest("hex"), original = hash(); await restoreDatabase(backup, restored);
  const copy = openDatabase(restored);
  try {
    assertMigrated(copy); verifyDatabase(copy);
    const found = new CatalogBrowseStore(copy).list(owner, { q: "%_" }).items;
    assert.equal(found[0]!.entity.id, item.entity.id); assert.equal(new CatalogLibraryStore(copy).get(owner, item.id).note, item.note);
    await new CatalogStore(copy).removeSource({ sourceEntityId: saved!.sourceEntityId, reason: "rights_request" });
    assert.equal(new CatalogBrowseStore(copy).list(owner, { q: "fantasy" }).items.length, 0);
    assert.equal((copy.prepare("SELECT count(*) AS n FROM album INDEXED BY catalog_album_search_title_idx WHERE instr(normalize_search(title),'fantasy')>0").get() as { n: number }).n, 0);
    verifyDatabase(copy);
  } finally { copy.close(); }
  assert.equal(hash(), original); assert.equal(browse.list(owner, { q: "fantasy" }).items.length, 1);
});

test("query plan probe compares exact baseline rows in a disposable DB without retaining rejected indexes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-query-probe-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "report.json");
  const result = spawnSync(process.execPath, ["scripts/bench-catalog-query-plans.ts", "--albums", "20", "--samples", "3", "--output", output],
    { encoding: "utf8", env: { ...process.env, TMPDIR: dir }, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output, "utf8")); assert.equal(report.measurements.length, 6); assert.equal(report.method.preliminary, true);
  for (const variant of report.measurements) for (const row of variant.rows) { assert.equal(row.samplesMs.length, 3); assert.ok(row.plan.length); }
  assert.equal(report.measurements.at(-1).variant, "bounded-source-window"); assert.deepEqual(readdirSync(dir), ["report.json"]);
});
