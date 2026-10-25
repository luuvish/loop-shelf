import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogTrackSearchStore } from "../src/catalog/track-search.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { encodeTrackCursor, trackCursorContext } from "../src/catalog/track-search-cursor.ts";
import { profileAlbum, referenceItems, referenceTracks } from "../scripts/benchmarks/search-profiles.ts";
import { queryPlans } from "../scripts/benchmarks/query-plans.ts";

test("last-page exhaustion uses the raw candidate count, distinguishes 255/256/257 and never leaks internal counters", async (t) => {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const owner = randomUUID(); db.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'Test',?,0,'now','now')`).run(owner, `${owner}@example.test`);
  const catalog = new CatalogStore(db), search = new CatalogTrackSearchStore(db), library = new CatalogLibraryStore(db);
  const makeAlbum = profileAlbum("unique", 100);
  for (let i = 0; i < 100; i++) await catalog.ingestSynthetic(makeAlbum(i, 3));
  const before = referenceTracks(db, "synthetic"), albums = [...new Set(before.map((r) => r.albumId))];
  const personal = library.create(owner, { entityId: albums[15]!, note: "preserved-private", favorite: true }).item;
  db.transaction(() => { for (const id of albums.slice(15, 67)) db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=?").run(id); })();
  const expected = referenceTracks(db, "synthetic"), context = trackCursorContext({ q: "synthetic", limit: 100 });
  assert.equal(expected.length, 144);
  for (const start of [43, 44, 45]) {
    const input = { q: "Synthetic", limit: 100, cursor: encodeTrackCursor(before[start - 1]!, context) };
    const page = search.search(input), rows = expected.slice(start, start + 100);
    const more: boolean = expected.length > start + 100;
    assert.deepEqual(page.items, referenceItems(rows));
    assert.equal(page.nextCursor, more ? encodeTrackCursor(rows.at(-1)!, context) : null);
    assert.equal(page.nextOffset, null); assert.equal(page.paginationLimited, false);
    assert.ok(!JSON.stringify(page).includes("candidateCount"));
    const plans = queryPlans(db, () => search.search(input));
    assert.ok(plans.some((p) => p.sql.startsWith("WITH track_window")));
    assert.equal(plans.some((p) => p.sql.startsWith("WITH eligible") && p.sql.includes("@afterTitle")), start !== 45);
  }
  const last = { q: "Synthetic", limit: 100, cursor: encodeTrackCursor(before.at(-1)!, context) };
  assert.deepEqual(search.search(last).items, []);
  assert.ok(queryPlans(db, () => search.search(last)).some((p) => p.sql.startsWith("WITH eligible") && p.sql.includes("@afterTitle")));
  const preserved = library.get(owner, personal.id); assert.equal(preserved.note, personal.note); assert.equal(preserved.version, personal.version);
});
