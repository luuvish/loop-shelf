import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createBookmarkInput } from "./bookmarks.ts";
import { normalizeAlbumUrl } from "../sources/urls.ts";
import { ARCHIVE_MAX_BYTES, ARCHIVE_MAX_ITEMS } from "../shared/transfer.ts";
import type { ArchiveBookmark, ArchiveConnection, BookmarkArchive, ImportPreview, ImportResult } from "../shared/transfer.ts";

export class TransferError extends Error {
  readonly code: "invalid_archive" | "archive_too_large" | "import_conflict" | "preview_stale";
  constructor(code: TransferError["code"]) { super(code); this.code = code; }
}
const timestamp = z.iso.datetime({ precision: 3 });
const recordSchema = z.object({
  id: z.uuid(), entityId: z.uuid(), title: createBookmarkInput.shape.title,
  url: createBookmarkInput.shape.url, note: createBookmarkInput.shape.note.removeDefault(),
  favorite: z.boolean(), createdAt: timestamp, updatedAt: timestamp,
}).strict();
const archiveSchema = z.object({
  format: z.literal("loopshelf-bookmarks"), schemaVersion: z.literal(1), exportedAt: timestamp,
  bookmarks: z.array(recordSchema).max(ARCHIVE_MAX_ITEMS),
  connections: z.array(z.object({ parentId: z.uuid(), memberId: z.uuid(), connectedAt: timestamp }).strict()).max(ARCHIVE_MAX_ITEMS),
}).strict();
export const previewInput = z.object({ archive: z.unknown() }).strict();
export const importInput = previewInput.extend({ token: z.string().max(200) }).strict();
const source = (url: string) => url.startsWith("https://")
  ? normalizeAlbumUrl("khinsider", url) ?? normalizeAlbumUrl("zophar", url) : null;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") + 1 > ARCHIVE_MAX_BYTES) throw new TransferError("archive_too_large");
}

export function parseArchive(input: unknown): BookmarkArchive {
  bounded(input);
  const result = archiveSchema.safeParse(input);
  if (!result.success) throw new TransferError("invalid_archive");
  const archive = result.data;
  const ids = new Set<string>(), itemIds = new Set<string>(), sources = new Set<string>();
  for (const item of archive.bookmarks) {
    const ref = source(item.url);
    if (!ref || ref.pageUrl !== item.url || ids.has(item.id) || ids.has(item.entityId) || item.id === item.entityId
      || /\p{Surrogate}/u.test(item.title + item.note) || item.createdAt > item.updatedAt
      || sources.has(`${ref.sourceId}:${ref.externalKey}`)) throw new TransferError("invalid_archive");
    ids.add(item.id); ids.add(item.entityId); itemIds.add(item.id); sources.add(`${ref.sourceId}:${ref.externalKey}`);
  }
  // Reject silent trimming: an accepted file is restored without changing its personal text.
  const rawItems = (input as BookmarkArchive).bookmarks;
  if (archive.bookmarks.some((item, index) => item.title !== rawItems[index]!.title || item.url !== rawItems[index]!.url)) throw new TransferError("invalid_archive");
  const members = new Set<string>(), parents = new Map<string, number>();
  for (const link of archive.connections) {
    if (!itemIds.has(link.parentId) || !itemIds.has(link.memberId) || link.parentId === link.memberId || members.has(link.memberId)) throw new TransferError("invalid_archive");
    members.add(link.memberId); parents.set(link.parentId, (parents.get(link.parentId) ?? 0) + 1);
  }
  if ([...parents].some(([parent, count]) => members.has(parent) || count > 19)) throw new TransferError("invalid_archive");
  return archive;
}

interface Snapshot { bookmarks: ArchiveBookmark[]; connections: ArchiveConnection[]; versions: { id: string; version: number }[] }
export class LibraryTransfer {
  readonly db: Database.Database;
  readonly secret: string;
  constructor(db: Database.Database, secret: string) { this.db = db; this.secret = secret; }

  private snapshot(userId: string): Snapshot {
    const rows = this.db.prepare(`SELECT li.id, li.entity_id AS entityId, b.entered_title AS title, b.page_url AS url,
      li.note, li.favorite, li.created_at AS createdAt, li.updated_at AS updatedAt, li.version
      FROM library_item li JOIN bookmark b ON b.entity_id = li.entity_id AND b.owner_id = li.user_id
      WHERE li.user_id = ? ORDER BY li.id LIMIT ?`).all(userId, ARCHIVE_MAX_ITEMS + 1) as (Omit<ArchiveBookmark, "favorite"> & { favorite: number; version: number })[];
    if (rows.length > ARCHIVE_MAX_ITEMS) throw new TransferError("archive_too_large");
    const connections = this.db.prepare(`SELECT parent_id AS parentId, member_id AS memberId, connected_at AS connectedAt
      FROM bookmark_connection WHERE user_id = ? ORDER BY member_id`).all(userId) as ArchiveConnection[];
    return { bookmarks: rows.map(({ version: _version, favorite, ...item }) => ({ ...item, favorite: !!favorite })),
      versions: rows.map(({ id, version }) => ({ id, version })), connections };
  }

  export(userId: string): BookmarkArchive {
    return this.db.transaction(() => {
      const snapshot = this.snapshot(userId);
      const archive: BookmarkArchive = { format: "loopshelf-bookmarks", schemaVersion: 1, exportedAt: new Date().toISOString(),
        bookmarks: snapshot.bookmarks, connections: snapshot.connections };
      bounded(archive); return archive;
    })();
  }

  private inspect(archive: BookmarkArchive, snapshot: Snapshot) {
    const existing = new Map(snapshot.bookmarks.map((item) => [item.id, item]));
    const bySource = new Map(snapshot.bookmarks.map((item) => [item.url, item.id]));
    const linksFor = (links: ArchiveConnection[]) => {
      const map = new Map<string, string[]>();
      for (const link of links) for (const id of [link.parentId, link.memberId]) {
        const items = map.get(id) ?? []; items.push(JSON.stringify(link)); map.set(id, items);
      }
      return new Map([...map].map(([id, items]) => [id, JSON.stringify(items.sort())]));
    };
    const beforeLinks = linksFor(snapshot.connections), afterLinks = linksFor(archive.connections);
    const occupied = this.db.prepare("SELECT 1 FROM entity WHERE id = @id UNION ALL SELECT 1 FROM library_item WHERE id = @id UNION ALL SELECT 1 FROM catalog_detached_item WHERE id=@id LIMIT 1");
    const conflicts: ImportPreview["conflicts"] = [], additions: ArchiveBookmark[] = [];
    let skipCount = 0;
    archive.bookmarks.forEach((item, index) => {
      const current = existing.get(item.id);
      let reason: ImportPreview["conflicts"][number]["reason"] | undefined;
      if (current) {
        if (current.entityId !== item.entityId) reason = "id_conflict";
        else if (Object.keys(current).some((key) => current[key as keyof ArchiveBookmark] !== item[key as keyof ArchiveBookmark])) reason = "content_conflict";
        else if ((beforeLinks.get(item.id) ?? "[]") !== (afterLinks.get(item.id) ?? "[]")) reason = "connection_conflict";
        else skipCount++;
      } else if (occupied.get({ id: item.id }) || occupied.get({ id: item.entityId })) reason = "id_conflict";
      else if (bySource.has(item.url)) reason = "source_conflict";
      else additions.push(item);
      // Only incoming fields are returned. Never reveal another owner's content or identity.
      if (reason) conflicts.push({ index, title: item.title, reason });
    });
    const newIds = new Set(additions.map((item) => item.id));
    const links = archive.connections.filter((link) => newIds.has(link.memberId));
    if (!conflicts.length) {
      if (snapshot.bookmarks.length + additions.length > ARCHIVE_MAX_ITEMS) throw new TransferError("archive_too_large");
      bounded({ format: "loopshelf-bookmarks", schemaVersion: 1, exportedAt: new Date().toISOString(),
        bookmarks: [...snapshot.bookmarks, ...additions], connections: [...snapshot.connections, ...links] });
    }
    return { additions, links, summary: { addCount: additions.length, skipCount, connectionCount: links.length,
      conflictCount: conflicts.length, conflicts: conflicts.slice(0, 50) } };
  }

  private signature(userId: string, archive: BookmarkArchive, snapshot: Snapshot, expires: string) {
    return createHmac("sha256", this.secret).update(JSON.stringify(["loopshelf-import-v1", userId, digest(archive), digest(snapshot), expires])).digest("hex");
  }

  preview(userId: string, input: unknown): ImportPreview {
    const archive = parseArchive(input);
    return this.db.transaction(() => {
      const snapshot = this.snapshot(userId), plan = this.inspect(archive, snapshot);
      const expires = String(Date.now() + 10 * 60 * 1000);
      return { ...plan.summary, token: plan.summary.conflictCount ? null : `${expires}.${this.signature(userId, archive, snapshot, expires)}` };
    })();
  }

  import(userId: string, input: unknown, token: string): ImportResult {
    const archive = parseArchive(input);
    return this.db.transaction(() => {
      const snapshot = this.snapshot(userId);
      const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
      if (!match || Number(match[1]) < Date.now() || !timingSafeEqual(Buffer.from(match[2]!, "hex"), Buffer.from(this.signature(userId, archive, snapshot, match[1]!), "hex")))
        throw new TransferError("preview_stale");
      const plan = this.inspect(archive, snapshot);
      if (plan.summary.conflictCount) throw new TransferError("import_conflict");
      for (const item of plan.additions) {
        const ref = source(item.url)!;
        const revision = this.db.prepare<[], { value: number }>("UPDATE library_revision SET value = value + 1 WHERE singleton = 1 RETURNING value").get()!.value;
        this.db.prepare("INSERT INTO entity(id, kind, created_at) VALUES (?, 'bookmark', ?)").run(item.entityId, item.createdAt);
        this.db.prepare(`INSERT INTO bookmark(entity_id, owner_id, source_id, external_key, entered_title, page_url) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(item.entityId, userId, ref.sourceId, ref.externalKey, item.title, item.url);
        this.db.prepare(`INSERT INTO library_item(id, user_id, entity_id, note, favorite, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(item.id, userId, item.entityId, item.note, Number(item.favorite), revision, item.createdAt, item.updatedAt);
      }
      for (const link of plan.links) this.db.prepare("INSERT INTO bookmark_connection(member_id, parent_id, user_id, connected_at) VALUES (?, ?, ?, ?)")
        .run(link.memberId, link.parentId, userId, link.connectedAt);
      return { added: plan.additions.length, skipped: plan.summary.skipCount, connectionsAdded: plan.links.length };
    }).immediate();
  }
}
