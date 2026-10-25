-- Derived public search order; never a new identity or a personal-data cache.
-- Eligibility matches the full track query. Expiry/policy cleanup still runs before every read.
CREATE VIEW catalog_track_search_current AS
SELECT t.id AS track_id,t.album_id,normalize_search(t.title) AS sort_title,
  s.id AS source_entity_id,s.source_id,s.external_key,b.position,adopted.id AS observation_id
FROM catalog_album_state c
JOIN album a ON a.id=c.album_id
JOIN entity album_entity ON album_entity.id=a.id AND album_entity.lifecycle='active'
JOIN source_entity s ON s.id=c.source_entity_id AND s.availability IN ('unverified','available')
JOIN catalog_source_kind sk ON sk.source_entity_id=s.id AND sk.sample_kind='synthetic'
JOIN catalog_observation title_evidence ON title_evidence.id=c.title_observation_id AND title_evidence.content_state='active'
JOIN catalog_observation adopted ON adopted.id=c.tracks_observation_id AND adopted.content_state='active'
JOIN catalog_track_binding b ON b.observation_id=adopted.id
JOIN track t ON t.id=b.track_id AND t.album_id=a.id
JOIN entity track_entity ON track_entity.id=t.id AND track_entity.lifecycle='active'
JOIN catalog_track_origin origin ON origin.track_id=t.id
JOIN catalog_observation first_seen ON first_seen.id=origin.observation_id AND first_seen.source_entity_id=s.id
WHERE NOT EXISTS (SELECT 1 FROM catalog_removal r WHERE r.album_id=a.id);

CREATE TABLE catalog_track_search_index (
  track_id TEXT PRIMARY KEY NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  album_id TEXT NOT NULL REFERENCES album(id) ON DELETE CASCADE,
  sort_title TEXT NOT NULL,
  source_entity_id TEXT NOT NULL REFERENCES source_entity(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  external_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5000),
  observation_id TEXT NOT NULL REFERENCES catalog_observation(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX catalog_track_search_order_idx ON catalog_track_search_index(sort_title,source_id,external_key,position,track_id);
CREATE INDEX catalog_track_search_album_idx ON catalog_track_search_index(album_id);
INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current;

-- Synchronization lives in SQLite so service writes, maintenance and restored snapshots agree.

CREATE TRIGGER catalog_search_state_insert AFTER INSERT ON catalog_album_state
BEGIN
  DELETE FROM catalog_track_search_index WHERE album_id=NEW.album_id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE album_id=NEW.album_id;
END;

CREATE TRIGGER catalog_search_state_update AFTER UPDATE ON catalog_album_state
BEGIN
  DELETE FROM catalog_track_search_index WHERE album_id=NEW.album_id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE album_id=NEW.album_id;
END;

CREATE TRIGGER catalog_search_state_delete AFTER DELETE ON catalog_album_state
BEGIN
  DELETE FROM catalog_track_search_index WHERE album_id=OLD.album_id;
END;

CREATE TRIGGER catalog_search_track_insert AFTER INSERT ON track
BEGIN
  DELETE FROM catalog_track_search_index WHERE track_id=NEW.id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE track_id=NEW.id;
END;

CREATE TRIGGER catalog_search_track_update AFTER UPDATE OF id,album_id,title ON track
BEGIN
  DELETE FROM catalog_track_search_index WHERE track_id=OLD.id;
  DELETE FROM catalog_track_search_index WHERE track_id=NEW.id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE track_id=NEW.id;
END;

CREATE TRIGGER catalog_search_entity_update AFTER UPDATE OF lifecycle ON entity
BEGIN
  DELETE FROM catalog_track_search_index WHERE track_id=NEW.id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE track_id=NEW.id;
  DELETE FROM catalog_track_search_index WHERE album_id=NEW.id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE album_id=NEW.id;
END;

CREATE TRIGGER catalog_search_source_update AFTER UPDATE OF availability,source_id,external_key,entity_id,id ON source_entity
BEGIN
  DELETE FROM catalog_track_search_index WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=NEW.id);
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=NEW.id);
END;

CREATE TRIGGER catalog_search_binding_insert AFTER INSERT ON catalog_track_binding
BEGIN
  DELETE FROM catalog_track_search_index WHERE track_id=NEW.track_id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE track_id=NEW.track_id;
END;

CREATE TRIGGER catalog_search_binding_delete AFTER DELETE ON catalog_track_binding
BEGIN
  DELETE FROM catalog_track_search_index WHERE track_id=OLD.track_id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE track_id=OLD.track_id;
END;

CREATE TRIGGER catalog_search_origin_insert AFTER INSERT ON catalog_track_origin
BEGIN
  DELETE FROM catalog_track_search_index WHERE track_id=NEW.track_id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE track_id=NEW.track_id;
END;

CREATE TRIGGER catalog_search_origin_delete AFTER DELETE ON catalog_track_origin
BEGIN
  DELETE FROM catalog_track_search_index WHERE track_id=OLD.track_id;
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE track_id=OLD.track_id;
END;

CREATE TRIGGER catalog_search_kind_insert AFTER INSERT ON catalog_source_kind
BEGIN
  DELETE FROM catalog_track_search_index WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=NEW.source_entity_id);
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=NEW.source_entity_id);
END;

CREATE TRIGGER catalog_search_kind_update AFTER UPDATE ON catalog_source_kind
BEGIN
  DELETE FROM catalog_track_search_index WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=NEW.source_entity_id);
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=NEW.source_entity_id);
END;

CREATE TRIGGER catalog_search_kind_delete AFTER DELETE ON catalog_source_kind
BEGIN
  DELETE FROM catalog_track_search_index WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=OLD.source_entity_id);
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=OLD.source_entity_id);
END;

CREATE TRIGGER catalog_search_observation_update AFTER UPDATE OF content_state ON catalog_observation
BEGIN
  DELETE FROM catalog_track_search_index WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=NEW.source_entity_id);
  INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current WHERE album_id IN (SELECT album_id FROM catalog_album_state WHERE source_entity_id=NEW.source_entity_id);
END;

CREATE TRIGGER catalog_search_removal_insert AFTER INSERT ON catalog_removal
BEGIN
  DELETE FROM catalog_track_search_index WHERE album_id=NEW.album_id;
END;

