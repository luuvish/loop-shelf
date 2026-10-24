-- Short-lived undo receipts. Deleted content is absent from the library/search/export.
CREATE TABLE bookmark_deletion (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES "session"(id) ON DELETE CASCADE,
  bookmark_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  expires_at INTEGER NOT NULL,
  snapshot TEXT CHECK (snapshot IS NULL OR json_valid(snapshot)),
  state TEXT NOT NULL CHECK (state IN ('deleted', 'restored')),
  CHECK ((state = 'deleted' AND snapshot IS NOT NULL) OR (state = 'restored' AND snapshot IS NULL))
) STRICT;
CREATE INDEX bookmark_deletion_expiry ON bookmark_deletion(expires_at);
CREATE INDEX bookmark_deletion_owner ON bookmark_deletion(user_id);
CREATE TRIGGER bookmark_deletion_session_owner BEFORE INSERT ON bookmark_deletion
WHEN NOT EXISTS (SELECT 1 FROM "session" WHERE id = NEW.session_id AND "userId" = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'Undo session owner mismatch'); END;
