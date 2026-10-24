-- Disposable normalized metadata, independent of canonical entities and private libraries.
CREATE TABLE source_metadata_cache (
  source_id TEXT NOT NULL CHECK (source_id IN ('khinsider','zophar')),
  kind TEXT NOT NULL CHECK (kind IN ('search','album')),
  request_key TEXT NOT NULL,
  sample_kind TEXT NOT NULL CHECK (sample_kind IN ('synthetic','live-capture')),
  parser_version TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  fresh_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 8388608),
  CHECK (captured_at <= fresh_until AND fresh_until <= expires_at),
  PRIMARY KEY (source_id, kind, request_key, sample_kind)
) STRICT;

-- Rights/policy removal invalidates all search pages for that source, including old parser versions.
CREATE TRIGGER catalog_removal_purge_source_cache AFTER INSERT ON catalog_removal
BEGIN
  DELETE FROM source_metadata_cache
  WHERE source_id=(SELECT source_id FROM source_entity WHERE id=NEW.source_entity_id)
    AND (kind='search' OR request_key=(SELECT external_key FROM source_entity WHERE id=NEW.source_entity_id));
END;
