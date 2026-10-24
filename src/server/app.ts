import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type Database from "better-sqlite3";
import { z, ZodError } from "zod";
import { authOptions, type AuthConfig } from "../auth/options.ts";
import { assertMigrated } from "../database/migrate.ts";
import { withDatabase } from "../database/access.ts";
import { BookmarkStore, LibraryError } from "../library/bookmarks.ts";
import { LibraryTransfer, TransferError, previewInput, importInput } from "../library/transfer.ts";
import { BookmarkDeletions, DeletionError } from "../library/deletions.ts";
import { ARCHIVE_MAX_BYTES } from "../shared/transfer.ts";
import { CatalogLibraryError, CatalogLibraryStore } from "../library/catalog.ts";
import { CatalogBrowseStore } from "../catalog/browse.ts";
import { CatalogTransfer } from "../library/catalog-transfer.ts";
import { registerSearchAndSourceAlbum } from "./search.ts";
import { reconcileCatalogRetention } from "../catalog/retention.ts";
import { CatalogError } from "../catalog/input.ts";

export async function buildApp(db: Database.Database, config: AuthConfig) {
  assertMigrated(db);
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 32 * 1024 });
  const auth = betterAuth(authOptions(db, config));
  await auth.$context;
  const bookmarks = new BookmarkStore(db);
  const catalogLibrary = new CatalogLibraryStore(db);
  const catalogBrowse = new CatalogBrowseStore(db);
  const deletions = new BookmarkDeletions(db);
  await withDatabase(db, async () => { deletions.purge(); reconcileCatalogRetention(db); });
  let closing = false;
  const cleanup = setInterval(() => {
    void withDatabase(db, async () => { if (!closing && db.open) { deletions.purge(); reconcileCatalogRetention(db); } })
      .catch(() => { app.log.error("Could not reconcile expired receipts or catalog metadata"); });
  }, 10000);
  cleanup.unref();
  app.addHook("onClose", async () => { closing = true; clearInterval(cleanup); });
  const transfer = new LibraryTransfer(db, config.secret);
  const catalogTransfer = new CatalogTransfer(db, config.secret);
  const transferFor = (archive: unknown) => typeof archive === "object" && archive !== null && "format" in archive && archive.format === "loopshelf-catalog" ? catalogTransfer : transfer;
  await app.register(rateLimit, { global: false });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    if (request.headers.host !== new URL(config.baseURL).host)
      return reply.code(400).send({ code: "invalid_host" });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== config.baseURL)
      return reply.code(403).send({ code: "invalid_origin" });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CatalogError) return reply.code(error.code === "not_found" ? 404 : 409).send({ code: error.code });
    if (error instanceof CatalogLibraryError) return reply.code(error.code === "not_found" ? 404 : error.code === "invalid_connection" ? 400 : 409).send({ code: error.code });
    if (error instanceof DeletionError) return reply.code(error.code === "undo_unavailable" ? 404 : 409).send({ code: error.code });
    if (error instanceof TransferError) return reply.code(error.code === "archive_too_large" ? 413 : error.code === "invalid_archive" ? 400 : 409).send({ code: error.code });
    if (error instanceof ZodError) return reply.code(400).send({ code: "invalid_input", fields: error.issues.map((issue) => issue.path.join(".")) });
    if (error instanceof LibraryError) return reply.code(error.code === "not_found" ? 404 : ["conflict", "grouped_bookmark", "connection_limit"].includes(error.code) ? 409 : 400)
      .send({ code: error.code, message: error.message });
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500)
      return reply.code(error.statusCode).send({ code: error.statusCode === 429 ? "rate_limited" : "invalid_request" });
    return reply.code(500).send({ code: "internal_error" });
  });

  // Only these authentication operations are exposed. Provisioning/reset stay local.
  for (const [method, path] of [["POST", "sign-in/email"], ["POST", "sign-out"], ["GET", "get-session"]] as const) {
    app.route({ method, url: `/api/auth/${path}`, config: { rateLimit: { max: path === "sign-in/email" ? 5 : 100, timeWindow: "1 minute" } },
      handler: (request, reply) => withDatabase(db, async () => {
        const headers = fromNodeHeaders(request.headers);
        // Never trust a client-supplied proxy/IP header for rate limiting.
        headers.set("x-loopshelf-client-ip", request.ip);
        const response = await auth.handler(new Request(new URL(request.url, config.baseURL), {
          method: request.method, headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }));
        response.headers.forEach((value, key) => { if (key !== "set-cookie" && key !== "cache-control") reply.header(key, value); });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header("set-cookie", cookies);
        reply.code(response.status);
        return await response.text();
      }) });
  }

  app.get("/api/health", async () => ({ status: "ok" }));
  registerSearchAndSourceAlbum(app, db, async (request) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers),
      query: { disableCookieCache: true, disableRefresh: true } });
    return session ? { userId: session.user.id, sessionId: session.session.id } : null;
  }, auth);
  // Session lookup and the operation share one database turn, even after disconnects/errors.
  async function forUser(request: FastifyRequest, reply: FastifyReply, action: (userId: string, sessionId: string) => unknown) {
    return withDatabase(db, async () => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) { reply.code(401); return { code: "unauthorized" }; }
      // A UI draft must not be written under a different cookie session after a tab switches accounts.
      // This is a precondition, never an authentication credential or a choice of user.
      const expectedSession = request.headers["x-loopshelf-session"];
      if (expectedSession !== undefined && expectedSession !== session.session.id) {
        reply.code(401); return { code: "session_changed" };
      }
      reply.header("X-LoopShelf-User", session.user.id);
      return action(session.user.id, session.session.id);
    });
  }
  app.get("/api/me", (request, reply) => forUser(request, reply, (userId) => ({ userId })));
  const routeId = (request: FastifyRequest) => z.object({ id: z.uuid() }).strict().parse(request.params).id;
  app.get("/api/catalog/albums", (request, reply) => forUser(request, reply, (userId) => catalogBrowse.list(userId, request.query)));
  app.get("/api/catalog/albums/:id", (request, reply) => forUser(request, reply, (userId) => catalogBrowse.detail(userId, routeId(request), request.query)));
  app.get("/api/library/catalog/:id/source-candidates", (request, reply) => forUser(request, reply, (userId) => catalogBrowse.candidates(userId, routeId(request), request.query)));
  // Personal saves of existing synthetic catalog entities; no catalog fetch, ingestion, or operator endpoints.
  app.get("/api/library/catalog", (request, reply) => forUser(request, reply, (userId) => catalogLibrary.list(userId, request.query)));
  app.post("/api/library/catalog", (request, reply) => forUser(request, reply, (userId) => {
    z.object({}).strict().parse(request.query);
    const result = catalogLibrary.create(userId, request.body);
    reply.code(result.created ? 201 : 200); return result;
  }));
  const catalogItemId = (request: FastifyRequest) => {
    z.object({}).strict().parse(request.query);
    return z.object({ id: z.uuid() }).strict().parse(request.params).id;
  };
  app.get("/api/library/catalog/:id", (request, reply) => forUser(request, reply, (userId) => catalogLibrary.get(userId, catalogItemId(request))));
  app.patch("/api/library/catalog/:id", (request, reply) => forUser(request, reply, (userId) => catalogLibrary.update(userId, catalogItemId(request), request.body)));
  app.delete("/api/library/catalog/:id", (request, reply) => forUser(request, reply, (userId) => {
    catalogLibrary.delete(userId, catalogItemId(request), request.body); reply.code(204); return undefined;
  }));
  app.get("/api/library/catalog/:id/sources", (request, reply) => forUser(request, reply, (userId) => {
    const item = catalogLibrary.get(userId, catalogItemId(request));
    return { itemId: item.id, version: item.version, sourceLinks: item.sourceLinks };
  }));
  app.post("/api/library/catalog/:id/sources", (request, reply) => forUser(request, reply, (userId) => catalogLibrary.connect(userId, catalogItemId(request), request.body)));
  app.delete("/api/library/catalog/:id/sources", (request, reply) => forUser(request, reply, (userId) => catalogLibrary.disconnect(userId, catalogItemId(request), request.body)));
  app.get("/api/library/catalog/export", (request, reply) => forUser(request, reply, (userId) => {
    z.object({}).strict().parse(request.query);
    const archive = catalogTransfer.export(userId);
    reply.header("Content-Disposition", `attachment; filename="loopshelf-catalog-${archive.exportedAt.slice(0, 10)}.json"`);
    return archive;
  }));
  app.get("/api/library/export", (request, reply) => forUser(request, reply, (userId) => {
    z.object({}).strict().parse(request.query);
    const archive = transfer.export(userId);
    reply.header("Content-Disposition", `attachment; filename="loopshelf-${archive.exportedAt.slice(0, 10)}.json"`);
    return archive;
  }));
  const importOptions = { bodyLimit: ARCHIVE_MAX_BYTES + 4096 };
  app.post("/api/library/import/preview", importOptions, (request, reply) => forUser(request, reply, (userId) => {
    const { archive } = previewInput.parse(request.body);
    return transferFor(archive).preview(userId, archive);
  }));
  app.post("/api/library/import", importOptions, (request, reply) => forUser(request, reply, (userId) => {
    const { archive, token } = importInput.parse(request.body);
    return transferFor(archive).import(userId, archive, token);
  }));
  app.get("/api/bookmarks", (request, reply) => forUser(request, reply, (userId) => bookmarks.list(userId, request.query)));
  app.post("/api/bookmarks", (request, reply) => forUser(request, reply, (userId) => {
      const result = bookmarks.create(userId, request.body);
      reply.code(result.created ? 201 : 200);
      return result;
    }));
  app.get("/api/bookmarks/:id", (request, reply) => forUser(request, reply, (userId) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return bookmarks.get(userId, id);
    }));
  app.patch("/api/bookmarks/:id", (request, reply) => forUser(request, reply, (userId) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return bookmarks.update(userId, id, request.body);
    }));
  app.delete("/api/bookmarks/:id", (request, reply) => forUser(request, reply, (userId) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const { version } = z.object({ version: z.number().int().positive() }).strict().parse(request.body);
      bookmarks.delete(userId, id, version);
      reply.code(204);
      return undefined;
    }));
  app.post("/api/bookmarks/:id/deletion", (request, reply) => forUser(request, reply, (userId, sessionId) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return deletions.delete(userId, sessionId, id, request.body);
  }));
  app.post("/api/bookmark-deletions/:id/restore", (request, reply) => forUser(request, reply, (userId, sessionId) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body);
    return deletions.restore(userId, sessionId, id);
  }));
  app.get("/api/bookmarks/:id/connections", (request, reply) => forUser(request, reply, (userId) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return bookmarks.connections(userId, id);
  }));
  app.post("/api/bookmarks/:id/connections", (request, reply) => forUser(request, reply, (userId) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return bookmarks.connect(userId, id, request.body);
  }));
  app.delete("/api/bookmarks/:id/connections", (request, reply) => forUser(request, reply, (userId) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return bookmarks.disconnect(userId, id, request.body);
  }));
  return app;
}
