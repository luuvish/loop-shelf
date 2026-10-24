import type { FailureCode, CapturedPage, PageKind, ParseResult, SourceId } from "../types.ts";
import type { AccessDecision, SourceRequest, TransportClock, TransportCode, TransportResult } from "../transport/contracts.ts";

export interface MetadataPolicy {
  /** Must change whenever any permission, evidence or retention rule changes. */
  revision: string;
  collect: AccessDecision;
  cache: AccessDecision;
  display: AccessDecision;
}
export interface AdapterFailure {
  ok: false;
  code: FailureCode | TransportCode | "policy_changed" | "content_removed" | "cache_error";
  stage: "input" | "policy" | "capability" | "transport" | "parser" | "cache";
  httpStatus?: number;
  retryAt?: number;
}
export interface MetadataDelivery extends Extract<ParseResult, { ok: true }> {
  delivery: { from: "transport" | "cache"; freshness: "fresh" | "stale"; freshUntil: string; expiresAt: string };
  refreshFailure?: AdapterFailure;
}
export type AdapterResult = MetadataDelivery | AdapterFailure;
export interface AdapterDependencies {
  sampleKind: CapturedPage["sampleKind"];
  policy(source: SourceId, kind: PageKind): MetadataPolicy;
  capture(request: SourceRequest, signal: AbortSignal): Promise<TransportResult>;
  parser: { version: string; parse(page: CapturedPage): ParseResult };
  clock: TransportClock;
}
export const CACHE_LIMITS = Object.freeze({
  searchFreshMs: 6 * 60 * 60_000, searchMaxAgeMs: 7 * 24 * 60 * 60_000,
  albumFreshMs: 7 * 24 * 60 * 60_000, albumMaxAgeMs: 30 * 24 * 60 * 60_000,
  emptyMs: 15 * 60_000, maxRows: 200, maxBytes: 32 * 1024 * 1024,
  maxFlights: 16, maxSubscribers: 32, deadlineMs: 12_000,
});
export class AdapterFault extends Error {
  readonly failure: AdapterFailure;
  constructor(code: AdapterFailure["code"], stage: AdapterFailure["stage"]) {
    super(code); this.failure = { ok: false, code, stage };
  }
}
