-- Portable references stay private. Import never creates a shared music entity or source.
CREATE TABLE catalog_detached_item (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  entity_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('album','track')),
  reference_json TEXT NOT NULL CHECK (json_valid(reference_json)
    AND json_extract(reference_json,'$.entityId')=entity_id AND json_extract(reference_json,'$.kind')=kind),
  title_override TEXT CHECK (title_override IS NULL OR length(trim(title_override)) BETWEEN 1 AND 300),
  note TEXT NOT NULL CHECK (length(note)<=10000), favorite INTEGER NOT NULL CHECK (favorite IN (0,1)),
  version INTEGER NOT NULL CHECK (version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (id,user_id), UNIQUE (user_id,entity_id)
) STRICT;
CREATE INDEX catalog_detached_owner_idx ON catalog_detached_item(user_id,created_at DESC,id DESC);
CREATE TABLE catalog_detached_link (
  library_item_id TEXT NOT NULL, user_id TEXT NOT NULL, source_entity_id TEXT NOT NULL,
  reference_json TEXT NOT NULL CHECK (json_valid(reference_json)
    AND json_extract(reference_json,'$.source.id')=source_entity_id AND json_extract(reference_json,'$.kind')='album'),
  asserted_at TEXT NOT NULL,
  FOREIGN KEY (library_item_id,user_id) REFERENCES catalog_detached_item(id,user_id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,source_entity_id)
) STRICT;
CREATE INDEX catalog_detached_link_item_idx ON catalog_detached_link(user_id,library_item_id);
CREATE TRIGGER detached_identity_immutable BEFORE UPDATE OF id,user_id,entity_id,kind,reference_json ON catalog_detached_item
BEGIN SELECT RAISE(ABORT,'Detached catalog identity is immutable'); END;
CREATE TRIGGER detached_revision_insert AFTER INSERT ON catalog_detached_item BEGIN
  UPDATE library_revision SET value=max(value,NEW.version) WHERE singleton=1;
END;
CREATE TRIGGER detached_revision_update AFTER UPDATE OF version ON catalog_detached_item BEGIN
  UPDATE library_revision SET value=max(value,NEW.version) WHERE singleton=1;
END;
CREATE TRIGGER detached_item_collision BEFORE INSERT ON catalog_detached_item
WHEN EXISTS (SELECT 1 FROM library_item WHERE id=NEW.id OR (user_id=NEW.user_id AND entity_id=NEW.entity_id))
 OR EXISTS (SELECT 1 FROM entity WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Personal catalog ID conflict'); END;
CREATE TRIGGER library_detached_collision BEFORE INSERT ON library_item
WHEN EXISTS (SELECT 1 FROM catalog_detached_item WHERE id=NEW.id OR (user_id=NEW.user_id AND entity_id=NEW.entity_id))
BEGIN SELECT RAISE(ABORT,'Personal catalog ID conflict'); END;
CREATE TRIGGER entity_detached_collision BEFORE INSERT ON entity
WHEN EXISTS (SELECT 1 FROM catalog_detached_item WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Personal catalog ID conflict'); END;
CREATE TRIGGER detached_link_no_update BEFORE UPDATE ON catalog_detached_link
BEGIN SELECT RAISE(ABORT,'Disconnect a personal source before reconnecting'); END;
CREATE TRIGGER detached_link_guard BEFORE INSERT ON catalog_detached_link
WHEN (SELECT count(*) FROM catalog_detached_link WHERE user_id=NEW.user_id AND library_item_id=NEW.library_item_id)>=20
 OR EXISTS (SELECT 1 FROM user_source_link WHERE user_id=NEW.user_id AND source_entity_id=NEW.source_entity_id)
 OR NOT EXISTS (SELECT 1 FROM catalog_detached_item WHERE id=NEW.library_item_id AND user_id=NEW.user_id AND kind='album'
   AND json_extract(reference_json,'$.source.id')<>NEW.source_entity_id)
BEGIN SELECT RAISE(ABORT,'Invalid detached source connection'); END;
CREATE TRIGGER resolved_link_detached_guard BEFORE INSERT ON user_source_link
WHEN EXISTS (SELECT 1 FROM catalog_detached_link WHERE user_id=NEW.user_id AND source_entity_id=NEW.source_entity_id)
BEGIN SELECT RAISE(ABORT,'Personal source already connected'); END;
CREATE TRIGGER detached_link_added AFTER INSERT ON catalog_detached_link BEGIN
  INSERT INTO user_source_link_event(user_id,library_item_id,source_entity_id,action,occurred_at)
    VALUES (NEW.user_id,NEW.library_item_id,NEW.source_entity_id,'connect',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER detached_link_removed AFTER DELETE ON catalog_detached_link
WHEN EXISTS (SELECT 1 FROM "user" WHERE id=OLD.user_id) BEGIN
  INSERT INTO user_source_link_event(user_id,library_item_id,source_entity_id,action,occurred_at)
    VALUES (OLD.user_id,OLD.library_item_id,OLD.source_entity_id,'disconnect',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
