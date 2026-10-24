import type Database from "better-sqlite3";
import { getSourceAlbumService } from "./source-album.ts";
import { catalogAdmissionPolicy } from "./source-save/policy.ts";
import { createSourceSaveService, type SourceSaveAuthentication } from "./source-save/service.ts";

/** Closed product facade, not registered as an HTTP endpoint. Use the server's actual Better Auth instance. */
export function createSourceAlbumSaveService(db: Database.Database, auth: SourceSaveAuthentication) {
  return createSourceSaveService(db, { auth, sampleKind: "live-capture", policy: catalogAdmissionPolicy,
    detail: getSourceAlbumService(db), clock: { now: () => performance.timeOrigin + performance.now(),
      timer(ms, callback) { const id = setTimeout(callback, ms); return () => clearTimeout(id); } },
  });
}
