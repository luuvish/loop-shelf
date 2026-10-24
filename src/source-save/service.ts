import type Database from "better-sqlite3";
import { withDatabase } from "../database/access.ts";
import { CatalogError } from "../catalog/input.ts";
import { CatalogLibraryError } from "../library/catalog.ts";
import type { SourceAlbumResult } from "../shared/source-album.ts";
import { MetadataCache } from "../sources/adapters/cache.ts";
import { abortable, type TransportClock } from "../sources/transport/contracts.ts";
import type { SourceId, Provenance } from "../sources/types.ts";
import { admitSourceAlbum, parseSourceSaveInput, requireCatalogPermission, SourceSaveError, type CatalogAdmissionPolicy } from "./admission.ts";
import { commitSyntheticSourceSave } from "./persistence.ts";

export interface SourceSaveAuthentication {
  api: { getSession(options: { headers: Headers }): Promise<{ user: { id: string }; session: { id: string } } | null> };
}
interface Dependencies {
  sampleKind: Provenance["sampleKind"]; auth: SourceSaveAuthentication; clock: TransportClock;
  policy(sourceId: SourceId): CatalogAdmissionPolicy;
  detail: { getAlbum(input: unknown, signal?: AbortSignal): Promise<SourceAlbumResult>; recheck(input: unknown, value: SourceAlbumResult): SourceAlbumResult };
}
export const SOURCE_SAVE_LIMITS = Object.freeze({ deadlineMs: 12000, maxActive: 16, bodyBytes: 32768 });
export type SourceSaveResult = ReturnType<typeof commitSyntheticSourceSave> | { ok: false; code: SourceSaveError["code"] };

/** Internal offline seam. There is no HTTP route, caller-supplied metadata, writer override, or userId input. */
export function createSourceSaveService(db: Database.Database, deps: Dependencies) {
  let active = 0;
  const removed = new MetadataCache(db);
  return {
    async save(raw: unknown, suppliedHeaders: Headers, signal?: AbortSignal): Promise<SourceSaveResult> {
      if (signal?.aborted) return { ok: false, code: "cancelled" };
      if (active >= SOURCE_SAVE_LIMITS.maxActive) return { ok: false, code: "queue_full" };
      active++;
      const headers = new Headers(suppliedHeaders), controller = new AbortController(), started = deps.clock.now();
      const cancel = () => controller.abort("cancelled"); signal?.addEventListener("abort", cancel, { once: true });
      const stop = deps.clock.timer(SOURCE_SAVE_LIMITS.deadlineMs, () => controller.abort("timeout"));
      const check = () => {
        if (deps.clock.now() - started >= SOURCE_SAVE_LIMITS.deadlineMs) controller.abort("timeout");
        if (controller.signal.aborted) throw new SourceSaveError(controller.signal.reason === "timeout" ? "timeout" : "cancelled");
      };
      try {
        // Snapshot all request input before the first await; later caller mutations cannot change a queued save.
        const input = parseSourceSaveInput(raw), ref = { sourceId: input.sourceId, externalKey: input.externalKey };
        const initial = await abortable(withDatabase(db, async () => {
          check(); const session = await deps.auth.api.getSession({ headers: new Headers(headers) }); check();
          if (!session) throw new SourceSaveError("unauthorized");
          if (!headers.has("x-loopshelf-session")) throw new SourceSaveError("session_required");
          if (headers.get("x-loopshelf-session") !== session.session.id) throw new SourceSaveError("session_changed");
          const policy = structuredClone(deps.policy(input.sourceId));
          requireCatalogPermission(policy, input.sourceId, deps.sampleKind, deps.clock.now());
          // A live writer needs expiry-aware storage and read/transfer/removal paths. Synthetic SQL must never receive it.
          if (deps.sampleKind !== "synthetic") throw new SourceSaveError("storage_unavailable");
          if (removed.isRemoved(input.sourceId, input.externalKey)) throw new SourceSaveError("content_removed");
          return { userId: session.user.id, sessionId: session.session.id, policy };
        }), controller.signal);
        const detail = await abortable(Promise.resolve().then(() => { check(); return deps.detail.getAlbum(ref, controller.signal); }), controller.signal);
        return await abortable(withDatabase(db, async () => {
          check(); const session = await deps.auth.api.getSession({ headers: new Headers(headers) }); check();
          if (!session) throw new SourceSaveError("unauthorized");
          if (session.user.id !== initial.userId || session.session.id !== initial.sessionId) throw new SourceSaveError("session_changed");
          const recheck = () => {
            check(); const policy = structuredClone(deps.policy(input.sourceId));
            requireCatalogPermission(policy, input.sourceId, deps.sampleKind, deps.clock.now());
            if (JSON.stringify(policy) !== JSON.stringify(initial.policy)) throw new SourceSaveError("policy_changed");
            if (removed.isRemoved(input.sourceId, input.externalKey)) throw new SourceSaveError("content_removed");
            return policy;
          };
          const policy = recheck();
          const current = deps.detail.recheck(ref, detail);
          if (!current.ok || !current.result.ok) {
            const code = !current.ok ? current.code : !current.result.ok ? current.result.code : "source_error";
            if (["policy_disabled", "policy_changed", "content_removed", "result_expired", "cancelled", "queue_full"].includes(code))
              throw new SourceSaveError(code as SourceSaveError["code"]);
            if (code === "not_found" || code === "blocked") throw new SourceSaveError("catalog_unavailable");
            throw new SourceSaveError("source_error");
          }
          const admitted = admitSourceAlbum(input, current, policy, deps.clock.now());
          return commitSyntheticSourceSave(db, initial.userId, input, admitted, () => {
            const latest = recheck(); admitSourceAlbum(input, current, latest, deps.clock.now());
          });
        }), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return { ok: false, code: controller.signal.reason === "timeout" ? "timeout" : "cancelled" };
        if (error instanceof SourceSaveError) return { ok: false, code: error.code };
        if (error instanceof CatalogError) return { ok: false, code: error.code === "source_suppressed" ? "content_removed"
          : error.code === "observation_conflict" ? "snapshot_changed" : "catalog_unavailable" };
        if (error instanceof CatalogLibraryError) return { ok: false, code: "catalog_unavailable" };
        return { ok: false, code: "database_error" };
      } finally {
        stop(); signal?.removeEventListener("abort", cancel); controller.abort("finished"); active--;
      }
    },
  };
}
