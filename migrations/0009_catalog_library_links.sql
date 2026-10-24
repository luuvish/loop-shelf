-- Private source judgments never change shared catalog mappings.
CREATE INDEX user_source_link_item_idx ON user_source_link(user_id, library_item_id);
CREATE TRIGGER user_source_link_no_update BEFORE UPDATE ON user_source_link
BEGIN SELECT RAISE(ABORT, 'Disconnect a personal source before reconnecting'); END;
CREATE TRIGGER user_source_link_limit BEFORE INSERT ON user_source_link
WHEN (SELECT count(*) FROM user_source_link WHERE user_id=NEW.user_id AND library_item_id=NEW.library_item_id)>=20
BEGIN SELECT RAISE(ABORT, 'Personal source connection limit'); END;
CREATE TRIGGER linked_library_identity_immutable BEFORE UPDATE OF id,user_id,entity_id ON library_item
WHEN (NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.entity_id<>OLD.entity_id)
 AND (EXISTS (SELECT 1 FROM user_source_link WHERE library_item_id=OLD.id)
   OR EXISTS (SELECT 1 FROM entity WHERE id=OLD.entity_id AND kind IN ('album','track')))
BEGIN SELECT RAISE(ABORT, 'Saved catalog identity is immutable'); END;

CREATE TABLE user_source_link_event (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  library_item_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('connect','disconnect')),
  occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX user_source_link_event_owner_idx ON user_source_link_event(user_id,library_item_id,id);
CREATE TRIGGER user_source_link_added AFTER INSERT ON user_source_link BEGIN
  INSERT INTO user_source_link_event(user_id,library_item_id,source_entity_id,action,occurred_at)
    VALUES (NEW.user_id,NEW.library_item_id,NEW.source_entity_id,'connect',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER user_source_link_removed AFTER DELETE ON user_source_link
WHEN EXISTS (SELECT 1 FROM "user" WHERE id=OLD.user_id) BEGIN
  INSERT INTO user_source_link_event(user_id,library_item_id,source_entity_id,action,occurred_at)
    VALUES (OLD.user_id,OLD.library_item_id,OLD.source_entity_id,'disconnect',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
