import type Database from "better-sqlite3";
import { getSourceAlbumService } from "./source-album.ts";
import { catalogAdmissionPolicy } from "./source-save/policy.ts";
import { createSourceSaveService, type SourceSaveAuthentication } from "./source-save/service.ts";

/** Closed product facade used by the authenticated HTTP endpoint. Use the server's actual Better Auth instance. */
export function createSourceAlbumSaveService(db: Database.Database, auth: SourceSaveAuthentication) {
  return createSourceSaveService(db, { auth, sampleKind: "live-capture", policy: catalogAdmissionPolicy,
    detail: getSourceAlbumService(db), clock: { now: () => performance.timeOrigin + performance.now(),
      timer(ms, callback) { const id = setTimeout(callback, ms); return () => clearTimeout(id); } },
  });
}

const instances = new WeakMap<Database.Database, ReturnType<typeof createSourceAlbumSaveService>>();
/** One product service per app DB, with the app's actual authentication object. No HTTP/env override. */
export function getSourceAlbumSaveService(db: Database.Database, auth: SourceSaveAuthentication) {
  let service = instances.get(db);
  if (!service) { service = createSourceAlbumSaveService(db, auth); instances.set(db, service); }
  return service;
}
