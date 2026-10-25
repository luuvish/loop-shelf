import type { CapturedPage, SourceId } from "../types.ts";

export type SourceRequest =
  | { sourceId: SourceId; kind: "search"; query: string }
  | { sourceId: SourceId; kind: "album"; externalKey: string };
export type TransportCode = "invalid_input" | "policy_disabled" | "blocked" | "unsafe_address"
  | "redirect_rejected" | "rate_limited" | "queue_full" | "cancelled" | "timeout"
  | "network_error" | "not_found" | "http_error" | "invalid_response" | "response_too_large";
export interface TransportFailure {
  ok: false;
  code: TransportCode;
  httpStatus?: number;
  /** Milliseconds since Unix epoch. Omitted except when a source cooldown applies. */
  retryAt?: number;
}
export type TransportResult = { ok: true; page: CapturedPage } | TransportFailure;
export type AccessDecision = { allowed: true; revision?: string } | { allowed: false; code: "policy_disabled" | "blocked" };
export interface Address { address: string; family: 4 | 6 }
export interface WireResponse {
  status: number;
  /** Lowercase names, at most one value per relevant header. */
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
export interface TransportClock {
  /** Monotonic epoch milliseconds, unaffected by wall-clock adjustment during a request. */
  now(): number;
  timer(ms: number, callback: () => void): () => void;
}
export interface SourcePermit {
  beginAttempt(signal: AbortSignal): Promise<void>;
  assertRunning(signal: AbortSignal): Promise<void>;
  rateLimit(header: string | undefined, signal: AbortSignal): Promise<number>;
  endAttempt(signal: AbortSignal): Promise<void>;
  release(signal: AbortSignal): Promise<void>;
}
export interface SourceCoordinator {
  acquire(source: SourceId, signal: AbortSignal, remainingMs: number): Promise<SourcePermit>;
}
/** Trusted in-process dependencies, never populated from an HTTP request or environment flag. */
export interface TransportDependencies {
  authorize(request: SourceRequest, url: URL): AccessDecision;
  resolve(host: string, signal: AbortSignal): Promise<readonly Address[]>;
  open(url: URL, address: Address, signal: AbortSignal): Promise<WireResponse>;
  clock: TransportClock;
  sampleKind: CapturedPage["sampleKind"];
  coordinator?: SourceCoordinator;
}
export const TRANSPORT_LIMITS = Object.freeze({
  timeoutMs: 10_000, intervalMs: 3_000, maxBodyBytes: 5 * 1024 * 1024,
  maxRedirects: 2, maxWaiting: 8, fallbackCooldownMs: 60_000, maxHeaderBytes: 16 * 1024,
});
export class TransportFault extends Error {
  readonly failure: TransportFailure;
  constructor(code: TransportCode, details: { httpStatus?: number; retryAt?: number } = {}) {
    super(code);
    this.failure = { ok: false, code, ...details };
  }
}

/** Late DNS/driver results cannot resume an aborted operation. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => { aborted = true; reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { if (aborted) late?.(value); else resolve(value); }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
