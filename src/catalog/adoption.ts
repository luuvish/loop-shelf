import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { CatalogError, type AlbumObservationData } from "./input.ts";
import type { CatalogTrackAdoption, CatalogTrackReview, CatalogReviewTrack } from "./types.ts";
import { catalogSampleKind, observationIsActive } from "./retention.ts";

export const MAX_ADOPTION_INPUT_BYTES = 1024 * 1024;
const request = z.object({
  requestId: z.uuid(), albumId: z.uuid(), expectedTracksObservationId: z.uuid(), observationId: z.uuid(),
  assignments: z.array(z.object({ position: z.number().int().min(1).max(5000), trackId: z.uuid().nullable() }).strict()).min(1).max(5000),
  missingTrackIds: z.array(z.uuid()).max(5000),
}).strict();
interface State { source_entity_id: string; tracks_observation_id: string | null; detail_observation_id: string | null }
function activeState(db: Database.Database, albumId: string): State {
  if (db.prepare("SELECT 1 FROM catalog_removal WHERE album_id=?").get(albumId))
    throw new CatalogError("source_suppressed", "Removed sources cannot be reviewed or adopted");
  const state = db.prepare(`SELECT c.*,s.availability FROM catalog_album_state c JOIN source_entity s ON s.id=c.source_entity_id
    WHERE c.album_id=?`).get(albumId) as (State & { availability: string }) | undefined;
  if (!state) throw new CatalogError("not_found", "Managed catalog album not found");
  if (state.detail_observation_id && !observationIsActive(db, state.detail_observation_id)) throw new CatalogError("content_expired", "Current detail has expired");
  if (["blocked", "not_found", "removed"].includes(state.availability))
    throw new CatalogError("source_suppressed", "Suppressed sources cannot be reviewed or adopted");
  return state;
}
function observation(db: Database.Database, id: string) {
  return db.prepare("SELECT data_json,tracks_sha256 FROM catalog_observation WHERE id=?").get(id) as { data_json: string; tracks_sha256: string };
}

/** Caller holds withDatabase. This review never guesses an identity correspondence. */
export function readTrackReview(db: Database.Database, albumId: string): CatalogTrackReview {
  if (!z.uuid().safeParse(albumId).success) throw new CatalogError("invalid_input", "An album UUID is required");
  const state = activeState(db, albumId);
  if (!state.tracks_observation_id || !state.detail_observation_id)
    throw new CatalogError("review_not_required", "No changed detailed track list is available");
  const baseline = observation(db, state.tracks_observation_id), target = observation(db, state.detail_observation_id);
  if (observationIsActive(db, state.tracks_observation_id) && baseline.tracks_sha256 === target.tracks_sha256)
    throw new CatalogError("review_not_required", "The latest list already matches the adopted list");
  const data = JSON.parse(target.data_json) as Extract<AlbumObservationData, { kind: "album" }>;
  const existingTracks = db.prepare(`SELECT t.id,t.title,t.track_label AS displayNumber,t.duration_ms AS durationMs,
    e.lifecycle,b.position AS currentPosition,o.observation_id AS originObservationId
    FROM track t JOIN entity e ON e.id=t.id LEFT JOIN catalog_track_origin o ON o.track_id=t.id
    LEFT JOIN catalog_track_binding b ON b.track_id=t.id AND b.observation_id=? WHERE t.album_id=? ORDER BY t.position`)
    .all(state.tracks_observation_id, albumId) as CatalogReviewTrack[];
  return { albumId, sourceEntityId: state.source_entity_id, expectedTracksObservationId: state.tracks_observation_id,
    observationId: state.detail_observation_id, sampleKind: catalogSampleKind(db, state.source_entity_id), existingTracks, incomingTracks: data.tracks };
}

/** Trusted operator only. All positions and all omitted current IDs must be explicitly accounted for. */
export function adoptTracks(db: Database.Database, input: unknown): CatalogTrackAdoption & { applied: boolean } {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(input); } catch { /* rejected below */ }
  if (!encoded || Buffer.byteLength(encoded) > MAX_ADOPTION_INPUT_BYTES)
    throw new CatalogError("invalid_input", "Track adoption input exceeds its byte limit or is not serializable");
  const parsed = request.safeParse(input);
  if (!parsed.success) throw new CatalogError("invalid_input", "A complete explicit track adoption request is required");
  const plan = parsed.data;
  // Normalize only set order; target positions still require a complete ordered list.
  plan.missingTrackIds.sort();
  const fingerprint = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  return db.transaction(() => {
    activeState(db, plan.albumId); // Even a previous successful request cannot expose a removed receipt.
    const previous = db.prepare("SELECT request_sha256,result_json FROM catalog_track_adoption WHERE request_id=?").get(plan.requestId) as
      { request_sha256: string; result_json: string } | undefined;
    if (previous) {
      if (!observationIsActive(db, plan.observationId)) throw new CatalogError("content_expired", "Expired adoption cannot be replayed");
      if (previous.request_sha256 !== fingerprint) throw new CatalogError("adoption_conflict", "Request ID was used for a different adoption");
      return { ...JSON.parse(previous.result_json) as CatalogTrackAdoption, applied: false };
    }
    const state = activeState(db, plan.albumId);
    if (state.tracks_observation_id !== plan.expectedTracksObservationId || state.detail_observation_id !== plan.observationId)
      throw new CatalogError("stale_review", "The adopted or latest detailed observation changed; review again");
    const review = readTrackReview(db, plan.albumId);
    const invalid = (): never => { throw new CatalogError("invalid_mapping", "Account for every incoming row and every omitted current track exactly once"); };
    if (plan.assignments.length !== review.incomingTracks.length || plan.assignments.some((row, i) => row.position !== i + 1)) invalid();
    const reused = plan.assignments.flatMap((row) => row.trackId ? [row.trackId] : []), missing = new Set(plan.missingTrackIds), reusedSet = new Set(reused);
    if (reusedSet.size !== reused.length || missing.size !== plan.missingTrackIds.length || reused.some((id) => missing.has(id))) invalid();
    const existing = new Map(review.existingTracks.map((row) => [row.id, row]));
    if (reused.some((id) => !existing.has(id)) || plan.missingTrackIds.some((id) => existing.get(id)?.currentPosition == null)) invalid();
    if (review.existingTracks.some((row) => row.currentPosition !== null && !reusedSet.has(row.id) && !missing.has(row.id))) invalid();
    // This path cannot overwrite manual/global track relationships or metadata without a provenance review.
    const conflict = db.prepare(`SELECT 1 FROM source_entity WHERE id<>@sourceId AND
        (entity_id=@albumId OR entity_id IN (SELECT id FROM track WHERE album_id=@albumId))
      UNION ALL SELECT 1 FROM assertion WHERE entity_id IN (SELECT id FROM track WHERE album_id=@albumId)
        AND (source_entity_id IS NOT @sourceId OR method<>'source' OR observation_id IS NULL)
      UNION ALL SELECT 1 FROM track t WHERE album_id=@albumId AND (recording_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM catalog_track_origin origin JOIN catalog_observation o ON o.id=origin.observation_id
        WHERE origin.track_id=t.id AND o.source_entity_id=@sourceId)) LIMIT 1`).get({ albumId: plan.albumId, sourceId: review.sourceEntityId });
    if (conflict) throw new CatalogError("adoption_conflict", "Shared or unmanaged tracks require a provenance review");
    const adoptedAt = new Date().toISOString();
    const capturedAt = (db.prepare("SELECT captured_at FROM catalog_observation WHERE id=?").get(plan.observationId) as { captured_at: string }).captured_at;
    // New origins must point at the adopted baseline. The entire state change rolls back on any later failure.
    db.prepare("UPDATE catalog_album_state SET tracks_observation_id=? WHERE album_id=?").run(plan.observationId, plan.albumId);
    let slot = (db.prepare("SELECT coalesce(max(position),0) AS n FROM track WHERE album_id=?").get(plan.albumId) as { n: number }).n;
    const assignments = plan.assignments.map((mapping, index) => {
      const row = review.incomingTracks[index]!, id = mapping.trackId ?? randomUUID();
      if (mapping.trackId === null) {
        db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'track',?)").run(id, adoptedAt);
        db.prepare("INSERT INTO track(id,album_id,position,title) VALUES (?,?,?,?)").run(id, plan.albumId, ++slot, row.title);
        db.prepare("INSERT INTO catalog_track_origin VALUES (?,?,?)").run(id, plan.observationId, row.snapshotLocator);
      }
      db.prepare("UPDATE track SET title=?,track_label=?,disc_label=?,duration_ms=? WHERE id=?")
        .run(row.title, row.displayNumber, row.discLabel, row.durationSeconds === null ? null : row.durationSeconds * 1000, id);
      db.prepare("UPDATE entity SET lifecycle='active' WHERE id=?").run(id);
      db.prepare("INSERT INTO catalog_track_binding VALUES (?,?,?)").run(plan.observationId, row.position, id);
      db.prepare(`INSERT INTO assertion(id,entity_id,source_entity_id,field,value_json,observed_at,method,observation_id)
        VALUES (?,?,?,'track',?,?,'source',?)`).run(randomUUID(), id, review.sourceEntityId, JSON.stringify(row), capturedAt, plan.observationId);
      return { position: row.position, trackId: id, created: mapping.trackId === null };
    });
    for (const id of plan.missingTrackIds) db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=?").run(id);
    const result: CatalogTrackAdoption = { requestId: plan.requestId, albumId: plan.albumId, sourceEntityId: review.sourceEntityId,
      baseObservationId: plan.expectedTracksObservationId, observationId: plan.observationId, adoptedAt, assignments, missingTrackIds: plan.missingTrackIds };
    db.prepare("INSERT INTO catalog_track_adoption VALUES (?,?,?,?,?,?,?,?)").run(plan.requestId, review.sourceEntityId,
      plan.albumId, plan.expectedTracksObservationId, plan.observationId, fingerprint, JSON.stringify(result), adoptedAt);
    return { ...result, applied: true };
  }).immediate();
}
