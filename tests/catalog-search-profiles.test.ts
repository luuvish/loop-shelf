import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogTrackSearchStore } from "../src/catalog/track-search.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { blockProfilePrefix, prepareProfile, profileAlbum, referenceItems, referenceTracks, searchProfiles } from "../scripts/benchmarks/search-profiles.ts";
import { queryPlans } from "../scripts/benchmarks/query-plans.ts";

test("seven search profiles preserve full cursor traversal, source filtering and private content against independent SQL", async (t) => {
  for (const profile of searchProfiles) {
    await t.test(profile, async () => {
      const db = openDatabase(":memory:"); migrate(db);
      try {
        const id = randomUUID(); db.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'Test',?,0,'now','now')`).run(id, `${id}@example.test`);
        const catalog = new CatalogStore(db), library = new CatalogLibraryStore(db), search = new CatalogTrackSearchStore(db);
        const makeAlbum = profileAlbum(profile, 100);
        const [first] = await catalog.ingestSynthetic(makeAlbum(0, 3));
        const personal = library.create(id, { entityId: first!.albumId, note: "private-only-search-phrase", favorite: true }).item;
        for (let i = 1; i < 100; i++) await catalog.ingestSynthetic(makeAlbum(i, 3));
        assert.equal(blockProfilePrefix(db, profile, 100), profile === "blocked-prefix" ? 60 : 0);
        const prepared = prepareProfile(db, profile);
        for (let slot = 0; slot < prepared.inputs.length; slot++) prepared.assertPage(search.search(prepared.inputs[slot]), slot);
        if (profile === "unique") assert.equal(prepared.summary.normalizedTitles, 300);
        if (profile === "sparse") assert.equal(prepared.summary.referenceRows, 2);
        if (profile === "blocked-prefix") assert.equal(prepared.summary.referenceRows, 120);
        for (const sourceId of [undefined, "khinsider", "zophar"] as const) {
          const expected = referenceItems(referenceTracks(db, prepared.inputs[0]!.q, sourceId));
          const actual = []; let cursor: string | null = null, pages = 0;
          do {
            const result = search.search({ q: prepared.inputs[0]!.q, limit: 7, ...(sourceId ? { sourceId } : {}), ...(cursor ? { cursor } : {}) });
            actual.push(...result.items); cursor = result.nextCursor; assert.ok(++pages < 100);
          } while (cursor);
          assert.deepEqual(actual, expected);
        }
        if (profile === "unique") {
          const albumOrder = [...new Set(referenceTracks(db, "Synthetic").map((row) => row.albumId))];
          // 81 albums * 3 tracks = 243 invalid candidates: exactly 13 survivors fill limit + 1.
          // With 82 albums hidden only 10 survive in the same prefix: a full read must find later rows.
          for (const hidden of [81, 82]) {
            db.transaction(() => { for (const albumId of albumOrder.slice(0, hidden)) db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=?").run(albumId); })();
            const current = prepareProfile(db, profile), plans = queryPlans(db, () => current.assertPage(search.search(current.inputs[0]), 0));
            assert.ok(plans.some((p) => p.sql.startsWith("WITH track_window")));
            assert.equal(plans.some((p) => p.sql.startsWith("WITH eligible")), hidden === 82);
            current.assertPage(search.search(current.inputs[1]), 1);
          }
        }
        assert.equal(search.search({ q: personal.note }).items.length, 0);
        const retained = library.get(id, personal.id);
        assert.equal(retained.id, personal.id); assert.equal(retained.note, personal.note); assert.equal(retained.favorite, true); assert.equal(retained.version, personal.version);
      } finally { db.close(); }
    });
  }
});

test("profile CLI keeps real authentication, independent expected pages, all samples and disposable DB isolation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-profiles-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, "untouched.sqlite"); writeFileSync(sentinel, "do-not-open");
  const env = { ...process.env, TMPDIR: dir, DATABASE_PATH: sentinel };
  for (const profile of ["unique", "sparse", "blocked-prefix", "boundary", "deep", "offset-deep"]) {
    const output = join(dir, `${profile}.json`);
    const result = spawnSync(process.execPath, ["scripts/bench-catalog-concurrency.ts", "--profile", profile, "--albums", profile === "offset-deep" ? "100" : "20", "--tracks", "3", "--samples", "3", "--output", output], { encoding: "utf8", env, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.searchProfile.profile, profile); assert.equal(report.searchProfile.version, "catalog-search-profiles-v2");
    assert.ok(report.searchProfile.referenceRows > 0); assert.ok(report.checks.independentTrackReference);
    assert.match(report.searchProfile.referenceOrderSha256, /^[a-f0-9]{64}$/u);
    assert.equal(report.measurements.length, 3);
    for (const m of report.measurements) {
      assert.equal(m.samples.length, 18); assert.equal(m.byKind.length, 6);
      for (const k of m.byKind) assert.equal(k.count, 3);
      for (const sample of m.samples) assert.equal(sample.turns, 1);
    }
    assert.equal(report.passed, report.measurements.every((m: { byKind: { total: { p95Ms: number } }[] }) => m.byKind.every((k) => k.total.p95Ms <= 300)));
    assert.equal(readFileSync(sentinel, "utf8"), "do-not-open");
  }
  const bad = spawnSync(process.execPath, ["scripts/bench-catalog-concurrency.ts", "--profile", "unknown"], { encoding: "utf8", env, timeout: 30000 });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /Unknown search profile/u);
  const noBoundary = spawnSync(process.execPath, ["scripts/bench-catalog-concurrency.ts", "--profile", "boundary", "--tracks", "1"], { encoding: "utf8", env, timeout: 30000 });
  assert.notEqual(noBoundary.status, 0); assert.match(noBoundary.stderr, /requires at least two track titles/u);
  assert.deepEqual(readdirSync(dir).sort(), ["blocked-prefix.json", "boundary.json", "deep.json", "offset-deep.json", "sparse.json", "unique.json", "untouched.sqlite"]);
});
