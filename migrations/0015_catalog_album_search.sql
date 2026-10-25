-- Measured album-first reads otherwise normalize and sort every eligible album for each page.
-- SQLite maintains this derived order with current titles, including retention/removal updates.
CREATE INDEX catalog_album_search_title_idx ON album(normalize_search(title), id);
