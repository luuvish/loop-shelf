// Disposable benchmark fixtures and an independent pre-optimization SQL reference, never product inputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { normalizeSearch } from "../../src/database/connection.ts";
import { encodeTrackCursor, trackCursorContext, type TrackCursorAnchor } from "../../src/catalog/track-search-cursor.ts";
import type { CatalogTrackSearchItem, CatalogTrackSearchPage } from "../../src/shared/catalog-track-search.ts";
import { syntheticAlbum } from "./catalog-fixture.ts";

export const searchProfiles = ["repeated", "unique", "sparse", "blocked-prefix", "boundary", "deep", "offset-deep"] as const;
export type SearchProfile = typeof searchProfiles[number];
export const profileVersion = "catalog-search-profiles-v2";
export const referenceFile = "docs/evidence/2026-10-25-catalog-concurrency-final.json";
const baseline = JSON.parse(readFileSync(new URL(`../../${referenceFile}`, import.meta.url), "utf8")) as { plans: { tracks: { sql: string }[] } };
const after = "AND normalize_search(t.title)>=@afterTitle\n    AND (normalize_search(t.title),e.sourceId,e.externalKey,b.position,t.id)>(@afterTitle,@afterSource,@afterKey,@afterPosition,@afterId)";
const original = baseline.plans.tracks.find((row) => row.sql.includes(after))!.sql;
assert.ok(original.includes("LIMIT @limit "));
const referenceSql = original.replace(after, "").replace("LIMIT @limit ", "LIMIT @limit OFFSET @offset");

interface ReferenceRow extends TrackCursorAnchor {
  title: string; displayNumber: string | null; discLabel: string | null; durationMs: number | null;
  albumTitle: string; pageUrl: string; capturedAt: string; parserVersion: string; expiresAt: string | null;
  titleObservationId: string; titleCapturedAt: string; titleParserVersion: string; titleExpiresAt: string | null;
  trackState: CatalogTrackSearchItem["album"]["trackState"];
  sourceId: CatalogTrackSearchItem["album"]["sourceId"];
}
export function referenceTracks(db: Database.Database, q: string, sourceId?: "khinsider" | "zophar") {
  const sql = sourceId ? referenceSql.replace("r.album_id=a.id)", "r.album_id=a.id) AND s.source_id=@sourceId") : referenceSql;
  return db.prepare(sql).all({ q: normalizeSearch(q), limit: -1, offset: 0, ...(sourceId ? { sourceId } : {}) }) as ReferenceRow[];
}
export function referenceItems(rows: ReferenceRow[]): CatalogTrackSearchItem[] {
  return rows.map((r) => ({ id: r.id, title: r.title, position: r.position, displayNumber: r.displayNumber, discLabel: r.discLabel, durationMs: r.durationMs,
    provenance: { observationId: r.observationId, capturedAt: r.capturedAt, parserVersion: r.parserVersion, expiresAt: r.expiresAt },
    album: { id: r.albumId, title: r.albumTitle, sourceEntityId: r.sourceEntityId, sourceId: r.sourceId, externalKey: r.externalKey, pageUrl: r.pageUrl,
      trackState: r.trackState, provenance: { observationId: r.titleObservationId, capturedAt: r.titleCapturedAt, parserVersion: r.titleParserVersion, expiresAt: r.titleExpiresAt } } }));
}
export function profileAlbum(profile: SearchProfile, albums: number) {
  return (index: number, tracks: number) => {
    const input = syntheticAlbum(index, tracks);
    assert.equal(input.data.kind, "album");
    if (input.data.kind === "album") {
      input.data.tracks.forEach((row, i) => {
        if (profile === "unique") row.title = `[Synthetic] Unique ${String(index).padStart(5, "0")}-${String(i).padStart(3, "0")}`;
        if (profile === "sparse" && index >= Math.floor(albums * .98) && i === 0) row.title = "[Synthetic] needle";
      });
      input.provenance.bodySha256 = createHash("sha256").update(JSON.stringify(input.data)).digest("hex");
    }
    return input;
  };
}
export function blockProfilePrefix(db: Database.Database, profile: SearchProfile, albums: number) {
  if (profile !== "blocked-prefix") return 0;
  return db.prepare(`UPDATE source_entity SET availability='blocked' WHERE id IN
    (SELECT id FROM source_entity WHERE external_kind='album' ORDER BY source_id,external_key LIMIT ?)`)
    .run(Math.floor(albums * .6)).changes;
}
export interface ProfileInput { q: string; limit: number; cursor?: string; offset?: number }
export function prepareProfile(db: Database.Database, profile: SearchProfile) {
  const q = profile === "sparse" ? "needle" : "Synthetic", limit = profile === "offset-deep" ? 100 : 12, rows = referenceTracks(db, q);
  assert.ok(rows.length);
  const base = { q, limit }, context = trackCursorContext({ q: normalizeSearch(q), limit });
  const boundary = rows.findIndex((r) => r.sortTitle !== rows[0]!.sortTitle);
  assert.ok(profile !== "boundary" || boundary > 0, "Boundary profile requires more than one matching title");
  const offsets = profile === "offset-deep" ? [Math.max(0, rows.length - 100), Math.max(0, rows.length - 50)]
    : profile === "boundary" ? [Math.max(1, boundary - 6), Math.max(1, boundary)]
    : profile === "deep" ? [Math.floor(rows.length * .9), Math.floor(rows.length * .99)] : [0, Math.min(limit, rows.length - 1)];
  const inputs: ProfileInput[] = offsets.map((offset) => ({ ...base, ...(profile === "offset-deep" ? { offset } : offset ? { cursor: encodeTrackCursor(rows[offset - 1]!, context) } : {}) }));
  function assertPage(page: CatalogTrackSearchPage, slot: number) {
    const offset = offsets[slot]!, expected = rows.slice(offset, offset + limit), more = rows.length > offset + limit;
    assert.equal(page.sampleKind, "synthetic"); assert.equal(page.identity, "source-provisional");
    assert.equal(page.query, normalizeSearch(q)); assert.equal(page.sourceId, null);
    assert.deepEqual(page.items, referenceItems(expected));
    assert.equal(page.nextCursor, more ? encodeTrackCursor(expected.at(-1)!, context) : null);
    assert.equal(page.nextOffset, !inputs[slot]!.cursor && more ? offset + limit : null); assert.equal(page.paginationLimited, false);
  }
  return { inputs, assertPage, summary: { version: profileVersion, profile, query: q, limit, offsets,
    referenceRows: rows.length, referenceOrderSha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    referenceSqlSha256: createHash("sha256").update(referenceSql).digest("hex"),
    normalizedTitles: (db.prepare("SELECT count(DISTINCT normalize_search(title)) AS n FROM track").get() as { n: number }).n,
    blockedAlbums: (db.prepare("SELECT count(*) AS n FROM source_entity WHERE external_kind='album' AND availability='blocked'").get() as { n: number }).n,
    scope: "full independent ordered SQL reference; exact DTO and pagination of two measured pages; setup/reference excluded from timings; small regression fixtures additionally traverse every cursor page" } };
}
