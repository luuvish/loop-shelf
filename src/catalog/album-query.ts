import type Database from "better-sqlite3";
import { normalizeSearch } from "../database/connection.ts";
import type { SourceId } from "../sources/types.ts";
import { reconcileCatalogRetention } from "./retention.ts";

// Preserve the measured album-first plan, including on databases without ANALYZE statistics.
export const availableAlbums = `SELECT a.id FROM album a CROSS JOIN entity e ON e.id=a.id
  JOIN catalog_album_state c ON c.album_id=a.id JOIN source_entity s ON s.id=c.source_entity_id
  JOIN catalog_source_kind sk ON sk.source_entity_id=s.id AND sk.sample_kind='synthetic'
  JOIN catalog_observation retained_title ON retained_title.id=c.title_observation_id AND retained_title.content_state='active'
  WHERE e.lifecycle='active' AND s.availability IN ('unverified','available')
  AND NOT EXISTS (SELECT 1 FROM catalog_removal r WHERE r.album_id=a.id)`;

export interface AlbumQuery { q: string; limit: number; offset: number; sourceId?: SourceId | undefined }
/** Caller owns the database boundary. Returns one extra row for pagination. */
export function readAlbumIds(db: Database.Database, options: AlbumQuery, exclude?: { userId: string; sourceEntityId: string }): string[] {
  reconcileCatalogRetention(db);
  const params: Record<string, string | number> = { limit: options.limit + 1, offset: options.offset, q: normalizeSearch(options.q) };
  let filter = " AND instr(normalize_search(a.title),@q)>0";
  if (options.sourceId) { filter += " AND s.source_id=@sourceId"; params.sourceId = options.sourceId; }
  if (exclude) {
    filter += " AND s.id<>@excludeSource AND NOT EXISTS (SELECT 1 FROM user_source_link l WHERE l.user_id=@userId AND l.source_entity_id=s.id)";
    filter += " AND NOT EXISTS (SELECT 1 FROM catalog_detached_link l WHERE l.user_id=@userId AND l.source_entity_id=s.id)";
    params.excludeSource = exclude.sourceEntityId; params.userId = exclude.userId;
  }
  return (db.prepare(`${availableAlbums}${filter} ORDER BY normalize_search(a.title),s.source_id,s.external_key,a.id LIMIT @limit OFFSET @offset`)
    .all(params) as { id: string }[]).map((row) => row.id);
}
