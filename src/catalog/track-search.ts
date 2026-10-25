import type Database from "better-sqlite3";
import { z } from "zod";
import { trackIndexPageQuery, trackQuery } from "./track-query.ts";
import { normalizeSearch } from "../database/connection.ts";
import type { CatalogTrackSearchItem, CatalogTrackSearchPage } from "../shared/catalog-track-search.ts";
import { reconcileCatalogRetention } from "./retention.ts";
import { CatalogError } from "./input.ts";
import { encodeTrackCursor, trackAnchorFingerprint, trackCursorContext, trackCursorSchema, type TrackCursorAnchor } from "./track-search-cursor.ts";

const inputSchema = z.object({
  q: z.string().max(200).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Control characters are not allowed")
    .transform(normalizeSearch).pipe(z.string().min(1).max(200)),
  sourceId: z.enum(["khinsider", "zophar"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(12),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
  cursor: trackCursorSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.cursor && (value.offset !== undefined || value.cursor.context !== trackCursorContext(value)))
    ctx.addIssue({ code: "custom", message: "Cursor requires the same query/source/limit and no offset" });
});


interface TrackRow extends Omit<CatalogTrackSearchItem, "album" | "provenance"> {
  sortTitle: string;
  candidateCount?: number;
  albumId: string; albumTitle: string; sourceEntityId: string;
  sourceId: CatalogTrackSearchItem["album"]["sourceId"]; externalKey: string; pageUrl: string;
  observationId: string; capturedAt: string; parserVersion: string; expiresAt: string | null;
  titleObservationId: string; titleCapturedAt: string; titleParserVersion: string; titleExpiresAt: string | null;
  trackState: CatalogTrackSearchItem["album"]["trackState"];
}

/** Caller owns withDatabase. Pure local catalog search; no user table reads, ingestion or network. */
export class CatalogTrackSearchStore {
  readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }
  search(input: unknown): CatalogTrackSearchPage {
    const options = inputSchema.parse(input);
    reconcileCatalogRetention(this.db);
    return this.db.transaction((): CatalogTrackSearchPage => {
      const checkedAt = new Date().toISOString();
      const filter = options.sourceId ? " AND s.source_id=@sourceId" : "", context = trackCursorContext(options);
      const params: Record<string, string | number> = { q: options.q, limit: options.limit + 1 };
      if (options.sourceId) params.sourceId = options.sourceId;
      if (options.cursor) {
        // Re-read the anchor through the same public eligibility/binding checks as page results.
        const anchor = this.db.prepare(trackQuery(filter, "anchor")).get({ ...params, anchorId: options.cursor.id, limit: 1 }) as TrackRow | undefined;
        if (!anchor || trackAnchorFingerprint(anchor) !== options.cursor.anchor)
          throw new CatalogError("cursor_invalidated", "The continuation changed; start a new search");
        Object.assign(params, { afterTitle: anchor.sortTitle, afterSource: anchor.sourceId, afterKey: anchor.externalKey,
          afterPosition: anchor.position, afterId: anchor.id });
      } else params.offset = options.offset ?? 0;
      let rows: TrackRow[] | undefined;
      if (options.offset) {
        const expected = this.db.prepare(trackIndexPageQuery(filter)).all(params) as TrackCursorAnchor[];
        rows = this.db.prepare(trackQuery(filter, "indexed-page")).all(params) as TrackRow[];
        if (rows.length !== expected.length || rows.some((row, i) => trackAnchorFingerprint(row) !== trackAnchorFingerprint(expected[i]!)))
          throw new Error("Catalog search index does not match current evidence; verify and rebuild the index");
      }
      if (!options.offset) {
        // A bounded ordered prefix is sufficient only when it fills the entire page plus lookahead.
        // The least matching title comes from the index, never from a cache or personal data.
        const first = this.db.prepare(`SELECT normalize_search(title) AS title FROM track INDEXED BY catalog_track_search_title_idx
          WHERE instr(normalize_search(title),@q)>0 ${options.cursor ? "AND normalize_search(title)>=@afterTitle" : ""}
          ORDER BY normalize_search(title) LIMIT 1`).get(params) as { title: string } | undefined;
        if (!first) rows = [];
        else {
          const sameTitle = !!options.cursor && first.title === params.afterTitle;
          const window = this.db.prepare(trackQuery(filter, "window", sameTitle)).all({ ...params, firstTitle: first.title }) as TrackRow[];
          if (window.length === options.limit + 1) rows = window;
          // Fewer rows do not prove exhaustion: later sources/titles may still contain matches.
          if (!rows) {
            // Unlike the single-title/source prefix, this prefix spans title boundaries and sparse
            // sources in the complete public sort order. All evidence/lifecycle checks still apply.
            const ordered = this.db.prepare(trackQuery(filter, "ordered-window", !!options.cursor)).all(params) as TrackRow[];
            if (ordered.length === options.limit + 1 || ordered[0]?.candidateCount !== undefined && ordered[0].candidateCount < 256) rows = ordered;
            // A nonempty result with fewer than 256 *raw* candidates proves the entire remaining
            // candidate set was checked. At the cap (or with no counter row), still fall back.
          }
        }
      }
      rows ??= this.db.prepare(trackQuery(filter, options.cursor ? "after" : "page")).all(params) as TrackRow[];
      const items = rows.slice(0, options.limit).map((row): CatalogTrackSearchItem => ({
        id: row.id, title: row.title, position: row.position, displayNumber: row.displayNumber, discLabel: row.discLabel, durationMs: row.durationMs,
        provenance: { observationId: row.observationId, capturedAt: row.capturedAt, parserVersion: row.parserVersion, expiresAt: row.expiresAt },
        album: { id: row.albumId, title: row.albumTitle, sourceEntityId: row.sourceEntityId, sourceId: row.sourceId,
          externalKey: row.externalKey, pageUrl: row.pageUrl, trackState: row.trackState,
          provenance: { observationId: row.titleObservationId, capturedAt: row.titleCapturedAt, parserVersion: row.titleParserVersion, expiresAt: row.titleExpiresAt } },
      }));
      const hasMore = rows.length > options.limit, next = (options.offset ?? 0) + options.limit;
      return { sampleKind: "synthetic", identity: "source-provisional", query: options.q, sourceId: options.sourceId ?? null,
        checkedAt, items, nextCursor: hasMore ? encodeTrackCursor(rows[options.limit - 1]!, context) : null,
        nextOffset: !options.cursor && hasMore && next <= 100000 ? next : null,
        paginationLimited: !options.cursor && hasMore && next > 100000 };
    }).deferred();
  }
}
