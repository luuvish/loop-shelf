export const ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
export const ARCHIVE_MAX_ITEMS = 5000;

export interface ArchiveBookmark {
  id: string; entityId: string; title: string; url: string; note: string; favorite: boolean;
  createdAt: string; updatedAt: string;
}
export interface ArchiveConnection { parentId: string; memberId: string; connectedAt: string }
export interface BookmarkArchive {
  format: "loopshelf-bookmarks"; schemaVersion: 1; exportedAt: string;
  bookmarks: ArchiveBookmark[]; connections: ArchiveConnection[];
}
export type ImportConflictReason = "id_conflict" | "source_conflict" | "content_conflict" | "connection_conflict";
export interface ImportPreview {
  scope?: "catalog"; unresolvedCount?: number;
  addCount: number; skipCount: number; connectionCount: number; conflictCount: number;
  conflicts: { index: number; title: string; reason: ImportConflictReason }[];
  token: string | null;
}
export interface ImportResult { added: number; skipped: number; connectionsAdded: number; scope?: "catalog"; unresolved?: number }
