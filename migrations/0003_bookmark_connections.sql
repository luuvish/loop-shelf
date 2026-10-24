-- Private, reversible grouping of user-entered bookmarks. No shared source assertions.
CREATE TABLE bookmark_connection (
  member_id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  CHECK (member_id <> parent_id),
  FOREIGN KEY (member_id, user_id) REFERENCES library_item(id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_id, user_id) REFERENCES library_item(id, user_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX bookmark_connection_parent_idx ON bookmark_connection(parent_id, user_id);

-- A group is a star: a representative and standalone members, never nested or cyclic.
CREATE TRIGGER bookmark_connection_insert BEFORE INSERT ON bookmark_connection BEGIN
  SELECT RAISE(ABORT, 'bookmark connections require private bookmarks')
    WHERE NOT EXISTS (SELECT 1 FROM library_item li JOIN bookmark b ON b.entity_id = li.entity_id
      WHERE li.id = NEW.parent_id AND li.user_id = NEW.user_id AND b.owner_id = NEW.user_id)
    OR NOT EXISTS (SELECT 1 FROM library_item li JOIN bookmark b ON b.entity_id = li.entity_id
      WHERE li.id = NEW.member_id AND li.user_id = NEW.user_id AND b.owner_id = NEW.user_id);
  SELECT RAISE(ABORT, 'nested bookmark connection') WHERE EXISTS (
    SELECT 1 FROM bookmark_connection WHERE member_id = NEW.parent_id OR parent_id = NEW.member_id);
  SELECT RAISE(ABORT, 'bookmark connection limit') WHERE
    (SELECT count(*) FROM bookmark_connection WHERE parent_id = NEW.parent_id) >= 19;
END;
CREATE TRIGGER bookmark_connection_immutable BEFORE UPDATE ON bookmark_connection
BEGIN SELECT RAISE(ABORT, 'disconnect before reconnecting'); END;
CREATE TRIGGER connected_bookmark_identity_immutable BEFORE UPDATE OF user_id, entity_id ON library_item
WHEN (NEW.user_id <> OLD.user_id OR NEW.entity_id <> OLD.entity_id)
AND EXISTS (SELECT 1 FROM bookmark_connection WHERE member_id = OLD.id OR parent_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'connected bookmark identity is immutable'); END;

-- Keep minimal user-private audit IDs even after a disconnected bookmark is deleted.
CREATE TABLE bookmark_connection_event (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('connect', 'disconnect')),
  occurred_at TEXT NOT NULL
) STRICT;
CREATE INDEX bookmark_connection_event_owner_idx ON bookmark_connection_event(user_id, parent_id, id);
CREATE TRIGGER bookmark_connection_added AFTER INSERT ON bookmark_connection BEGIN
  INSERT INTO bookmark_connection_event(user_id, parent_id, member_id, action, occurred_at)
    VALUES (NEW.user_id, NEW.parent_id, NEW.member_id, 'connect', NEW.connected_at);
END;
CREATE TRIGGER bookmark_connection_removed AFTER DELETE ON bookmark_connection BEGIN
  INSERT INTO bookmark_connection_event(user_id, parent_id, member_id, action, occurred_at)
    VALUES (OLD.user_id, OLD.parent_id, OLD.member_id, 'disconnect', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
