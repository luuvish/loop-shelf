import type { CatalogLibraryItem, SavedCatalogEntity } from "./catalog-library.ts";
export interface CatalogEntry { entity: SavedCatalogEntity; savedItemId: string | null }
export interface CatalogAlbumPage { items: CatalogEntry[]; nextOffset: number | null }
export interface CatalogTrackEntry extends CatalogEntry { displayNumber: string | null; discLabel: string | null }
export interface CatalogAlbumDetail {
  album: CatalogEntry;
  trackState: "not_loaded" | "unchanged" | "review_required";
  tracks: CatalogTrackEntry[];
  nextOffset: number | null;
}
export interface CatalogCandidates extends CatalogAlbumPage { target: CatalogLibraryItem; itemId: string; version: number; remainingSlots: number }
