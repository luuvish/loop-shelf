import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { normalizeAlbumUrl } from "../sources/urls.ts";
import type { Bookmark, BookmarkConnections, DisconnectedBookmark } from "../shared/bookmarks.ts";
export type { Bookmark } from "../shared/bookmarks.ts";
import { normalizeSearch } from "../database/connection.ts";

const title = z.string().trim().min(1).max(300).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const note = z.string().max(10000).refine((value) => !value.includes("\0"));
const url = z.string().trim().min(1).max(2048);
const id = z.uuid();
export const createBookmarkInput = z.object({ title, url, note: note.default(""), favorite: z.boolean().default(false) }).strict();
export const updateBookmarkInput = z.object({ title: title.optional(), url: url.optional(), note: note.optional(),
  favorite: z.boolean().optional(), version: z.number().int().positive() }).strict()
  .refine((input) => Object.keys(input).some((key) => key !== "version"), { message: "No changes supplied" });
export const listBookmarkInput = z.object({
  q: z.string().trim().max(200).default(""),
  favorite: z.enum(["true", "false"]).optional(),
  standalone: z.literal("true").optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();

export class LibraryError extends Error {
  readonly code: "not_found" | "conflict" | "invalid_url" | "invalid_connection" | "grouped_bookmark" | "connection_limit";
  constructor(code: LibraryError["code"], message: string) { super(message); this.code = code; }
}

interface Row extends Omit<Bookmark, "favorite" | "provenance"> { favorite: number }
const connectionInput = z.object({ version: z.number().int().positive(), memberId: id, memberVersion: z.number().int().positive() }).strict();
const rootId = "COALESCE(bc.parent_id, li.id)";
const select = `SELECT li.id, li.entity_id AS entityId, b.entered_title AS title, b.page_url AS url,
  b.source_id AS sourceId, b.external_key AS externalKey, li.note, li.favorite, li.version,
  li.created_at AS createdAt, li.updated_at AS updatedAt, ${rootId} AS rootId,
  (SELECT count(*) + 1 FROM bookmark_connection WHERE parent_id = ${rootId} AND user_id = li.user_id) AS sourceCount
  FROM library_item li JOIN bookmark b ON b.entity_id = li.entity_id AND b.owner_id = li.user_id
  LEFT JOIN bookmark_connection bc ON bc.member_id = li.id AND bc.user_id = li.user_id`;
const view = (row: Row): Bookmark => ({ ...row, favorite: row.favorite === 1, provenance: "user-entered" });

function sourceRef(value: string) {
  // A bookmark must be an absolute supported page URL, not an arbitrary network target.
  if (!value.startsWith("https://")) throw new LibraryError("invalid_url", "Supported HTTPS album URL required");
  const ref = normalizeAlbumUrl("khinsider", value) ?? normalizeAlbumUrl("zophar", value);
  if (!ref) throw new LibraryError("invalid_url", "Supported HTTPS album URL required");
  return ref;
}

/** userId is supplied only by a trusted session or local administrator, never a request body. */
export class BookmarkStore {
  readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }

  get(userId: string, bookmarkId: string): Bookmark {
    const row = this.db.prepare(`${select} WHERE li.user_id = ? AND li.id = ?`).get(userId, id.parse(bookmarkId)) as Row | undefined;
    if (!row) throw new LibraryError("not_found", "Bookmark not found");
    return view(row);
  }

  list(userId: string, input: unknown = {}): { items: Bookmark[]; nextOffset: number | null } {
    const options = listBookmarkInput.parse(input);
    const query = normalizeSearch(options.q);
    const clauses = ["li.user_id = @userId", "bc.member_id IS NULL"];
    const parameters: Record<string, string | number> = { userId, limit: options.limit + 1, offset: options.offset };
    if (options.favorite) { clauses.push("li.favorite = @favorite"); parameters.favorite = Number(options.favorite === "true"); }
    if (options.standalone) clauses.push("NOT EXISTS (SELECT 1 FROM bookmark_connection WHERE parent_id = li.id)");
    if (query) {
      // Search the original records, map each owned hit to its representative, then deduplicate.
      const matches = `SELECT COALESCE(c.parent_id, owned.id) FROM library_item owned
        JOIN bookmark ob ON ob.entity_id = owned.entity_id AND ob.owner_id = owned.user_id
        LEFT JOIN bookmark_connection c ON c.member_id = owned.id AND c.user_id = owned.user_id
        WHERE owned.user_id = @userId AND `;
      if ([...query].length >= 3) {
        clauses.push(`li.id IN (${matches} owned.id IN (SELECT library_item_id FROM bookmark_search WHERE bookmark_search MATCH @query))`);
        parameters.query = `"${query.replaceAll('"', '""')}"`;
      } else {
        clauses.push(`li.id IN (${matches} instr(normalize_search(ob.entered_title || ' ' || owned.note), @query) > 0)`);
        parameters.query = query;
      }
    }
    const rows = this.db.prepare(`${select} WHERE ${clauses.join(" AND ")}
      ORDER BY li.created_at DESC, li.id DESC LIMIT @limit OFFSET @offset`).all(parameters) as Row[];
    return { items: rows.slice(0, options.limit).map(view), nextOffset: rows.length > options.limit ? options.offset + options.limit : null };
  }

  create(userId: string, input: unknown): { item: Bookmark; created: boolean } {
    const data = createBookmarkInput.parse(input);
    const ref = sourceRef(data.url);
    return this.db.transaction(() => {
      const existing = this.db.prepare(`${select} WHERE li.user_id = ? AND b.source_id = ? AND b.external_key = ?`)
        .get(userId, ref.sourceId, ref.externalKey) as Row | undefined;
      // Double submission never overwrites an existing title or note.
      if (existing) return { item: view(existing), created: false };
      const entityId = randomUUID();
      const itemId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO entity(id, kind, created_at) VALUES (?, 'bookmark', ?)").run(entityId, now);
      this.db.prepare(`INSERT INTO bookmark(entity_id, owner_id, source_id, external_key, entered_title, page_url)
        VALUES (?, ?, ?, ?, ?, ?)`).run(entityId, userId, ref.sourceId, ref.externalKey, data.title, ref.pageUrl);
      this.db.prepare(`INSERT INTO library_item(id, user_id, entity_id, note, favorite, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(itemId, userId, entityId, data.note, Number(data.favorite), now, now);
      return { item: this.get(userId, itemId), created: true };
    }).immediate();
  }

  update(userId: string, bookmarkId: string, input: unknown): Bookmark {
    const data = updateBookmarkInput.parse(input);
    const ref = data.url ? sourceRef(data.url) : null;
    return this.db.transaction(() => {
      const current = this.get(userId, bookmarkId);
      if (current.version !== data.version) throw new LibraryError("conflict", "Bookmark changed; reload before editing");
      if (ref && this.db.prepare(`SELECT 1 FROM bookmark WHERE owner_id = ? AND source_id = ? AND external_key = ? AND entity_id <> ?`)
        .get(userId, ref.sourceId, ref.externalKey, current.entityId)) throw new LibraryError("conflict", "This source is already bookmarked");
      this.db.prepare(`UPDATE bookmark SET entered_title = ?, page_url = ?, source_id = ?, external_key = ?
        WHERE entity_id = ? AND owner_id = ?`).run(data.title ?? current.title, ref?.pageUrl ?? current.url,
        ref?.sourceId ?? current.sourceId, ref?.externalKey ?? current.externalKey, current.entityId, userId);
      this.db.prepare(`UPDATE library_item SET note = ?, favorite = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND user_id = ?`).run(data.note ?? current.note, Number(data.favorite ?? current.favorite), new Date().toISOString(), bookmarkId, userId);
      if (current.rootId !== current.id) this.touch(userId, current.rootId);
      return this.get(userId, bookmarkId);
    }).immediate();
  }

  delete(userId: string, bookmarkId: string, version: number): void {
    z.number().int().positive().parse(version);
    this.db.transaction(() => {
      const current = this.get(userId, bookmarkId);
      if (current.version !== version) throw new LibraryError("conflict", "Bookmark changed; reload before deleting");
      if (current.rootId !== current.id || current.sourceCount > 1)
        throw new LibraryError("grouped_bookmark", "Disconnect bookmarks before deleting");
      this.db.prepare("DELETE FROM library_item WHERE id = ? AND user_id = ?").run(bookmarkId, userId);
      this.db.prepare("DELETE FROM bookmark WHERE entity_id = ? AND owner_id = ?").run(current.entityId, userId);
      this.db.prepare("DELETE FROM entity WHERE id = ? AND kind = 'bookmark'").run(current.entityId);
    }).immediate();
  }

  connections(userId: string, bookmarkId: string): BookmarkConnections {
    const current = this.get(userId, bookmarkId);
    const root = current.rootId === current.id ? current : this.get(userId, current.rootId);
    const members = this.db.prepare(`${select} WHERE li.user_id = ? AND bc.parent_id = ?
      ORDER BY bc.connected_at, li.id`).all(userId, root.id) as Row[];
    return { root, members: members.map(view) };
  }

  connect(userId: string, bookmarkId: string, input: unknown): BookmarkConnections {
    const data = connectionInput.parse(input);
    return this.db.transaction(() => {
      const root = this.get(userId, bookmarkId), member = this.get(userId, data.memberId);
      this.checkVersions(root, member, data);
      if (root.id === member.id) throw new LibraryError("invalid_connection", "Cannot connect a bookmark to itself");
      if (root.rootId !== root.id || member.rootId !== member.id || member.sourceCount > 1)
        throw new LibraryError("grouped_bookmark", "Choose a standalone bookmark to connect");
      if (root.sourceCount >= 20) throw new LibraryError("connection_limit", "At most 20 sources per group");
      this.db.prepare(`INSERT INTO bookmark_connection(member_id, parent_id, user_id, connected_at) VALUES (?, ?, ?, ?)`)
        .run(member.id, root.id, userId, new Date().toISOString());
      this.touch(userId, root.id); this.touch(userId, member.id);
      return this.connections(userId, root.id);
    }).immediate();
  }

  disconnect(userId: string, bookmarkId: string, input: unknown): DisconnectedBookmark {
    const data = connectionInput.parse(input);
    return this.db.transaction(() => {
      const root = this.get(userId, bookmarkId), member = this.get(userId, data.memberId);
      this.checkVersions(root, member, data);
      if (root.id === member.id || root.rootId !== root.id || member.rootId !== root.id)
        throw new LibraryError("conflict", "Connection changed; reload before disconnecting");
      this.db.prepare("DELETE FROM bookmark_connection WHERE user_id = ? AND parent_id = ? AND member_id = ?")
        .run(userId, root.id, member.id);
      this.touch(userId, root.id); this.touch(userId, member.id);
      return { group: this.connections(userId, root.id), detached: this.get(userId, member.id) };
    }).immediate();
  }

  private touch(userId: string, bookmarkId: string) {
    this.db.prepare("UPDATE library_item SET version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(new Date().toISOString(), bookmarkId, userId);
  }

  private checkVersions(root: Bookmark, member: Bookmark, data: z.infer<typeof connectionInput>) {
    if (root.version !== data.version || member.version !== data.memberVersion)
      throw new LibraryError("conflict", "Bookmark changed; reload before changing connections");
  }
}
