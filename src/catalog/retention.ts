import type Database from "better-sqlite3";
import { CatalogError } from "./input.ts";
import { catalogAdmissionPolicy } from "../source-save/policy.ts";
import type { SourceId } from "../sources/types.ts";

export const EXPIRED_ALBUM_TITLE = "보관이 종료된 앨범";
export const EXPIRED_TRACK_TITLE = "보관이 종료된 트랙";
// Historical upgrade fixtures may deliberately use an earlier schema. Product startup asserts latest schema.
export const hasRetentionModel = (db: Database.Database) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_source_kind'").get();
export function catalogSampleKind(db: Database.Database, sourceEntityId: string): "synthetic" | "live-capture" {
  if (!hasRetentionModel(db)) return "synthetic";
  const row = db.prepare("SELECT sample_kind FROM catalog_source_kind WHERE source_entity_id=?").get(sourceEntityId) as { sample_kind: "synthetic" | "live-capture" } | undefined;
  if (!row) throw new CatalogError("unmanaged_source", "Catalog sample kind is missing");
  return row.sample_kind;
}

/** Caller owns withDatabase; no network. Retains identity/provenance hashes, erases source text and stale copies. */
export function reconcileCatalogRetention(db: Database.Database, now = Date.now()): number {
  if (!hasRetentionModel(db)) return 0;
  if (!Number.isFinite(new Date(now).getTime())) throw new CatalogError("invalid_input", "A valid retention clock is required");
  return db.transaction(() => {
    const projection = `SELECT o.id,o.source_entity_id,o.sample_kind,o.retention_revision,o.expires_at,s.source_id,s.entity_id
      FROM catalog_observation o JOIN source_entity s ON s.id=o.source_entity_id
      WHERE o.content_state='active' AND o.expires_at IS NOT NULL`;
    const rows = db.prepare(`${projection} AND o.sample_kind='synthetic' AND o.expires_at<=?
      UNION ALL ${projection} AND o.sample_kind='live-capture'`).all(new Date(now).toISOString()) as
      { id: string; source_entity_id: string; sample_kind: string; retention_revision: string; expires_at: string; source_id: SourceId; entity_id: string }[];
    let count = 0;
    const affectedAlbums = new Set<string>();
    for (const row of rows) {
      let state: "expired" | "policy_revoked" | null = Date.parse(row.expires_at) <= now ? "expired" : null;
      if (row.sample_kind === "live-capture") {
        const policy = catalogAdmissionPolicy(row.source_id);
        if (policy.persistence.status !== "allowed" || policy.revision !== row.retention_revision) state = "policy_revoked";
      }
      if (!state) continue;
      // Never silently erase manually curated/shared canonical values. Fail closed pending operator review.
      const conflict = db.prepare(`SELECT 1 FROM source_entity WHERE id<>@sourceId AND (entity_id=@albumId OR entity_id IN (SELECT id FROM track WHERE album_id=@albumId))
        UNION ALL SELECT 1 FROM assertion WHERE (entity_id=@albumId OR entity_id IN (SELECT id FROM track WHERE album_id=@albumId))
          AND (source_entity_id IS NOT @sourceId OR method<>'source' OR observation_id IS NULL)
        UNION ALL SELECT 1 FROM album WHERE id=@albumId AND (album_kind IS NOT NULL OR release_date IS NOT NULL OR catalog_number IS NOT NULL)
        UNION ALL SELECT 1 FROM album_game WHERE album_id=@albumId
        UNION ALL SELECT 1 FROM track WHERE album_id=@albumId AND recording_id IS NOT NULL LIMIT 1`).get({ sourceId: row.source_entity_id, albumId: row.entity_id });
      if (conflict) throw new CatalogError("removal_conflict", "Expired shared metadata requires explicit review");
      db.prepare(`UPDATE catalog_observation SET content_state=?,data_json='{}',warnings_json='[]',
        page_context_json=CASE WHEN kind='search' THEN '{}' ELSE NULL END,
        page_url=(SELECT page_url FROM source_entity WHERE id=source_entity_id) WHERE id=?`).run(state, row.id);
      db.prepare("DELETE FROM assertion WHERE observation_id=?").run(row.id);
      db.prepare("UPDATE catalog_track_origin SET snapshot_locator=track_id WHERE observation_id=?").run(row.id);
      db.prepare("DELETE FROM source_url_history WHERE source_entity_id=?").run(row.source_entity_id);
      affectedAlbums.add(row.entity_id);
      count++;
    }
    if (count) {
      const album = db.prepare(`UPDATE album SET title=@title WHERE id=@albumId AND id IN (
        SELECT c.album_id FROM catalog_album_state c JOIN catalog_observation o ON o.id=c.title_observation_id WHERE o.content_state<>'active')`);
      const tracks = db.prepare(`UPDATE track SET title=@title,track_label=NULL,disc_label=NULL,duration_ms=NULL WHERE album_id=@albumId AND id IN (
          SELECT t.id FROM track t JOIN catalog_track_origin origin ON origin.track_id=t.id
          JOIN catalog_observation o ON o.id=(SELECT b.observation_id FROM catalog_track_binding b JOIN catalog_observation adopted ON adopted.id=b.observation_id
            WHERE b.track_id=t.id ORDER BY adopted.captured_at DESC LIMIT 1) WHERE t.album_id=@albumId AND o.content_state<>'active')`);
      for (const albumId of affectedAlbums) {
        album.run({ albumId, title: EXPIRED_ALBUM_TITLE });
        tracks.run({ albumId, title: EXPIRED_TRACK_TITLE });
      }
    }
    return count;
  }).immediate();
}

export function observationIsActive(db: Database.Database, id: string | null): boolean {
  if (!id) return false;
  if (!hasRetentionModel(db)) return true;
  return !!db.prepare("SELECT 1 FROM catalog_observation WHERE id=? AND content_state='active'").get(id);
}

/** Leases are immutable: retries cannot extend an observation's original retention. Synthetic rehearsal only. */
export function attachSyntheticRetention(db: Database.Database, observationId: string, policyRevision: string, expiresAt: string) {
  if (!db.inTransaction || !hasRetentionModel(db)) throw new CatalogError("invalid_input", "Retention requires a migrated transaction");
  const row = db.prepare("SELECT sample_kind,captured_at,retention_revision,expires_at,content_state FROM catalog_observation WHERE id=?").get(observationId) as
    { sample_kind: string; captured_at: string; retention_revision: string | null; expires_at: string | null; content_state: string } | undefined;
  if (!row || row.sample_kind !== "synthetic" || !policyRevision.trim() || policyRevision.length > 200 || !Number.isFinite(Date.parse(expiresAt))
    || new Date(expiresAt).toISOString() !== expiresAt || expiresAt <= row.captured_at || Date.parse(expiresAt) > Date.parse(row.captured_at) + 30 * 86400_000)
    throw new CatalogError("invalid_input", "Invalid retention lease");
  if (row.content_state !== "active") throw new CatalogError("content_expired", "Expired observations cannot be restored by retry");
  if (row.retention_revision && (row.retention_revision !== policyRevision || row.expires_at !== expiresAt)) throw new CatalogError("retention_conflict", "Retention cannot be renewed for the same observation");
  db.prepare("UPDATE catalog_observation SET retention_revision=?,expires_at=? WHERE id=?").run(policyRevision, expiresAt, observationId);
}
