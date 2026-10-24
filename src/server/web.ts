import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

/** Both development and built assets share the API's Host/Origin boundary. */
export async function registerWeb(app: FastifyInstance, development = false) {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Referrer-Policy", "no-referrer").header("X-Frame-Options", "DENY");
    if (!development) reply.header("Content-Security-Policy", [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
      "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
      "worker-src 'self'", "manifest-src 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ].join("; "));
  });
  if (development) {
    app.get("/sw.js", async (_request, reply) => reply.code(404).send({ code: "development_worker_disabled" }));
    const [{ createServer }, { default: middie }] = await Promise.all([import("vite"), import("@fastify/middie")]);
    await app.register(middie);
    const vite = await createServer({ server: { middlewareMode: true, ws: { server: app.server } }, appType: "spa" });
    app.use((request, response, next) => {
      // Never let the SPA fallback swallow unknown auth/API endpoints.
      if (request.url?.split("?")[0] === "/sw.js") return next();
      if (request.url?.split("?")[0]?.match(/^\/api(?:\/|$)/u)) return next();
      vite.middlewares(request, response, next);
    });
    app.addHook("onClose", async () => { await vite.close(); });
    return;
  }
  const root = fileURLToPath(new URL("../../dist/", import.meta.url));
  if (!existsSync(`${root}index.html`)) throw new Error("Web build missing. Run npm run build first (or npm run dev).");
  await app.register(fastifyStatic, { root, index: ["index.html"], cacheControl: false, dotfiles: "deny" });
}
