import type Database from "better-sqlite3";
import { withDatabase } from "../database/access.ts";
import type { SearchDelivery, SearchFailure, SearchResult, SearchResponse, SourceSearchResult } from "../shared/search.ts";
import type { SourceAdapter } from "../sources/adapters.ts";
import type { AdapterResult, MetadataPolicy } from "../sources/adapters/contracts.ts";
import { MetadataCache, validateContext } from "../sources/adapters/cache.ts";
import { abortable, type TransportClock } from "../sources/transport/contracts.ts";
import type { Provenance, SourceId } from "../sources/types.ts";
import { readLocalAlbums } from "./local.ts";
import { parseSearchInput, searchSourceIds as sourceIds, type SearchInput } from "./input.ts";

export const SEARCH_LIMITS = Object.freeze({ deadlineMs: 12_000, sourceBudgetMs: 11_000, maxActive: 16 });
interface SearchDependencies {
  sampleKind: Provenance["sampleKind"];
  adapters: Readonly<Record<SourceId, Pick<SourceAdapter, "searchAlbums">>>;
  policy(source: SourceId): MetadataPolicy;
  clock: TransportClock;
}
const fail = (code: SearchFailure["code"], stage: SearchFailure["stage"]): SearchFailure => ({ ok: false, code, stage });
function status(local: SearchResponse["local"], sources: SourceSearchResult[]): SearchResponse["status"] {
  const count = Number(local.ok) + sources.filter(({ result }) => result.ok).length;
  const degraded = sources.some(({ result }) => result.ok && (result.delivery.freshness === "stale" || result.refreshFailure || result.data.coverage === "partial-or-changed"));
  return !count ? "failed" : count === sources.length + 1 && !degraded ? "complete" : "partial";
}

/** Trusted offline seam only. The product factory supplies fixed live adapters and policy. No HTTP/user context. */
export function createSearchService(db: Database.Database, deps: SearchDependencies) {
  const cache = new MetadataCache(db);
  let active = 0;
  function finalizeSource(source: SourceSearchResult): SourceSearchResult {
    let policy = source.policy;
    let result = source.result;
    try {
      policy = structuredClone(deps.policy(source.sourceId));
      if (!result.ok) return { ...source, policy };
      if (!policy.display.allowed) result = fail(policy.display.code, "policy");
      else if (JSON.stringify(policy) !== JSON.stringify(source.policy)) result = fail("policy_changed", "policy");
      else if (result.delivery.from === "cache" && !policy.cache.allowed) result = fail(policy.cache.code, "policy");
      else if (result.delivery.from === "transport" && !policy.collect.allowed) result = fail(policy.collect.code, "policy");
      else if (Date.parse(result.delivery.expiresAt) <= deps.clock.now()) result = fail("result_expired", "search");
      else if (result.data.albums.some((album) => cache.isRemoved(source.sourceId, album.externalKey))) result = fail("content_removed", "cache");
      else result = { ...result, delivery: { ...result.delivery, freshness: deps.clock.now() < Date.parse(result.delivery.freshUntil) ? "fresh" : "stale" } };
    } catch { result = fail("database_error", "search"); }
    return { sourceId: source.sourceId, policy, result };
  }
  return {
    /** Recheck a held service result after async authentication. Caller MUST own withDatabase. No network. */
    recheck(input: unknown, result: SearchResult): SearchResult {
      if (!result.ok) return result;
      const options = parseSearchInput(input);
      if (result.sampleKind !== deps.sampleKind || result.query !== options.q
        || JSON.stringify(result.sources.map((s) => s.sourceId)) !== JSON.stringify(sourceIds.filter((id) => options.sources.includes(id))))
        throw new Error("Search result context changed");
      const sources = result.sources.map(finalizeSource);
      const local = result.local.ok ? readLocalAlbums(db, options, deps.sampleKind) : result.local;
      return { ...result, local, sources, status: status(local, sources), completedAt: new Date(deps.clock.now()).toISOString(),
        elapsedMs: result.elapsedMs + Math.max(0, deps.clock.now() - Date.parse(result.completedAt)) };
    },
    async search(input: unknown, signal?: AbortSignal): Promise<SearchResult> {
    if (signal?.aborted) return { ok: false, code: "cancelled" };
    let options: SearchInput;
    try {
      options = parseSearchInput(input);
    } catch { return { ok: false, code: "invalid_input" }; }
    if (active >= SEARCH_LIMITS.maxActive) return { ok: false, code: "queue_full" };
    active++;
    const started = deps.clock.now(), controller = new AbortController(), sourceController = new AbortController();
    let deadline = false;
    const cancel = () => { controller.abort("cancelled"); sourceController.abort("cancelled"); };
    signal?.addEventListener("abort", cancel, { once: true });
    const stop = deps.clock.timer(SEARCH_LIMITS.deadlineMs, () => { deadline = true; controller.abort("timeout"); sourceController.abort("timeout"); });
    // Reserve the last second for a serialized, current snapshot and final policy/removal checks.
    const stopSources = deps.clock.timer(SEARCH_LIMITS.sourceBudgetMs, () => { deadline = true; sourceController.abort("timeout"); });
    const selected = sourceIds.filter((id) => options.sources.includes(id));
    let sources: SourceSearchResult[] = [];
    try {
      sources = await Promise.all(selected.map(async (sourceId): Promise<SourceSearchResult> => {
        const policy = structuredClone(deps.policy(sourceId));
        let result: SourceSearchResult["result"];
        try {
          sourceController.signal.throwIfAborted();
          const response = await abortable(Promise.resolve().then(() => {
            sourceController.signal.throwIfAborted();
            return deps.adapters[sourceId].searchAlbums(options.q, sourceController.signal);
          }), sourceController.signal);
          result = response.ok ? validateDelivery(response, sourceId) : structuredClone(response);
        } catch {
          result = fail(sourceController.signal.aborted ? sourceController.signal.reason === "cancelled" ? "cancelled" : "timeout" : "source_error", "search");
        }
        return { sourceId, policy, result };
      }));
      stopSources();
      controller.signal.throwIfAborted();
      // No remote await inside this boundary. Results observed earlier are checked again before exposure.
      return await abortable(withDatabase(db, async (): Promise<SearchResponse> => {
        controller.signal.throwIfAborted();
        const checkedSources = sources.map((source) => finalizeSource(source));
        let local;
        try { local = readLocalAlbums(db, options, deps.sampleKind); }
        catch { local = fail("database_error", "search"); }
        if (deps.clock.now() - started >= SEARCH_LIMITS.deadlineMs) {
          deadline = true; controller.abort("timeout"); controller.signal.throwIfAborted();
        }
        return response(local, checkedSources);
      }), controller.signal);
    } catch {
      if (signal?.aborted) return { ok: false, code: "cancelled" };
      // A final snapshot could not be checked. Do not expose held metadata after a possible removal.
      const error = fail(controller.signal.aborted ? "timeout" : "database_error", "search");
      return response(error, sources.map((source) => ({ ...source, result: source.result.ok ? error : source.result })));
    } finally {
      stop(); stopSources(); signal?.removeEventListener("abort", cancel);
      controller.abort("cancelled"); sourceController.abort("cancelled"); active--;
    }

    function validateDelivery(result: Extract<AdapterResult, { ok: true }>, sourceId: SourceId): SearchDelivery | SearchFailure {
      try {
        const { delivery, refreshFailure, ...dto } = result;
        const metadata = validateContext(dto, { request: { sourceId, kind: "search", query: options.q },
          sampleKind: deps.sampleKind, parserVersion: result.provenance.parserVersion, policyRevision: "checked-separately" });
        const captured = Date.parse(metadata.provenance.capturedAt), fresh = Date.parse(delivery.freshUntil), expires = Date.parse(delivery.expiresAt);
        if (metadata.data.kind !== "search" || !["transport", "cache"].includes(delivery.from)
          || !["fresh", "stale"].includes(delivery.freshness) || !Number.isFinite(fresh) || !Number.isFinite(expires)
          || captured > deps.clock.now() || fresh < captured || expires < fresh) throw new Error("Invalid delivery");
        return { ...metadata, data: metadata.data, delivery: structuredClone(delivery), ...(refreshFailure ? { refreshFailure: structuredClone(refreshFailure) } : {}) };
      } catch { return fail("invalid_response", "search"); }
    }
    function response(local: SearchResponse["local"], results: SourceSearchResult[]): SearchResponse {
      return { ok: true, query: options.q, sampleKind: deps.sampleKind,
        status: status(local, results),
        termination: deadline ? "deadline" : "settled", completedAt: new Date(deps.clock.now()).toISOString(),
        elapsedMs: Math.max(0, deps.clock.now() - started), local, sources: results };
    }
  } };
}
