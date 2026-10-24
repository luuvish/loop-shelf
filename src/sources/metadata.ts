import { z } from "zod";
import { isPageUrl, normalizeAlbumUrl, normalizeNextPage } from "./urls.ts";

export class MetadataError extends Error {
  readonly code: "invalid_input" | "parse_failure";
  constructor(code: MetadataError["code"], message: string) { super(message); this.code = code; }
}

export const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const text = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value));
const source = z.enum(["khinsider", "zophar"]);
const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const summary = z.object({
  sourceId: source, externalKey: text(1024), pageUrl: text(2048), title: text(1000),
  titleKind: z.enum(["album-title", "source-display-label"]), platforms: z.array(text(300)).max(100),
  sourceCategory: text(1000).nullable(), sourceYearLabel: text(1000).nullable(),
}).strict();
const track = z.object({
  externalKey: z.null(), snapshotLocator: text(300), position: z.number().int().positive().max(5000),
  displayNumber: text(100).nullable(), discLabel: z.null(), title: text(1000),
  durationLabel: text(300).nullable(), durationSeconds: z.number().int().nonnegative().max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)).nullable(),
}).strict();
const detail = summary.extend({ kind: z.literal("album"), titleKind: z.literal("album-title"),
  sourceClaims: z.array(z.object({ label: text(1000), value: text(10000) }).strict()).max(100),
  releaseDate: z.null(), tracks: z.array(track).min(1).max(5000), playback: z.literal("unverified"),
}).strict();
const search = z.object({ kind: z.literal("search"), albums: z.array(summary).max(1000),
  reportedCount: z.number().int().nonnegative().safe(), nextPageUrl: text(2048).nullable(),
  coverage: z.enum(["reported-count-matches", "partial-or-changed"]), resultLimit: z.null(),
}).strict();
const result = z.object({ ok: z.literal(true), data: z.discriminatedUnion("kind", [search, detail]),
  provenance: z.object({ sourceId: source, pageUrl: text(2048), capturedAt: timestamp, parsedAt: timestamp,
    parserVersion: text(100), bodySha256: z.string().regex(/^[a-f\d]{64}$/u), sampleKind: z.enum(["synthetic", "live-capture"]),
  }).strict(), warnings: z.array(text(1000)).max(100),
}).strict();
export type Metadata = z.infer<typeof result>;
export type AlbumObservationData = z.infer<typeof summary> | z.infer<typeof detail>;

/** Shape/provenance validation only; this does not grant collection, cache or display permission. */
export function validateMetadata(input: unknown): Metadata {
  const fail = (message: string): never => { throw new MetadataError("invalid_input", message); };
  let encoded: string | undefined;
  try { encoded = JSON.stringify(input); } catch { fail("A serializable parser result is required"); }
  if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_METADATA_BYTES) fail("Metadata exceeds its byte limit");
  if (input && typeof input === "object" && "ok" in input && input.ok === false)
    throw new MetadataError("parse_failure", "Successful parsed metadata is required");
  const parsed = result.safeParse(input);
  if (!parsed.success) fail("Invalid metadata DTO");
  const value = parsed.data!;
  const { data, provenance } = value;
  if (!provenance.pageUrl.startsWith("https://") || !isPageUrl(provenance.sourceId, data.kind, provenance.pageUrl)) fail("Invalid provenance URL");
  const albums = data.kind === "album" ? [data] : data.albums;
  if (new Set(albums.map((album) => album.externalKey)).size !== albums.length) fail("Repeated source album key");
  for (const album of albums) {
    const ref = normalizeAlbumUrl(album.sourceId, album.pageUrl);
    if (album.sourceId !== provenance.sourceId || !ref || ref.externalKey !== album.externalKey || ref.pageUrl !== album.pageUrl) fail("Source reference mismatch");
  }
  if (data.kind === "album") {
    if (normalizeAlbumUrl(provenance.sourceId, provenance.pageUrl)?.externalKey !== data.externalKey) fail("Detail provenance mismatch");
    if (data.tracks.some((row, index) => row.position !== index + 1)
      || new Set(data.tracks.map((row) => row.snapshotLocator)).size !== data.tracks.length) fail("Invalid snapshot positions or locators");
  } else {
    if ((data.reportedCount === 0 && albums.length !== 0) || (data.reportedCount > 0 && albums.length === 0)) fail("Contradictory search count");
    if (data.coverage === "reported-count-matches" && (data.reportedCount !== albums.length || data.nextPageUrl !== null)) fail("Invalid coverage claim");
    if (data.nextPageUrl && normalizeNextPage(provenance.sourceId, data.nextPageUrl, provenance.pageUrl) !== data.nextPageUrl) fail("Invalid next page URL");
  }
  return value;
}
