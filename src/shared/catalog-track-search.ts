import type { SourceId } from "../sources/types.ts";

export interface CatalogTrackEvidence {
  observationId: string;
  capturedAt: string;
  parserVersion: string;
  expiresAt: string | null;
}
/** The source reference belongs to the containing album, not to an invented track source key. */
export interface CatalogTrackSearchItem {
  id: string;
  title: string;
  position: number;
  displayNumber: string | null;
  discLabel: string | null;
  durationMs: number | null;
  provenance: CatalogTrackEvidence;
  album: {
    id: string;
    title: string;
    sourceEntityId: string;
    sourceId: SourceId;
    externalKey: string;
    pageUrl: string;
    provenance: CatalogTrackEvidence;
    trackState: "unchanged" | "review_required";
  };
}
export interface CatalogTrackSearchPage {
  sampleKind: "synthetic";
  identity: "source-provisional";
  query: string;
  sourceId: SourceId | null;
  checkedAt: string;
  items: CatalogTrackSearchItem[];
  /** Pass unchanged with the same query/source/limit; does not grant access or freeze results. */
  nextCursor: string | null;
  nextOffset: number | null;
  /** More rows exist, but the next offset would exceed this API's bounded paging range. */
  paginationLimited: boolean;
}
