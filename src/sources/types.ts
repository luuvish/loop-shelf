export type SourceId = "khinsider" | "zophar";
export type PageKind = "search" | "album";
export type FailureCode =
  | "blocked" | "rate_limited" | "not_found" | "http_error"
  | "parse_changed" | "invalid_input" | "unsupported" | "policy_disabled";

/** Input is an already captured document. Parsers never access the network. */
export interface CapturedPage {
  sourceId: SourceId;
  kind: PageKind;
  url: string;
  status: number;
  headers: Record<string, string>;
  html: string;
  capturedAt: string;
  sampleKind: "live-capture" | "synthetic";
}

export interface Provenance {
  sourceId: SourceId;
  pageUrl: string;
  capturedAt: string;
  parsedAt: string;
  parserVersion: string;
  bodySha256: string;
  sampleKind: CapturedPage["sampleKind"];
}

export interface SourceAlbumRef {
  sourceId: SourceId;
  externalKey: string;
  pageUrl: string;
}

export interface AlbumSummary extends SourceAlbumRef {
  title: string;
  titleKind: "album-title" | "source-display-label";
  platforms: string[];
  sourceCategory: string | null;
  sourceYearLabel: string | null;
}

export interface SearchPage {
  kind: "search";
  albums: AlbumSummary[];
  reportedCount: number;
  nextPageUrl: string | null;
  /** Matching this page's reported count does not prove catalog completeness. */
  coverage: "reported-count-matches" | "partial-or-changed";
  resultLimit: null;
}

export interface SourceTrack {
  /** No stable source track ID has been verified. Never persist the row as identity. */
  externalKey: null;
  snapshotLocator: string;
  position: number;
  displayNumber: string | null;
  discLabel: null;
  title: string;
  durationLabel: string | null;
  durationSeconds: number | null;
}

export interface AlbumDetail extends AlbumSummary {
  kind: "album";
  sourceClaims: { label: string; value: string }[];
  releaseDate: null;
  tracks: SourceTrack[];
  /** Discovering a download link does not create an authorized playable resource. */
  playback: "unverified";
}

export type ParsedData = SearchPage | AlbumDetail;
export type ParseResult =
  | { ok: true; data: ParsedData; provenance: Provenance; warnings: string[] }
  | { ok: false; code: FailureCode; message: string; httpStatus: number };
