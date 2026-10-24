import type Database from "better-sqlite3";
import { withDatabase } from "../../database/access.ts";
import { abortable, TransportFault, type SourceRequest } from "../transport/contracts.ts";
import { redirectUrl, requestUrl } from "../transport/requests.ts";
import { MetadataCache, validateContext, type CacheContext, type CacheEntry } from "./cache.ts";
import { retentionFromHeaders } from "./retention.ts";
import { AdapterFault, CACHE_LIMITS, type AdapterDependencies, type AdapterFailure, type AdapterResult,
  type MetadataDelivery, type MetadataPolicy } from "./contracts.ts";

interface Flight { controller: AbortController; promise: Promise<AdapterResult>; subscribers: number }
const failure = (code: AdapterFailure["code"], stage: AdapterFailure["stage"]): AdapterFailure => ({ ok: false, code, stage });
function transient(error: AdapterFailure): boolean {
  return ["network_error", "timeout", "rate_limited", "queue_full", "parse_changed", "invalid_response", "response_too_large"].includes(error.code)
    || error.code === "http_error" && (error.httpStatus ?? 0) >= 500;
}
function delivery(entry: CacheEntry, from: "cache" | "transport", now: number, error?: AdapterFailure): MetadataDelivery {
  return { ...entry.metadata, delivery: { from, freshness: now < entry.freshUntil ? "fresh" : "stale",
    freshUntil: new Date(entry.freshUntil).toISOString(), expiresAt: new Date(entry.expiresAt).toISOString() },
    ...(error ? { refreshFailure: error } : {}) };
}

/** Trusted offline seam; product code uses getSourceAdapters without policy/transport overrides. */
export function createMetadataService(db: Database.Database, deps: AdapterDependencies) {
  const cache = new MetadataCache(db);
  const flights = new Map<string, Flight>();
  const checkedPolicy = (context: CacheContext, signal: AbortSignal): MetadataPolicy => {
    signal.throwIfAborted();
    const policy = deps.policy(context.request.sourceId, context.request.kind);
    if (!policy.cache.allowed || !policy.display.allowed) cache.purgeSource(context.request.sourceId);
    if (!policy.display.allowed) throw new AdapterFault(policy.display.code, "policy");
    if (policy.revision !== context.policyRevision) throw new AdapterFault("policy_changed", "policy");
    return policy;
  };
  const locked = <T>(action: () => T) => withDatabase(db, async () => action());

  async function work(context: CacheContext, signal: AbortSignal): Promise<AdapterResult> {
    const request = context.request;
    try {
      const hit = await locked(() => {
        const policy = checkedPolicy(context, signal);
        cache.checkRemoval(context);
        if (request.sourceId === "khinsider" && request.kind === "album") throw new AdapterFault("unsupported", "capability");
        const entry = policy.cache.allowed ? cache.read(context, deps.clock.now()) : undefined;
        return entry && deps.clock.now() < entry.freshUntil ? delivery(entry, "cache", deps.clock.now()) : undefined;
      });
      if (hit) return hit;
      const policy = deps.policy(request.sourceId, request.kind);
      if (policy.revision !== context.policyRevision) throw new AdapterFault("policy_changed", "policy");
      if (!policy.collect.allowed) return policyFailure(policy.collect.code);
      signal.throwIfAborted();
      const captured = await abortable(Promise.resolve().then(() => deps.capture(request, signal)), signal)
        .catch((error: unknown) => { if (signal.aborted) throw error; return { ok: false as const, code: "network_error" as const }; });
      signal.throwIfAborted();
      if (!captured.ok) return await finishFailure({ ...captured, stage: "transport" });
      const page = captured.page;
      if (page.sourceId !== request.sourceId || page.kind !== request.kind || page.sampleKind !== context.sampleKind)
        return await finishFailure(failure("invalid_response", "transport"));
      try { redirectUrl(request, requestUrl(request), page.url); }
      catch { return await finishFailure(failure("invalid_response", "transport")); }
      const retention = retentionFromHeaders(page.headers, deps.clock.now());
      if (!retention.store) await locked(() => { checkedPolicy(context, signal); cache.delete(context); });
      let parsed;
      try { parsed = deps.parser.parse(page); }
      catch { return await finishFailure(failure("parse_changed", "parser")); }
      if (!parsed.ok) return await finishFailure({ ok: false, code: parsed.code, stage: "parser", httpStatus: parsed.httpStatus });
      let metadata;
      try { metadata = validateContext(parsed, context); }
      catch { return await finishFailure(failure("invalid_response", "parser")); }
      return await locked(() => {
        const policy = checkedPolicy(context, signal);
        if (!policy.collect.allowed) return policyFailure(policy.collect.code);
        cache.checkRemoval(context, metadata);
        const entry = policy.cache.allowed && retention.store ? cache.write(context, metadata, deps.clock.now(), retention)
          : cache.entry(metadata);
        if (entry.capturedAt > deps.clock.now() || entry.expiresAt <= deps.clock.now())
          throw new AdapterFault("invalid_response", "parser");
        return delivery(entry, "transport", deps.clock.now());
      });
    } catch (error) {
      if (signal.aborted) return (signal.reason as AdapterFault).failure;
      if (error instanceof AdapterFault) return error.failure;
      // Exceptions are not converted into an empty success or used to overwrite last-good metadata.
      return failure("cache_error", "cache");
    }

    function policyFailure(code: "policy_disabled" | "blocked") { return failure(code, "policy"); }
    async function finishFailure(error: AdapterFailure): Promise<AdapterResult> {
      return locked(() => {
        const policy = checkedPolicy(context, signal);
        cache.checkRemoval(context);
        if (error.code === "blocked" || error.code === "not_found") cache.delete(context);
        const current = policy.cache.allowed ? cache.read(context, deps.clock.now()) : undefined;
        if (current && transient(error)) return delivery(current, "cache", deps.clock.now(), error);
        return error;
      });
    }
  }

  function subscribe(key: string, flight: Flight, signal?: AbortSignal): Promise<AdapterResult> {
    if (flight.subscribers >= CACHE_LIMITS.maxSubscribers) return Promise.resolve(failure("queue_full", "transport"));
    flight.subscribers++;
    return new Promise((resolve) => {
      let finished = false;
      const complete = (result: AdapterResult) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        flight.subscribers--;
        resolve(structuredClone(result));
      };
      const abort = () => {
        complete(failure("cancelled", "transport"));
        if (!flight.subscribers && flights.get(key) === flight) {
          flights.delete(key);
          flight.controller.abort(new AdapterFault("cancelled", "transport"));
        }
      };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      void flight.promise.then(complete);
    });
  }
  return {
    get(input: SourceRequest, signal?: AbortSignal): Promise<AdapterResult> {
      if (signal?.aborted) return Promise.resolve(failure("cancelled", "transport"));
      let context: CacheContext;
      try {
        const url = requestUrl(input);
        const request: SourceRequest = input.kind === "search"
          ? { sourceId: input.sourceId, kind: "search", query: url.searchParams.get("search")! }
          : { sourceId: input.sourceId, kind: "album", externalKey: input.externalKey };
        context = { request, sampleKind: deps.sampleKind, parserVersion: deps.parser.version,
          policyRevision: deps.policy(request.sourceId, request.kind).revision };
      } catch (error) {
        return Promise.resolve(failure(error instanceof TransportFault ? error.failure.code : "invalid_input", "input"));
      }
      const key = JSON.stringify(context);
      const existing = flights.get(key);
      if (existing) return subscribe(key, existing, signal);
      if (flights.size >= CACHE_LIMITS.maxFlights) return Promise.resolve(failure("queue_full", "transport"));
      const controller = new AbortController();
      const stop = deps.clock.timer(CACHE_LIMITS.deadlineMs, () => controller.abort(new AdapterFault("timeout", "transport")));
      const flight: Flight = { controller, subscribers: 0, promise: Promise.resolve(failure("cancelled", "transport")) };
      flights.set(key, flight);
      flight.promise = abortable(Promise.resolve().then(() => work(context, controller.signal)), controller.signal)
        .catch((): AdapterResult => controller.signal.aborted ? (controller.signal.reason as AdapterFault).failure : failure("cache_error", "cache"))
        .finally(() => { stop(); if (flights.get(key) === flight) flights.delete(key); });
      return subscribe(key, flight, signal);
    },
  };
}
