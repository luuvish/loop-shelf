import type Database from "better-sqlite3";
import { CatalogStore } from "../catalog/store.ts";
import { CatalogLibraryStore } from "../library/catalog.ts";
import { SourceSaveError, type SourceSaveInput, type admitSourceAlbum } from "./admission.ts";

/** Synthetic rehearsal only. Caller owns withDatabase; no Promise/network may run in this transaction. */
export function commitSyntheticSourceSave(db: Database.Database, userId: string, input: SourceSaveInput,
  admitted: ReturnType<typeof admitSourceAlbum>, check: () => void) {
  if (admitted.metadata.provenance.sampleKind !== "synthetic") throw new SourceSaveError("storage_unavailable");
  if (admitted.metadata.data.kind !== "album" || admitted.metadata.data.sourceId !== input.sourceId
    || admitted.metadata.data.externalKey !== input.externalKey) throw new SourceSaveError("invalid_response");
  const catalog = new CatalogStore(db), library = new CatalogLibraryStore(db);
  return db.transaction(() => {
    check();
    const latest = db.prepare(`SELECT o.captured_at FROM source_entity s JOIN catalog_album_state c ON c.source_entity_id=s.id
      JOIN catalog_observation o ON o.id=c.detail_observation_id WHERE s.source_id=? AND s.external_kind='album' AND s.external_key=?`)
      .get(input.sourceId, input.externalKey) as { captured_at: string } | undefined;
    if (latest && latest.captured_at > admitted.metadata.provenance.capturedAt) throw new SourceSaveError("snapshot_changed");
    const [row] = catalog.ingestRetainedAlbumInTransaction(admitted.metadata, { policyRevision: admitted.policyRevision, expiresAt: admitted.retainUntil });
    if (!row) throw new SourceSaveError("invalid_response");
    const saved = library.create(userId, { entityId: row.albumId, titleOverride: input.titleOverride, note: input.note, favorite: input.favorite });
    const state = db.prepare(`SELECT o.tracks_sha256 AS latest,b.tracks_sha256 AS adopted,b.content_state AS adoptedState FROM catalog_album_state c
      JOIN catalog_observation o ON o.id=c.detail_observation_id JOIN catalog_observation b ON b.id=c.tracks_observation_id WHERE c.album_id=?`)
      .get(row.albumId) as { latest: string; adopted: string; adoptedState: string };
    check(); // Roll back BOTH shared and personal writes on expiry/cancellation/policy changes.
    return { ok: true as const, sampleKind: "synthetic" as const, ...saved, observationId: row.observationId,
      trackState: state.adoptedState === "active" && state.latest === state.adopted ? "unchanged" as const : "review_required" as const };
  }).immediate();
}
