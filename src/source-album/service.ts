import type Database from "better-sqlite3";
import { z } from "zod";
import { withDatabase } from "../database/access.ts";
import type { SourceAlbumDelivery, SourceAlbumFailure, SourceAlbumResponse, SourceAlbumResult } from "../shared/source-album.ts";
import type { SourceAdapter } from "../sources/adapters.ts";
import { MetadataCache, validateContext } from "../sources/adapters/cache.ts";
import type { AdapterFailure, AdapterResult, MetadataPolicy } from "../sources/adapters/contracts.ts";
import { abortable, type TransportClock } from "../sources/transport/contracts.ts";
import { requestUrl } from "../sources/transport/requests.ts";
import type { Provenance, SourceId } from "../sources/types.ts";
import { parseSourceAlbumInput, type SourceAlbumInput } from "./input.ts";

export const SOURCE_ALBUM_LIMITS = Object.freeze({ deadlineMs: 12_000, sourceBudgetMs: 11_000, maxActive: 16 });
interface Dependencies {
  sampleKind: Provenance["sampleKind"];
  adapters: Readonly<Record<SourceId, Pick<SourceAdapter, "getAlbum">>>;
  policy(source: SourceId): MetadataPolicy;
  clock: TransportClock;
}
const failureSchema = z.object({ ok: z.literal(false),
  code: z.enum(["invalid_input", "policy_disabled", "blocked", "unsafe_address", "redirect_rejected", "rate_limited", "queue_full", "cancelled", "timeout",
    "network_error", "not_found", "http_error", "invalid_response", "response_too_large", "parse_changed", "unsupported", "policy_changed", "content_removed", "cache_error"]),
  stage: z.enum(["input", "policy", "capability", "transport", "parser", "cache"]),
  httpStatus: z.number().int().min(100).max(599).optional(), retryAt: z.number().nonnegative().finite().optional(),
}).strict();
const deliverySchema = z.object({ from: z.enum(["transport", "cache"]), freshness: z.enum(["fresh", "stale"]),
  freshUntil: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }),
}).strict();
function adapterFailure(input: unknown): AdapterFailure {
  const value = failureSchema.parse(input);
  return { ok: false, code: value.code, stage: value.stage,
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }), ...(value.retryAt === undefined ? {} : { retryAt: value.retryAt }) };
}
const fail = (code: SourceAlbumFailure["code"], stage: SourceAlbumFailure["stage"] = "album"): SourceAlbumFailure => ({ ok: false, code, stage });
const unavailablePolicy = (): MetadataPolicy => ({ revision: "unavailable", collect: { allowed: false, code: "policy_disabled" },
  cache: { allowed: false, code: "policy_disabled" }, display: { allowed: false, code: "policy_disabled" } });
function status(result: SourceAlbumResponse["result"]): SourceAlbumResponse["status"] {
  return !result.ok ? "failed" : result.delivery.freshness === "stale" || result.refreshFailure ? "partial" : "complete";
}

/** Internal offline seam. Product dependencies are fixed in source-album.ts, never supplied by HTTP/env. */
export function createSourceAlbumService(db: Database.Database, deps: Dependencies) {
  const cache = new MetadataCache(db);
  let active = 0;
  function validate(response: AdapterResult, input: SourceAlbumInput): SourceAlbumDelivery | SourceAlbumFailure {
    try {
      if (!response.ok) return adapterFailure(response);
      const { delivery: rawDelivery, refreshFailure, ...dto } = response;
      const metadata = validateContext(dto, { request: { ...input, kind: "album" }, sampleKind: deps.sampleKind,
        parserVersion: response.provenance.parserVersion, policyRevision: "checked-separately" });
      const delivery = deliverySchema.parse(rawDelivery);
      const captured = Date.parse(metadata.provenance.capturedAt), fresh = Date.parse(delivery.freshUntil), expires = Date.parse(delivery.expiresAt);
      if (metadata.data.kind !== "album" || captured > deps.clock.now() || fresh < captured || expires < fresh) throw new Error("Invalid delivery");
      return { ...metadata, data: metadata.data, delivery, ...(refreshFailure ? { refreshFailure: adapterFailure(refreshFailure) } : {}) };
    } catch { return fail("invalid_response"); }
  }
  /** Caller owns withDatabase. Policies and removals are checked even when the held result is a failure. */
  function finalize(value: SourceAlbumResponse, input: SourceAlbumInput): SourceAlbumResponse {
    let policy = value.policy, result = value.result;
    try {
      policy = structuredClone(deps.policy(input.sourceId));
      if (!policy.cache.allowed || !policy.display.allowed) cache.purgeSource(input.sourceId);
      if (!policy.display.allowed) result = fail(policy.display.code, "policy");
      else if (cache.isRemoved(input.sourceId, input.externalKey)) result = fail("content_removed", "cache");
      else if (JSON.stringify(policy) !== JSON.stringify(value.policy)) result = fail("policy_changed", "policy");
      else if (result.ok) {
        result = validate(result, input);
        if (result.ok) {
          if (result.delivery.from === "cache" && !policy.cache.allowed) result = fail(policy.cache.code, "policy");
          else if (result.delivery.from === "transport" && !policy.collect.allowed) result = fail(policy.collect.code, "policy");
          else if (Date.parse(result.delivery.expiresAt) <= deps.clock.now()) result = fail("result_expired");
          else result = { ...result, delivery: { ...result.delivery, freshness: deps.clock.now() < Date.parse(result.delivery.freshUntil) ? "fresh" : "stale" } };
        }
      }
    } catch { result = fail("database_error"); }
    const now = deps.clock.now();
    return { ...value, policy, result, status: status(result), completedAt: new Date(now).toISOString(),
      elapsedMs: value.elapsedMs + Math.max(0, now - Date.parse(value.completedAt)) };
  }
  return {
    /** Recheck after final cookie authentication. Caller MUST own withDatabase; never performs network work. */
    recheck(input: unknown, value: SourceAlbumResult): SourceAlbumResult {
      if (!value.ok) return value;
      const options = parseSourceAlbumInput(input), url = requestUrl({ ...options, kind: "album" }).href;
      if (value.sampleKind !== deps.sampleKind || value.ref.sourceId !== options.sourceId
        || value.ref.externalKey !== options.externalKey || value.ref.pageUrl !== url) throw new Error("Album result context changed");
      return finalize(value, options);
    },
    async getAlbum(input: unknown, signal?: AbortSignal): Promise<SourceAlbumResult> {
      if (signal?.aborted) return { ok: false, code: "cancelled" };
      let options: SourceAlbumInput;
      try { options = parseSourceAlbumInput(input); } catch { return { ok: false, code: "invalid_input" }; }
      if (active >= SOURCE_ALBUM_LIMITS.maxActive) return { ok: false, code: "queue_full" };
      active++;
      const started = deps.clock.now(), controller = new AbortController(), sourceController = new AbortController();
      let deadline = false, policy = unavailablePolicy();
      const cancel = () => { controller.abort("cancelled"); sourceController.abort("cancelled"); };
      signal?.addEventListener("abort", cancel, { once: true });
      const stop = deps.clock.timer(SOURCE_ALBUM_LIMITS.deadlineMs, () => { deadline = true; controller.abort("timeout"); sourceController.abort("timeout"); });
      const stopSource = deps.clock.timer(SOURCE_ALBUM_LIMITS.sourceBudgetMs, () => { deadline = true; sourceController.abort("timeout"); });
      const check = () => {
        if (deps.clock.now() - started >= SOURCE_ALBUM_LIMITS.deadlineMs) { deadline = true; controller.abort("timeout"); }
        controller.signal.throwIfAborted();
      };
      const envelope = (result: SourceAlbumResponse["result"]): SourceAlbumResponse => ({ ok: true,
        ref: { ...options, pageUrl: requestUrl({ ...options, kind: "album" }).href }, sampleKind: deps.sampleKind,
        policy, result, status: status(result), termination: deadline ? "deadline" : "settled",
        completedAt: new Date(deps.clock.now()).toISOString(), elapsedMs: Math.max(0, deps.clock.now() - started) });
      try {
        let result: SourceAlbumResponse["result"] | null = await abortable(withDatabase(db, async () => {
          check(); policy = structuredClone(deps.policy(options.sourceId));
          if (!policy.cache.allowed || !policy.display.allowed) cache.purgeSource(options.sourceId);
          if (!policy.display.allowed) return fail(policy.display.code, "policy");
          if (cache.isRemoved(options.sourceId, options.externalKey)) return fail("content_removed", "cache");
          if (!policy.collect.allowed && !policy.cache.allowed) return fail(policy.collect.code, "policy");
          return null;
        }), controller.signal);
        if (!result) {
          try {
            const response = await abortable(Promise.resolve().then(() => {
              sourceController.signal.throwIfAborted();
              return deps.adapters[options.sourceId].getAlbum(options.externalKey, sourceController.signal);
            }), sourceController.signal);
            result = validate(response, options);
          } catch { result = fail(sourceController.signal.aborted ? sourceController.signal.reason === "cancelled" ? "cancelled" : "timeout" : "source_error"); }
        }
        stopSource(); check(); const value = envelope(result);
        return await abortable(withDatabase(db, async () => { check(); const final = finalize(value, options); check(); return final; }), controller.signal);
      } catch {
        if (signal?.aborted) return { ok: false, code: "cancelled" };
        // A final database/policy/removal snapshot could not be checked. Never return the held metadata.
        return envelope(fail(controller.signal.aborted ? "timeout" : "database_error"));
      } finally {
        stop(); stopSource(); signal?.removeEventListener("abort", cancel);
        controller.abort("finished"); sourceController.abort("finished"); active--;
      }
    },
  };
}
