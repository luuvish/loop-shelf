import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { setImmediate } from "node:timers/promises";
import { test as nodeTest, type TestContext } from "node:test";
import { createAccount, resetAccountPassword } from "../src/auth/accounts.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { acquireDatabase, withDatabase } from "../src/database/access.ts";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { getSearchService } from "../src/search.ts";
import { buildApp } from "../src/server/app.ts";
import { SEARCH_HTTP_LIMITS } from "../src/server/search.ts";
import type { SearchResult } from "../src/shared/search.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";

const config = { baseURL: "http://127.0.0.1:3000", secret: "search-api-test-secret-at-least-32-characters-long" };
const baseHeaders = { host: "127.0.0.1:3000", origin: config.baseURL };
const password = "test-only-password-123";
const query = { q: "Album", sources: ["khinsider", "zophar"] };
const tick = () => setImmediate();
const test = (name: string, action: (t: TestContext) => Promise<void>) => nodeTest(name, { timeout: 10000 }, action);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
async function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db);
  const a = await createAccount(db, config, { name: "Alice", email: "alice@example.test", password });
  const b = await createAccount(db, config, { name: "Bob", email: "bob@example.test", password });
  const app = await buildApp(db, config);
  t.after(async () => { await app.close(); db.close(); });
  async function login(email = a.email) {
    const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: baseHeaders, payload: { email, password } });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = (await app.inject({ url: "/api/auth/get-session", headers: { ...baseHeaders, cookie } })).json().session.id as string;
    return { ...baseHeaders, cookie, "x-loopshelf-session": session };
  }
  const own = await login(), other = await login(b.email), service = getSearchService(db);
  const baseline = await service.search(query);
  function hold() {
    const entered = deferred<AbortSignal>(), result = deferred<SearchResult>();
    const mock = t.mock.method(service, "search", async (_input: unknown, signal?: AbortSignal) => { assert.ok(signal); entered.resolve(signal); return result.promise; });
    return { entered: entered.promise, result, mock };
  }
  const search = (headers = own, payload: unknown = query, url = "/api/search") => app.inject({ method: "POST", url, headers, payload: payload as object });
  return { db, app, a, b, own, other, login, service, baseline, hold, search };
}
function noStore(response: { headers: Record<string, unknown> }) { assert.equal(response.headers["cache-control"], "no-store"); }

test("real authenticated search reports disabled sources, isolates synthetic/private data and sends session-bound no-store headers", async (t) => {
  const h = await fixture(t), [album] = await new CatalogStore(h.db).ingestSynthetic(syntheticAlbum(0, 1));
  const bookmark = await h.app.inject({ method: "POST", url: "/api/bookmarks", headers: h.own,
    payload: { title: "Private secret", note: "Do not expose", url: "https://www.zophar.net/music/snes/private.html" } });
  const dns = t.mock.method(Resolver.prototype, "resolve4", () => { throw new Error("No external network"); });
  for (const [headers, user] of [[h.own, h.a], [h.other, h.b]] as const) {
    const response = await h.search(headers); assert.equal(response.statusCode, 200); noStore(response);
    assert.equal(response.headers["x-loopshelf-user"], user.id); assert.equal(response.headers["x-loopshelf-session"], headers["x-loopshelf-session"]);
    assert.equal(response.headers.vary, "Cookie, X-LoopShelf-Session");
    const body = response.json(); assert.equal(body.sampleKind, "live-capture"); assert.equal(body.status, "failed");
    assert.equal(body.local.code, "sample_kind_unavailable"); assert.deepEqual(body.sources.map((s: { result: { code: string } }) => s.result.code), ["policy_disabled", "policy_disabled"]);
    for (const secret of [album!.albumId, bookmark.json().item.id, "Private secret", "Do not expose"]) assert.ok(!response.body.includes(secret));
  }
  assert.equal(dns.mock.callCount(), 0); assert.deepEqual(h.db.prepare("SELECT * FROM source_metadata_cache").all(), []);
});

test("absent, forged and expired cookies fail before search even with a valid session precondition or forged user header", async (t) => {
  const h = await fixture(t), mock = t.mock.method(h.service, "search");
  for (const cookie of ["", "better-auth.session_token=forged"]) {
    const response = await h.search({ ...h.own, cookie, "x-user-id": h.a.id } as typeof h.own);
    assert.equal(response.statusCode, 401); assert.equal(response.json().code, "unauthorized"); noStore(response);
  }
  await withDatabase(h.db, async () => { h.db.prepare('UPDATE session SET "expiresAt"=0 WHERE id=?').run(h.own["x-loopshelf-session"]); });
  assert.equal((await h.search()).statusCode, 401); assert.equal(mock.mock.callCount(), 0);
});

test("search requires the current session precondition without treating it as a credential or user selector", async (t) => {
  const h = await fixture(t), mock = t.mock.method(h.service, "search");
  const { "x-loopshelf-session": ignored, ...without } = h.own; void ignored;
  const missing = await h.app.inject({ method: "POST", url: "/api/search", headers: without, payload: query });
  assert.equal(missing.statusCode, 428); assert.equal(missing.json().code, "session_required"); noStore(missing);
  const changed = await h.search({ ...h.other, "x-loopshelf-session": h.own["x-loopshelf-session"] });
  assert.equal(changed.statusCode, 401); assert.equal(changed.json().code, "session_changed"); assert.equal(mock.mock.callCount(), 0);
  const valid = await h.search({ ...h.own, "x-user-id": h.b.id } as typeof h.own);
  assert.equal(valid.statusCode, 200); assert.equal(valid.headers["x-loopshelf-user"], h.a.id);
});

test("exact Host and Origin are required before a search can run", async (t) => {
  const h = await fixture(t), mock = t.mock.method(h.service, "search");
  const { origin: ignored, ...without } = h.own; void ignored;
  for (const headers of [without, { ...h.own, origin: "null" }, { ...h.own, origin: "https://attacker.test" }]) {
    const response = await h.app.inject({ method: "POST", url: "/api/search", headers, payload: query });
    assert.equal(response.statusCode, 403); assert.equal(response.json().code, "invalid_origin"); noStore(response);
  }
  assert.equal((await h.search({ ...h.own, host: "attacker.test" })).statusCode, 400); assert.equal(mock.mock.callCount(), 0);
});

test("strict JSON input rejects URL queries, owner/policy/sample injection and unsupported request shapes before search", async (t) => {
  const h = await fixture(t), mock = t.mock.method(h.service, "search");
  for (const payload of [{}, { ...query, q: "" }, { ...query, q: "a\nb" }, { ...query, q: "x".repeat(201) },
    { ...query, userId: h.b.id }, { ...query, sampleKind: "synthetic" }, { ...query, policy: "allowed" },
    { ...query, sources: ["unknown"] }, { ...query, sources: ["zophar", "zophar"] }, { ...query, limit: "12" }, { ...query, offset: -1 }]) {
    const response = await h.search(h.own, payload); assert.equal(response.statusCode, 400, JSON.stringify(payload)); noStore(response);
  }
  assert.equal((await h.search(h.own, query, "/api/search?userId=forged")).statusCode, 400);
  const text = await h.app.inject({ method: "POST", url: "/api/search", headers: { ...h.own, "content-type": "text/plain" }, payload: JSON.stringify(query) });
  assert.equal(text.statusCode, 415); noStore(text);
  const malformed = await h.app.inject({ method: "POST", url: "/api/search", headers: { ...h.own, "content-type": "application/json" }, payload: '{"q":' });
  assert.equal(malformed.statusCode, 400); noStore(malformed); assert.equal(mock.mock.callCount(), 0);
});

test("search is POST-only and applies a four-KiB UTF-8 body limit without starting collection", async (t) => {
  const h = await fixture(t), mock = t.mock.method(h.service, "search");
  for (const method of ["GET", "HEAD", "OPTIONS"] as const) assert.equal((await h.app.inject({ method, url: "/api/search", headers: h.own })).statusCode, 404);
  const result = await h.search(h.own, { q: "星".repeat(1500) }); assert.equal(result.statusCode, 413); noStore(result);
  assert.equal(mock.mock.callCount(), 0);
});

test("source selection is explicit and local page options do not create automatic remote requests", async (t) => {
  const h = await fixture(t);
  const local = await h.search(h.own, { q: " 星 " }); assert.equal(local.statusCode, 200); assert.deepEqual(local.json().sources, []);
  const selected = await h.search(h.own, { q: " 星 ", sources: ["zophar"], limit: 1, offset: 2 });
  assert.equal(selected.statusCode, 200); assert.equal(selected.json().query, "星");
  assert.deepEqual(selected.json().sources.map((s: { sourceId: string }) => s.sourceId), ["zophar"]);
});

test("per-IP search rate limit cannot be bypassed by switching cookies or spoofing proxy headers", async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < SEARCH_HTTP_LIMITS.perMinute; i++) assert.equal((await h.search(i % 2 ? h.own : h.other)).statusCode, 200);
  const limited = await h.search({ ...h.own, "x-forwarded-for": "192.0.2.20" } as typeof h.own);
  assert.equal(limited.statusCode, 429); assert.equal(limited.json().code, "rate_limited"); noStore(limited);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
});

test("logout and bookmark writes complete during a pending search; the old session cannot receive its result", async (t) => {
  const h = await fixture(t), held = h.hold(), pending = h.search(); await held.entered;
  const saved = await h.app.inject({ method: "POST", url: "/api/bookmarks", headers: h.own,
    payload: { title: "During search", url: "https://www.zophar.net/music/snes/during.html" } });
  assert.equal(saved.statusCode, 201);
  const logout = await h.app.inject({ method: "POST", url: "/api/auth/sign-out", headers: h.own, payload: {} }); assert.equal(logout.statusCode, 200);
  held.result.resolve(h.baseline); const response = await pending;
  assert.equal(response.statusCode, 401); assert.deepEqual(response.json(), { code: "unauthorized" }); noStore(response);
  assert.equal(response.headers["x-loopshelf-user"], undefined); assert.equal(response.headers["x-loopshelf-session"], undefined);
});

test("a password reset while waiting revokes the pending request's actual session", async (t) => {
  const h = await fixture(t), held = h.hold(), pending = h.search(); await held.entered;
  await resetAccountPassword(h.db, config, { email: h.a.email, password: "replacement-password-123" });
  held.result.resolve(h.baseline); const response = await pending;
  assert.equal(response.statusCode, 401); noStore(response);
});

test("session expiry during search is rechecked without refreshing the session lifetime", async (t) => {
  const h = await fixture(t), held = h.hold();
  const before = h.db.prepare('SELECT "expiresAt" FROM session WHERE id=?').get(h.own["x-loopshelf-session"]);
  const pending = h.search(); await held.entered;
  assert.deepEqual(h.db.prepare('SELECT "expiresAt" FROM session WHERE id=?').get(h.own["x-loopshelf-session"]), before);
  await withDatabase(h.db, async () => { h.db.prepare('UPDATE session SET "expiresAt"=0 WHERE id=?').run(h.own["x-loopshelf-session"]); });
  held.result.resolve(h.baseline); assert.equal((await pending).statusCode, 401);
});

test("logout/account switch discards the old response and rejects the old UI precondition under the new cookie", async (t) => {
  const h = await fixture(t), held = h.hold(), pending = h.search(); await held.entered;
  await h.app.inject({ method: "POST", url: "/api/auth/sign-out", headers: h.own, payload: {} });
  const switched = await h.login(h.b.email);
  held.result.resolve(h.baseline); assert.equal((await pending).statusCode, 401);
  assert.equal((await h.search({ ...switched, "x-loopshelf-session": h.own["x-loopshelf-session"] })).statusCode, 401);
  held.mock.mock.restore(); const current = await h.search(switched);
  assert.equal(current.statusCode, 200); assert.equal(current.headers["x-loopshelf-user"], h.b.id);
  assert.equal(current.headers["x-loopshelf-session"], switched["x-loopshelf-session"]);
});

test("HTTP deadline bounds non-cooperative search, aborts it and does not revalidate late results", async (t) => {
  const h = await fixture(t), held = h.hold(), verify = t.mock.method(h.service, "recheck");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = h.search(), signal = await held.entered;
  t.mock.timers.tick(SEARCH_HTTP_LIMITS.deadlineMs); const response = await pending;
  assert.equal(response.statusCode, 504); assert.deepEqual(response.json(), { code: "search_timeout" }); noStore(response); assert.ok(signal.aborted);
  held.result.resolve(h.baseline); await tick(); assert.equal(verify.mock.callCount(), 0); t.mock.timers.reset();
});

test("authentication queue wait is bounded and timed-out callbacks do not read after unlocking", async (t) => {
  const h = await fixture(t), release = await acquireDatabase(h.db), search = t.mock.method(h.service, "search"), prepare = t.mock.method(h.db, "prepare");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = deferred<void>(), schedule = globalThis.setTimeout;
  const timer = t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => {
    const handle = schedule(callback, ms); if (ms === SEARCH_HTTP_LIMITS.deadlineMs) scheduled.resolve(); return handle;
  });
  const pending = h.search(); await scheduled.promise; t.mock.timers.tick(SEARCH_HTTP_LIMITS.deadlineMs);
  const response = await pending; assert.equal(response.statusCode, 504); noStore(response);
  const calls = prepare.mock.callCount(); release(); await tick(); assert.equal(prepare.mock.callCount(), calls); assert.equal(search.mock.callCount(), 0);
  timer.mock.restore(); t.mock.timers.reset();
});

test("the final authentication queue is also bounded, discarding metadata that could not be rechecked", async (t) => {
  const h = await fixture(t), entered = deferred<void>(); let release = () => {};
  t.mock.method(h.service, "search", async () => { release = await acquireDatabase(h.db); entered.resolve(); return h.baseline; });
  const verify = t.mock.method(h.service, "recheck"); t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = h.search(); await entered.promise; await tick(); t.mock.timers.tick(SEARCH_HTTP_LIMITS.deadlineMs);
  const response = await pending; assert.equal(response.statusCode, 504); assert.ok(!("sources" in response.json()));
  release(); await tick(); assert.equal(verify.mock.callCount(), 0); t.mock.timers.reset();
});

test("global HTTP admission bounds authentication and source work independently of per-IP rate limits", async (t) => {
  const h = await fixture(t), held = h.hold();
  const requests = Array.from({ length: SEARCH_HTTP_LIMITS.maxActive }, () => h.search().then((r) => r));
  for (let i = 0; i < 100 && held.mock.mock.callCount() < SEARCH_HTTP_LIMITS.maxActive; i++) await tick();
  assert.equal(held.mock.mock.callCount(), SEARCH_HTTP_LIMITS.maxActive);
  const overflow = await h.search(); assert.equal(overflow.statusCode, 429); assert.equal(overflow.json().code, "queue_full"); noStore(overflow);
  held.result.resolve(h.baseline); for (const result of await Promise.all(requests)) assert.equal(result.statusCode, 200);
  assert.equal((await h.search()).statusCode, 200);
});

test("shutdown aborts active searches instead of waiting for a non-cooperative source", async (t) => {
  const h = await fixture(t), held = h.hold(), pending = h.search(), signal = await held.entered;
  const closing = h.app.close(), response = await pending; await closing;
  assert.ok(signal.aborted); assert.equal(response.statusCode, 503); assert.equal(response.json().code, "server_closing"); noStore(response);
  held.result.resolve(h.baseline);
});

test("internal search failure is a no-store server error without exposing exception details", async (t) => {
  const h = await fixture(t); t.mock.method(h.service, "search", async () => { throw new Error("private key and query detail"); });
  const result = await h.search(); assert.equal(result.statusCode, 500); assert.deepEqual(result.json(), { code: "internal_error" }); noStore(result);
});

test("HTTP cannot expose a synthetic result accidentally returned by an internal service", async (t) => {
  const h = await fixture(t); assert.ok(h.baseline.ok);
  t.mock.method(h.service, "search", async () => ({ ...h.baseline, sampleKind: "synthetic" }) as SearchResult);
  const result = await h.search(); assert.equal(result.statusCode, 500); assert.ok(!result.body.includes("synthetic")); noStore(result);
});

async function listen(h: Awaited<ReturnType<typeof fixture>>) {
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  const address = h.app.server.address(); assert.ok(address && typeof address === "object"); return address.port;
}
function wire(port: number, headers: Record<string, string>) {
  const payload = JSON.stringify(query);
  const received = deferred<{ status: number; body: string; headers: Record<string, unknown> }>();
  const request = httpRequest({ hostname: "127.0.0.1", port, path: "/api/search", method: "POST",
    headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
    let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => received.resolve({ status: response.statusCode!, body, headers: response.headers }));
  });
  request.on("error", () => {}); request.end(payload);
  return { request, received: received.promise };
}

test("real HTTP request-body completion does not cancel a pending search; the completed response keeps session headers", async (t) => {
  const h = await fixture(t), port = await listen(h), held = h.hold(), client = wire(port, h.own), signal = await held.entered;
  await tick(); assert.ok(!signal.aborted); held.result.resolve(h.baseline);
  const response = await client.received; assert.equal(response.status, 200); noStore(response);
  assert.equal(response.headers["x-loopshelf-session"], h.own["x-loopshelf-session"]); assert.equal(JSON.parse(response.body).sampleKind, "live-capture");
});

test("real HTTP disconnect after uploading the body aborts the search subscriber and prevents late delivery", async (t) => {
  const h = await fixture(t), port = await listen(h), held = h.hold(), client = wire(port, h.own), signal = await held.entered;
  const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  const verify = t.mock.method(h.service, "recheck"); client.request.destroy(); await aborted;
  assert.equal(signal.reason, "disconnected"); held.result.resolve(h.baseline); await tick(); assert.equal(verify.mock.callCount(), 0);
  held.mock.mock.restore(); assert.equal((await h.search()).statusCode, 200);
});
