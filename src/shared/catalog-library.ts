import type { SourceId } from "../sources/types.ts";

export interface SavedCatalogEntity {
  id: string;
  kind: "album" | "track";
  albumId: string;
  title: string;
  sampleKind: "synthetic" | "live-capture";
  identity: "source-provisional";
  contentState: "active" | "removed" | "unresolved" | "expired";
  lifecycle: "active" | "unavailable";
  presence: "album" | "current" | "missing" | "removed" | "unresolved" | "expired";
  position: number | null;
  durationMs: number | null;
  sourceEntityId: string;
  sourceId: SourceId;
  externalKey: string;
  pageUrl: string;
  sourceAvailability: "unverified" | "available" | "blocked" | "not_found" | "removed";
}
export interface PersonalCatalogSource {
  source: SavedCatalogEntity;
  assertedAt: string;
  relationship: "user-asserted";
}
export interface CatalogLibraryItem {
  id: string;
  entity: SavedCatalogEntity;
  title: string;
  titleOverride: string | null;
  note: string;
  favorite: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  sourceLinks: PersonalCatalogSource[];
}
export interface CatalogLibraryPage { items: CatalogLibraryItem[]; nextOffset: number | null }
