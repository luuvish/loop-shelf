-- Measured global track searches need ordered normalized titles without per-row JS normalization.
-- This is a derived SQLite index: adoption, expiry and removal update it with the Track row.
CREATE INDEX catalog_track_search_title_idx ON track(normalize_search(title), album_id, id);
