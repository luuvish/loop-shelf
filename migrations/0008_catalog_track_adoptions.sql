-- Track.position remains its stable allocation slot. Adopted list positions live in bindings.
CREATE TABLE catalog_track_binding (
  observation_id TEXT NOT NULL REFERENCES catalog_observation(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5000),
  track_id TEXT NOT NULL REFERENCES track(id) ON DELETE RESTRICT,
  PRIMARY KEY (observation_id, position),
  UNIQUE (observation_id, track_id)
) STRICT;
INSERT INTO catalog_track_binding(observation_id,position,track_id)
  SELECT o.observation_id,t.position,t.id FROM catalog_track_origin o JOIN track t ON t.id=o.track_id;
CREATE INDEX catalog_track_binding_track_idx ON catalog_track_binding(track_id);
CREATE TRIGGER catalog_track_binding_insert BEFORE INSERT ON catalog_track_binding
WHEN NOT EXISTS (
  SELECT 1 FROM catalog_observation o JOIN source_entity s ON s.id=o.source_entity_id
  JOIN track t ON t.album_id=s.entity_id JOIN catalog_track_origin origin ON origin.track_id=t.id
  WHERE o.id=NEW.observation_id AND o.kind='album' AND t.id=NEW.track_id
    AND json_extract(o.data_json,'$.tracks[' || (NEW.position-1) || '].position')=NEW.position
    AND NOT EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=s.id)
)
BEGIN SELECT RAISE(ABORT, 'Track binding must reference a managed album observation row'); END;
CREATE TRIGGER catalog_track_binding_no_update BEFORE UPDATE ON catalog_track_binding
BEGIN SELECT RAISE(ABORT, 'Track binding is immutable'); END;
CREATE TRIGGER catalog_track_binding_no_delete BEFORE DELETE ON catalog_track_binding
WHEN NOT EXISTS (SELECT 1 FROM catalog_observation o JOIN catalog_removal r ON r.source_entity_id=o.source_entity_id WHERE o.id=OLD.observation_id)
BEGIN SELECT RAISE(ABORT, 'Track binding may only be purged with source content'); END;

CREATE TABLE catalog_track_adoption (
  request_id TEXT PRIMARY KEY NOT NULL,
  source_entity_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  base_observation_id TEXT NOT NULL,
  observation_id TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256)=64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  adopted_at TEXT NOT NULL,
  FOREIGN KEY (source_entity_id,album_id) REFERENCES source_entity(id,entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (base_observation_id,source_entity_id) REFERENCES catalog_observation(id,source_entity_id),
  FOREIGN KEY (observation_id,source_entity_id) REFERENCES catalog_observation(id,source_entity_id)
) STRICT;
CREATE TRIGGER catalog_track_adoption_insert BEFORE INSERT ON catalog_track_adoption
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id)
  OR NOT EXISTS (SELECT 1 FROM catalog_observation WHERE id=NEW.base_observation_id AND kind='album')
  OR NOT EXISTS (SELECT 1 FROM catalog_album_state WHERE album_id=NEW.album_id
    AND source_entity_id=NEW.source_entity_id AND detail_observation_id=NEW.observation_id AND tracks_observation_id=NEW.observation_id)
BEGIN SELECT RAISE(ABORT, 'Track adoption must match the active album detail'); END;
CREATE TRIGGER catalog_track_adoption_no_update BEFORE UPDATE ON catalog_track_adoption
BEGIN SELECT RAISE(ABORT, 'Track adoption is immutable'); END;
CREATE TRIGGER catalog_track_adoption_no_delete BEFORE DELETE ON catalog_track_adoption
WHEN NOT EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=OLD.source_entity_id)
BEGIN SELECT RAISE(ABORT, 'Track adoption may only be purged with source content'); END;
