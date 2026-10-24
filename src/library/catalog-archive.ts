import { z } from "zod";
import { normalizeAlbumUrl } from "../sources/urls.ts";
import { ARCHIVE_MAX_BYTES, ARCHIVE_MAX_ITEMS } from "../shared/transfer.ts";
import type { CatalogArchive, CatalogArchiveV2, TypedCatalogReference } from "../shared/catalog-transfer.ts";
import { TransferError } from "./transfer.ts";

const timestamp = z.iso.datetime({ precision: 3 });
const reference = z.object({ entityId: z.uuid(), kind: z.enum(["album", "track"]), albumId: z.uuid(),
  source: z.object({ id: z.uuid(), sourceId: z.enum(["khinsider", "zophar"]), externalKey: z.string().min(1).max(2048), pageUrl: z.string().max(2048) }).strict(),
}).strict();
const item = z.object({ id: z.uuid(), reference, titleOverride: z.string().min(1).max(300).refine((v) => v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v)).nullable(),
  note: z.string().max(10000).refine((v) => !v.includes("\0")), favorite: z.boolean(), createdAt: timestamp, updatedAt: timestamp,
  sourceLinks: z.array(z.object({ reference, assertedAt: timestamp }).strict()).max(20),
}).strict();
const typedReference = reference.extend({ sampleKind: z.enum(["synthetic", "live-capture"]) });
const typedItem = item.extend({ reference: typedReference, sourceLinks: z.array(z.object({ reference: typedReference, assertedAt: timestamp }).strict()).max(20) });
const schema = z.discriminatedUnion("schemaVersion", [
  z.object({ format: z.literal("loopshelf-catalog"), schemaVersion: z.literal(1), sampleKind: z.literal("synthetic"), exportedAt: timestamp, items: z.array(item).max(ARCHIVE_MAX_ITEMS) }).strict(),
  z.object({ format: z.literal("loopshelf-catalog"), schemaVersion: z.literal(2), exportedAt: timestamp, items: z.array(typedItem).max(ARCHIVE_MAX_ITEMS) }).strict(),
]);
/** Normalize only after strict version-specific validation; missing kinds are legal solely in v1. */
export function catalogArchiveV2(archive: CatalogArchive): CatalogArchiveV2 {
  if (archive.schemaVersion === 2) return archive;
  return { format: archive.format, schemaVersion: 2, exportedAt: archive.exportedAt, items: archive.items.map((row) => ({ ...row,
    reference: { ...row.reference, sampleKind: "synthetic" },
    sourceLinks: row.sourceLinks.map((link) => ({ ...link, reference: { ...link.reference, sampleKind: "synthetic" } })),
  })) };
}
/** Older immutable detached rows contain v1 references; their kind remains synthetic. */
export function storedCatalogReference(json: string): TypedCatalogReference {
  const raw: unknown = JSON.parse(json), parsed = typedReference.safeParse(raw);
  if (parsed.success) return parsed.data;
  const legacy = reference.safeParse(raw);
  if (!legacy.success) throw new TransferError("invalid_archive");
  return { ...legacy.data, sampleKind: "synthetic" };
}
export function boundCatalogArchive(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") + 1 > ARCHIVE_MAX_BYTES) throw new TransferError("archive_too_large");
}
export function parseCatalogArchive(input: unknown): CatalogArchive {
  boundCatalogArchive(input);
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new TransferError("invalid_archive");
  const archive = catalogArchiveV2(parsed.data), ids = new Set<string>(), entities = new Set<string>(), links = new Set<string>();
  const roles = new Map<string, string>(), references = new Map<string, string>(), sources = new Map<string, string>();
  const fail = (): never => { throw new TransferError("invalid_archive"); };
  function claim(id: string, role: string) { if (roles.has(id) && roles.get(id) !== role) fail(); roles.set(id, role); }
  function inspect(ref: TypedCatalogReference) {
    const normalized = normalizeAlbumUrl(ref.source.sourceId, ref.source.pageUrl);
    if (!ref.source.pageUrl.startsWith("https://") || !normalized || normalized.externalKey !== ref.source.externalKey || normalized.pageUrl !== ref.source.pageUrl
      || (ref.kind === "album") !== (ref.albumId === ref.entityId)) fail();
    claim(ref.entityId, ref.kind); claim(ref.albumId, "album"); claim(ref.source.id, "source");
    for (const value of [ref, { ...ref, kind: "album", entityId: ref.albumId }]) {
      const json = JSON.stringify(value);
      if (references.has(value.entityId) && references.get(value.entityId) !== json) fail(); references.set(value.entityId, json);
    }
    const sourceValue = JSON.stringify([ref.source, ref.albumId, ref.sampleKind]);
    if (sources.has(ref.source.id) && sources.get(ref.source.id) !== sourceValue) fail(); sources.set(ref.source.id, sourceValue);
  }
  for (const item of archive.items) {
    if (ids.has(item.id) || entities.has(item.reference.entityId) || item.createdAt > item.updatedAt
      || /\p{Surrogate}/u.test((item.titleOverride ?? "") + item.note) || (item.reference.kind === "track" && item.sourceLinks.length)) fail();
    ids.add(item.id); entities.add(item.reference.entityId); claim(item.id, "private"); inspect(item.reference);
    for (const link of item.sourceLinks) {
      if (link.reference.sampleKind !== item.reference.sampleKind || link.reference.kind !== "album" || link.reference.source.id === item.reference.source.id || links.has(link.reference.source.id)) fail();
      links.add(link.reference.source.id); inspect(link.reference);
    }
    item.sourceLinks.sort((a, b) => a.reference.source.id.localeCompare(b.reference.source.id));
  }
  for (const row of parsed.data.items) row.sourceLinks.sort((a, b) => a.reference.source.id.localeCompare(b.reference.source.id));
  return parsed.data;
}
