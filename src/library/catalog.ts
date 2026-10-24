import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { normalizeSearch } from "../database/connection.ts";
import { readManagedEntity } from "../catalog/entities.ts";
import { reconcileCatalogRetention } from "../catalog/retention.ts";
import { readDetached } from "./catalog-references.ts";
import type { CatalogLibraryItem, CatalogLibraryPage, PersonalCatalogSource, SavedCatalogEntity } from "../shared/catalog-library.ts";

const title = z.string().trim().min(1).max(300).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const note = z.string().max(10000).refine((value) => !value.includes("\0"));
const version = z.number().int().positive().safe();
const createInput = z.object({ entityId: z.uuid(), titleOverride: title.nullable().default(null), note: note.default(""), favorite: z.boolean().default(false) }).strict();
const updateInput = z.object({ titleOverride: title.nullable().optional(), note: note.optional(), favorite: z.boolean().optional(), version }).strict()
  .refine((value) => Object.keys(value).some((key) => key !== "version"), { message: "No changes supplied" });
const linkInput = z.object({ sourceEntityId: z.uuid(), version }).strict();
const deleteInput = z.object({ version }).strict();
const listInput = z.object({ q: z.string().trim().max(200).default(""), favorite: z.enum(["true", "false"]).optional(),
  kind: z.enum(["album", "track"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();

export class CatalogLibraryError extends Error {
  readonly code: "not_found" | "conflict" | "catalog_unavailable" | "invalid_connection" | "connection_limit";
  constructor(code: CatalogLibraryError["code"], message: string) { super(message); this.code = code; }
}
interface ItemRow { id: string; entityId: string; titleOverride: string | null; note: string; favorite: number;
  version: number; createdAt: string; updatedAt: string }
const itemSelect = `SELECT li.id,li.entity_id AS entityId,li.title_override AS titleOverride,li.note,li.favorite,li.version,
  li.created_at AS createdAt,li.updated_at AS updatedAt FROM library_item li JOIN entity e ON e.id=li.entity_id
  WHERE li.user_id=@userId AND e.kind IN ('album','track')`;

/** Synchronous operations; HTTP callers hold withDatabase across session validation and this store. */
export class CatalogLibraryStore {
  readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }

  private entity(entityId: string): SavedCatalogEntity {
    const entity = readManagedEntity(this.db, entityId);
    if (!entity) throw new CatalogLibraryError("not_found", "Managed catalog entity not found");
    return entity;
  }

  private view(userId: string, row: ItemRow): CatalogLibraryItem {
    const { entityId, favorite, ...data } = row, entity = this.entity(entityId);
    const links = this.db.prepare(`SELECT s.entity_id AS entityId,l.asserted_at AS assertedAt FROM user_source_link l
      JOIN source_entity s ON s.id=l.source_entity_id WHERE l.user_id=? AND l.library_item_id=? ORDER BY l.asserted_at,l.source_entity_id`)
      .all(userId, row.id) as { entityId: string; assertedAt: string }[];
    const sourceLinks: PersonalCatalogSource[] = links.map((link) => ({ source: this.entity(link.entityId), assertedAt: link.assertedAt, relationship: "user-asserted" }));
    return { ...data, entity, title: row.titleOverride ?? entity.title, favorite: favorite === 1, sourceLinks };
  }
  get(userId: string, itemId: string): CatalogLibraryItem {
    reconcileCatalogRetention(this.db);
    return this.db.transaction(() => {
      z.uuid().parse(itemId);
      const detached = readDetached(this.db, userId, itemId);
      if (detached) return detached;
      const row = this.db.prepare(`${itemSelect} AND li.id=@itemId`).get({ userId, itemId: z.uuid().parse(itemId) }) as ItemRow | undefined;
      if (!row) throw new CatalogLibraryError("not_found", "Saved catalog item not found");
      return this.view(userId, row);
    }).deferred();
  }
  list(userId: string, input: unknown = {}): CatalogLibraryPage {
    reconcileCatalogRetention(this.db);
    const options = listInput.parse(input), q = normalizeSearch(options.q);
    const params: Record<string, string | number> = { userId, limit: options.limit + 1, offset: options.offset };
    let where = "", detachedWhere = "";
    if (options.kind) { where += " AND e.kind=@kind"; detachedWhere += " AND kind=@kind"; params.kind = options.kind; }
    if (options.favorite) { where += " AND li.favorite=@favorite"; detachedWhere += " AND favorite=@favorite"; params.favorite = Number(options.favorite === "true"); }
    if (q) {
      // Read current metadata, never a retained search copy of removed source content. Literal NFKC substring search.
      where += ` AND (instr(normalize_search(coalesce(li.title_override,'') || ' ' || li.note || ' ' || coalesce(
        (SELECT title FROM track WHERE id=li.entity_id),(SELECT title FROM album WHERE id=li.entity_id),'')),@q)>0
        OR EXISTS (SELECT 1 FROM user_source_link l JOIN source_entity s ON s.id=l.source_entity_id JOIN album a ON a.id=s.entity_id
          WHERE l.user_id=@userId AND l.library_item_id=li.id AND instr(normalize_search(a.title),@q)>0))`;
      params.q = q;
      detachedWhere += ` AND instr(normalize_search(coalesce(title_override,CASE kind WHEN 'album' THEN '원본 미연결 앨범' ELSE '원본 미연결 트랙' END) || ' ' || note),@q)>0`;
    }
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id,createdAt FROM (${itemSelect}${where}) UNION ALL
        SELECT id,created_at AS createdAt FROM catalog_detached_item WHERE user_id=@userId${detachedWhere}
        ORDER BY createdAt DESC,id DESC LIMIT @limit OFFSET @offset`).all(params) as { id: string }[];
      return { items: rows.slice(0, options.limit).map((row) => this.get(userId, row.id)), nextOffset: rows.length > options.limit ? options.offset + options.limit : null };
    }).deferred();
  }
  private available(entity: SavedCatalogEntity) {
    if (entity.lifecycle === "unavailable" || entity.contentState !== "active" || entity.presence === "missing" || ["blocked", "not_found", "removed"].includes(entity.sourceAvailability))
      throw new CatalogLibraryError("catalog_unavailable", "Catalog content is unavailable for a new save or connection");
  }
  create(userId: string, input: unknown): { item: CatalogLibraryItem; created: boolean } {
    reconcileCatalogRetention(this.db);
    const data = createInput.parse(input);
    return this.db.transaction(() => {
      const detached = this.db.prepare("SELECT id FROM catalog_detached_item WHERE user_id=? AND entity_id=?").get(userId, data.entityId) as { id: string } | undefined;
      if (detached) return { item: this.get(userId, detached.id), created: false };
      const row = this.db.prepare(`${itemSelect} AND li.entity_id=@entityId`).get({ userId, entityId: data.entityId }) as ItemRow | undefined;
      if (row) return { item: this.view(userId, row), created: false }; // Preserve explicit private content on retry, including unavailable saves.
      this.available(this.entity(data.entityId));
      const itemId = randomUUID(), now = new Date().toISOString();
      this.db.prepare("INSERT INTO library_item(id,user_id,entity_id,title_override,note,favorite,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(itemId, userId, data.entityId, data.titleOverride, data.note, Number(data.favorite), now, now);
      return { item: this.get(userId, itemId), created: true };
    }).immediate();
  }
  private checkVersion(item: CatalogLibraryItem, expected: number) {
    if (item.version !== expected) throw new CatalogLibraryError("conflict", "Saved catalog item changed; reload first");
  }
  private touch(userId: string, itemId: string, detached = false) {
    this.db.prepare(`UPDATE ${detached ? "catalog_detached_item" : "library_item"} SET version=version+1,updated_at=? WHERE id=? AND user_id=?`).run(new Date().toISOString(), itemId, userId);
  }
  update(userId: string, itemId: string, input: unknown): CatalogLibraryItem {
    const data = updateInput.parse(input);
    return this.db.transaction(() => {
      const current = this.get(userId, itemId); this.checkVersion(current, data.version);
      const detached = current.entity.contentState === "unresolved";
      this.db.prepare(`UPDATE ${detached ? "catalog_detached_item" : "library_item"} SET title_override=?,note=?,favorite=? WHERE id=? AND user_id=?`)
        .run(data.titleOverride === undefined ? current.titleOverride : data.titleOverride, data.note ?? current.note, Number(data.favorite ?? current.favorite), itemId, userId);
      this.touch(userId, itemId, detached); return this.get(userId, itemId);
    }).immediate();
  }
  delete(userId: string, itemId: string, input: unknown): void {
    const data = deleteInput.parse(input);
    this.db.transaction(() => {
      const current = this.get(userId, itemId); this.checkVersion(current, data.version);
      // FK cascade removes only this user's judgments. Shared entities/other users are untouched.
      this.db.prepare(`DELETE FROM ${current.entity.contentState === "unresolved" ? "catalog_detached_item" : "library_item"} WHERE id=? AND user_id=?`).run(itemId, userId);
    }).immediate();
  }
  connect(userId: string, itemId: string, input: unknown): CatalogLibraryItem {
    const data = linkInput.parse(input);
    return this.db.transaction(() => {
      const current = this.get(userId, itemId); this.checkVersion(current, data.version);
      if (current.entity.contentState === "unresolved") this.available(current.entity);
      const source = this.db.prepare("SELECT entity_id FROM source_entity WHERE id=? AND external_kind='album'").get(data.sourceEntityId) as { entity_id: string | null } | undefined;
      if (!source?.entity_id) throw new CatalogLibraryError("not_found", "Managed album source not found");
      const target = this.entity(source.entity_id);
      if (current.entity.sampleKind !== target.sampleKind || current.entity.kind !== "album" || target.sourceEntityId !== data.sourceEntityId || current.entity.sourceEntityId === target.sourceEntityId)
        throw new CatalogLibraryError("invalid_connection", "Choose another managed album source; track sources are not available");
      const existing = this.db.prepare(`SELECT library_item_id FROM user_source_link WHERE user_id=@userId AND source_entity_id=@id UNION ALL
        SELECT library_item_id FROM catalog_detached_link WHERE user_id=@userId AND source_entity_id=@id`)
        .get({ userId, id: data.sourceEntityId }) as { library_item_id: string } | undefined;
      if (existing?.library_item_id === itemId) return current;
      if (existing) throw new CatalogLibraryError("conflict", "Source is already connected in your library; disconnect it first");
      this.available(current.entity); this.available(target);
      if (current.sourceLinks.length >= 20) throw new CatalogLibraryError("connection_limit", "At most 20 personal sources per item");
      this.db.prepare("INSERT INTO user_source_link VALUES (?,?,?,?)").run(userId, itemId, data.sourceEntityId, new Date().toISOString());
      this.touch(userId, itemId); return this.get(userId, itemId);
    }).immediate();
  }
  disconnect(userId: string, itemId: string, input: unknown): CatalogLibraryItem {
    const data = linkInput.parse(input);
    return this.db.transaction(() => {
      const current = this.get(userId, itemId); this.checkVersion(current, data.version);
      const detached = current.entity.contentState === "unresolved";
      const result = this.db.prepare(`DELETE FROM ${detached ? "catalog_detached_link" : "user_source_link"} WHERE user_id=? AND library_item_id=? AND source_entity_id=?`).run(userId, itemId, data.sourceEntityId);
      if (!result.changes) throw new CatalogLibraryError("not_found", "Personal source connection not found");
      this.touch(userId, itemId, detached); return this.get(userId, itemId);
    }).immediate();
  }
}
