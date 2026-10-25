import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { test as nodeTest, type TestContext } from "node:test";
import { betterAuth } from "better-auth";
import { createAccount, resetAccountPassword } from "../src/auth/accounts.ts";
import { authOptions } from "../src/auth/options.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { acquireDatabase, withDatabase } from "../src/database/access.ts";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { buildApp } from "../src/server/app.ts";
import { SOURCE_READ_HTTP_LIMITS as limits } from "../src/server/source-read.ts";
import { getSourceAlbumService } from "../src/source-album.ts";
import { createSourceAlbumService } from "../src/source-album/service.ts";
import { getSourceAlbumSaveService } from "../src/source-save.ts";
import { createSourceSaveService } from "../src/source-save/service.ts";
import { sourceDetailFingerprint, type CatalogAdmissionPolicy } from "../src/source-save/admission.ts";
import type { SourceAlbumResult, SourceAlbumHttpResult } from "../src/shared/source-album.ts";
import { Clock, allowed, deferred, delivery, input, tick } from "./helpers/source-album.ts";

const config = { baseURL: "http://127.0.0.1:3000", secret: "source-save-api-tests-secret-at-least-32-characters" };
const base = { host: "127.0.0.1:3000", origin: config.baseURL }, password = "source-save-api-password-123";
const path = "/api/source-album/save";
const test = (name: string, run: (t: TestContext) => Promise<void>) => nodeTest(name, { timeout: 10000 }, run);
async function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db);
  const alice = await createAccount(db, config, { name: "Alice", email: "alice@example.test", password });
  const bob = await createAccount(db, config, { name: "Bob", email: "bob@example.test", password });
  const app = await buildApp(db, config);
  const gate = { enabled: false, entered: deferred<void>(), release: deferred<void>() };
  app.addHook("onSend", async (request, reply, payload) => {
    if (gate.enabled && request.url === path && reply.statusCode === 201) { gate.entered.resolve(); await gate.release.promise; }
    return payload;
  });
  t.after(async () => { gate.release.resolve(); await app.close(); db.close(); });
  const auth = betterAuth(authOptions(db, config)); await auth.$context;
  async function login(email = alice.email) {
    const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: base, payload: { email, password } });
    assert.equal(response.statusCode, 200);
    const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = (await app.inject({ url: "/api/auth/get-session", headers: { ...base, cookie } })).json().session.id as string;
    return { ...base, cookie, "x-loopshelf-session": session };
  }
  const own = await login(), other = await login(bob.email), clock = new Clock(); clock.time = Date.now() - 5000;
  const value = delivery(clock.now()), metadataPolicy = allowed();
  const policy: CatalogAdmissionPolicy = { sourceId: "zophar", sampleKind: "synthetic", revision: "synthetic-save-api-v1",
    metadataRevision: metadataPolicy.revision, parserVersion: value.provenance.parserVersion,
    persistence: { status: "allowed", reviewedAt: "2026-10-23T00:00:00Z", evidence: ["offline fixture only"], maxRetentionMs: 120000 } };
  const adapter = { getAlbum: async () => structuredClone(value) };
  const detail = createSourceAlbumService(db, { clock, sampleKind: "synthetic", policy: () => metadataPolicy, adapters: { khinsider: adapter, zophar: adapter } });
  const offline = createSourceSaveService(db, { auth, clock, sampleKind: "synthetic", policy: () => policy, detail });
  const product = getSourceAlbumSaveService(db, auth), productDetail = getSourceAlbumService(db);
  function enable() {
    // Only internal methods change. HTTP has no policy/sample-kind/auth override; actual cookie sessions are required.
    t.mock.method(product, "save", (...args: Parameters<typeof offline.save>) => offline.save(...args));
    t.mock.method(product, "selection", (...args: Parameters<typeof offline.selection>) => offline.selection(...args));
    t.mock.method(productDetail, "getAlbum", (...args: Parameters<typeof detail.getAlbum>) => detail.getAlbum(...args));
    t.mock.method(productDetail, "recheck", (...args: Parameters<typeof detail.recheck>) => detail.recheck(...args));
  }
  const request = () => ({ ...input, expectedFingerprint: sourceDetailFingerprint(value) });
  const save = (headers = own, payload: unknown = request(), url = path) => app.inject({ method: "POST", url, headers, payload: payload as object });
  const preview = (headers = own) => app.inject({ method: "POST", url: "/api/source-album", headers, payload: input });
  function empty() { for (const name of ["album", "track", "source_entity", "catalog_observation", "catalog_source_kind"])
    assert.equal((db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n, 0, name);
    assert.equal((db.prepare("SELECT count(*) AS n FROM library_item i JOIN entity e ON e.id=i.entity_id WHERE e.kind IN ('album','track')").get() as { n: number }).n, 0); }
  async function hold() {
    const response = await detail.getAlbum(input), entered = deferred<AbortSignal>(), result = deferred<SourceAlbumResult>();
    const mock = t.mock.method(detail, "getAlbum", async (_input: unknown, signal?: AbortSignal) => { assert.ok(signal); entered.resolve(signal); return result.promise; });
    return { response, entered: entered.promise, release: () => result.resolve(response), mock };
  }
  async function wire() {
    if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address(); assert.ok(address && typeof address === "object");
    const data = JSON.stringify(request()), received = deferred<{ status: number; body: string }>();
    const closed = deferred<void>();
    const client = httpRequest({ hostname: "127.0.0.1", port: address.port, path, method: "POST", headers: {
      ...own, "content-type": "application/json", "content-length": Buffer.byteLength(data),
    } }, (response) => { let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => received.resolve({ status: response.statusCode!, body })); });
    client.on("error", () => {}); client.on("close", () => closed.resolve()); client.end(data);
    return { client, received: received.promise, closed: closed.promise };
  }
  return { db, app, auth, alice, bob, own, other, login, clock, value, metadataPolicy, policy, detail, offline, product, productDetail,
    enable, request, save, preview, empty, hold, wire, gate };
}
function noStore(response: { headers: Record<string, unknown> }) { assert.equal(response.headers["cache-control"], "no-store"); }

test("product save API and detail selection remain closed without external requests or catalog writes", async (t) => {
  const h = await fixture(t), dns = t.mock.method(Resolver.prototype, "resolve4", () => { throw new Error("No external requests"); });
  for (const ref of [input, { sourceId: "khinsider", externalKey: "test-album" }]) {
    const preview = await h.app.inject({ method: "POST", url: "/api/source-album", headers: h.own, payload: ref });
    assert.deepEqual(preview.json().save, { status: "unavailable", code: "policy_disabled" });
    const result = await h.save(h.own, { ...ref, expectedFingerprint: "0".repeat(64) });
    assert.equal(result.statusCode, 503); assert.deepEqual(result.json(), { code: "policy_disabled" }); noStore(result);
    assert.equal(result.headers["x-loopshelf-user"], undefined);
  }
  h.empty(); assert.equal(dns.mock.callCount(), 0);
});

test("save API rejects missing/forged cookies, stale session conditions, Host and Origin before invoking the writer", async (t) => {
  const h = await fixture(t), spy = t.mock.method(h.product, "save");
  for (const cookie of ["", "better-auth.session_token=forged"]) assert.equal((await h.save({ ...h.own, cookie })).statusCode, 401);
  const { "x-loopshelf-session": ignored, ...missing } = h.own; void ignored;
  assert.equal((await h.app.inject({ method: "POST", url: path, headers: missing, payload: h.request() })).statusCode, 428);
  assert.equal((await h.save({ ...h.other, "x-loopshelf-session": h.own["x-loopshelf-session"] })).statusCode, 401);
  for (const origin of ["", "null", "https://attacker.test"]) assert.equal((await h.save({ ...h.own, origin })).statusCode, 403);
  assert.equal((await h.save({ ...h.own, host: "attacker.test" })).statusCode, 400); assert.equal(spy.mock.callCount(), 0); h.empty();
});

test("save API is strict POST/JSON with a 32-KiB byte limit and no metadata, identity, policy or query injection", async (t) => {
  const h = await fixture(t), spy = t.mock.method(h.product, "save");
  for (const extra of [{ userId: h.bob.id }, { sampleKind: "synthetic" }, { policy: "allowed" }, { data: h.value.data },
    { entityId: h.alice.id }, { sourceId: "unknown" }, { url: "https://evil.test" }, { externalKey: "../other" },
    { expectedFingerprint: "bad" }, { note: "\0" }, { favorite: 1 }]) assert.equal((await h.save(h.own, { ...h.request(), ...extra })).statusCode, 400);
  assert.equal((await h.save(h.own, h.request(), `${path}?userId=${h.bob.id}`)).statusCode, 400);
  for (const method of ["GET", "HEAD", "OPTIONS"] as const) assert.equal((await h.app.inject({ method, url: path, headers: h.own })).statusCode, 404);
  assert.equal((await h.app.inject({ method: "POST", url: path, headers: { ...h.own, "content-type": "text/plain" }, payload: JSON.stringify(h.request()) })).statusCode, 415);
  assert.equal((await h.app.inject({ method: "POST", url: path, headers: { ...h.own, "content-type": "application/json" }, payload: '{"sourceId":' })).statusCode, 400);
  const large = await h.save(h.own, { ...h.request(), note: "🎵".repeat(9000) }); assert.equal(large.statusCode, 413); noStore(large);
  assert.equal(spy.mock.callCount(), 0); h.empty();
});

test("search, detail and save share the same per-IP quota across cookies and spoofed proxy headers", async (t) => {
  const h = await fixture(t);
  for (let i = 0; i < limits.perMinute; i++) {
    const response = i % 3 === 0 ? await h.save() : i % 3 === 1 ? await h.preview(h.other)
      : await h.app.inject({ method: "POST", url: "/api/search", headers: h.own, payload: { q: "Album" } });
    assert.equal(response.statusCode, i % 3 === 0 ? 503 : 200);
  }
  for (const url of [path, "/api/source-album", "/api/search"]) {
    const result = await h.save({ ...h.other, "x-forwarded-for": "192.0.2.1" } as typeof h.own, h.request(), url);
    assert.equal(result.statusCode, 429); assert.equal(result.json().code, "rate_limited"); assert.ok(Number(result.headers["retry-after"]) > 0);
  }
  assert.equal((await h.app.inject({ url: "/api/bookmarks", headers: h.own })).statusCode, 200); h.empty();
});

test("detail provides an advisory exact selection; first/duplicate and two-user saves preserve IDs and private contents", async (t) => {
  const h = await fixture(t); h.enable();
  const read = await h.preview(), body = read.json<SourceAlbumHttpResult>(); assert.ok(body.ok); assert.equal(body.save.status, "available");
  assert.ok(body.save.status === "available"); assert.equal(body.save.expectedFingerprint, h.request().expectedFingerprint);
  assert.equal(body.save.validUntil, h.value.delivery.freshUntil); assert.equal(body.save.retainUntil, h.value.delivery.expiresAt); h.empty();
  const first = await h.save({ ...h.own, "x-user-id": h.bob.id } as typeof h.own, { ...h.request(), note: "my private note", favorite: true });
  assert.equal(first.statusCode, 201); noStore(first); assert.equal(first.headers.vary, "Cookie, X-LoopShelf-Session");
  assert.equal(first.headers["x-loopshelf-user"], h.alice.id); assert.equal(first.headers["x-loopshelf-session"], h.own["x-loopshelf-session"]);
  assert.ok(!("authenticated" in first.json())); assert.equal(first.json().sampleKind, "synthetic");
  const again = await h.save(h.own, { ...h.request(), note: "must not overwrite" }); assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json().item, first.json().item); assert.equal(again.json().observationId, first.json().observationId);
  const other = await h.save(h.other); assert.equal(other.statusCode, 201); assert.notEqual(other.json().item.id, first.json().item.id);
  assert.equal(other.json().item.entity.id, first.json().item.entity.id); assert.equal(other.json().item.note, "");
  assert.equal((await h.app.inject({ url: `/api/library/catalog/${first.json().item.id}`, headers: h.other })).statusCode, 404);
});

test("changed observation rejects the old fingerprint and requires a newly inspected detail", async (t) => {
  const h = await fixture(t); h.enable(); const request = h.request(); h.value.data.title = "Changed detail title";
  const rejected = await h.save(h.own, request); assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().code, "snapshot_changed"); h.empty();
  const fresh = (await h.preview()).json(); assert.notEqual(fresh.save.expectedFingerprint, request.expectedFingerprint);
  assert.equal((await h.save(h.own, { ...request, expectedFingerprint: fresh.save.expectedFingerprint })).statusCode, 201);
});

test("selection never offers a fingerprint for stale, expired or policy-disabled metadata", async (t) => {
  const h = await fixture(t); h.enable();
  h.clock.time += 60000; const stale = (await h.preview()).json(); assert.deepEqual(stale.save, { status: "unavailable", code: "refresh_required" });
  h.clock.time += 60000; const expired = (await h.preview()).json(); assert.equal(expired.save.status, "unavailable"); assert.ok(!expired.save.expectedFingerprint);
  h.policy.persistence = { status: "unknown" }; const disabled = (await h.preview()).json(); assert.deepEqual(disabled.save, { status: "unavailable", code: "policy_disabled" }); h.empty();
});

test("save and detail share active slots, including queued authentication, and release them after completion", async (t) => {
  const h = await fixture(t); h.enable(); const held = await h.hold();
  const pending = Array.from({ length: limits.maxActive }, (_, i) => (i % 2 ? h.save() : h.preview()).then((r) => r));
  await held.entered; for (let i = 0; i < 60; i++) await tick();
  const overflow = await h.save(); assert.equal(overflow.statusCode, 429); assert.equal(overflow.json().code, "queue_full");
  held.release(); for (const response of await Promise.all(pending)) assert.ok([200, 201].includes(response.statusCode));
  assert.equal((await h.save()).statusCode, 200);
});

test("logout during detail wait prevents saving while unrelated private writes remain available", async (t) => {
  const h = await fixture(t); h.enable(); const held = await h.hold(), pending = h.save(); await held.entered;
  assert.equal((await h.app.inject({ method: "POST", url: "/api/bookmarks", headers: h.own, payload: { title: "During save", url: "https://www.zophar.net/music/nes/during.html" } })).statusCode, 201);
  assert.equal((await h.app.inject({ method: "POST", url: "/api/auth/sign-out", headers: h.own, payload: {} })).statusCode, 200);
  held.release(); const response = await pending; assert.equal(response.statusCode, 401); assert.equal(response.headers["x-loopshelf-user"], undefined); noStore(response); h.empty();
});

test("session expiry and password reset during pending saves are checked against actual sessions", async (t) => {
  for (const mode of ["expiry", "reset"]) {
    const h = await fixture(t); h.enable(); const held = await h.hold(), pending = h.save(); await held.entered;
    if (mode === "expiry") await withDatabase(h.db, async () => { h.db.prepare('UPDATE "session" SET "expiresAt"=0 WHERE id=?').run(h.own["x-loopshelf-session"]); });
    else await resetAccountPassword(h.db, config, { email: h.alice.email, password: "changed-test-password-123" });
    held.release(); assert.equal((await pending).statusCode, 401); h.empty();
  }
});

test("a separate login does not revoke the valid saving session and response identity stays bound to that session", async (t) => {
  const h = await fixture(t); h.enable(); const held = await h.hold(), pending = h.save(); await held.entered;
  const next = await h.login(h.bob.email); held.release(); const response = await pending; assert.equal(response.statusCode, 201);
  assert.equal(response.headers["x-loopshelf-user"], h.alice.id); assert.equal(response.headers["x-loopshelf-session"], h.own["x-loopshelf-session"]);
  assert.equal((await h.save({ ...next, "x-loopshelf-session": h.own["x-loopshelf-session"] })).statusCode, 401);
});

test("policy revocation while saving and immediately after private writes reject or roll back the entire operation", async (t) => {
  const h = await fixture(t); h.enable(); const held = await h.hold(), pending = h.save(); await held.entered;
  const permission = h.policy.persistence; h.policy.persistence = { status: "denied" }; held.release();
  assert.equal((await pending).json().code, "policy_disabled"); h.empty(); held.mock.mock.restore(); h.policy.persistence = permission;
  const create = CatalogLibraryStore.prototype.create;
  t.mock.method(CatalogLibraryStore.prototype, "create", function(this: CatalogLibraryStore, ...args: Parameters<typeof create>) {
    const result = create.apply(this, args); h.policy.persistence = { status: "unknown" }; return result;
  });
  const result = await h.save(); assert.equal(result.statusCode, 503); h.empty();
});

test("content removal during a pending save preserves personal IDs and refuses to revive the source", async (t) => {
  const h = await fixture(t); h.enable(); const first = await h.save(), item = first.json().item;
  const held = await h.hold(), pending = h.save(); await held.entered;
  await new CatalogStore(h.db).removeSource({ sourceEntityId: item.entity.sourceEntityId, reason: "rights_request" });
  held.release(); const result = await pending; assert.equal(result.statusCode, 409); assert.equal(result.json().code, "content_removed");
  const current = await h.app.inject({ url: `/api/library/catalog/${item.id}`, headers: h.own }); assert.equal(current.json().id, item.id); assert.equal(current.json().entity.contentState, "removed");
});

test("database failure rolls back metadata, lease and private rows and returns no partial identifiers", async (t) => {
  const h = await fixture(t); h.enable(); h.db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON library_item BEGIN SELECT RAISE(ABORT,'test failure'); END");
  const result = await h.save(); assert.equal(result.statusCode, 500); assert.deepEqual(result.json(), { code: "database_error" }); h.empty();
});

test("HTTP deadline cancels a non-cooperative detail wait and prevents its late response from writing", async (t) => {
  const h = await fixture(t); h.enable(); const held = await h.hold(); t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = h.save(), signal = await held.entered; t.mock.timers.tick(limits.deadlineMs);
  const result = await pending; assert.equal(result.statusCode, 504); assert.equal(result.json().code, "save_timeout"); assert.ok(signal.aborted);
  held.release(); await tick(); h.empty(); t.mock.timers.reset();
});

test("save HTTP deadline covers the initial authentication queue with no delayed writer or database access", async (t) => {
  const h = await fixture(t); h.enable(); const release = await acquireDatabase(h.db), scheduled = deferred<void>();
  t.mock.timers.enable({ apis: ["setTimeout"] }); const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => { const handle = schedule(callback, ms); if (ms === limits.deadlineMs) scheduled.resolve(); return handle; });
  const prepare = t.mock.method(h.db, "prepare"), writer = t.mock.method(h.product, "save");
  const pending = h.save(); await scheduled.promise; t.mock.timers.tick(limits.deadlineMs); assert.equal((await pending).statusCode, 504);
  const count = prepare.mock.callCount(); release(); await tick(); assert.equal(prepare.mock.callCount(), count); assert.equal(writer.mock.callCount(), 0); h.empty(); t.mock.timers.reset();
});

test("save HTTP deadline covers final authentication queues and queued commits remain cancelled", async (t) => {
  const h = await fixture(t); h.enable(); const held = await h.hold(); t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = h.save(); await held.entered; const release = await acquireDatabase(h.db); held.release(); await tick();
  t.mock.timers.tick(limits.deadlineMs); assert.equal((await pending).statusCode, 504); release(); await tick(); h.empty(); t.mock.timers.reset();
});

test("server shutdown cancels pending saves without late commits", async (t) => {
  const h = await fixture(t); h.enable(); const held = await h.hold(), pending = h.save(); const signal = await held.entered;
  const closing = h.app.close(); const result = await pending; assert.equal(result.statusCode, 503); assert.equal(result.json().code, "server_closing");
  assert.ok(signal.aborted); held.release(); await closing; await tick(); h.empty();
});

test("actual HTTP body completion permits saving and socket disconnection before commit cancels only that save", async (t) => {
  const h = await fixture(t); h.enable(); const held = await h.hold(), first = await h.wire(), signal = await held.entered;
  await tick(); assert.ok(!signal.aborted); held.release(); assert.equal((await first.received).status, 201); held.mock.mock.restore();
  const stopped = await h.hold(), second = await h.wire(), stoppedSignal = await stopped.entered;
  const aborted = new Promise<void>((resolve) => stoppedSignal.addEventListener("abort", () => resolve(), { once: true }));
  const before = h.db.prepare("SELECT * FROM catalog_observation").all(); second.client.destroy(); await aborted;
  stopped.release(); await tick(); assert.deepEqual(h.db.prepare("SELECT * FROM catalog_observation").all(), before);
});

test("a lost committed response is recoverable by explicit retry without new IDs or overwritten private content", async (t) => {
  const h = await fixture(t); h.enable(); h.gate.enabled = true; const client = await h.wire(); await h.gate.entered.promise;
  // Slow/lost response transmission must not retain the DB boundary.
  const rows = await h.app.inject({ url: "/api/library/catalog", headers: h.own }); const item = rows.json().items[0]; assert.ok(item);
  client.client.destroy(); await client.closed; h.gate.enabled = false; h.gate.release.resolve();
  const retry = await h.save(h.own, { ...h.request(), note: "not an overwrite" }); assert.equal(retry.statusCode, 200); assert.deepEqual(retry.json().item, item);
});


test("even an allowed live test profile exposes no selection and cannot reach the synthetic writer", async (t) => {
  const h = await fixture(t); h.enable(); h.policy.sampleKind = "live-capture";
  const live = createSourceSaveService(h.db, { auth: h.auth, clock: h.clock, sampleKind: "live-capture", policy: () => h.policy, detail: h.detail });
  t.mock.method(h.product, "selection", live.selection); t.mock.method(h.product, "save", live.save);
  const preview = await h.preview(); assert.deepEqual(preview.json().save, { status: "unavailable", code: "storage_unavailable" });
  const detail = t.mock.method(h.detail, "getAlbum"); const saved = await h.save(); assert.equal(saved.statusCode, 503);
  assert.deepEqual(saved.json(), { code: "storage_unavailable" }); assert.equal(detail.mock.callCount(), 0); h.empty();
});

test("save selection is recomputed after final detail checks, not retained from service completion", async (t) => {
  const h = await fixture(t); h.enable();
  const read = t.mock.method(h.productDetail, "getAlbum", async () => {
    const result = await h.detail.getAlbum(input); h.clock.time += 60000; return result;
  });
  const stale = await h.preview(); assert.equal(stale.json().save.status, "unavailable"); assert.ok(!stale.json().save.expectedFingerprint); read.mock.restore();
  h.clock.time -= 60000;
  t.mock.method(h.productDetail, "getAlbum", async () => {
    const result = await h.detail.getAlbum(input); h.policy.persistence = { status: "denied" }; return result;
  });
  const revoked = await h.preview(); assert.deepEqual(revoked.json().save, { status: "unavailable", code: "policy_disabled" }); h.empty();
});

test("an explicitly confirmed changed track list preserves existing Track IDs and reports review_required through HTTP", async (t) => {
  const h = await fixture(t); h.enable(); const first = await h.save(); assert.equal(first.statusCode, 201);
  const before = h.db.prepare("SELECT id FROM track ORDER BY position").all();
  h.clock.time += 1000; h.value.provenance.capturedAt = new Date(h.clock.now()).toISOString(); h.value.provenance.parsedAt = h.value.provenance.capturedAt;
  h.value.data.tracks.reverse(); h.value.data.tracks.forEach((row, i) => { row.position = i + 1; });
  const preview = await h.preview(), second = await h.save(h.own, { ...h.request(), expectedFingerprint: preview.json().save.expectedFingerprint });
  assert.equal(second.statusCode, 200); assert.equal(second.json().trackState, "review_required");
  assert.equal(second.json().item.id, first.json().item.id); assert.deepEqual(h.db.prepare("SELECT id FROM track ORDER BY position").all(), before);
});

test("saved-origin lookup requires an actual session and rejects unsafe or extra query fields", async (t) => {
  const h = await fixture(t), url = `/api/library/catalog/source-save?${new URLSearchParams(input)}`;
  assert.equal((await h.app.inject({ url, headers: base })).statusCode, 401);
  const { "x-loopshelf-session": ignored, ...missing } = h.own; void ignored;
  assert.equal((await h.app.inject({ url, headers: missing })).statusCode, 428);
  assert.equal((await h.app.inject({ url, headers: { ...h.other, "x-loopshelf-session": h.own["x-loopshelf-session"] } })).statusCode, 401);
  for (const query of ["", "sourceId=zophar&externalKey=../bad", `${new URLSearchParams(input)}&userId=${h.bob.id}`])
    assert.equal((await h.app.inject({ url: `/api/library/catalog/source-save?${query}`, headers: h.own })).statusCode, 400);
  const empty = await h.app.inject({ url, headers: h.own }); assert.deepEqual(empty.json(), { item: null }); noStore(empty);
  assert.equal(empty.headers["x-loopshelf-session"], h.own["x-loopshelf-session"]); h.empty();
});

test("saved-origin lookup returns only the current user's exact original album and survives content removal", async (t) => {
  const h = await fixture(t); h.enable(); const first = await h.save(h.own, { ...h.request(), note: "kept private" });
  const url = `/api/library/catalog/source-save?${new URLSearchParams(input)}`;
  const own = await h.app.inject({ url, headers: h.own }); assert.deepEqual(own.json().item, first.json().item);
  assert.deepEqual((await h.app.inject({ url, headers: h.other })).json(), { item: null });
  assert.deepEqual((await h.app.inject({ url: `${url}-other`, headers: h.own })).json(), { item: null });
  await new CatalogStore(h.db).removeSource({ sourceEntityId: first.json().item.entity.sourceEntityId, reason: "rights_request" });
  const removed = (await h.app.inject({ url, headers: h.own })).json().item; assert.equal(removed.id, first.json().item.id);
  assert.equal(removed.entity.contentState, "removed"); assert.equal(removed.note, "kept private");
});

test("saved-origin lookup never relinks an imported unresolved same-key reference", async (t) => {
  const h = await fixture(t); h.enable(); const first = (await h.save()).json().item;
  const { CatalogTransfer } = await import("../src/library/catalog-transfer.ts");
  const { randomUUID } = await import("node:crypto");
  const transfer = new CatalogTransfer(h.db, config.secret), archive = transfer.export(h.alice.id);
  new CatalogLibraryStore(h.db).delete(h.alice.id, first.id, { version: first.version });
  const item = archive.items[0]!; item.id = randomUUID(); item.reference.entityId = randomUUID(); item.reference.albumId = item.reference.entityId; item.reference.source.id = randomUUID();
  transfer.import(h.alice.id, archive, transfer.preview(h.alice.id, archive).token!);
  const url = `/api/library/catalog/source-save?${new URLSearchParams(input)}`;
  assert.deepEqual((await h.app.inject({ url, headers: h.own })).json(), { item: null });
  assert.equal(new CatalogLibraryStore(h.db).get(h.alice.id, item.id).entity.contentState, "unresolved");
});
