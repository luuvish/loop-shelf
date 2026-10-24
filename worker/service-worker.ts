// Build-time constants. Only public, content-verified app-shell files are admitted.
declare const PRECACHE: readonly { url: string; sha256: string }[];
declare const VERSION: string;
declare const self: ServiceWorkerGlobalScope;
export {};

const prefix = "loopshelf-shell-v1-";
const cacheName = prefix + VERSION;
const allowed = new Set(PRECACHE.map((entry) => entry.url));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // Validate the entire release before writing anything: a partial deploy must not
    // replace a working offline shell, nor cache an HTML fallback as JavaScript.
    const responses = await Promise.all(PRECACHE.map(async (entry) => {
      const response = await fetch(entry.url, { credentials: "omit", cache: "reload", redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok || response.type !== "basic") throw new Error("Shell asset unavailable");
      const hash = await crypto.subtle.digest("SHA-256", await response.clone().arrayBuffer());
      const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (hex !== entry.sha256) throw new Error("Shell asset does not match release");
      return { url: entry.url, response };
    }));
    const cache = await caches.open(cacheName);
    try { for (const entry of responses) await cache.put(entry.url, entry.response); }
    catch (cause) { await caches.delete(cacheName); throw cause; }
    // Updates wait for all existing clients to close. Never discard an open draft.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function navigation(request: Request): Promise<Response> {
  try {
    const response = await fetch(request, { signal: AbortSignal.timeout(4000) });
    if (response.status < 500) return response;
  } catch { /* Offline or unavailable server: use the verified public shell. */ }
  const fallback = await (await caches.open(cacheName)).match("/index.html");
  return fallback ?? Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // No runtime cache writes, cookie-bearing APIs, queries, external resources,
  // audio, Range requests, or mutation queues. Unmatched requests use the network.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.search || request.headers.has("Range")) return;
  if (request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
    event.respondWith(navigation(request));
  } else if (allowed.has(url.pathname)) {
    event.respondWith((async () => (await (await caches.open(cacheName)).match(url.pathname)) ?? fetch(request))());
  }
});
