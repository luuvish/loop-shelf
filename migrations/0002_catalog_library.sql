-- Internal IDs are UUIDs created by services. Source locators never serve as entity IDs.
CREATE TABLE entity (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('game','album','track','work','recording','bookmark')),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','unavailable')),
  created_at TEXT NOT NULL,
  UNIQUE (id, kind)
) STRICT;
CREATE TRIGGER entity_kind_immutable BEFORE UPDATE OF kind ON entity
WHEN NEW.kind <> OLD.kind BEGIN SELECT RAISE(ABORT, 'entity kind is immutable'); END;

CREATE TABLE game (
  id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL DEFAULT 'game' CHECK (entity_kind = 'game'),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  FOREIGN KEY (id, entity_kind) REFERENCES entity(id, kind) ON DELETE RESTRICT
) STRICT;
CREATE TABLE album (
  id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL DEFAULT 'album' CHECK (entity_kind = 'album'),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  album_kind TEXT, release_date TEXT, catalog_number TEXT,
  FOREIGN KEY (id, entity_kind) REFERENCES entity(id, kind) ON DELETE RESTRICT
) STRICT;
CREATE TABLE musical_work (
  id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL DEFAULT 'work' CHECK (entity_kind = 'work'),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  FOREIGN KEY (id, entity_kind) REFERENCES entity(id, kind) ON DELETE RESTRICT
) STRICT;
CREATE TABLE recording (
  id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL DEFAULT 'recording' CHECK (entity_kind = 'recording'),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0), version_label TEXT,
  FOREIGN KEY (id, entity_kind) REFERENCES entity(id, kind) ON DELETE RESTRICT
) STRICT;
CREATE TABLE track (
  id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL DEFAULT 'track' CHECK (entity_kind = 'track'),
  album_id TEXT NOT NULL REFERENCES album(id) ON DELETE RESTRICT,
  recording_id TEXT REFERENCES recording(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0), disc_label TEXT, track_label TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0), duration_ms INTEGER CHECK (duration_ms >= 0),
  FOREIGN KEY (id, entity_kind) REFERENCES entity(id, kind) ON DELETE RESTRICT,
  UNIQUE (album_id, position)
) STRICT;
CREATE TABLE album_game (
  album_id TEXT NOT NULL REFERENCES album(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES game(id) ON DELETE CASCADE,
  PRIMARY KEY (album_id, game_id)
) STRICT;
CREATE TABLE recording_work (
  recording_id TEXT NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES musical_work(id) ON DELETE CASCADE,
  PRIMARY KEY (recording_id, work_id)
) STRICT;

CREATE TABLE source_entity (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL CHECK (source_id IN ('khinsider','zophar')),
  external_kind TEXT NOT NULL CHECK (external_kind IN ('game','album','track')),
  external_key TEXT NOT NULL CHECK (length(external_key) > 0),
  entity_id TEXT,
  page_url TEXT NOT NULL,
  availability TEXT NOT NULL DEFAULT 'unverified'
    CHECK (availability IN ('unverified','available','blocked','not_found','removed')),
  fetched_at TEXT, parser_version TEXT,
  FOREIGN KEY (entity_id, external_kind) REFERENCES entity(id, kind) ON DELETE RESTRICT,
  UNIQUE (source_id, external_kind, external_key)
) STRICT;
CREATE TABLE source_url_history (
  id INTEGER PRIMARY KEY, source_entity_id TEXT NOT NULL REFERENCES source_entity(id) ON DELETE RESTRICT,
  previous_url TEXT NOT NULL, changed_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER source_url_changed AFTER UPDATE OF page_url ON source_entity
WHEN NEW.page_url <> OLD.page_url BEGIN
  INSERT INTO source_url_history(source_entity_id, previous_url, changed_at)
  VALUES (OLD.id, OLD.page_url, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TABLE assertion (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE RESTRICT,
  source_entity_id TEXT REFERENCES source_entity(id) ON DELETE RESTRICT,
  field TEXT NOT NULL, value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  observed_at TEXT NOT NULL, method TEXT NOT NULL CHECK (method IN ('source','curated'))
) STRICT;
CREATE INDEX assertion_entity_idx ON assertion(entity_id);

-- Private input remains outside the shared source metadata catalog.
CREATE TABLE bookmark (
  entity_id TEXT PRIMARY KEY, entity_kind TEXT NOT NULL DEFAULT 'bookmark' CHECK (entity_kind = 'bookmark'),
  owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL CHECK (source_id IN ('khinsider','zophar')),
  external_key TEXT NOT NULL CHECK (length(external_key) > 0),
  entered_title TEXT NOT NULL CHECK (length(trim(entered_title)) BETWEEN 1 AND 300),
  page_url TEXT NOT NULL CHECK (length(page_url) <= 2048),
  FOREIGN KEY (entity_id, entity_kind) REFERENCES entity(id, kind) ON DELETE RESTRICT,
  UNIQUE (owner_id, source_id, external_key)
) STRICT;
CREATE TRIGGER bookmark_owner_immutable BEFORE UPDATE OF owner_id ON bookmark
WHEN NEW.owner_id <> OLD.owner_id BEGIN SELECT RAISE(ABORT, 'bookmark owner is immutable'); END;
CREATE TABLE library_item (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE RESTRICT,
  title_override TEXT, note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 10000),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (user_id, entity_id), UNIQUE (id, user_id)
) STRICT;
CREATE INDEX library_item_owner_idx ON library_item(user_id, created_at DESC, id DESC);
CREATE TRIGGER library_bookmark_owner_insert BEFORE INSERT ON library_item
WHEN EXISTS (SELECT 1 FROM entity WHERE id = NEW.entity_id AND kind = 'bookmark')
AND NOT EXISTS (SELECT 1 FROM bookmark WHERE entity_id = NEW.entity_id AND owner_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'bookmark ownership mismatch'); END;
CREATE TRIGGER library_bookmark_owner_update BEFORE UPDATE OF user_id, entity_id ON library_item
WHEN EXISTS (SELECT 1 FROM entity WHERE id = NEW.entity_id AND kind = 'bookmark')
AND NOT EXISTS (SELECT 1 FROM bookmark WHERE entity_id = NEW.entity_id AND owner_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'bookmark ownership mismatch'); END;

CREATE TABLE user_source_link (
  user_id TEXT NOT NULL, library_item_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL REFERENCES source_entity(id) ON DELETE RESTRICT,
  asserted_at TEXT NOT NULL,
  FOREIGN KEY (library_item_id, user_id) REFERENCES library_item(id, user_id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, source_entity_id)
) STRICT;

-- Private index: queries must join library_item and filter its owner.
CREATE VIRTUAL TABLE bookmark_search USING fts5(library_item_id UNINDEXED, search_text, tokenize='trigram');
CREATE TRIGGER bookmark_search_insert AFTER INSERT ON library_item BEGIN
  INSERT INTO bookmark_search(library_item_id, search_text)
    SELECT NEW.id, normalize_search(b.entered_title || ' ' || NEW.note)
    FROM bookmark b WHERE b.entity_id = NEW.entity_id;
END;
CREATE TRIGGER bookmark_search_update AFTER UPDATE ON library_item BEGIN
  DELETE FROM bookmark_search WHERE library_item_id = OLD.id;
  INSERT INTO bookmark_search(library_item_id, search_text)
    SELECT NEW.id, normalize_search(b.entered_title || ' ' || NEW.note)
    FROM bookmark b WHERE b.entity_id = NEW.entity_id;
END;
CREATE TRIGGER bookmark_search_delete AFTER DELETE ON library_item BEGIN
  DELETE FROM bookmark_search WHERE library_item_id = OLD.id;
END;
CREATE TRIGGER bookmark_title_search_update AFTER UPDATE OF entered_title ON bookmark BEGIN
  DELETE FROM bookmark_search WHERE library_item_id IN (SELECT id FROM library_item WHERE entity_id = NEW.entity_id);
  INSERT INTO bookmark_search(library_item_id, search_text)
    SELECT id, normalize_search(NEW.entered_title || ' ' || note) FROM library_item WHERE entity_id = NEW.entity_id;
END;
