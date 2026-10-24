import type Database from "better-sqlite3";
import { getSourceAdapters, metadataPolicy } from "./sources/adapters.ts";
import { createSourceAlbumService } from "./source-album/service.ts";

export type { SourceAlbumResult, SourceAlbumResponse } from "./shared/source-album.ts";
const instances = new WeakMap<Database.Database, ReturnType<typeof createSourceAlbumService>>();
/** Fixed product dependencies. A successful read does not create catalog, library or playback resources. */
export function getSourceAlbumService(db: Database.Database) {
  const existing = instances.get(db);
  if (existing) return existing;
  const service = createSourceAlbumService(db, { sampleKind: "live-capture", adapters: getSourceAdapters(db),
    policy: (source) => metadataPolicy(source, "album"),
    clock: { now: () => performance.timeOrigin + performance.now(),
      timer(ms, callback) { const id = setTimeout(callback, ms); return () => clearTimeout(id); } },
  });
  instances.set(db, service); return service;
}
