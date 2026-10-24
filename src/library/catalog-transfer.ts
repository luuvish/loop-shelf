import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { readManagedEntity } from "../catalog/entities.ts";
import type { ArchiveCatalogItem, CatalogArchive, CatalogArchiveV2, TypedCatalogReference } from "../shared/catalog-transfer.ts";
import { ARCHIVE_MAX_ITEMS, type ImportPreview, type ImportResult } from "../shared/transfer.ts";
import { CatalogLibraryStore } from "./catalog.ts";
import { archiveItemOf, referenceOf, unresolvedTitle } from "./catalog-references.ts";
import { boundCatalogArchive, parseCatalogArchive, catalogArchiveV2 } from "./catalog-archive.ts";
import { TransferError } from "./transfer.ts";
import { hasRetentionModel, reconcileCatalogRetention } from "../catalog/retention.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Snapshot { items: ArchiveCatalogItem<TypedCatalogReference>[]; versions: { id: string; version: number; unresolved: boolean }[] }
/** Authenticated private-file transfer. No shared catalog writes, URL matching, or network calls. */
export class CatalogTransfer {
  readonly db: Database.Database; readonly secret: string;
  constructor(db: Database.Database, secret: string) { this.db = db; this.secret = secret; }
  private snapshot(userId: string): Snapshot {
    reconcileCatalogRetention(this.db);
    const ids = this.db.prepare(`SELECT li.id FROM library_item li JOIN entity e ON e.id=li.entity_id WHERE li.user_id=@userId AND e.kind IN ('album','track')
      UNION ALL SELECT id FROM catalog_detached_item WHERE user_id=@userId ORDER BY id LIMIT @limit`).all({ userId, limit: ARCHIVE_MAX_ITEMS + 1 }) as { id: string }[];
    if (ids.length > ARCHIVE_MAX_ITEMS) throw new TransferError("archive_too_large");
    const store = new CatalogLibraryStore(this.db), items = ids.map(({ id }) => store.get(userId, id));
    return { items: items.map(archiveItemOf), versions: items.map((item) => ({ id: item.id, version: item.version, unresolved: item.entity.contentState === "unresolved" })) };
  }
  private archive(items: ArchiveCatalogItem<TypedCatalogReference>[]): CatalogArchiveV2 {
    return { format: "loopshelf-catalog", schemaVersion: 2, exportedAt: new Date().toISOString(), items };
  }
  export(userId: string): CatalogArchiveV2 {
    return this.db.transaction(() => { const archive = this.archive(this.snapshot(userId).items); boundCatalogArchive(archive); return archive; }).deferred();
  }
  private referenceState(ref: TypedCatalogReference): "resolved" | "unresolved" | "conflict" {
    const privateId = this.db.prepare("SELECT 1 FROM library_item WHERE id=@id UNION ALL SELECT 1 FROM catalog_detached_item WHERE id=@id");
    if ([ref.entityId, ref.albumId, ref.source.id].some((id) => privateId.get({ id }))) return "conflict";
    if (this.db.prepare("SELECT 1 FROM entity WHERE id=?").get(ref.source.id)
      || this.db.prepare("SELECT 1 FROM source_entity WHERE id IN (?,?)").get(ref.entityId, ref.albumId)
      || this.db.prepare("SELECT 1 FROM entity WHERE id=? AND kind<>'album'").get(ref.albumId)) return "conflict";
    const entity = readManagedEntity(this.db, ref.entityId);
    if (entity) return JSON.stringify(referenceOf(entity)) === JSON.stringify(ref) ? "resolved" : "conflict";
    const kind = this.db.prepare("SELECT kind FROM entity WHERE id=?").get(ref.entityId) as { kind: string } | undefined;
    if (kind && kind.kind !== ref.kind) return "conflict";
    const source = this.db.prepare("SELECT source_id,external_key,entity_id FROM source_entity WHERE id=?").get(ref.source.id) as { source_id: string; external_key: string; entity_id: string | null } | undefined;
    if (source && (source.source_id !== ref.source.sourceId || source.external_key !== ref.source.externalKey || source.entity_id !== ref.albumId)) return "conflict";
    if (source && hasRetentionModel(this.db)) {
      const known = this.db.prepare("SELECT sample_kind FROM catalog_source_kind WHERE source_entity_id=?").get(ref.source.id) as { sample_kind: string } | undefined;
      if (known && known.sample_kind !== ref.sampleKind) return "conflict";
    }
    return "unresolved";
  }
  private inspect(userId: string, archive: CatalogArchiveV2, snapshot: Snapshot) {
    const current = new Map(snapshot.items.map((item) => [item.id, item])), byEntity = new Set(snapshot.items.map((item) => item.reference.entityId));
    const occupied = this.db.prepare(`SELECT 1 FROM library_item WHERE id=@id UNION ALL SELECT 1 FROM catalog_detached_item WHERE id=@id
      UNION ALL SELECT 1 FROM entity WHERE id=@id UNION ALL SELECT 1 FROM source_entity WHERE id=@id LIMIT 1`);
    const linked = this.db.prepare(`SELECT library_item_id AS id FROM user_source_link WHERE user_id=@userId AND source_entity_id=@sourceId UNION ALL
      SELECT library_item_id AS id FROM catalog_detached_link WHERE user_id=@userId AND source_entity_id=@sourceId`);
    const conflicts: ImportPreview["conflicts"] = [], additions: { item: ArchiveCatalogItem<TypedCatalogReference>; unresolved: boolean }[] = [];
    let skipCount = 0;
    const resolution: string[][] = [];
    archive.items.forEach((item, index) => {
      const existing = current.get(item.id), refs = [item.reference, ...item.sourceLinks.map((link) => link.reference)], states = refs.map((ref) => this.referenceState(ref));
      resolution.push(refs.map((ref, index) => {
        const entity = readManagedEntity(this.db, ref.entityId);
        return JSON.stringify([states[index], entity?.contentState, entity?.presence, entity?.sourceAvailability, entity?.lifecycle, entity?.sampleKind]);
      }));
      let reason: ImportPreview["conflicts"][number]["reason"] | undefined;
      if (existing) {
        if (JSON.stringify(existing.reference) !== JSON.stringify(item.reference)) reason = "id_conflict";
        else if (JSON.stringify(existing) !== JSON.stringify(item)) reason = "content_conflict";
        else skipCount++;
      } else if (occupied.get({ id: item.id }) || states.includes("conflict")) reason = "id_conflict";
      else if (byEntity.has(item.reference.entityId)) reason = "source_conflict";
      else if (item.sourceLinks.some((link) => linked.get({ userId, sourceId: link.reference.source.id }))) reason = "connection_conflict";
      else additions.push({ item, unresolved: states.includes("unresolved") });
      if (reason) conflicts.push({ index, title: item.titleOverride ?? unresolvedTitle(item.reference.kind), reason });
    });
    if (!conflicts.length) {
      if (snapshot.items.length + additions.length > ARCHIVE_MAX_ITEMS) throw new TransferError("archive_too_large");
      boundCatalogArchive(this.archive([...snapshot.items, ...additions.map(({ item }) => item)]));
    }
    return { additions, resolution, summary: { scope: "catalog" as const, addCount: additions.length, skipCount,
      unresolvedCount: additions.filter((item) => item.unresolved).length, connectionCount: additions.reduce((sum, { item }) => sum + item.sourceLinks.length, 0),
      conflictCount: conflicts.length, conflicts: conflicts.slice(0, 50) } };
  }
  private signature(userId: string, archive: CatalogArchive, snapshot: Snapshot, resolution: string[][], expires: string) {
    return createHmac("sha256", this.secret).update(JSON.stringify(["loopshelf-catalog-import-v2", userId, digest(archive), digest(snapshot), resolution, expires])).digest("hex");
  }
  preview(userId: string, input: unknown): ImportPreview {
    const file = parseCatalogArchive(input), archive = catalogArchiveV2(file);
    return this.db.transaction(() => {
      const snapshot = this.snapshot(userId), plan = this.inspect(userId, archive, snapshot), expires = String(Date.now() + 600000);
      return { ...plan.summary, token: plan.summary.conflictCount ? null : `${expires}.${this.signature(userId, file, snapshot, plan.resolution, expires)}` };
    }).deferred();
  }
  import(userId: string, input: unknown, token: string): ImportResult {
    const file = parseCatalogArchive(input), archive = catalogArchiveV2(file);
    return this.db.transaction(() => {
      const snapshot = this.snapshot(userId), plan = this.inspect(userId, archive, snapshot), match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
      if (!match || Number(match[1]) < Date.now() || !timingSafeEqual(Buffer.from(match[2]!, "hex"), Buffer.from(this.signature(userId, file, snapshot, plan.resolution, match[1]!), "hex")))
        throw new TransferError("preview_stale");
      if (plan.summary.conflictCount) throw new TransferError("import_conflict");
      for (const { item, unresolved } of plan.additions) {
        const revision = this.db.prepare<[], { value: number }>("UPDATE library_revision SET value=value+1 WHERE singleton=1 RETURNING value").get()!.value;
        if (unresolved) {
          this.db.prepare(`INSERT INTO catalog_detached_item(id,user_id,entity_id,kind,reference_json,title_override,note,favorite,version,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(item.id, userId, item.reference.entityId, item.reference.kind, JSON.stringify(item.reference), item.titleOverride, item.note, Number(item.favorite), revision, item.createdAt, item.updatedAt);
          for (const link of item.sourceLinks) this.db.prepare("INSERT INTO catalog_detached_link VALUES (?,?,?,?,?)").run(item.id, userId, link.reference.source.id, JSON.stringify(link.reference), link.assertedAt);
        } else {
          this.db.prepare("INSERT INTO library_item(id,user_id,entity_id,title_override,note,favorite,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(item.id, userId, item.reference.entityId, item.titleOverride, item.note, Number(item.favorite), revision, item.createdAt, item.updatedAt);
          for (const link of item.sourceLinks) this.db.prepare("INSERT INTO user_source_link VALUES (?,?,?,?)").run(userId, item.id, link.reference.source.id, link.assertedAt);
        }
      }
      return { scope: "catalog" as const, added: plan.additions.length, skipped: plan.summary.skipCount, connectionsAdded: plan.summary.connectionCount, unresolved: plan.summary.unresolvedCount };
    }).immediate();
  }
}
