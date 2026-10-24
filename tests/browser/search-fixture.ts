// Browser response fixtures only. No source policy is opened and no catalog is populated.
import type { SearchResponse, SourceSearchResult, LocalSearchAlbum } from "../../src/shared/search.ts";
import type { AlbumSummary, Provenance, SourceId } from "../../src/sources/types.ts";

export interface Query { q: string; sources: SourceId[]; limit: number; offset: number }
export function album(sourceId: SourceId, key: string, title = "[합성] 별의 기억"): AlbumSummary {
  return { sourceId, externalKey: sourceId === "khinsider" ? key : `nes/${key}`,
    pageUrl: sourceId === "khinsider" ? `https://downloads.khinsider.com/game-soundtracks/album/${key}` : `https://www.zophar.net/music/nes/${key}.html`,
    title, titleKind: "source-display-label", platforms: [], sourceCategory: null, sourceYearLabel: null };
}
function provenance(sourceId: SourceId, pageUrl: string): Provenance {
  return { sourceId, pageUrl, capturedAt: "2026-10-23T00:00:00.000Z", parsedAt: "2026-10-23T00:00:01.000Z",
    parserVersion: "browser-synthetic-v1", bodySha256: "a".repeat(64), sampleKind: "synthetic" };
}
export function localAlbum(key: string): LocalSearchAlbum {
  const value = album("khinsider", key, `[합성] 로컬 ${key}`);
  return { id: key, sourceEntityId: `source-${key}`, sourceId: value.sourceId, externalKey: value.externalKey, pageUrl: value.pageUrl,
    title: value.title, titleKind: "album-title", identity: "source-provisional", provenance: provenance(value.sourceId, value.pageUrl) };
}
export function sourceResult(sourceId: SourceId): SourceSearchResult {
  const pageUrl = sourceId === "khinsider" ? "https://downloads.khinsider.com/search?search=star" : "https://www.zophar.net/search?search=star";
  return { sourceId, policy: { revision: "synthetic-fixture", collect: { allowed: true }, cache: { allowed: true }, display: { allowed: true } },
    result: { ok: true, data: { kind: "search", albums: [album(sourceId, "star")], reportedCount: 1, nextPageUrl: null, coverage: "reported-count-matches", resultLimit: null },
      provenance: provenance(sourceId, pageUrl), warnings: [], delivery: { from: "cache", freshness: "fresh", freshUntil: "2099-01-01T00:00:00.000Z", expiresAt: "2099-01-02T00:00:00.000Z" } } };
}
export function response(input: Query): SearchResponse {
  return { ok: true, query: input.q, sampleKind: "synthetic", status: "complete", termination: "settled", completedAt: new Date().toISOString(), elapsedMs: 10,
    local: { ok: true, sampleKind: "synthetic", freshness: "not-revalidated", items: [localAlbum(`page-${input.offset}`)], nextOffset: input.offset === 0 ? 12 : null },
    sources: [...input.sources].sort().map(sourceResult) };
}
