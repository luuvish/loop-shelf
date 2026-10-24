import type Database from "better-sqlite3";
import { readAlbumIds, type AlbumQuery } from "../catalog/album-query.ts";
import type { LocalSearchAlbum, LocalSearchResult } from "../shared/search.ts";
import type { Provenance } from "../sources/types.ts";

type Row = Omit<LocalSearchAlbum, "identity" | "provenance"> & Omit<Provenance, "sourceId" | "pageUrl"> & { evidenceUrl: string };

/** Public metadata only; caller owns withDatabase. Never reads user/library tables. */
export function readLocalAlbums(db: Database.Database, query: AlbumQuery, sampleKind: Provenance["sampleKind"]): LocalSearchResult {
  // The managed catalog only admits synthetic observations today. Do not misreport live search as an empty catalog.
  if (sampleKind !== "synthetic") return { ok: false, code: "sample_kind_unavailable", stage: "search" };
  return db.transaction((): LocalSearchResult => {
    const ids = readAlbumIds(db, query);
    const items = ids.slice(0, query.limit).map((id): LocalSearchAlbum => {
      const row = db.prepare(`SELECT a.id,a.title,s.id AS sourceEntityId,s.source_id AS sourceId,s.external_key AS externalKey,
        s.page_url AS pageUrl,json_extract(o.data_json,'$.titleKind') AS titleKind,o.page_url AS evidenceUrl,
        o.captured_at AS capturedAt,o.parsed_at AS parsedAt,o.parser_version AS parserVersion,o.body_sha256 AS bodySha256,o.sample_kind AS sampleKind
        FROM album a JOIN catalog_album_state c ON c.album_id=a.id JOIN source_entity s ON s.id=c.source_entity_id
        JOIN catalog_observation o ON o.id=c.title_observation_id AND o.source_entity_id=s.id WHERE a.id=?`).get(id) as Row;
      if (row.sampleKind !== sampleKind) throw new Error("Unexpected catalog sample kind");
      const { capturedAt, parsedAt, parserVersion, bodySha256, sampleKind: kind, evidenceUrl, ...album } = row;
      return { ...album, identity: "source-provisional", provenance: { sourceId: row.sourceId, pageUrl: evidenceUrl,
        capturedAt, parsedAt, parserVersion, bodySha256, sampleKind: kind } };
    });
    return { ok: true, sampleKind, freshness: "not-revalidated", items, nextOffset: ids.length > query.limit ? query.offset + query.limit : null };
  }).deferred();
}
