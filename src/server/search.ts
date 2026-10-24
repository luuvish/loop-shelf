import { fromNodeHeaders } from "better-auth/node";
import { getSourceAlbumSaveService } from "../source-save.ts";
import { parseSourceSaveInput } from "../source-save/admission.ts";
import { SOURCE_SAVE_LIMITS, type SourceSaveAuthentication } from "../source-save/service.ts";
import { sourceSaveStatus } from "./source-save.ts";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { getSearchService } from "../search.ts";
import { parseSearchInput } from "../search/input.ts";
import { getSourceAlbumService } from "../source-album.ts";
import { parseSourceAlbumInput } from "../source-album/input.ts";
import { createSourceRoutes, type ReadSession } from "./source-read.ts";

export { SOURCE_READ_HTTP_LIMITS as SEARCH_HTTP_LIMITS } from "./source-read.ts";

/** Fixed product services; no HTTP/env injection of policy, adapters or sample kind. */
export function registerSearchAndSourceAlbum(app: FastifyInstance, db: Database.Database, readSession: ReadSession, auth: SourceSaveAuthentication) {
  const search = getSearchService(db), album = getSourceAlbumService(db);
  const save = getSourceAlbumSaveService(db, auth);
  const routes = createSourceRoutes(app, db, readSession);
  routes.read({ path: "/api/search", timeoutCode: "search_timeout", parse: parseSearchInput,
    read: (input, signal) => search.search(input, signal), recheck: (input, result) => search.recheck(input, result) });
  routes.read({ path: "/api/source-album", timeoutCode: "album_timeout", parse: parseSourceAlbumInput,
    read: (input, signal) => album.getAlbum(input, signal), recheck: (input, result) => {
      const checked = album.recheck(input, result);
      return checked.ok ? { ...checked, save: save.selection(input, checked) } : checked;
    } });
  routes.write({ path: "/api/source-album/save", timeoutCode: "save_timeout", bodyBytes: SOURCE_SAVE_LIMITS.bodyBytes, parse: parseSourceSaveInput,
    write: async (input, request, signal) => {
      const result = await save.save(input, fromNodeHeaders(request.headers), signal);
      if (!result.ok) return { status: sourceSaveStatus(result.code), value: { code: result.code } };
      const { authenticated, ...value } = result;
      return { status: result.created ? 201 : 200, value, authenticated };
    } });
}
