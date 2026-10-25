import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogTrackSearchStore } from "../src/catalog/track-search.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { normalizeTrackQuery, validTrackQuery, validTrackPage, trackPageLifetime } from "../web/catalog-track-response.ts";

async function fixture() {
  const db = openDatabase(":memory:"); migrate(db);
  try { await new CatalogStore(db).ingestSynthetic(syntheticAlbum(0, 14)); return new CatalogTrackSearchStore(db).search({ q: "Synthetic", limit: 12 }); }
  finally { db.close(); }
}
const input = { q: "ＳＹＮＴＨＥＴＩＣ", sourceId: "", cursor: null } as const;
test("track screen accepts the actual first/continuation contract and short literal Unicode queries", async () => {
  const page = await fixture(); assert.equal(validTrackPage(page, input), true);
  const next = { ...page, nextOffset: null, nextCursor: null, items: page.items.slice(0, 2) };
  assert.equal(validTrackPage(next, { ...input, cursor: page.nextCursor }), true);
  for (const q of ["기", "記憶", "%_", "🦊", "  ＦＡＮＴＡＳＹ  "]) assert.equal(validTrackQuery(q), true);
  for (const q of ["", "　", "a\n", "x\u200b", "a".repeat(201), "ﷺ".repeat(200)]) assert.equal(validTrackQuery(q), false);
  assert.equal(normalizeTrackQuery("  ＦＡＮＴＡＳＹ   曲  "), "fantasy 曲");
});
test("track screen rejects mismatched kinds/queries/sources/IDs/URLs/paging and malformed rows", async () => {
  const original = await fixture();
  for (const mutate of [
    (p: typeof original) => { p.sampleKind = "live-capture" as typeof p.sampleKind; },
    (p: typeof original) => { p.query = "other"; }, (p: typeof original) => { p.sourceId = "zophar"; },
    (p: typeof original) => { p.nextOffset = 100; }, (p: typeof original) => { p.nextCursor = "!"; },
    (p: typeof original) => { p.paginationLimited = true; }, (p: typeof original) => { p.items.push(p.items[0]!); },
    (p: typeof original) => { p.items[1]!.id = p.items[0]!.id; },
    (p: typeof original) => { p.items[0]!.album.pageUrl = "javascript:alert(1)"; },
    (p: typeof original) => { p.items[0]!.album.externalKey = "mismatch"; },
    (p: typeof original) => { p.items[0]!.provenance.capturedAt = "invalid"; },
    (p: typeof original) => { p.items[0]!.album.provenance.expiresAt = "invalid"; },
    (p: typeof original) => { p.items[0]!.position = 0; }, (p: typeof original) => { p.items[0]!.durationMs = -1; },
  ]) { const value = structuredClone(original); mutate(value); assert.equal(validTrackPage(value, input), false); }
  assert.equal(validTrackPage(null as unknown as typeof original, input), false);
  assert.equal(validTrackPage({ ...original, nextOffset: null }, { ...input, cursor: original.nextCursor }), false);
  assert.equal(validTrackPage(original, { ...input, sourceId: "zophar" }), false);
});
test("track lifetime uses the earliest album/track evidence and deducts request plus session delay without local wall-clock assumptions", async () => {
  const page = await fixture(); assert.equal(trackPageLifetime(page, 200), null);
  const at = Date.parse(page.checkedAt);
  page.items[0]!.provenance.expiresAt = new Date(at + 8000).toISOString();
  page.items[1]!.album.provenance.expiresAt = new Date(at + 4000).toISOString();
  assert.equal(trackPageLifetime(page, 1500), 2500); assert.ok(trackPageLifetime(page, 4500)! < 0);
});
