// Check album-level availability/evidence once per album. The normalized-title index avoids
// repeated JS normalization and starts the sort; only current bindings admit results.
export function trackIndexPageQuery(filter: string) {
  return `SELECT s.track_id AS id,s.album_id AS albumId,s.sort_title AS sortTitle,s.source_entity_id AS sourceEntityId,
    s.source_id AS sourceId,s.external_key AS externalKey,s.position,s.observation_id AS observationId
    FROM catalog_track_search_index s WHERE instr(s.sort_title,@q)>0${filter}
    ORDER BY s.sort_title,s.source_id,s.external_key,s.position,s.track_id LIMIT @limit OFFSET @offset`;
}
export function trackQuery(filter: string, mode: "page" | "anchor" | "after" | "window" | "ordered-window" | "indexed-page" = "page", windowAfter = false) {
  const after = mode === "after" || (mode === "window" || mode === "ordered-window") && windowAfter;
  return `WITH ${mode === "window" ? `source_window AS MATERIALIZED (
    SELECT s.* FROM source_entity s WHERE s.external_kind='album'${filter}
    ${windowAfter ? "AND (s.source_id,s.external_key)>=(@afterSource,@afterKey)" : ""}
    ORDER BY s.source_id,s.external_key LIMIT 256
  ), ` : mode === "ordered-window" ? `track_window AS MATERIALIZED (
    SELECT t.id,t.album_id,normalize_search(t.title) AS sortTitle,s.source_id,s.external_key,b.position
    FROM track t INDEXED BY catalog_track_search_title_idx
    CROSS JOIN catalog_album_state c ON c.album_id=t.album_id
    CROSS JOIN source_entity s ON s.id=c.source_entity_id
    CROSS JOIN catalog_track_binding b ON b.observation_id=c.tracks_observation_id AND b.track_id=t.id
    WHERE instr(normalize_search(t.title),@q)>0 AND s.availability IN ('unverified','available')${filter}
    ${after ? `AND normalize_search(t.title)>=@afterTitle
    AND (normalize_search(t.title),s.source_id,s.external_key,b.position,t.id)>(@afterTitle,@afterSource,@afterKey,@afterPosition,@afterId)` : ""}
    ORDER BY sortTitle,s.source_id,s.external_key,b.position,t.id LIMIT 256
  ), ` : mode === "indexed-page" ? `indexed_page AS MATERIALIZED (${trackIndexPageQuery(filter)}), ` : ""}eligible AS MATERIALIZED (
    SELECT a.id AS albumId,a.title AS albumTitle,s.id AS sourceEntityId,s.source_id AS sourceId,s.external_key AS externalKey,s.page_url AS pageUrl,
      adopted.id AS observationId,adopted.captured_at AS capturedAt,adopted.parser_version AS parserVersion,adopted.expires_at AS expiresAt,
      title_evidence.id AS titleObservationId,title_evidence.captured_at AS titleCapturedAt,
      title_evidence.parser_version AS titleParserVersion,title_evidence.expires_at AS titleExpiresAt,
      CASE WHEN adopted.tracks_sha256=latest.tracks_sha256 AND latest.content_state='active' THEN 'unchanged' ELSE 'review_required' END AS trackState
    ${mode === "window" ? `FROM source_window s CROSS JOIN catalog_album_state c ON c.source_entity_id=s.id
    CROSS JOIN album a ON a.id=c.album_id CROSS JOIN entity album_entity ON album_entity.id=a.id` : `${mode === "indexed-page" ?
      "FROM (SELECT DISTINCT albumId FROM indexed_page) candidate_albums CROSS JOIN album a ON a.id=candidate_albums.albumId" : mode === "ordered-window" ?
      "FROM (SELECT DISTINCT album_id FROM track_window) candidate_albums CROSS JOIN album a ON a.id=candidate_albums.album_id" : "FROM album a"} CROSS JOIN entity album_entity ON album_entity.id=a.id
    JOIN catalog_album_state c ON c.album_id=a.id JOIN source_entity s ON s.id=c.source_entity_id`}
    JOIN catalog_source_kind sk ON sk.source_entity_id=s.id AND sk.sample_kind='synthetic'
    JOIN catalog_observation title_evidence ON title_evidence.id=c.title_observation_id AND title_evidence.content_state='active'
    JOIN catalog_observation adopted ON adopted.id=c.tracks_observation_id AND adopted.content_state='active'
    LEFT JOIN catalog_observation latest ON latest.id=c.detail_observation_id
    WHERE album_entity.lifecycle='active' AND s.availability IN ('unverified','available')
    AND NOT EXISTS (SELECT 1 FROM catalog_removal r WHERE r.album_id=a.id)${filter}
    ${mode === "anchor" ? "AND a.id=(SELECT album_id FROM track WHERE id=@anchorId)" : ""}
  ), hits AS MATERIALIZED (
    SELECT t.id,b.position,e.albumId,normalize_search(t.title) AS sortTitle,e.sourceId,e.externalKey
    ${mode === "indexed-page" || mode === "ordered-window" ? `FROM ${mode === "indexed-page" ? "indexed_page" : "track_window"} candidate CROSS JOIN track t ON t.id=candidate.id CROSS JOIN eligible e ON e.albumId=t.album_id` : mode === "window" ? `FROM eligible e CROSS JOIN track t INDEXED BY catalog_track_search_title_idx ON t.album_id=e.albumId` :
      `FROM track t ${mode === "anchor" ? "" : "INDEXED BY catalog_track_search_title_idx"} CROSS JOIN eligible e ON e.albumId=t.album_id`}
    CROSS JOIN catalog_track_binding b ON b.observation_id=e.observationId AND b.track_id=t.id
    CROSS JOIN entity track_entity ON track_entity.id=t.id
    JOIN catalog_track_origin origin ON origin.track_id=t.id
    JOIN catalog_observation first_seen ON first_seen.id=origin.observation_id AND first_seen.source_entity_id=e.sourceEntityId
    WHERE track_entity.lifecycle='active' AND ${mode === "window" ? "normalize_search(t.title)=@firstTitle" : "instr(normalize_search(t.title),@q)>0"}
    ${mode === "anchor" ? "AND t.id=@anchorId" : ""}
    ${after ? `AND normalize_search(t.title)>=@afterTitle
    AND (normalize_search(t.title),e.sourceId,e.externalKey,b.position,t.id)>(@afterTitle,@afterSource,@afterKey,@afterPosition,@afterId)` : ""}
    ORDER BY sortTitle,e.sourceId,e.externalKey,b.position,t.id LIMIT @limit ${mode === "page" ? "OFFSET @offset" : ""}
  ) SELECT t.id,t.title,h.sortTitle,h.position,t.track_label AS displayNumber,t.disc_label AS discLabel,t.duration_ms AS durationMs,e.*
    ${mode === "ordered-window" ? ",(SELECT count(*) FROM track_window) AS candidateCount" : ""}
    FROM hits h JOIN track t ON t.id=h.id JOIN eligible e ON e.albumId=h.albumId
    ORDER BY h.sortTitle,h.sourceId,h.externalKey,h.position,h.id`;
}

