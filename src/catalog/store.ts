import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { withDatabase } from "../database/access.ts";
import { CatalogError, validateSyntheticResult, type AlbumObservationData, type CatalogInput } from "./input.ts";
import type { CatalogAlbum, CatalogIngestedAlbum, CatalogObservation, CatalogTrack } from "./types.ts";
import { readCatalogRemoval, removeCatalogSource, REMOVED_ALBUM_TITLE } from "./removal.ts";
import { adoptTracks, readTrackReview } from "./adoption.ts";
import { reconcileCatalogRetention, catalogSampleKind, observationIsActive, hasRetentionModel, attachSyntheticRetention } from "./retention.ts";

import { validateRetainedAlbum, type CatalogLease } from "./retained-input.ts";

interface State {
  album_id: string;
  source_entity_id: string;
  latest_observation_id: string;
  summary_observation_id: string | null;
  detail_observation_id: string | null;
  title_observation_id: string;
  tracks_observation_id: string | null;
}
interface ObservationRow {
  id: string; source_entity_id: string; source_id: CatalogAlbum["sourceId"];
  kind: "search" | "album"; sample_kind: "synthetic" | "live-capture"; page_url: string;
  captured_at: string; parsed_at: string; parser_version: string; body_sha256: string;
  data_sha256: string; tracks_sha256: string | null; data_json: string; page_context_json: string | null; warnings_json: string;
}
interface SourceRow {
  id: string; entity_id: string | null; availability: CatalogAlbum["availability"];
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function tracksHash(data: AlbumObservationData): string | null {
  if (!("tracks" in data)) return null;
  // Compare the complete ordered observation, never a title/length or row locator as an identity key.
  return hash(data.tracks.map((row) => ({ position: row.position, externalKey: row.externalKey,
    displayNumber: row.displayNumber, discLabel: row.discLabel, title: row.title,
    durationLabel: row.durationLabel, durationSeconds: row.durationSeconds })));
}

/** No transport or HTTP surface. Only synthetic DTOs are admitted, with all access serialized. */
export class CatalogStore {
  readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }

  async ingestSynthetic(input: unknown): Promise<CatalogIngestedAlbum[]> {
    const result = validateSyntheticResult(input);
    return withDatabase(this.db, async () => this.db.transaction(() => this.ingestValidated(result)).immediate());
  }

  /** Internal composition only: caller owns withDatabase AND a synchronous transaction. Still synthetic-only. */
  ingestSyntheticInTransaction(input: unknown): CatalogIngestedAlbum[] {
    if (!this.db.inTransaction) throw new Error("Catalog ingestion requires the caller's transaction");
    return this.ingestValidated(validateSyntheticResult(input));
  }

  /** Offline lease rehearsal. Does not admit or relabel live input. Caller owns withDatabase and transaction. */
  ingestRetainedSyntheticInTransaction(input: unknown, lease: { policyRevision: string; expiresAt: string }): CatalogIngestedAlbum[] {
    const result = this.ingestSyntheticInTransaction(input);
    for (const row of result) attachSyntheticRetention(this.db, row.observationId, lease.policyRevision, lease.expiresAt);
    return result;
  }

  /** Internal admitted-album path. Live input independently checks fixed product policy; no permission injection. */
  ingestRetainedAlbumInTransaction(input: unknown, rawLease: unknown): CatalogIngestedAlbum[] {
    if (!this.db.inTransaction || !hasRetentionModel(this.db)) throw new CatalogError("invalid_input", "Retained ingestion requires a migrated transaction");
    const { metadata, lease } = validateRetainedAlbum(input, rawLease);
    return this.ingestValidated(metadata, lease);
  }

  private ingestValidated(result: CatalogInput, lease?: CatalogLease): CatalogIngestedAlbum[] {
    reconcileCatalogRetention(this.db);
    const albums = result.data.kind === "album" ? [result.data] : result.data.albums;
    return albums.map((album) => this.ingestAlbum(album, result, lease));
  }

  async getAlbum(albumId: string): Promise<CatalogAlbum> {
    return withDatabase(this.db, async () => {
      reconcileCatalogRetention(this.db);
      z.uuid().parse(albumId);
      const removed = this.db.prepare(`SELECT s.id AS sourceEntityId,s.source_id AS sourceId,s.external_key AS externalKey,s.page_url AS pageUrl
        FROM catalog_removal r JOIN source_entity s ON s.id=r.source_entity_id WHERE r.album_id=?`).get(albumId) as
          Pick<CatalogAlbum, "sourceEntityId" | "sourceId" | "externalKey" | "pageUrl"> | undefined;
      if (removed) return { id: albumId, ...removed, sampleKind: catalogSampleKind(this.db, removed.sourceEntityId), identity: "source-provisional", availability: "removed",
        contentState: "removed", removal: readCatalogRemoval(this.db, removed.sourceEntityId)!, title: REMOVED_ALBUM_TITLE, titleKind: null,
        titleObservationId: null, latestObservationId: null, latestDetailObservationId: null, tracksObservationId: null, trackState: "removed", tracks: [] };
      const state = this.state(albumId);
      if (!state) throw new CatalogError("not_found", "Catalog album not found");
      const sampleKind = catalogSampleKind(this.db, state.source_entity_id);
      if (!observationIsActive(this.db, state.title_observation_id)) throw new CatalogError("content_expired", "Album metadata is no longer retained");
      const row = this.db.prepare(`SELECT a.title, s.source_id AS sourceId, s.external_key AS externalKey,
        s.page_url AS pageUrl, s.availability FROM album a JOIN source_entity s ON s.id=? WHERE a.id=?`)
        .get(state.source_entity_id, albumId) as Pick<CatalogAlbum, "title" | "sourceId" | "externalKey" | "pageUrl" | "availability">;
      const title = this.observation(state.title_observation_id);
      const baseline = state.tracks_observation_id ? this.observation(state.tracks_observation_id) : null;
      const detail = state.detail_observation_id ? this.observation(state.detail_observation_id) : null;
      const tracks = !observationIsActive(this.db, state.tracks_observation_id) ? [] : this.db.prepare(`SELECT t.id, b.position, t.title, t.track_label AS displayNumber,
        t.disc_label AS discLabel, t.duration_ms AS durationMs, t.recording_id AS recordingId,
        o.observation_id AS originObservationId, o.snapshot_locator AS snapshotLocator,
        b.observation_id AS adoptedObservationId,
        json_extract(ob.data_json,'$.tracks[' || (b.position-1) || '].snapshotLocator') AS adoptedSnapshotLocator
        FROM track t JOIN catalog_track_origin o ON o.track_id=t.id
        JOIN catalog_track_binding b ON b.track_id=t.id JOIN catalog_observation ob ON ob.id=b.observation_id
        WHERE t.album_id=? AND b.observation_id=? ORDER BY b.position`)
        .all(albumId, state.tracks_observation_id) as CatalogTrack[];
      return { id: albumId, sourceEntityId: state.source_entity_id, ...row, sampleKind, identity: "source-provisional",
        contentState: "active", removal: null,
        titleKind: (JSON.parse(title.data_json) as AlbumObservationData).titleKind,
        titleObservationId: title.id, latestObservationId: state.latest_observation_id,
        latestDetailObservationId: state.detail_observation_id, tracksObservationId: state.tracks_observation_id,
        trackState: !baseline ? "not_loaded" : observationIsActive(this.db, state.tracks_observation_id) && baseline.tracks_sha256 === detail?.tracks_sha256 ? "unchanged" : "review_required", tracks };
    });
  }

  /** Trusted local operator only; never bind this to an end-user library deletion route. */
  async removeSource(input: unknown) {
    return withDatabase(this.db, async () => removeCatalogSource(this.db, input));
  }

  /** Trusted local operator review/adoption; no end-user or transport surface. */
  async getTrackReview(albumId: string) {
    return withDatabase(this.db, async () => { reconcileCatalogRetention(this.db); return this.db.transaction(() => readTrackReview(this.db, albumId)).deferred(); });
  }

  async adoptTrackList(input: unknown) {
    return withDatabase(this.db, async () => { reconcileCatalogRetention(this.db); return adoptTracks(this.db, input); });
  }

  async getObservation(observationId: string): Promise<CatalogObservation> {
    return withDatabase(this.db, async () => {
      reconcileCatalogRetention(this.db);
      const row = this.observation(z.uuid().parse(observationId));
      if (!observationIsActive(this.db, row.id)) throw new CatalogError("content_expired", "Observation metadata is no longer retained");
      return { id: row.id, sourceEntityId: row.source_entity_id, kind: row.kind,
        data: JSON.parse(row.data_json) as AlbumObservationData, warnings: JSON.parse(row.warnings_json) as string[],
        pageContext: row.page_context_json ? JSON.parse(row.page_context_json) as CatalogObservation["pageContext"] : null,
        provenance: { sourceId: row.source_id, pageUrl: row.page_url, capturedAt: row.captured_at, parsedAt: row.parsed_at,
          parserVersion: row.parser_version, bodySha256: row.body_sha256, sampleKind: row.sample_kind } };
    });
  }

  private state(albumId: string): State | undefined {
    return this.db.prepare("SELECT * FROM catalog_album_state WHERE album_id=?").get(albumId) as State | undefined;
  }
  private observation(id: string): ObservationRow {
    const row = this.db.prepare(`SELECT o.*, s.source_id FROM catalog_observation o
      JOIN source_entity s ON s.id=o.source_entity_id WHERE o.id=?`).get(id) as ObservationRow | undefined;
    if (!row) throw new CatalogError("not_found", "Catalog observation not found");
    return row;
  }

  private ingestAlbum(data: AlbumObservationData, result: CatalogInput, lease?: CatalogLease): CatalogIngestedAlbum {
    const db = this.db, { provenance, warnings } = result, kind = result.data.kind;
    const { parsedAt, ...capture } = provenance;
    const page = result.data;
    const pageContext: CatalogObservation["pageContext"] = page.kind === "search" ? { kind: "search", reportedCount: page.reportedCount,
      coverage: page.coverage, nextPageUrl: page.nextPageUrl, resultLimit: page.resultLimit } : null;
    const fingerprint = hash({ kind, capture, data, pageContext, warnings });
    const dataHash = hash(data), trackHash = tracksHash(data);
    let source = db.prepare("SELECT id, entity_id, availability FROM source_entity WHERE source_id=? AND external_kind='album' AND external_key=?")
      .get(data.sourceId, data.externalKey) as SourceRow | undefined;
    let state: State | undefined;
    if (source) {
      if (hasRetentionModel(db) && catalogSampleKind(db, source.id) !== provenance.sampleKind)
        throw new CatalogError("sample_kind_conflict", "Source identity belongs to another sample kind");
      if (readCatalogRemoval(db, source.id)) throw new CatalogError("source_suppressed", "Removed source cannot be repopulated");
      state = source.entity_id ? this.state(source.entity_id) : undefined;
      if (!state || state.source_entity_id !== source.id)
        throw new CatalogError("unmanaged_source", "Existing source mapping requires explicit review");
      if (["removed", "blocked", "not_found"].includes(source.availability))
        throw new CatalogError("source_suppressed", "Suppressed source cannot be repopulated by ingestion");
      const duplicate = db.prepare("SELECT id FROM catalog_observation WHERE source_entity_id=? AND fingerprint=?").get(source.id, fingerprint) as { id: string } | undefined;
      if (duplicate) {
        if (!observationIsActive(db, duplicate.id)) throw new CatalogError("content_expired", "Expired observations cannot be revived by retry");
        if (lease) {
          if (provenance.sampleKind === "synthetic") attachSyntheticRetention(db, duplicate.id, lease.policyRevision, lease.expiresAt);
          else {
            const existing = db.prepare("SELECT retention_revision,expires_at FROM catalog_observation WHERE id=?").get(duplicate.id) as { retention_revision: string; expires_at: string };
            if (existing.retention_revision !== lease.policyRevision || existing.expires_at !== lease.expiresAt)
              throw new CatalogError("retention_conflict", "A retry cannot change an observation lease");
          }
        }
        return { albumId: state.album_id, sourceEntityId: source.id, observationId: duplicate.id, outcome: "duplicate" };
      }
    } else {
      source = { id: randomUUID(), entity_id: randomUUID(), availability: "unverified" };
      db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'album',?)").run(source.entity_id, new Date().toISOString());
      db.prepare("INSERT INTO album(id,title) VALUES (?,?)").run(source.entity_id, data.title);
      db.prepare(`INSERT INTO source_entity(id,source_id,external_kind,external_key,entity_id,page_url)
        VALUES (?,?,'album',?,?,?)`).run(source.id, data.sourceId, data.externalKey, source.entity_id, data.pageUrl);
    }
    const albumId = source.entity_id!;
    const previousKindId = kind === "album" ? state?.detail_observation_id : state?.summary_observation_id;
    const previousKind = previousKindId ? this.observation(previousKindId) : null;
    if (db.prepare(`SELECT 1 FROM catalog_observation WHERE source_entity_id=? AND kind=? AND captured_at=? AND data_sha256<>? LIMIT 1`)
      .get(source.id, kind, provenance.capturedAt, dataHash))
      throw new CatalogError("observation_conflict", "Conflicting data at the same capture time requires review");
    const promote = !previousKind || provenance.capturedAt > previousKind.captured_at;
    const observationId = randomUUID();
    db.prepare(`INSERT INTO catalog_observation(id,source_entity_id,kind,sample_kind,page_url,captured_at,parsed_at,parser_version,
      body_sha256,fingerprint,data_sha256,tracks_sha256,data_json,page_context_json,warnings_json${lease ? ",retention_revision,expires_at" : ""})
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${lease ? ",?,?" : ""})`)
      .run(observationId, source.id, kind, provenance.sampleKind, provenance.pageUrl, provenance.capturedAt, parsedAt, provenance.parserVersion,
        provenance.bodySha256, fingerprint, dataHash, trackHash, JSON.stringify(data), pageContext ? JSON.stringify(pageContext) : null, JSON.stringify(warnings),
        ...(lease ? [lease.policyRevision, lease.expiresAt] : []));
    const fields: Record<string, unknown> = { title: data.title, titleKind: data.titleKind, platforms: data.platforms,
      sourceCategory: data.sourceCategory, sourceYearLabel: data.sourceYearLabel };
    if ("tracks" in data) { fields.sourceClaims = data.sourceClaims; fields.releaseDate = data.releaseDate; }
    for (const [field, value] of Object.entries(fields)) this.assertion(albumId, source.id, observationId, provenance.capturedAt, field, value);

    if (!state) {
      state = { album_id: albumId, source_entity_id: source.id, latest_observation_id: observationId,
        summary_observation_id: kind === "search" ? observationId : null,
        detail_observation_id: kind === "album" ? observationId : null,
        title_observation_id: observationId, tracks_observation_id: kind === "album" ? observationId : null };
      db.prepare(`INSERT INTO catalog_album_state VALUES (@album_id,@source_entity_id,@latest_observation_id,
        @summary_observation_id,@detail_observation_id,@title_observation_id,@tracks_observation_id)`).run(state);
    } else if (promote) {
      if (kind === "album") state.detail_observation_id = observationId;
      else state.summary_observation_id = observationId;
      state.title_observation_id = state.detail_observation_id ?? state.summary_observation_id!;
      if (kind === "album" && !state.tracks_observation_id) state.tracks_observation_id = observationId;
      const latest = this.observation(state.latest_observation_id);
      if (provenance.capturedAt > latest.captured_at || (provenance.capturedAt === latest.captured_at && kind === "album"))
        state.latest_observation_id = observationId;
      db.prepare(`UPDATE catalog_album_state SET latest_observation_id=@latest_observation_id,
        summary_observation_id=@summary_observation_id,detail_observation_id=@detail_observation_id,
        title_observation_id=@title_observation_id,tracks_observation_id=@tracks_observation_id
        WHERE album_id=@album_id AND source_entity_id=@source_entity_id`).run(state);
    }
    if (state.tracks_observation_id === observationId && "tracks" in data) {
      // Allocate UUIDs only at the initial baseline. A changed keyless list never edits these rows.
      for (const track of data.tracks) {
        const trackId = randomUUID();
        db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'track',?)").run(trackId, new Date().toISOString());
        db.prepare(`INSERT INTO track(id,album_id,position,disc_label,track_label,title,duration_ms) VALUES (?,?,?,?,?,?,?)`)
          .run(trackId, albumId, track.position, track.discLabel, track.displayNumber, track.title,
            track.durationSeconds === null ? null : track.durationSeconds * 1000);
        db.prepare("INSERT INTO catalog_track_origin VALUES (?,?,?)").run(trackId, observationId, track.snapshotLocator);
        db.prepare("INSERT INTO catalog_track_binding VALUES (?,?,?)").run(observationId, track.position, trackId);
        this.assertion(trackId, source.id, observationId, provenance.capturedAt, "track", track);
      }
    }
    if (promote) {
      // Search summaries never revive expired detail titles.
      if (observationIsActive(db, state.title_observation_id)) {
        const title = JSON.parse(this.observation(state.title_observation_id).data_json) as AlbumObservationData;
        db.prepare("UPDATE album SET title=? WHERE id=?").run(title.title, albumId);
      }
      if (state.latest_observation_id === observationId)
        db.prepare("UPDATE source_entity SET page_url=?,fetched_at=?,parser_version=? WHERE id=?")
          .run(data.pageUrl, provenance.capturedAt, provenance.parserVersion, source.id);
    }
    return { albumId, sourceEntityId: source.id, observationId, outcome: promote ? "applied" : "historical" };
  }

  private assertion(entityId: string, sourceId: string, observationId: string, observedAt: string, field: string, value: unknown) {
    this.db.prepare(`INSERT INTO assertion(id,entity_id,source_entity_id,field,value_json,observed_at,method,observation_id)
      VALUES (?,?,?,?,?,?,'source',?)`).run(randomUUID(), entityId, sourceId, field, JSON.stringify(value), observedAt, observationId);
  }
}
