import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { buildPwa } from "../scripts/build-pwa.ts";

type WorkerEvent = { request?: Request; waitUntil?: (promise: Promise<unknown>) => void; respondWith?: (promise: Promise<Response>) => void };
const origin = "https://loopshelf.test";
function harness(broken = false) {
  const events = new Map<string, (event: WorkerEvent) => void>();
  const stored = new Map<string, Map<string, Response>>();
  const calls: { url: string; init?: RequestInit }[] = [];
  let claims = 0, offline = false;
  const files = [{ url: "/index.html", body: "<main>public shell</main>" }, { url: "/assets/app.js", body: "public script" }];
  const entries = files.map(({ url, body }) => ({ url, sha256: createHash("sha256").update(body).digest("hex") }));
  const source = stripTypeScriptTypes(readFileSync(new URL("../worker/service-worker.ts", import.meta.url), "utf8")).replace("export {};", "");
  const caches = {
    keys: async () => [...stored.keys()], delete: async (key: string) => stored.delete(key),
    open: async (key: string) => {
      if (!stored.has(key)) stored.set(key, new Map());
      const cache = stored.get(key)!;
      return { put: async (url: string, response: Response) => { cache.set(url, response.clone()); }, match: async (url: string) => cache.get(url)?.clone() };
    },
  };
  runInNewContext(source, {
    PRECACHE: entries, VERSION: "release-one", URL, Request, Response, Uint8Array, AbortSignal, crypto: webcrypto, caches,
    self: { location: { origin }, clients: { claim: async () => { claims++; } }, addEventListener: (name: string, callback: (event: WorkerEvent) => void) => events.set(name, callback) },
    fetch: async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input.url).pathname;
      calls.push({ url, ...(init ? { init } : {}) });
      if (offline) throw new Error("offline");
      const response = new Response(broken ? "incorrect deployment" : files.find((entry) => entry.url === url)?.body ?? "network content");
      Object.defineProperty(response, "type", { value: "basic" }); return response;
    },
  });
  async function lifecycle(name: string) { let promise: Promise<unknown> | undefined; events.get(name)!({ waitUntil: (value) => { promise = value; } }); await promise; }
  function request(path: string, init?: RequestInit, navigate = false) {
    const request = new Request(new URL(path, origin), init);
    if (navigate) Object.defineProperty(request, "mode", { value: "navigate" });
    let response: Promise<Response> | undefined;
    events.get("fetch")!({ request, respondWith: (value) => { response = value; } }); return response;
  }
  return { stored, calls, lifecycle, request, claims: () => claims, goOffline: () => { offline = true; } };
}

test("worker admits only content-verified static release files without cookies", async () => {
  const worker = harness(); await worker.lifecycle("install");
  assert.deepEqual([...worker.stored.get("loopshelf-shell-v1-release-one")!.keys()], ["/index.html", "/assets/app.js"]);
  assert.equal(worker.calls.length, 2);
  for (const { init } of worker.calls) { assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error"); }
  const broken = harness(true);
  await assert.rejects(broken.lifecycle("install"), /does not match/);
  assert.equal(broken.stored.size, 0);
});

test("worker ignores private APIs, downloads, audio, mutations, queries and other origins", async () => {
  const worker = harness(); await worker.lifecycle("install");
  for (const path of ["/api/auth/get-session", "/api/bookmarks", "/api/library/export", "/private.json", "/music.mp3", "/?token=private", "/index.html?user=alice", "https://outside.test/assets/app.js"]) assert.equal(worker.request(path), undefined, path);
  assert.equal(worker.request("/assets/app.js", { method: "POST", body: "private" }), undefined);
  assert.equal(worker.request("/assets/app.js", { headers: { Range: "bytes=0-3" } }), undefined);
  assert.equal(worker.request("/api/bookmarks", undefined, true), undefined);
  assert.equal(worker.calls.length, 2);
  worker.goOffline();
  assert.equal(await (await worker.request("/", undefined, true))?.text(), "<main>public shell</main>");
  assert.equal(await (await worker.request("/assets/app.js"))?.text(), "public script");
  assert.equal(worker.stored.get("loopshelf-shell-v1-release-one")!.size, 2);
});

test("activation cleans only older LoopShelf shell releases", async () => {
  const worker = harness(); await worker.lifecycle("install");
  worker.stored.set("loopshelf-shell-v1-old", new Map()); worker.stored.set("unrelated-cache", new Map());
  await worker.lifecycle("activate");
  assert.deepEqual([...worker.stored.keys()], ["loopshelf-shell-v1-release-one", "unrelated-cache"]);
  assert.equal(worker.claims(), 1);
});

test("build uses a deterministic allowlist and content-addressed release, ignoring unrelated files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loopshelf-pwa-build-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync("dist", root, { recursive: true });
  writeFileSync(join(root, "private.json"), "private"); writeFileSync(join(root, "assets", "sound.mp3"), "audio");
  const first = await buildPwa(root); const second = await buildPwa(root);
  assert.equal(first.version, second.version);
  assert.ok(first.entries.length >= 8);
  assert.ok(first.entries.every(({ url }) => !/private|sound|\.map$|sw\.js/u.test(url)));
  writeFileSync(join(root, "index.html"), "changed public shell");
  assert.notEqual((await buildPwa(root)).version, first.version);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.id, "/"); assert.equal(manifest.display, "standalone");
  for (const { src, sizes } of manifest.icons) {
    const png = readFileSync(join(root, src));
    assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, sizes);
  }
});
