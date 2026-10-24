import type { SourceId } from "../sources/types.ts";

export interface Bookmark {
  id: string; entityId: string; title: string; url: string; sourceId: SourceId; externalKey: string;
  note: string; favorite: boolean; version: number; createdAt: string; updatedAt: string;
  provenance: "user-entered";
  rootId: string;
  sourceCount: number;
}

export interface BookmarkPage { items: Bookmark[]; nextOffset: number | null }
export interface BookmarkDraft { title: string; url: string; note: string; favorite: boolean }
export interface BookmarkConnections { root: Bookmark; members: Bookmark[] }
export interface DisconnectedBookmark { group: BookmarkConnections; detached: Bookmark }
