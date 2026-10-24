-- A restored UUID must not reuse the optimistic version held by an old editor.
-- Preserve the high-water mark after deletion. Local revisions are not portable data.
CREATE TABLE library_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 9007199254740990)
) STRICT;
INSERT INTO library_revision(singleton, value)
  SELECT 1, max(CAST(unixepoch('subsec') * 1000 AS INTEGER), coalesce(max(version), 1)) FROM library_item;
CREATE TRIGGER library_revision_insert AFTER INSERT ON library_item BEGIN
  UPDATE library_revision SET value = max(value, NEW.version) WHERE singleton = 1;
END;

-- Restored connection dates are historical; the audit action happens now.
DROP TRIGGER bookmark_connection_added;
CREATE TRIGGER bookmark_connection_added AFTER INSERT ON bookmark_connection BEGIN
  INSERT INTO bookmark_connection_event(user_id, parent_id, member_id, action, occurred_at)
    VALUES (NEW.user_id, NEW.parent_id, NEW.member_id, 'connect', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER library_revision_update AFTER UPDATE OF version ON library_item BEGIN
  UPDATE library_revision SET value = max(value, NEW.version) WHERE singleton = 1;
END;
