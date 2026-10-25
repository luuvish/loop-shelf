// Isolated E2E infrastructure: never opens the operator's database or reads .env.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openDatabase } from "../../src/database/connection.ts";
import { migrate } from "../../src/database/migrate.ts";
import { createAccount } from "../../src/auth/accounts.ts";
import { buildApp } from "../../src/server/app.ts";
import { installSourceSaveFixture } from "./source-save-fixture.ts";
import { installTrackSearchFixture } from "./track-search-fixture.ts";
import { seedCatalog } from "./catalog-fixture.ts";
import { registerWeb } from "../../src/server/web.ts";

const development = process.argv.includes("--dev");
const pwa = process.argv.includes("--pwa");
const catalogViewport = process.argv.includes("--catalog-desktop") ? "desktop" : process.argv.includes("--catalog-mobile") ? "mobile" : null;
const searchViewport = process.argv.includes("--search-desktop") ? "desktop" : process.argv.includes("--search-mobile") ? "mobile" : null;
const albumViewport = process.argv.includes("--album-desktop") ? "desktop" : process.argv.includes("--album-mobile") ? "mobile" : null;
const saveViewport = process.argv.includes("--save-desktop") ? "desktop" : process.argv.includes("--save-mobile") ? "mobile" : null;
const trackViewport = process.argv.includes("--track-desktop") ? "desktop" : process.argv.includes("--track-mobile") ? "mobile" : null;
const port = trackViewport === "desktop" ? 4199 : trackViewport === "mobile" ? 4200 : saveViewport === "desktop" ? 4197 : saveViewport === "mobile" ? 4198 : albumViewport === "desktop" ? 4195 : albumViewport === "mobile" ? 4196 : searchViewport === "desktop" ? 4193 : searchViewport === "mobile" ? 4194 : catalogViewport === "desktop" ? 4191 : catalogViewport === "mobile" ? 4192 : development ? 4188 : pwa ? 4189 : 4187;
const directory = mkdtempSync(join(tmpdir(), "loopshelf-browser-"));
const db = openDatabase(join(directory, "test.sqlite"));
process.once("exit", () => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
const config = { baseURL: `http://127.0.0.1:${port}`, secret: randomBytes(32).toString("base64url") };
const app = await build();
async function build() {
  migrate(db);
  for (const name of ["alice", "bob"]) await createAccount(db, config, { name: `${name} (검증용)`, email: `${name}@example.test`, password: "browser-test-password-123" });
  if (catalogViewport) {
    for (const viewport of [catalogViewport]) {
      const user = await createAccount(db, config, { name: `카탈로그 ${viewport} (검증용)`, email: `catalog-${viewport}@example.test`, password: "browser-test-password-123" });
      await seedCatalog(db, user.id, `browser-${viewport}`);
    }
  }
  const server = await buildApp(db, config);
  if (saveViewport) await installSourceSaveFixture(db, config);
  if (trackViewport) await installTrackSearchFixture(db, server);
  if (pwa) {
    const original = readFileSync(new URL("../../dist/sw.js", import.meta.url), "utf8");
    let variant = "base";
    server.post<{ Body: { variant: string } }>("/__test/pwa-release", async (request, reply) => {
      if (!["base", "next", "broken"].includes(request.body.variant)) return reply.code(400).send();
      variant = request.body.variant; return { variant };
    });
    server.get("/sw.js", async (_request, reply) => {
      const versioned = variant === "base" ? original : original.replace(/const VERSION = "([^"]+)";/u, `const VERSION = "$1-${variant}";`);
      return reply.type("application/javascript").send(variant === "broken" ? versioned.replace(/"sha256":"[a-f0-9]+"/u, '"sha256":"invalid-test-digest"') : versioned);
    });
  }
  await registerWeb(server, development);
  server.addHook("onClose", async () => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return server;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
await app.listen({ host: "127.0.0.1", port });
process.stdout.write(`Isolated browser fixture: ${config.baseURL}\n`);
