import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { CatalogBrowseStore } from "../src/catalog/browse.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { seedBenchmark, syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { queryPlans } from "../scripts/benchmarks/query-plans.ts";

async function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const a = randomUUID(), b = randomUUID(), now = new Date().toISOString();
  for (const id of [a, b]) db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)').run(id, "Test", `${id}@example.test`, now, now);
  const seeded = await seedBenchmark(db, a, b, 20, 3);
  return { db, a, b, ...seeded, browse: new CatalogBrowseStore(db), catalog: new CatalogStore(db), library: new CatalogLibraryStore(db) };
}

test("catalog browsing bounds album and current-binding reads without scanning unrelated entities", async (t) => {
  const { db, a, albumIds, browse } = await fixture(t);
  const albums = queryPlans(db, () => browse.list(a, { q: "記憶" }));
  const detail = queryPlans(db, () => browse.detail(a, albumIds.at(-1)!, { limit: 2, offset: 1 }));
  for (const queries of [albums, detail]) {
    const details = queries.flatMap((query) => query.plan.map((row) => (row as { detail: string }).detail));
    assert.ok(!details.some((value) => /^SCAN e(?:\s|$)/u.test(value)), details.join("\n"));
  }
  const binding = detail.find((query) => query.sql.includes("ORDER BY b.position"))!;
  assert.ok(binding.plan.some((row) => /SEARCH b .*observation_id=/u.test((row as { detail: string }).detail)));
  assert.ok(!binding.plan.some((row) => /TEMP B-TREE/u.test((row as { detail: string }).detail)));
  const rows = browse.detail(a, albumIds.at(-1)!, { limit: 2, offset: 1 });
  assert.deepEqual(rows.tracks.map((row) => row.entity.position), [2, 3]); assert.equal(rows.nextOffset, null);
});

test("narrow catalog reads retain live titles, source ordering, ownership and unavailable-content exclusions", async (t) => {
  const { db, a, b, albumIds, savedIds, browse, catalog, library } = await fixture(t);
  const first = albumIds[0]!, second = albumIds[1]!;
  // The same normalized title still sorts by source and source key; private content never participates.
  for (const index of [0, 1]) {
    const input = syntheticAlbum(index, 3); assert.equal(input.data.kind, "album");
    if (input.data.kind === "album") input.data.title = index ? "ABC 동일" : "ＡＢＣ 동일";
    input.provenance.capturedAt = "2026-10-24T01:00:00.000Z"; await catalog.ingestSynthetic(input);
  }
  const one = browse.list(a, { q: "abc", limit: 1 }), two = browse.list(a, { q: "abc", limit: 1, offset: 1 });
  assert.equal(one.items[0]!.entity.id, first); assert.equal(one.nextOffset, 1); assert.equal(two.items[0]!.entity.id, second);
  assert.notEqual(browse.list(a, { q: "abc" }).items[0]!.savedItemId, browse.list(b, { q: "abc" }).items[0]!.savedItemId);
  assert.equal(browse.list(a, { q: "other-account-secret" }).items.length, 0);
  assert.equal(library.list(a, { q: "other-account-secret" }).items.length, 0);
  assert.ok(library.list(a, { q: "미연결" }).items.every((item) => item.entity.contentState === "unresolved"));
  assert.equal(browse.list(a, { q: "미연결" }).items.length, 0);
  assert.equal(browse.list(a, { q: "기억의 숲 Album 00000" }).items.length, 0);
  const current = browse.detail(a, first, {}).tracks;
  db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=?").run(current[0]!.entity.id);
  assert.deepEqual(browse.detail(a, first, {}).tracks.map((row) => row.entity.id), current.slice(1).map((row) => row.entity.id));
  const otherSource = browse.detail(a, second, {}).album.entity.sourceEntityId;
  db.prepare("UPDATE source_entity SET availability='blocked' WHERE id=?").run(otherSource);
  assert.equal(browse.list(a, { q: "abc", sourceId: "zophar" }).items.length, 0);
  assert.throws(() => browse.detail(a, second, {}));
  assert.ok(browse.candidates(a, savedIds[0]!, {}).items.every((item) => item.entity.id !== second));
  await catalog.removeSource({ sourceEntityId: otherSource, reason: "policy_change" });
  assert.equal(browse.list(a, { q: "abc" }).items.length, 1);
  assert.throws(() => browse.candidates(b, savedIds[0]!, {}));
});

test("benchmark CLI uses an isolated disposable database and emits measured service and real-session API evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-bench-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, "do-not-open.sqlite"); writeFileSync(sentinel, "untouched existing path");
  const output = join(dir, "report.json");
  const result = spawnSync(process.execPath, ["scripts/bench-catalog.ts", "--albums", "20", "--tracks", "3", "--samples", "3", "--output", output],
    { encoding: "utf8", env: { ...process.env, TMPDIR: dir, DATABASE_PATH: sentinel }, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(sentinel, "utf8"), "untouched existing path");
  assert.deepEqual(readdirSync(dir).sort(), ["do-not-open.sqlite", "report.json"]);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.fixture.albums, 20); assert.equal(report.fixture.tracks, 60); assert.equal(report.method.samples, 3);
  assert.equal(report.measurements.filter((row: { layer: string }) => row.layer === "authenticated-inject").length, 3);
  assert.equal(report.measurements.length, 24);
  for (const row of report.measurements) {
    assert.equal(row.samplesMs.length, 3); assert.ok(row.p50Ms >= 0 && row.p95Ms >= row.p50Ms);
    assert.ok(Number.isFinite(row.firstMs));
  }
  assert.ok(report.measurements.some((row: { queries: unknown[] }) => row.queries.length > 0));
  const invalid = spawnSync(process.execPath, ["scripts/bench-catalog.ts", "--database", sentinel], { encoding: "utf8", timeout: 30000 });
  assert.notEqual(invalid.status, 0); assert.equal(readFileSync(sentinel, "utf8"), "untouched existing path");
});
