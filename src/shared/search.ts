import type { AdapterFailure, MetadataDelivery, MetadataPolicy } from "../sources/adapters/contracts.ts";
import type { AlbumSummary, Provenance, SearchPage, SourceId } from "../sources/types.ts";

export interface SearchFailure {
  ok: false;
  code: AdapterFailure["code"] | "database_error" | "source_error" | "result_expired" | "sample_kind_unavailable";
  stage: AdapterFailure["stage"] | "search";
  httpStatus?: number;
  retryAt?: number;
}
export interface LocalSearchAlbum {
  id: string;
  sourceEntityId: string;
  sourceId: SourceId;
  externalKey: string;
  pageUrl: string;
  title: string;
  titleKind: AlbumSummary["titleKind"];
  identity: "source-provisional";
  /** Evidence for the adopted title, not the latest search display label. */
  provenance: Provenance;
}
export type LocalSearchResult = { ok: true; sampleKind: "synthetic"; freshness: "not-revalidated";
  items: LocalSearchAlbum[]; nextOffset: number | null } | SearchFailure;
export interface SearchDelivery extends MetadataDelivery { data: SearchPage }
export interface SourceSearchResult {
  sourceId: SourceId;
  policy: MetadataPolicy;
  result: SearchDelivery | SearchFailure;
}
export interface SearchResponse {
  ok: true;
  query: string;
  sampleKind: Provenance["sampleKind"];
  status: "complete" | "partial" | "failed";
  termination: "settled" | "deadline";
  completedAt: string;
  elapsedMs: number;
  local: LocalSearchResult;
  sources: SourceSearchResult[];
}
export type SearchResult = SearchResponse | { ok: false; code: "invalid_input" | "cancelled" | "queue_full" };
