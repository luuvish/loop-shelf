-- Source observations are evidence, not cross-source identity decisions.
CREATE UNIQUE INDEX source_entity_mapping_idx ON source_entity(id, entity_id);
CREATE TABLE catalog_observation (
  id TEXT PRIMARY KEY NOT NULL,
  source_entity_id TEXT NOT NULL REFERENCES source_entity(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('search','album')),
  sample_kind TEXT NOT NULL CHECK (sample_kind = 'synthetic'),
  page_url TEXT NOT NULL,
  captured_at TEXT NOT NULL, parsed_at TEXT NOT NULL, parser_version TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  data_sha256 TEXT NOT NULL CHECK (length(data_sha256) = 64),
  tracks_sha256 TEXT CHECK (length(tracks_sha256) = 64),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  page_context_json TEXT CHECK (page_context_json IS NULL OR json_valid(page_context_json)),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  CHECK ((kind = 'album') = (tracks_sha256 IS NOT NULL)),
  CHECK ((kind = 'search') = (page_context_json IS NOT NULL)),
  UNIQUE (source_entity_id, fingerprint), UNIQUE (id, source_entity_id)
) STRICT;
CREATE INDEX catalog_observation_source_idx ON catalog_observation(source_entity_id, captured_at);

CREATE TABLE catalog_album_state (
  album_id TEXT PRIMARY KEY NOT NULL REFERENCES album(id) ON DELETE RESTRICT,
  source_entity_id TEXT NOT NULL UNIQUE,
  latest_observation_id TEXT NOT NULL,
  summary_observation_id TEXT,
  detail_observation_id TEXT,
  title_observation_id TEXT NOT NULL,
  tracks_observation_id TEXT,
  FOREIGN KEY (source_entity_id, album_id) REFERENCES source_entity(id, entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (latest_observation_id, source_entity_id) REFERENCES catalog_observation(id, source_entity_id),
  FOREIGN KEY (summary_observation_id, source_entity_id) REFERENCES catalog_observation(id, source_entity_id),
  FOREIGN KEY (detail_observation_id, source_entity_id) REFERENCES catalog_observation(id, source_entity_id),
  FOREIGN KEY (title_observation_id, source_entity_id) REFERENCES catalog_observation(id, source_entity_id),
  FOREIGN KEY (tracks_observation_id, source_entity_id) REFERENCES catalog_observation(id, source_entity_id)
) STRICT;
CREATE TRIGGER catalog_state_kinds_insert BEFORE INSERT ON catalog_album_state
WHEN (NEW.summary_observation_id IS NOT NULL AND (SELECT kind FROM catalog_observation WHERE id=NEW.summary_observation_id) <> 'search')
  OR (NEW.detail_observation_id IS NOT NULL AND (SELECT kind FROM catalog_observation WHERE id=NEW.detail_observation_id) <> 'album')
  OR (NEW.tracks_observation_id IS NOT NULL AND (SELECT kind FROM catalog_observation WHERE id=NEW.tracks_observation_id) <> 'album')
BEGIN SELECT RAISE(ABORT, 'Catalog observation kind mismatch'); END;
CREATE TRIGGER catalog_state_kinds_update BEFORE UPDATE ON catalog_album_state
WHEN NEW.album_id <> OLD.album_id OR NEW.source_entity_id <> OLD.source_entity_id
  OR (NEW.summary_observation_id IS NOT NULL AND (SELECT kind FROM catalog_observation WHERE id=NEW.summary_observation_id) <> 'search')
  OR (NEW.detail_observation_id IS NOT NULL AND (SELECT kind FROM catalog_observation WHERE id=NEW.detail_observation_id) <> 'album')
  OR (NEW.tracks_observation_id IS NOT NULL AND (SELECT kind FROM catalog_observation WHERE id=NEW.tracks_observation_id) <> 'album')
BEGIN SELECT RAISE(ABORT, 'Catalog identity or observation kind mismatch'); END;
CREATE TRIGGER catalog_source_identity BEFORE UPDATE ON source_entity
WHEN EXISTS (SELECT 1 FROM catalog_album_state WHERE source_entity_id=OLD.id)
 AND (NEW.id <> OLD.id OR NEW.source_id <> OLD.source_id OR NEW.external_kind <> OLD.external_kind
   OR NEW.external_key <> OLD.external_key OR NEW.entity_id IS NOT OLD.entity_id)
BEGIN SELECT RAISE(ABORT, 'Managed catalog source identity is immutable'); END;

CREATE TABLE catalog_track_origin (
  track_id TEXT PRIMARY KEY NOT NULL REFERENCES track(id) ON DELETE RESTRICT,
  observation_id TEXT NOT NULL REFERENCES catalog_observation(id) ON DELETE RESTRICT,
  snapshot_locator TEXT NOT NULL,
  UNIQUE (observation_id, snapshot_locator)
) STRICT;
CREATE TRIGGER catalog_track_origin_insert BEFORE INSERT ON catalog_track_origin
WHEN NOT EXISTS (
  SELECT 1 FROM track t JOIN catalog_album_state s ON s.album_id=t.album_id
  WHERE t.id=NEW.track_id AND s.tracks_observation_id=NEW.observation_id
)
BEGIN SELECT RAISE(ABORT, 'Track origin must reference its album baseline'); END;
CREATE TRIGGER catalog_track_origin_immutable BEFORE UPDATE ON catalog_track_origin
BEGIN SELECT RAISE(ABORT, 'Track origin is immutable'); END;

ALTER TABLE assertion ADD COLUMN observation_id TEXT REFERENCES catalog_observation(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX assertion_observation_field_idx ON assertion(observation_id, entity_id, field);
CREATE TRIGGER assertion_observation_source_insert BEFORE INSERT ON assertion
WHEN NEW.observation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM catalog_observation o JOIN source_entity s ON s.id=o.source_entity_id
  WHERE o.id=NEW.observation_id AND o.source_entity_id=NEW.source_entity_id
    AND (NEW.entity_id=s.entity_id OR EXISTS (SELECT 1 FROM track WHERE id=NEW.entity_id AND album_id=s.entity_id))
)
BEGIN SELECT RAISE(ABORT, 'Assertion observation source mismatch'); END;
CREATE TRIGGER assertion_observation_source_update BEFORE UPDATE ON assertion
WHEN NEW.observation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM catalog_observation o JOIN source_entity s ON s.id=o.source_entity_id
  WHERE o.id=NEW.observation_id AND o.source_entity_id=NEW.source_entity_id
    AND (NEW.entity_id=s.entity_id OR EXISTS (SELECT 1 FROM track WHERE id=NEW.entity_id AND album_id=s.entity_id))
)
BEGIN SELECT RAISE(ABORT, 'Assertion observation source mismatch'); END;
