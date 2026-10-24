import type Database from "better-sqlite3";
import type { SavedCatalogEntity } from "../shared/catalog-library.ts";
import { REMOVED_ALBUM_TITLE, REMOVED_TRACK_TITLE } from "./removal.ts";
import { EXPIRED_ALBUM_TITLE, EXPIRED_TRACK_TITLE, catalogSampleKind, observationIsActive, hasRetentionModel } from "./retention.ts";

interface EntityRow extends Omit<SavedCatalogEntity, "sampleKind" | "identity" | "contentState" | "presence"> {
  removed: number;
}
// Only service-managed albums (or their removal receipts) admit personal catalog saves.
// A track's source is its containing album; no track SourceEntity is invented from its row number.
export const managedEntitySelect = `SELECT e.id,e.kind,a.id AS albumId,coalesce(t.title,a.title) AS title,e.lifecycle,
  s.id AS sourceEntityId,s.source_id AS sourceId,s.external_key AS externalKey,s.page_url AS pageUrl,s.availability AS sourceAvailability,
  (r.source_entity_id IS NOT NULL) AS removed,b.position,t.duration_ms AS durationMs
  FROM entity e LEFT JOIN track t ON t.id=e.id JOIN album a ON a.id=coalesce(t.album_id,e.id)
  LEFT JOIN catalog_album_state c ON c.album_id=a.id LEFT JOIN catalog_removal r ON r.album_id=a.id
  JOIN source_entity s ON s.id=coalesce(c.source_entity_id,r.source_entity_id)
  LEFT JOIN catalog_track_binding b ON b.track_id=t.id AND b.observation_id=c.tracks_observation_id
  WHERE e.kind IN ('album','track') AND (e.kind='album' OR r.source_entity_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM catalog_track_origin origin JOIN catalog_observation o ON o.id=origin.observation_id
    WHERE origin.track_id=t.id AND o.source_entity_id=s.id))`;

export function readManagedEntity(db: Database.Database, entityId: string): SavedCatalogEntity | undefined {
  const row = db.prepare(`${managedEntitySelect} AND e.id=?`).get(entityId) as EntityRow | undefined;
  if (!row) return undefined;
  const sampleKind = catalogSampleKind(db, row.sourceEntityId);
  const { removed, lifecycle, ...data } = row;
  let expired = false;
  if (!removed && hasRetentionModel(db)) {
    const current = row.kind === "album" ? db.prepare("SELECT title_observation_id AS id FROM catalog_album_state WHERE album_id=?").get(row.albumId)
      : db.prepare(`SELECT b.observation_id AS id FROM catalog_track_binding b JOIN catalog_observation o ON o.id=b.observation_id
        WHERE b.track_id=? ORDER BY o.captured_at DESC LIMIT 1`).get(row.id);
    expired = !observationIsActive(db, (current as { id: string } | undefined)?.id ?? null);
  }
  return { ...data, lifecycle: removed ? "unavailable" : lifecycle, title: removed ? row.kind === "album" ? REMOVED_ALBUM_TITLE : REMOVED_TRACK_TITLE
    : expired ? row.kind === "album" ? EXPIRED_ALBUM_TITLE : EXPIRED_TRACK_TITLE : row.title,
    position: removed || expired ? null : row.position, durationMs: removed || expired ? null : row.durationMs,
    sourceAvailability: removed ? "removed" : row.sourceAvailability, contentState: removed ? "removed" : expired ? "expired" : "active",
    presence: removed ? "removed" : expired ? "expired" : row.kind === "album" ? "album" : row.position === null || lifecycle === "unavailable" ? "missing" : "current",
    sampleKind, identity: "source-provisional" };
}
