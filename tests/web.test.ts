import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { buildApp } from "../src/server/app.ts";
import { registerWeb } from "../src/server/web.ts";
import { existsSync } from "node:fs";

test("production web assets preserve security headers and API 404s", { skip: !existsSync("dist/index.html") }, async (t) => {
  const db = openDatabase(":memory:"); migrate(db);
  const app = await buildApp(db, { baseURL: "http://127.0.0.1:3000", secret: "test-only-web-secret-at-least-32-characters" });
  t.after(async () => { await app.close(); db.close(); });
  await registerWeb(app);
  const headers = { host: "127.0.0.1:3000" };
  const index = await app.inject({ url: "/", headers });
  assert.equal(index.statusCode, 200); assert.match(index.body, /<html lang="ko">/);
  assert.equal(index.headers["cache-control"], "no-store");
  assert.match(String(index.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(index.headers["referrer-policy"], "no-referrer");
  assert.match(String(index.headers["content-security-policy"]), /worker-src 'self'/);
  assert.match(index.body, /rel="manifest"/);
  const manifest = await app.inject({ url: "/manifest.webmanifest", headers });
  assert.equal(manifest.statusCode, 200); assert.equal(manifest.json().id, "/");
  const worker = await app.inject({ url: "/sw.js", headers });
  assert.equal(worker.statusCode, 200); assert.match(String(worker.headers["content-type"]), /javascript/);
  assert.equal(worker.headers["cache-control"], "no-store");
  for (const path of ["/api/unknown", "/api/auth/sign-up/email", "/src/server/main.ts"]) {
    assert.equal((await app.inject({ url: path, headers })).statusCode, 404);
  }
  assert.equal((await app.inject({ url: "/.env", headers })).statusCode, 403);
  assert.equal((await app.inject({ url: "/", headers: { host: "attacker.test" } })).statusCode, 400);
});
