import type { CatalogTrackEvidence, CatalogTrackSearchPage } from "../src/shared/catalog-track-search.ts";
import { normalizeAlbumUrl } from "../src/sources/urls.ts";
import type { SourceId } from "../src/sources/types.ts";

export interface TrackQuery { q: string; sourceId: SourceId | ""; cursor: string | null }
export const TRACK_PAGE_SIZE = 12;
export const normalizeTrackQuery = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
export function validTrackQuery(value: string): boolean {
  return value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value) && normalizeTrackQuery(value).length > 0 && normalizeTrackQuery(value).length <= 200;
}
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(v);
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const cursor = (v: unknown) => v === null || typeof v === "string" && /^[A-Za-z0-9_-]{1,384}$/u.test(v);
const evidence = (v: CatalogTrackEvidence) => uuid(v.observationId) && date(v.capturedAt) && text(v.parserVersion, 300) && (v.expiresAt === null || date(v.expiresAt));

/** Display validation only; source permissions and current membership remain server decisions. */
export function validTrackPage(value: CatalogTrackSearchPage, input: TrackQuery): boolean {
  try {
    if (value.sampleKind !== "synthetic" || value.identity !== "source-provisional" || value.query !== normalizeTrackQuery(input.q)
      || value.sourceId !== (input.sourceId || null) || !date(value.checkedAt) || !cursor(value.nextCursor)
      || value.nextCursor !== null && value.nextCursor === input.cursor || value.paginationLimited !== false
      || value.nextOffset !== (input.cursor === null && value.nextCursor !== null ? TRACK_PAGE_SIZE : null)
      || !Array.isArray(value.items) || value.items.length > TRACK_PAGE_SIZE
      || value.nextCursor !== null && value.items.length !== TRACK_PAGE_SIZE
      || new Set(value.items.map((item) => item.id)).size !== value.items.length) return false;
    return value.items.every((item) => {
      const album = item.album, link = normalizeAlbumUrl(album.sourceId, album.pageUrl);
      return uuid(item.id) && text(item.title, 1000) && integer(item.position) && item.position > 0
        && (item.durationMs === null || integer(item.durationMs)) && (item.displayNumber === null || text(item.displayNumber, 100))
        && (item.discLabel === null || text(item.discLabel, 300)) && evidence(item.provenance)
        && uuid(album.id) && uuid(album.sourceEntityId) && text(album.title, 1000) && evidence(album.provenance)
        && ["khinsider", "zophar"].includes(album.sourceId) && (!input.sourceId || album.sourceId === input.sourceId)
        && link?.externalKey === album.externalKey && link.pageUrl === album.pageUrl
        && ["unchanged", "review_required"].includes(album.trackState);
    });
  } catch { return false; }
}
/** Server-relative lifetime minus all request/session-confirmation time, independent of clock skew. */
export function trackPageLifetime(value: CatalogTrackSearchPage, elapsedMs: number): number | null {
  const expiries = value.items.flatMap((item) => [item.provenance.expiresAt, item.album.provenance.expiresAt]).filter((v) => v !== null);
  return expiries.length ? Math.min(...expiries.map(Date.parse)) - Date.parse(value.checkedAt) - elapsedMs : null;
}
