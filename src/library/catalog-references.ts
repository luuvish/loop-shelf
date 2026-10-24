import type Database from "better-sqlite3";
import type { TypedCatalogReference, ArchiveCatalogItem } from "../shared/catalog-transfer.ts";
import { storedCatalogReference } from "./catalog-archive.ts";
import type { CatalogLibraryItem, SavedCatalogEntity } from "../shared/catalog-library.ts";

export const referenceOf = (entity: SavedCatalogEntity): TypedCatalogReference => ({ entityId: entity.id, kind: entity.kind, albumId: entity.albumId,
  source: { id: entity.sourceEntityId, sourceId: entity.sourceId, externalKey: entity.externalKey, pageUrl: entity.pageUrl }, sampleKind: entity.sampleKind });
export const archiveItemOf = (item: CatalogLibraryItem): ArchiveCatalogItem<TypedCatalogReference> => ({ id: item.id, reference: referenceOf(item.entity),
  titleOverride: item.titleOverride, note: item.note, favorite: item.favorite, createdAt: item.createdAt, updatedAt: item.updatedAt,
  sourceLinks: item.sourceLinks.map((link) => ({ reference: referenceOf(link.source), assertedAt: link.assertedAt }))
    .sort((a, b) => a.reference.source.id.localeCompare(b.reference.source.id)) });
export const unresolvedTitle = (kind: "album" | "track") => kind === "album" ? "원본 미연결 앨범" : "원본 미연결 트랙";
function unresolved(reference: TypedCatalogReference): SavedCatalogEntity {
  return { id: reference.entityId, kind: reference.kind, albumId: reference.albumId, title: unresolvedTitle(reference.kind),
    sampleKind: reference.sampleKind, identity: "source-provisional", contentState: "unresolved", presence: "unresolved", lifecycle: "unavailable",
    position: null, durationMs: null, sourceEntityId: reference.source.id, sourceId: reference.source.sourceId,
    externalKey: reference.source.externalKey, pageUrl: reference.source.pageUrl, sourceAvailability: "unverified" };
}
export function readDetached(db: Database.Database, userId: string, id: string): CatalogLibraryItem | undefined {
  const row = db.prepare(`SELECT id,reference_json AS reference,title_override AS titleOverride,note,favorite,version,
    created_at AS createdAt,updated_at AS updatedAt FROM catalog_detached_item WHERE user_id=? AND id=?`).get(userId, id) as
    (Omit<CatalogLibraryItem, "entity" | "title" | "sourceLinks" | "favorite"> & { reference: string; favorite: number }) | undefined;
  if (!row) return undefined;
  const { reference, favorite, ...privateData } = row, entity = unresolved(storedCatalogReference(reference));
  const links = db.prepare(`SELECT reference_json AS reference,asserted_at AS assertedAt FROM catalog_detached_link
    WHERE user_id=? AND library_item_id=? ORDER BY asserted_at,source_entity_id`).all(userId, id) as { reference: string; assertedAt: string }[];
  return { ...privateData, entity, title: row.titleOverride ?? entity.title, favorite: !!favorite,
    sourceLinks: links.map((link) => ({ source: unresolved(storedCatalogReference(link.reference)), assertedAt: link.assertedAt, relationship: "user-asserted" })) };
}
