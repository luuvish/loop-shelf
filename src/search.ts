import type Database from "better-sqlite3";
import { getSourceAdapters, metadataPolicy } from "./sources/adapters.ts";
import { createSearchService } from "./search/service.ts";

export type { SearchResult, SearchResponse } from "./shared/search.ts";
const instances = new WeakMap<Database.Database, ReturnType<typeof createSearchService>>();
/** Fixed product dependencies for internal and authenticated HTTP use. No activation switch or catalog ingestion. */
export function getSearchService(db: Database.Database) {
  const existing = instances.get(db);
  if (existing) return existing;
  const service = createSearchService(db, { sampleKind: "live-capture", adapters: getSourceAdapters(db),
    policy: (source) => metadataPolicy(source, "search"),
    clock: { now: () => performance.timeOrigin + performance.now(),
      timer(ms, callback) { const id = setTimeout(callback, ms); return () => clearTimeout(id); } },
  });
  instances.set(db, service);
  return service;
}
