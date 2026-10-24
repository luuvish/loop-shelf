import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { getSearchService } from "../search.ts";
import { parseSearchInput } from "../search/input.ts";
import { getSourceAlbumService } from "../source-album.ts";
import { parseSourceAlbumInput } from "../source-album/input.ts";
import { createSourceReadRoutes, type ReadSession } from "./source-read.ts";

export { SOURCE_READ_HTTP_LIMITS as SEARCH_HTTP_LIMITS } from "./source-read.ts";

/** Fixed product services; no HTTP/env injection of policy, adapters or sample kind. */
export function registerSearchAndSourceAlbum(app: FastifyInstance, db: Database.Database, readSession: ReadSession) {
  const search = getSearchService(db), album = getSourceAlbumService(db);
  const register = createSourceReadRoutes(app, db, readSession);
  register({ path: "/api/search", timeoutCode: "search_timeout", parse: parseSearchInput,
    read: (input, signal) => search.search(input, signal), recheck: (input, result) => search.recheck(input, result) });
  register({ path: "/api/source-album", timeoutCode: "album_timeout", parse: parseSourceAlbumInput,
    read: (input, signal) => album.getAlbum(input, signal), recheck: (input, result) => album.recheck(input, result) });
}
