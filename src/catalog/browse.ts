import type Database from "better-sqlite3";
import { z } from "zod";
import { CatalogLibraryError, CatalogLibraryStore } from "../library/catalog.ts";
import type { CatalogAlbumDetail, CatalogAlbumPage, CatalogCandidates, CatalogEntry } from "../shared/catalog-browse.ts";
import { readManagedEntity } from "./entities.ts";
import { availableAlbums, readAlbumIds } from "./album-query.ts";
import { reconcileCatalogRetention } from "./retention.ts";

const pagination = z.object({ limit: z.coerce.number().int().min(1).max(100).default(12), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
const search = pagination.extend({ q: z.string().trim().max(200).default(""), sourceId: z.enum(["khinsider", "zophar"]).optional() });
// The current observation's (observation_id, position) key bounds and orders detail paging.
const currentTracks = `SELECT t.id,t.track_label AS displayNumber,t.disc_label AS discLabel
  FROM catalog_album_state c JOIN catalog_track_binding b ON b.observation_id=c.tracks_observation_id
  JOIN track t ON t.id=b.track_id AND t.album_id=c.album_id JOIN entity e ON e.id=t.id
  JOIN catalog_track_origin origin ON origin.track_id=t.id
  JOIN catalog_observation o ON o.id=origin.observation_id AND o.source_entity_id=c.source_entity_id
  JOIN catalog_observation adopted ON adopted.id=c.tracks_observation_id AND adopted.content_state='active'
  WHERE c.album_id=? AND e.lifecycle='active' ORDER BY b.position LIMIT ? OFFSET ?`;

/** Synchronous reads under the HTTP forUser/withDatabase boundary. No ingestion or network calls. */
export class CatalogBrowseStore {
  readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }
  private entry(userId: string, entityId: string): CatalogEntry {
    const entity = readManagedEntity(this.db, entityId);
    if (!entity) throw new CatalogLibraryError("not_found", "Catalog entry not found");
    const saved = this.db.prepare(`SELECT id FROM library_item WHERE user_id=@userId AND entity_id=@entityId UNION ALL
      SELECT id FROM catalog_detached_item WHERE user_id=@userId AND entity_id=@entityId`).get({ userId, entityId }) as { id: string } | undefined;
    return { entity, savedItemId: saved?.id ?? null };
  }
  private albums(userId: string, options: z.infer<typeof search>, excludeSource?: string): CatalogAlbumPage {
    const ids = readAlbumIds(this.db, options, excludeSource ? { userId, sourceEntityId: excludeSource } : undefined);
    return { items: ids.slice(0, options.limit).map((id) => this.entry(userId, id)), nextOffset: ids.length > options.limit ? options.offset + options.limit : null };
  }
  list(userId: string, input: unknown): CatalogAlbumPage {
    const options = search.parse(input);
    return this.db.transaction(() => this.albums(userId, options)).deferred();
  }
  detail(userId: string, albumId: string, input: unknown): CatalogAlbumDetail {
    reconcileCatalogRetention(this.db);
    z.uuid().parse(albumId); const options = pagination.parse(input);
    return this.db.transaction(() => {
      const exists = this.db.prepare(`${availableAlbums} AND a.id=?`).get(albumId);
      if (!exists) throw new CatalogLibraryError("not_found", "Available managed album not found");
      const state = this.db.prepare(`SELECT CASE WHEN baseline.id IS NULL THEN 'not_loaded'
        WHEN baseline.content_state='active' AND baseline.tracks_sha256=detail.tracks_sha256 THEN 'unchanged' ELSE 'review_required' END AS trackState
        FROM catalog_album_state c LEFT JOIN catalog_observation baseline ON baseline.id=c.tracks_observation_id
        LEFT JOIN catalog_observation detail ON detail.id=c.detail_observation_id WHERE c.album_id=?`)
        .get(albumId) as Pick<CatalogAlbumDetail, "trackState">;
      const rows = this.db.prepare(currentTracks).all(albumId, options.limit + 1, options.offset) as { id: string; displayNumber: string | null; discLabel: string | null }[];
      const tracks = rows.slice(0, options.limit).map(({ id, ...labels }) => ({ ...this.entry(userId, id), ...labels }));
      return { album: this.entry(userId, albumId), trackState: state.trackState, tracks, nextOffset: rows.length > options.limit ? options.offset + options.limit : null };
    }).deferred();
  }
  candidates(userId: string, itemId: string, input: unknown): CatalogCandidates {
    reconcileCatalogRetention(this.db);
    const options = search.parse(input);
    return this.db.transaction(() => {
      const item = new CatalogLibraryStore(this.db).get(userId, itemId);
      if (item.entity.kind !== "album") throw new CatalogLibraryError("invalid_connection", "Only albums admit personal source candidates");
      if (item.entity.contentState === "unresolved" || !this.db.prepare(`${availableAlbums} AND a.id=?`).get(item.entity.id))
        throw new CatalogLibraryError("catalog_unavailable", "Saved album is unavailable for new connections");
      const remainingSlots = Math.max(0, 20 - item.sourceLinks.length);
      return { target: item, itemId, version: item.version, remainingSlots, ...(remainingSlots ? this.albums(userId, options, item.entity.sourceEntityId) : { items: [], nextOffset: null }) };
    }).deferred();
  }
}
