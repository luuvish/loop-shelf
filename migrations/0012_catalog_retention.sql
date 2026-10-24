-- Rebuild only the parent with all dependent rows safely staged inside migrate's transaction.
-- No foreign_keys override, writable_schema, UUID replacement or changes to prior migrations.
CREATE TEMP TABLE saved_state AS SELECT * FROM catalog_album_state;
CREATE TEMP TABLE saved_origin AS SELECT * FROM catalog_track_origin;
CREATE TEMP TABLE saved_binding AS SELECT * FROM catalog_track_binding;
CREATE TEMP TABLE saved_adoption AS SELECT * FROM catalog_track_adoption;
CREATE TEMP TABLE saved_assertion AS SELECT * FROM assertion WHERE observation_id IS NOT NULL;
CREATE TEMP TABLE saved_observation AS SELECT * FROM catalog_observation;
DROP TRIGGER catalog_track_binding_no_delete;
DROP TRIGGER catalog_track_adoption_no_delete;
DELETE FROM catalog_track_adoption;
DELETE FROM catalog_track_binding;
DELETE FROM catalog_track_origin;
DELETE FROM catalog_album_state;
DELETE FROM assertion WHERE observation_id IS NOT NULL;
DROP TABLE catalog_observation;
CREATE TABLE catalog_observation (
  id TEXT PRIMARY KEY NOT NULL,
  source_entity_id TEXT NOT NULL REFERENCES source_entity(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('search','album')),
  sample_kind TEXT NOT NULL CHECK (sample_kind IN ('synthetic','live-capture')),
  page_url TEXT NOT NULL,
  captured_at TEXT NOT NULL, parsed_at TEXT NOT NULL, parser_version TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  data_sha256 TEXT NOT NULL CHECK (length(data_sha256) = 64),
  tracks_sha256 TEXT CHECK (length(tracks_sha256) = 64),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  page_context_json TEXT CHECK (page_context_json IS NULL OR json_valid(page_context_json)),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  retention_revision TEXT, expires_at TEXT,
  content_state TEXT NOT NULL DEFAULT 'active' CHECK (content_state IN ('active','expired','policy_revoked')),
  CHECK ((kind = 'album') = (tracks_sha256 IS NOT NULL)),
  CHECK ((kind = 'search') = (page_context_json IS NOT NULL)),
  CHECK ((retention_revision IS NULL) = (expires_at IS NULL)),
  CHECK (sample_kind='synthetic' OR (retention_revision IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (retention_revision IS NULL OR length(trim(retention_revision)) BETWEEN 1 AND 200),
  CHECK (expires_at IS NULL OR (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(captured_at))),
  CHECK (content_state='active' OR (data_json='{}' AND warnings_json='[]' AND (kind='album' OR page_context_json='{}'))),
  UNIQUE (source_entity_id, fingerprint), UNIQUE (id, source_entity_id)
) STRICT;
CREATE INDEX catalog_observation_source_idx ON catalog_observation(source_entity_id, captured_at);
-- Measured separately with 10,000 observations; exclude legacy unleased and already redacted rows.
CREATE INDEX catalog_observation_retention_idx ON catalog_observation(sample_kind,expires_at)
  WHERE content_state='active' AND expires_at IS NOT NULL;

INSERT INTO catalog_observation(id,source_entity_id,kind,sample_kind,page_url,captured_at,parsed_at,parser_version,body_sha256,fingerprint,data_sha256,tracks_sha256,data_json,page_context_json,warnings_json) SELECT id,source_entity_id,kind,sample_kind,page_url,captured_at,parsed_at,parser_version,body_sha256,fingerprint,data_sha256,tracks_sha256,data_json,page_context_json,warnings_json FROM saved_observation;

-- The original insertion guards remain active while references are restored.
INSERT INTO catalog_album_state SELECT * FROM saved_state;
-- Origins originally belonged to older baselines, so restore these proven rows before reinstalling that guard.
DROP TRIGGER catalog_track_origin_insert;
INSERT INTO catalog_track_origin SELECT * FROM saved_origin;
INSERT INTO catalog_track_binding SELECT * FROM saved_binding;
DROP TRIGGER catalog_track_adoption_insert;
INSERT INTO catalog_track_adoption SELECT * FROM saved_adoption;
INSERT INTO assertion SELECT * FROM saved_assertion;
DROP TABLE saved_state; DROP TABLE saved_origin; DROP TABLE saved_binding;
DROP TABLE saved_adoption; DROP TABLE saved_assertion; DROP TABLE saved_observation;
CREATE TRIGGER catalog_track_origin_insert BEFORE INSERT ON catalog_track_origin
WHEN NOT EXISTS (
  SELECT 1 FROM track t JOIN catalog_album_state s ON s.album_id=t.album_id
  WHERE t.id=NEW.track_id AND s.tracks_observation_id=NEW.observation_id
)
BEGIN SELECT RAISE(ABORT, 'Track origin must reference its album baseline'); END;
CREATE TRIGGER removed_observation_no_insert BEFORE INSERT ON catalog_observation
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id)
BEGIN SELECT RAISE(ABORT, 'Removed source cannot retain observations'); END;
CREATE TRIGGER removed_observation_no_update BEFORE UPDATE ON catalog_observation
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id OR source_entity_id=OLD.source_entity_id)
BEGIN SELECT RAISE(ABORT, 'Removed source cannot retain observations'); END;
CREATE TRIGGER catalog_track_binding_no_delete BEFORE DELETE ON catalog_track_binding
WHEN NOT EXISTS (SELECT 1 FROM catalog_observation o JOIN catalog_removal r ON r.source_entity_id=o.source_entity_id WHERE o.id=OLD.observation_id)
BEGIN SELECT RAISE(ABORT, 'Track binding may only be purged with source content'); END;
CREATE TRIGGER catalog_track_adoption_no_delete BEFORE DELETE ON catalog_track_adoption
WHEN NOT EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=OLD.source_entity_id)
BEGIN SELECT RAISE(ABORT, 'Track adoption may only be purged with source content'); END;
CREATE TRIGGER catalog_track_adoption_insert BEFORE INSERT ON catalog_track_adoption
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id)
  OR NOT EXISTS (SELECT 1 FROM catalog_observation WHERE id=NEW.base_observation_id AND kind='album')
  OR NOT EXISTS (SELECT 1 FROM catalog_album_state WHERE album_id=NEW.album_id
    AND source_entity_id=NEW.source_entity_id AND detail_observation_id=NEW.observation_id AND tracks_observation_id=NEW.observation_id)
BEGIN SELECT RAISE(ABORT, 'Track adoption must match the active album detail'); END;

-- A source identity never changes between fixture and captured data, including after removal.
CREATE TABLE catalog_source_kind (
  source_entity_id TEXT PRIMARY KEY NOT NULL REFERENCES source_entity(id) ON DELETE RESTRICT,
  sample_kind TEXT NOT NULL CHECK (sample_kind IN ('synthetic','live-capture'))
) STRICT;
INSERT INTO catalog_source_kind SELECT source_entity_id,'synthetic' FROM catalog_album_state
  UNION SELECT source_entity_id,'synthetic' FROM catalog_removal;
CREATE TRIGGER catalog_kind_no_update BEFORE UPDATE ON catalog_source_kind
BEGIN SELECT RAISE(ABORT,'Catalog sample kind is immutable'); END;
CREATE TRIGGER catalog_kind_no_delete BEFORE DELETE ON catalog_source_kind
BEGIN SELECT RAISE(ABORT,'Catalog sample kind must survive removal'); END;
CREATE TRIGGER catalog_observation_kind BEFORE INSERT ON catalog_observation
BEGIN
  INSERT OR IGNORE INTO catalog_source_kind VALUES (NEW.source_entity_id,NEW.sample_kind);
  SELECT CASE WHEN (SELECT sample_kind FROM catalog_source_kind WHERE source_entity_id=NEW.source_entity_id)<>NEW.sample_kind
    THEN RAISE(ABORT,'Catalog sample kind conflict') END;
END;
CREATE TRIGGER catalog_observation_identity BEFORE UPDATE ON catalog_observation
WHEN NEW.id<>OLD.id OR NEW.source_entity_id<>OLD.source_entity_id OR NEW.sample_kind<>OLD.sample_kind
  OR NEW.captured_at<>OLD.captured_at OR NEW.fingerprint<>OLD.fingerprint
  OR (OLD.retention_revision IS NOT NULL AND (NEW.retention_revision IS NOT OLD.retention_revision OR NEW.expires_at IS NOT OLD.expires_at))
  OR (OLD.content_state<>'active' AND NEW.content_state<>OLD.content_state)
BEGIN SELECT RAISE(ABORT,'Observation identity, retention and expired state are immutable'); END;
DROP TRIGGER catalog_track_origin_immutable;
CREATE TRIGGER catalog_track_origin_immutable BEFORE UPDATE ON catalog_track_origin
WHEN NEW.track_id<>OLD.track_id OR NEW.observation_id<>OLD.observation_id
  OR NOT EXISTS(SELECT 1 FROM catalog_observation WHERE id=OLD.observation_id AND content_state<>'active')
  OR NEW.snapshot_locator<>NEW.track_id
BEGIN SELECT RAISE(ABORT,'Track origin is immutable except expired locator redaction'); END;
CREATE TRIGGER catalog_observation_redacted BEFORE UPDATE ON catalog_observation
WHEN NEW.content_state<>'active' AND (NEW.data_json<>'{}' OR NEW.warnings_json<>'[]'
  OR (NEW.kind='search' AND NEW.page_context_json<>'{}'))
BEGIN SELECT RAISE(ABORT,'Expired observation cannot retain metadata'); END;
