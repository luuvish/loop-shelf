import type { AlbumObservationData } from "./input.ts";
import type { Provenance, SearchPage, SourceId, SourceTrack } from "../sources/types.ts";

export interface CatalogObservation {
  id: string;
  sourceEntityId: string;
  kind: "search" | "album";
  data: AlbumObservationData;
  pageContext: Omit<SearchPage, "albums"> | null;
  provenance: Provenance;
  warnings: string[];
}
export interface CatalogTrack {
  id: string;
  position: number;
  title: string;
  displayNumber: string | null;
  discLabel: string | null;
  durationMs: number | null;
  recordingId: string | null;
  originObservationId: string;
  snapshotLocator: string;
  adoptedObservationId: string;
  adoptedSnapshotLocator: string;
}
export interface CatalogReviewTrack {
  id: string;
  title: string;
  displayNumber: string | null;
  durationMs: number | null;
  lifecycle: "active" | "unavailable";
  currentPosition: number | null;
  originObservationId: string | null;
}
export interface CatalogTrackReview {
  albumId: string;
  sourceEntityId: string;
  expectedTracksObservationId: string;
  observationId: string;
  sampleKind: Provenance["sampleKind"];
  existingTracks: CatalogReviewTrack[];
  incomingTracks: SourceTrack[];
}
export interface CatalogTrackAdoption {
  requestId: string;
  albumId: string;
  sourceEntityId: string;
  baseObservationId: string;
  observationId: string;
  adoptedAt: string;
  assignments: { position: number; trackId: string; created: boolean }[];
  missingTrackIds: string[];
}
export interface CatalogRemoval {
  sourceEntityId: string;
  albumId: string;
  reason: "rights_request" | "policy_change";
  removedAt: string;
}
export interface ActiveCatalogAlbum {
  id: string;
  sourceEntityId: string;
  sourceId: SourceId;
  externalKey: string;
  pageUrl: string;
  availability: "unverified" | "available" | "blocked" | "not_found" | "removed";
  sampleKind: Provenance["sampleKind"];
  identity: "source-provisional";
  contentState: "active";
  removal: null;
  title: string;
  titleKind: "album-title" | "source-display-label";
  titleObservationId: string;
  latestObservationId: string;
  latestDetailObservationId: string | null;
  tracksObservationId: string | null;
  trackState: "not_loaded" | "unchanged" | "review_required";
  tracks: CatalogTrack[];
}
export interface RemovedCatalogAlbum extends Pick<ActiveCatalogAlbum,
  "id" | "sourceEntityId" | "sourceId" | "externalKey" | "pageUrl" | "sampleKind" | "identity" | "title"> {
  availability: "removed";
  contentState: "removed";
  removal: CatalogRemoval;
  titleKind: null;
  titleObservationId: null;
  latestObservationId: null;
  latestDetailObservationId: null;
  tracksObservationId: null;
  trackState: "removed";
  tracks: [];
}
export type CatalogAlbum = ActiveCatalogAlbum | RemovedCatalogAlbum;
export interface CatalogIngestedAlbum {
  albumId: string;
  sourceEntityId: string;
  observationId: string;
  outcome: "applied" | "duplicate" | "historical";
}
