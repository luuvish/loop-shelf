import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type {
  AlbumDetail, AlbumSummary, CapturedPage, ParseResult, ParsedData, SearchPage, SourceTrack,
} from "./types.ts";
import { isPageUrl, normalizeAlbumUrl, normalizeNextPage } from "./urls.ts";

export const PARSER_VERSION = "0.1.0";
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
const text = (value: string): string => value.replace(/\s+/gu, " ").trim();

class StructureError extends Error {}
function requireStructure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StructureError(message);
}

function nextPage($: CheerioAPI, page: CapturedPage, warnings: string[]): string | null {
  const candidates = $('a[rel~="next"], .pagination a, .pager a').toArray()
    .filter((node) => $(node).attr("rel")?.split(/\s+/).includes("next")
      || /^(?:next(?: page)?|次へ|다음|[›»])$/i.test(text($(node).text())));
  for (const candidate of candidates) {
    const href = $(candidate).attr("href");
    const next = href ? normalizeNextPage(page.sourceId, href, page.url) : null;
    if (next) return next;
    warnings.push("invalid_next_page_link");
  }
  return null;
}

function searchResult($: CheerioAPI, page: CapturedPage, albums: AlbumSummary[], count: number,
  warnings: string[]): SearchPage {
  requireStructure(Number.isSafeInteger(count) && count >= 0, "Invalid reported count");
  requireStructure(count !== 0 || albums.length === 0, "Zero count contradicts album rows");
  const unique = [...new Map(albums.map((album) => [album.externalKey, album])).values()];
  if (unique.length !== albums.length) warnings.push("duplicate_source_album_link");
  if (count !== unique.length) warnings.push("reported_count_mismatch");
  warnings.push("pagination_and_result_limit_unverified");
  const next = nextPage($, page, warnings);
  return { kind: "search", albums: unique, reportedCount: count, nextPageUrl: next,
    coverage: count === unique.length && !next ? "reported-count-matches" : "partial-or-changed",
    resultLimit: null };
}

function parseKhinsiderSearch($: CheerioAPI, page: CapturedPage, warnings: string[]): SearchPage {
  const counts = $("p").toArray().map((node) => /^Found ([\d,]+) matching albums\.$/.exec(text($(node).text())))
    .filter((match) => match !== null);
  requireStructure(counts.length === 1, "Missing or ambiguous album result count");
  const count = Number(counts[0]?.[1]?.replaceAll(",", ""));
  const table = $("table.albumList");
  requireStructure(table.length === 1 || (count === 0 && table.length === 0), "Missing album list");
  const albums: AlbumSummary[] = [];
  if (table.length) {
    const headings = table.find("tr").first().find("th").toArray().map((node) => text($(node).text()));
    requireStructure(headings.slice(1).join("|") === "Album|Platform|Type|Year", "Album columns changed");
    for (const row of table.find("tr").toArray().slice(1)) {
      const cells = $(row).children("td");
      requireStructure(cells.length === 5, "Album row columns changed");
      const anchor = cells.eq(1).find("a").first();
      const ref = normalizeAlbumUrl("khinsider", anchor.attr("href") ?? "");
      const title = text(anchor.text());
      requireStructure(ref && title, "Album row is missing a valid title/link");
      albums.push({ ...ref, title, titleKind: "album-title",
        platforms: cells.eq(2).find("a").toArray().map((node) => text($(node).text())).filter(Boolean),
        sourceCategory: text(cells.eq(3).text()) || null, sourceYearLabel: text(cells.eq(4).text()) || null });
    }
  }
  requireStructure(count === 0 || albums.length > 0, "Positive result count without rows");
  return searchResult($, page, albums, count, warnings);
}

function parseZopharSearch($: CheerioAPI, page: CapturedPage, warnings: string[]): SearchPage {
  const main = $("#main");
  requireStructure(main.length === 1 && text(main.children("h2").first().text()) === "Search Results",
    "Missing search page heading");
  const paragraphs = main.children("p").toArray();
  const sections = paragraphs.filter((node) => /^Found [\d,]+ music files\.$/.test(text($(node).text())));
  const empty = paragraphs.some((node) => text($(node).text()) === "No search results found!");
  requireStructure(!(empty && sections.length), "Contradictory empty search marker");
  if (empty) return searchResult($, page, [], 0, warnings);
  requireStructure(sections.length === 1, "Missing or ambiguous music result section");
  const heading = $(sections[0]!);
  const count = Number(/^Found ([\d,]+) music files\.$/.exec(text(heading.text()))?.[1]?.replaceAll(",", ""));
  const list = heading.next("p");
  const albums: AlbumSummary[] = [];
  for (const node of list.find("a").toArray()) {
    const anchor = $(node);
    const ref = normalizeAlbumUrl("zophar", anchor.attr("href") ?? "");
    const title = text(anchor.text());
    requireStructure(ref && title, "Invalid music result link/title");
    albums.push({ ...ref, title, titleKind: "source-display-label", platforms: [],
      sourceCategory: null, sourceYearLabel: null });
  }
  requireStructure(count === 0 || albums.length > 0, "Positive music count without links");
  return searchResult($, page, albums, count, warnings);
}

function durationSeconds(label: string | null): number | null {
  if (!label || !/^\d+:[0-5]\d(?::[0-5]\d)?$/.test(label)) return null;
  const seconds = label.split(":").reduce((value, part) => value * 60 + Number(part), 0);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function parseZopharAlbum($: CheerioAPI, page: CapturedPage, warnings: string[]): AlbumDetail {
  const ref = normalizeAlbumUrl("zophar", page.url);
  const info = $("#music_info");
  const title = text(info.children("h2").text());
  requireStructure(ref && info.length === 1 && title && $("#tracklist").length === 1,
    "Missing album identity or track table");
  const sourceClaims = info.find(".infoname").toArray().map((node) => ({
    label: text($(node).text()), value: text($(node).next(".infodata").text()),
  })).filter((claim) => claim.value);
  const tracks: SourceTrack[] = [];
  const rows = $("#tracklist tr").toArray();
  for (const row of rows) {
    if ($(row).children("th").length) continue;
    requireStructure($(row).hasClass("trackrow"), "Unknown track table row");
    const name = $(row).children("td.name");
    requireStructure(name.length === 1 && text(name.text()), "Track has no title");
    const durationLabel = text($(row).children("td.length").text()) || null;
    const duration = durationSeconds(durationLabel);
    const position = tracks.length + 1;
    if (duration === null) warnings.push(`track_duration_unknown:${position}`);
    tracks.push({ externalKey: null, snapshotLocator: `track-row:${position}`, position,
      displayNumber: text($(row).children("td.number").text()) || null, discLabel: null,
      title: text(name.text()), durationLabel, durationSeconds: duration });
  }
  // An empty table could be a redesign or a failed upstream render, not a zero-track album.
  requireStructure(tracks.length > 0, "Track table contains no verified rows");
  const labels = tracks.map((track) => track.displayNumber).filter((label) => label !== null);
  if (new Set(labels).size !== labels.length) warnings.push("duplicate_display_numbers");
  warnings.push("stable_track_keys_unverified");
  if (sourceClaims.some((claim) => claim.label === "Release date:")) warnings.push("release_date_semantics_unverified");
  return { ...ref, kind: "album", title, titleKind: "album-title",
    platforms: sourceClaims.filter((claim) => claim.label === "Console:").map((claim) => claim.value),
    sourceCategory: null, sourceYearLabel: null, sourceClaims, releaseDate: null, tracks, playback: "unverified" };
}

/** Research-only parsing. Success describes structure, never permission or playback. */
export function inspectCapturedPage(page: CapturedPage): ParseResult {
  const failure = (code: Extract<ParseResult, { ok: false }>["code"], message: string): ParseResult =>
    ({ ok: false, code, message, httpStatus: page.status });
  if (!isPageUrl(page.sourceId, page.kind, page.url) || !Number.isFinite(Date.parse(page.capturedAt))
    || !Number.isInteger(page.status) || page.status < 100 || page.status > 599)
    return failure("invalid_input", "Invalid capture URL, timestamp or HTTP status");
  if (page.status === 401 || page.status === 403) return failure("blocked", "Access denied; do not retry or bypass");
  if (page.status === 429) return failure("rate_limited", "Rate limited; respect Retry-After before further requests");
  if (page.status === 404 || page.status === 410) return failure("not_found", "Source page unavailable");
  if (page.status !== 200) return failure("http_error", "Expected HTTP 200; redirects are not followed by parsers");
  if (Buffer.byteLength(page.html, "utf8") > MAX_HTML_BYTES) return failure("invalid_input", "HTML exceeds 5 MiB limit");
  const headers = Object.fromEntries(Object.entries(page.headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!/^text\/html(?:;|$)/i.test(headers["content-type"] ?? "")) return failure("parse_changed", "Expected HTML content type");
  const $ = load(page.html);
  $("script, style, template, noscript").remove();
  if (/^(?:Just a moment|Attention Required|Access Denied)/i.test(text($("title").text()))
    || $("#challenge-form, #cf-challenge-running").length)
    return failure("blocked", "Challenge document, not catalog data");
  if (page.sourceId === "khinsider" && page.kind === "album")
    return failure("unsupported", "KHInsider album parser awaits an accessible permitted sample");
  const warnings: string[] = [];
  try {
    const data: ParsedData = page.kind === "album" ? parseZopharAlbum($, page, warnings)
      : page.sourceId === "khinsider" ? parseKhinsiderSearch($, page, warnings) : parseZopharSearch($, page, warnings);
    return { ok: true, data, warnings, provenance: { sourceId: page.sourceId, pageUrl: page.url,
      capturedAt: page.capturedAt, parsedAt: new Date().toISOString(), parserVersion: PARSER_VERSION,
      bodySha256: createHash("sha256").update(page.html).digest("hex"), sampleKind: page.sampleKind } };
  } catch (error) {
    if (error instanceof StructureError) return failure("parse_changed", error.message);
    throw error;
  }
}
