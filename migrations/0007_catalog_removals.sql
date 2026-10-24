-- Durable suppression survives loss of observation content. Personal rows still reference the same IDs.
CREATE TABLE catalog_removal (
  source_entity_id TEXT PRIMARY KEY NOT NULL,
  album_id TEXT NOT NULL UNIQUE REFERENCES album(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('rights_request','policy_change')),
  removed_at TEXT NOT NULL,
  FOREIGN KEY (source_entity_id, album_id) REFERENCES source_entity(id, entity_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER catalog_removal_no_update BEFORE UPDATE ON catalog_removal
BEGIN SELECT RAISE(ABORT, 'Catalog removal is immutable'); END;
CREATE TRIGGER catalog_removal_no_delete BEFORE DELETE ON catalog_removal
BEGIN SELECT RAISE(ABORT, 'Catalog removal cannot be undone implicitly'); END;

DROP TRIGGER catalog_source_identity;
CREATE TRIGGER catalog_source_identity BEFORE UPDATE ON source_entity
WHEN (EXISTS (SELECT 1 FROM catalog_album_state WHERE source_entity_id=OLD.id)
   OR EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=OLD.id))
 AND (NEW.id <> OLD.id OR NEW.source_id <> OLD.source_id OR NEW.external_kind <> OLD.external_kind
   OR NEW.external_key <> OLD.external_key OR NEW.entity_id IS NOT OLD.entity_id)
BEGIN SELECT RAISE(ABORT, 'Managed catalog source identity is immutable'); END;
CREATE TRIGGER removed_source_no_reactivation BEFORE UPDATE ON source_entity
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=OLD.id)
 AND (NEW.availability <> 'removed' OR NEW.fetched_at IS NOT NULL OR NEW.parser_version IS NOT NULL OR NEW.page_url <> OLD.page_url)
BEGIN SELECT RAISE(ABORT, 'Removed source cannot be reactivated'); END;

CREATE TRIGGER removed_observation_no_insert BEFORE INSERT ON catalog_observation
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id)
BEGIN SELECT RAISE(ABORT, 'Removed source cannot retain observations'); END;
CREATE TRIGGER removed_observation_no_update BEFORE UPDATE ON catalog_observation
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id OR source_entity_id=OLD.source_entity_id)
BEGIN SELECT RAISE(ABORT, 'Removed source cannot retain observations'); END;
CREATE TRIGGER removed_state_no_insert BEFORE INSERT ON catalog_album_state
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id OR album_id=NEW.album_id)
BEGIN SELECT RAISE(ABORT, 'Removed source cannot adopt metadata'); END;
CREATE TRIGGER removed_state_no_update BEFORE UPDATE ON catalog_album_state
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id OR source_entity_id=OLD.source_entity_id)
BEGIN SELECT RAISE(ABORT, 'Removed source cannot adopt metadata'); END;

CREATE TRIGGER removed_album_no_metadata BEFORE UPDATE ON album
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE album_id=OLD.id)
 AND (NEW.id <> OLD.id OR NEW.title <> '메타데이터가 제거된 앨범'
   OR NEW.album_kind IS NOT NULL OR NEW.release_date IS NOT NULL OR NEW.catalog_number IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Removed album cannot retain metadata'); END;
CREATE TRIGGER removed_track_no_insert BEFORE INSERT ON track
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE album_id=NEW.album_id)
BEGIN SELECT RAISE(ABORT, 'Removed album cannot add tracks'); END;
CREATE TRIGGER removed_track_no_delete BEFORE DELETE ON track
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE album_id=OLD.album_id)
BEGIN SELECT RAISE(ABORT, 'Removed track identity must be retained'); END;
CREATE TRIGGER removed_track_no_metadata BEFORE UPDATE ON track
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE album_id=OLD.album_id OR album_id=NEW.album_id)
 AND (NEW.id <> OLD.id OR NEW.album_id <> OLD.album_id OR NEW.position <> OLD.position
   OR NEW.title <> '메타데이터가 제거된 트랙' OR NEW.recording_id IS NOT NULL
   OR NEW.disc_label IS NOT NULL OR NEW.track_label IS NOT NULL OR NEW.duration_ms IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Removed track cannot retain metadata'); END;
CREATE TRIGGER removed_entity_no_reactivation BEFORE UPDATE ON entity
WHEN EXISTS (SELECT 1 FROM catalog_removal r WHERE r.album_id=OLD.id
  OR EXISTS (SELECT 1 FROM track WHERE id=OLD.id AND album_id=r.album_id))
 AND (NEW.id <> OLD.id OR NEW.lifecycle <> 'unavailable')
BEGIN SELECT RAISE(ABORT, 'Removed entity cannot be reactivated'); END;

CREATE TRIGGER removed_assertion_no_insert BEFORE INSERT ON assertion
WHEN EXISTS (SELECT 1 FROM catalog_removal r WHERE r.source_entity_id=NEW.source_entity_id OR r.album_id=NEW.entity_id
  OR EXISTS (SELECT 1 FROM track WHERE id=NEW.entity_id AND album_id=r.album_id))
BEGIN SELECT RAISE(ABORT, 'Removed content cannot have assertions'); END;
CREATE TRIGGER removed_assertion_no_update BEFORE UPDATE ON assertion
WHEN EXISTS (SELECT 1 FROM catalog_removal r WHERE r.source_entity_id=NEW.source_entity_id OR r.source_entity_id=OLD.source_entity_id
  OR r.album_id=NEW.entity_id OR r.album_id=OLD.entity_id
  OR EXISTS (SELECT 1 FROM track WHERE id IN (NEW.entity_id,OLD.entity_id) AND album_id=r.album_id))
BEGIN SELECT RAISE(ABORT, 'Removed content cannot have assertions'); END;
CREATE TRIGGER removed_url_history_no_insert BEFORE INSERT ON source_url_history
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id)
BEGIN SELECT RAISE(ABORT, 'Removed source cannot retain URL history'); END;
CREATE TRIGGER removed_url_history_no_update BEFORE UPDATE ON source_url_history
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE source_entity_id=NEW.source_entity_id OR source_entity_id=OLD.source_entity_id)
BEGIN SELECT RAISE(ABORT, 'Removed source cannot retain URL history'); END;
CREATE TRIGGER removed_album_game_no_insert BEFORE INSERT ON album_game
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE album_id=NEW.album_id)
BEGIN SELECT RAISE(ABORT, 'Removed album cannot gain game claims'); END;
CREATE TRIGGER removed_album_game_no_update BEFORE UPDATE ON album_game
WHEN EXISTS (SELECT 1 FROM catalog_removal WHERE album_id=NEW.album_id OR album_id=OLD.album_id)
BEGIN SELECT RAISE(ABORT, 'Removed album cannot gain game claims'); END;
