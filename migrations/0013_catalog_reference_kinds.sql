-- New private reference serialization needs a new schema ledger version: older app versions must
-- fail assertMigrated instead of treating live-capture references as synthetic. Existing v1 rows
-- remain immutable and are interpreted as synthetic only by the explicit legacy reader.
CREATE TRIGGER detached_reference_kind_insert BEFORE INSERT ON catalog_detached_item
WHEN json_type(NEW.reference_json,'$.sampleKind') IS NOT 'text'
  OR json_extract(NEW.reference_json,'$.sampleKind') NOT IN ('synthetic','live-capture')
BEGIN SELECT RAISE(ABORT,'New catalog references require an explicit sample kind'); END;
CREATE TRIGGER detached_link_kind_insert BEFORE INSERT ON catalog_detached_link
WHEN json_type(NEW.reference_json,'$.sampleKind') IS NOT 'text'
  OR json_extract(NEW.reference_json,'$.sampleKind') NOT IN ('synthetic','live-capture')
  OR json_extract(NEW.reference_json,'$.sampleKind') IS NOT (
    SELECT coalesce(json_extract(reference_json,'$.sampleKind'),'synthetic') FROM catalog_detached_item
    WHERE id=NEW.library_item_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'Personal source references must have the same explicit sample kind'); END;
