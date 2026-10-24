import type Database from "better-sqlite3";
import { z } from "zod";
import { BookmarkStore, LibraryError, type Bookmark } from "./bookmarks.ts";
import { UNDO_WINDOW_MS, type DeletionReceipt, type UndoResult } from "../shared/deletions.ts";

export const deletionInput = z.object({ operationId: z.uuid(), version: z.number().int().positive() }).strict();
export class DeletionError extends Error {
  readonly code: "undo_unavailable" | "undo_conflict" | "undo_limit";
  constructor(code: DeletionError["code"]) { super(code); this.code = code; }
}
interface Row {
  id: string; user_id: string; session_id: string; bookmark_id: string; version: number;
  expires_at: number; snapshot: string | null; state: "deleted" | "restored";
}

/** Call under withDatabase, with owner and session obtained from cookie authentication. */
export class BookmarkDeletions {
  readonly db: Database.Database;
  readonly store: BookmarkStore;
  constructor(db: Database.Database) { this.db = db; this.store = new BookmarkStore(db); }

  purge(now = Date.now()) {
    this.db.prepare('DELETE FROM bookmark_deletion WHERE expires_at <= ?')
      .run(now);
  }

  delete(userId: string, sessionId: string, bookmarkId: string, input: unknown, now = Date.now()): DeletionReceipt {
    const data = deletionInput.parse(input); z.uuid().parse(bookmarkId);
    this.purge(now);
    return this.db.transaction(() => {
      let row = this.db.prepare("SELECT * FROM bookmark_deletion WHERE id = ?").get(data.operationId) as Row | undefined;
      if (row) {
        if (row.user_id !== userId || row.session_id !== sessionId) throw new DeletionError("undo_unavailable");
        if (row.bookmark_id !== bookmarkId || row.version !== data.version) throw new LibraryError("conflict", "Deletion operation changed");
      } else {
        const current = this.store.get(userId, bookmarkId);
        if (this.db.prepare<[string], { n: number }>("SELECT count(*) AS n FROM bookmark_deletion WHERE user_id = ?").get(userId)!.n >= 20)
          throw new DeletionError("undo_limit");
        // The snapshot and deletion commit together, including grouped/version checks.
        this.store.delete(userId, bookmarkId, data.version);
        row = { id: data.operationId, user_id: userId, session_id: sessionId, bookmark_id: bookmarkId,
          version: data.version, expires_at: now + UNDO_WINDOW_MS, snapshot: JSON.stringify(current), state: "deleted" };
        this.db.prepare(`INSERT INTO bookmark_deletion(id,user_id,session_id,bookmark_id,version,expires_at,snapshot,state)
          VALUES (@id,@user_id,@session_id,@bookmark_id,@version,@expires_at,@snapshot,@state)`).run(row);
      }
      return { id: row.id, bookmarkId: row.bookmark_id, expiresAt: new Date(row.expires_at).toISOString(), remainingMs: row.expires_at - now, state: row.state };
    }).immediate();
  }

  restore(userId: string, sessionId: string, operationId: string, now = Date.now()): UndoResult {
    z.uuid().parse(operationId); this.purge(now);
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM bookmark_deletion WHERE id = ? AND user_id = ? AND session_id = ?")
        .get(operationId, userId, sessionId) as Row | undefined;
      if (!row) throw new DeletionError("undo_unavailable");
      // A replay cannot resurrect a later deletion or overwrite a subsequent edit.
      if (row.state === "restored") return { bookmarkId: row.bookmark_id, restored: false };
      const item = JSON.parse(row.snapshot!) as Bookmark; // Written only from a verified server record.
      const occupied = this.db.prepare("SELECT 1 FROM entity WHERE id=@id UNION ALL SELECT 1 FROM library_item WHERE id=@id UNION ALL SELECT 1 FROM catalog_detached_item WHERE id=@id LIMIT 1");
      if (occupied.get({ id: item.id }) || occupied.get({ id: item.entityId })
        || this.db.prepare("SELECT 1 FROM bookmark WHERE owner_id = ? AND source_id = ? AND external_key = ?").get(userId, item.sourceId, item.externalKey))
        throw new DeletionError("undo_conflict");
      const revision = this.db.prepare<[], { value: number }>("UPDATE library_revision SET value = value + 1 WHERE singleton = 1 RETURNING value").get()!.value;
      this.db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?, 'bookmark', ?)").run(item.entityId, item.createdAt);
      this.db.prepare("INSERT INTO bookmark(entity_id,owner_id,source_id,external_key,entered_title,page_url) VALUES (?,?,?,?,?,?)")
        .run(item.entityId, userId, item.sourceId, item.externalKey, item.title, item.url);
      this.db.prepare("INSERT INTO library_item(id,user_id,entity_id,note,favorite,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(item.id, userId, item.entityId, item.note, Number(item.favorite), revision, item.createdAt, item.updatedAt);
      this.db.prepare("UPDATE bookmark_deletion SET state = 'restored', snapshot = NULL WHERE id = ?").run(row.id);
      return { bookmarkId: item.id, restored: true };
    }).immediate();
  }
}
