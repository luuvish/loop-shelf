import type { SourceId, Provenance } from "../sources/types.ts";
/** Original v1 reference; always synthetic. Kept for importing existing files. */
export interface CatalogReference {
  entityId: string; kind: "album" | "track"; albumId: string;
  source: { id: string; sourceId: SourceId; externalKey: string; pageUrl: string };
}
export interface TypedCatalogReference extends CatalogReference { sampleKind: Provenance["sampleKind"] }
export interface ArchiveCatalogItem<R extends CatalogReference = CatalogReference> {
  id: string; reference: R; titleOverride: string | null; note: string; favorite: boolean;
  createdAt: string; updatedAt: string;
  sourceLinks: { reference: R; assertedAt: string }[];
}
export interface CatalogArchiveV1 {
  format: "loopshelf-catalog"; schemaVersion: 1; sampleKind: "synthetic"; exportedAt: string; items: ArchiveCatalogItem[];
}
export interface CatalogArchiveV2 {
  format: "loopshelf-catalog"; schemaVersion: 2; exportedAt: string; items: ArchiveCatalogItem<TypedCatalogReference>[];
}
export type CatalogArchive = CatalogArchiveV1 | CatalogArchiveV2;
