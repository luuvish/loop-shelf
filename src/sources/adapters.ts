import type Database from "better-sqlite3";
import { PARSER_VERSION, inspectCapturedPage } from "./parsers.ts";
import { productAccess, sourceAssessments } from "./policies.ts";
import { productReviewRevision } from "./review-policy.ts";
import { getSourceCapture } from "./transport.ts";
import type { PageKind, SourceId } from "./types.ts";
import { createMetadataService } from "./adapters/service.ts";
import type { AdapterResult, MetadataPolicy } from "./adapters/contracts.ts";

export type { AdapterResult, AdapterFailure, MetadataDelivery } from "./adapters/contracts.ts";
export function sourceCapabilities(sourceId: SourceId) {
  return structuredClone({ sourceId, parser: { search: true, album: sourceId === "zophar" },
    technical: sourceAssessments[sourceId].technical, policy: sourceAssessments[sourceId].policy,
    pagination: "unverified" as const, playback: "unsupported" as const });
}
export interface SourceAdapter {
  capabilities(): ReturnType<typeof sourceCapabilities>;
  searchAlbums(query: string, signal?: AbortSignal): Promise<AdapterResult>;
  getAlbum(externalKey: string, signal?: AbortSignal): Promise<AdapterResult>;
}
const instances = new WeakMap<Database.Database, Readonly<Record<SourceId, SourceAdapter>>>();

export function metadataPolicy(source: SourceId, kind: PageKind): MetadataPolicy {
  return { revision: productReviewRevision(source),
    collect: productAccess(source, kind), cache: productAccess(source, "cache"), display: productAccess(source, "display") };
}

/** Policy-gated product facade. No HTTP route, background collection or catalog ingestion. */
export function getSourceAdapters(db: Database.Database): Readonly<Record<SourceId, SourceAdapter>> {
  const previous = instances.get(db);
  if (previous) return previous;
  const service = createMetadataService(db, {
    sampleKind: "live-capture", capture: getSourceCapture(db),
    parser: { version: PARSER_VERSION, parse: inspectCapturedPage },
    policy: metadataPolicy,
    clock: { now: () => performance.timeOrigin + performance.now(),
      timer(ms, callback) { const id = setTimeout(callback, ms); return () => clearTimeout(id); } },
  });
  const adapter = (sourceId: SourceId): SourceAdapter => Object.freeze({
    capabilities: () => sourceCapabilities(sourceId),
    searchAlbums: (query: string, signal?: AbortSignal) => service.get({ sourceId, kind: "search", query }, signal),
    getAlbum: (externalKey: string, signal?: AbortSignal) => service.get({ sourceId, kind: "album", externalKey }, signal),
  });
  const adapters = Object.freeze({ khinsider: adapter("khinsider"), zophar: adapter("zophar") });
  instances.set(db, adapters);
  return adapters;
}
