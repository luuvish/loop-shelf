import type Database from "better-sqlite3";
import { z } from "zod";
import { CatalogError } from "./input.ts";
import type { CatalogRemoval } from "./types.ts";

export const REMOVED_ALBUM_TITLE = "메타데이터가 제거된 앨범";
export const REMOVED_TRACK_TITLE = "메타데이터가 제거된 트랙";
const request = z.object({ sourceEntityId: z.uuid(), reason: z.enum(["rights_request", "policy_change"]) }).strict();

export function readCatalogRemoval(db: Database.Database, sourceEntityId: string): CatalogRemoval | undefined {
  return db.prepare(`SELECT source_entity_id AS sourceEntityId, album_id AS albumId, reason, removed_at AS removedAt
    FROM catalog_removal WHERE source_entity_id=?`).get(sourceEntityId) as CatalogRemoval | undefined;
}

/** Caller holds withDatabase. Remove only this service's unshared provisional album, atomically. */
export function removeCatalogSource(db: Database.Database, input: unknown): CatalogRemoval & { removed: boolean } {
  const parsed = request.safeParse(input);
  if (!parsed.success) throw new CatalogError("invalid_input", "A source UUID and removal reason are required");
  const { sourceEntityId, reason } = parsed.data;
  return db.transaction(() => {
    const existing = readCatalogRemoval(db, sourceEntityId);
    if (existing) return { ...existing, removed: false };
    const source = db.prepare("SELECT entity_id AS albumId FROM source_entity WHERE id=?").get(sourceEntityId) as { albumId: string | null } | undefined;
    if (!source) throw new CatalogError("not_found", "Catalog source not found");
    const state = db.prepare("SELECT album_id FROM catalog_album_state WHERE source_entity_id=?").get(sourceEntityId) as { album_id: string } | undefined;
    if (!state || state.album_id !== source.albumId) throw new CatalogError("unmanaged_source", "Source removal requires a managed provisional album");
    const albumId = state.album_id;
    // Manual/global mappings and claims need a separate provenance review; never erase another source by inference.
    const members = "SELECT id FROM track WHERE album_id=@albumId UNION SELECT @albumId";
    const params = { albumId, sourceEntityId };
    const conflict = db.prepare(`SELECT 1 FROM source_entity WHERE id<>@sourceEntityId AND entity_id IN (${members})
      UNION ALL SELECT 1 FROM assertion WHERE (entity_id IN (${members})
        AND (source_entity_id IS NOT @sourceEntityId OR method<>'source' OR observation_id IS NULL))
        OR (source_entity_id=@sourceEntityId AND entity_id NOT IN (${members}))
      UNION ALL SELECT 1 FROM album WHERE id=@albumId AND (album_kind IS NOT NULL OR release_date IS NOT NULL OR catalog_number IS NOT NULL)
      UNION ALL SELECT 1 FROM album_game WHERE album_id=@albumId
      UNION ALL SELECT 1 FROM track t WHERE t.album_id=@albumId AND (t.recording_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM catalog_track_origin origin JOIN catalog_observation o ON o.id=origin.observation_id
        WHERE origin.track_id=t.id AND o.source_entity_id=@sourceEntityId)) LIMIT 1`).get(params);
    if (conflict) throw new CatalogError("removal_conflict", "Shared or unmanaged metadata requires explicit review before removal");
    const receipt: CatalogRemoval = { sourceEntityId, albumId, reason, removedAt: new Date().toISOString() };
    db.prepare("INSERT INTO catalog_removal(source_entity_id,album_id,reason,removed_at) VALUES (@sourceEntityId,@albumId,@reason,@removedAt)").run(receipt);
    db.prepare("DELETE FROM catalog_track_adoption WHERE source_entity_id=?").run(sourceEntityId);
    db.prepare("DELETE FROM catalog_track_binding WHERE observation_id IN (SELECT id FROM catalog_observation WHERE source_entity_id=?)").run(sourceEntityId);
    db.prepare("DELETE FROM assertion WHERE source_entity_id=?").run(sourceEntityId);
    db.prepare("DELETE FROM catalog_track_origin WHERE track_id IN (SELECT id FROM track WHERE album_id=?)").run(albumId);
    db.prepare("DELETE FROM catalog_album_state WHERE source_entity_id=?").run(sourceEntityId);
    db.prepare("DELETE FROM catalog_observation WHERE source_entity_id=?").run(sourceEntityId);
    db.prepare("DELETE FROM source_url_history WHERE source_entity_id=?").run(sourceEntityId);
    db.prepare("UPDATE album SET title=?,album_kind=NULL,release_date=NULL,catalog_number=NULL WHERE id=?").run(REMOVED_ALBUM_TITLE, albumId);
    db.prepare("UPDATE track SET title=?,disc_label=NULL,track_label=NULL,duration_ms=NULL,recording_id=NULL WHERE album_id=?").run(REMOVED_TRACK_TITLE, albumId);
    db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=? OR id IN (SELECT id FROM track WHERE album_id=?)").run(albumId, albumId);
    db.prepare("UPDATE source_entity SET availability='removed',fetched_at=NULL,parser_version=NULL WHERE id=?").run(sourceEntityId);
    return { ...receipt, removed: true };
  }).immediate();
}
