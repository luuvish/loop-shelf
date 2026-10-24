import assert from "node:assert/strict";
import { test as nodeTest, type TestContext } from "node:test";
import { betterAuth } from "better-auth";
import { createAccount, resetAccountPassword } from "../src/auth/accounts.ts";
import { authOptions } from "../src/auth/options.ts";
import { reconcileCatalogRetention } from "../src/catalog/retention.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { acquireDatabase, withDatabase } from "../src/database/access.ts";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { verifyDatabase } from "../src/database/backup.ts";
import { createSourceAlbumService } from "../src/source-album/service.ts";
import { createSourceAlbumSaveService } from "../src/source-save.ts";
import { createSourceSaveService, SOURCE_SAVE_LIMITS } from "../src/source-save/service.ts";
import { admitSourceAlbum, parseSourceSaveInput, sourceDetailFingerprint, SourceSaveError, type CatalogAdmissionPolicy } from "../src/source-save/admission.ts";
import { catalogAdmissionPolicy } from "../src/source-save/policy.ts";
import { commitSyntheticSourceSave } from "../src/source-save/persistence.ts";
import type { SourceAlbumResult, SourceAlbumResponse } from "../src/shared/source-album.ts";
import { Clock, allowed, deferred, delivery, envelope, failure, input, tick } from "./helpers/source-album.ts";

const config = { baseURL: "http://127.0.0.1:3000", secret: "source-save-internal-tests-secret-at-least-32-characters" };
const password = "source-save-test-password-123";
const test = (name: string, action: (t: TestContext) => Promise<void>) => nodeTest(name, { timeout: 10000 }, action);
const tables = ["entity", "album", "track", "source_entity", "assertion", "catalog_album_state", "catalog_observation", "catalog_track_origin", "catalog_track_binding", "catalog_source_kind", "library_item"];
async function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const alice = await createAccount(db, config, { name: "Alice", email: "alice@example.test", password });
  const bob = await createAccount(db, config, { name: "Bob", email: "bob@example.test", password });
  const auth = betterAuth(authOptions(db, config)); await auth.$context;
  async function login(email = alice.email) {
    return withDatabase(db, async () => {
      const response = await auth.handler(new Request(`${config.baseURL}/api/auth/sign-in/email`, { method: "POST",
        headers: { origin: config.baseURL, "content-type": "application/json", "x-loopshelf-client-ip": "127.0.0.1" }, body: JSON.stringify({ email, password }) }));
      assert.equal(response.status, 200);
      const headers = new Headers({ cookie: response.headers.getSetCookie().map((c) => c.split(";", 1)[0]).join("; ") });
      const session = await auth.api.getSession({ headers }); assert.ok(session);
      headers.set("x-loopshelf-session", session.session.id); return headers;
    });
  }
  const own = await login(), other = await login(bob.email), clock = new Clock(), metadataPolicy = allowed();
  clock.time = Date.now() - 5000; // Recent captures remain valid when the test clock advances independently.
  const value = delivery(clock.now());
  value.data.tracks[0]!.durationSeconds = null; value.data.tracks[0]!.durationLabel = null;
  const policy: CatalogAdmissionPolicy = { sourceId: "zophar", sampleKind: "synthetic", revision: "synthetic-catalog-rule-v1",
    metadataRevision: metadataPolicy.revision, parserVersion: value.provenance.parserVersion,
    persistence: { status: "allowed", reviewedAt: "2026-10-23T00:00:00Z", evidence: ["synthetic offline test only"], maxRetentionMs: 120000 } };
  const adapter = { getAlbum: async () => structuredClone(value) };
  const detail = createSourceAlbumService(db, { sampleKind: "synthetic", clock, policy: () => metadataPolicy, adapters: { khinsider: adapter, zophar: adapter } });
  const deps = { auth, clock, sampleKind: "synthetic" as const, policy: () => policy, detail };
  const service = createSourceSaveService(db, deps);
  const request = () => ({ ...input, expectedFingerprint: sourceDetailFingerprint(value) });
  const snapshot = () => tables.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
  const empty = () => { for (const name of tables) assert.equal((db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n, 0, name); };
  async function hold() {
    const response = await detail.getAlbum(input), entered = deferred<void>(), waiting = deferred<SourceAlbumResult>();
    const mock = t.mock.method(detail, "getAlbum", async () => { entered.resolve(); return waiting.promise; });
    return { response, entered: entered.promise, release: () => waiting.resolve(response), mock };
  }
  return { db, auth, own, other, login, alice, bob, clock, metadataPolicy, value, policy, detail, deps, service, request, snapshot, empty, hold };
}
function success(value: Awaited<ReturnType<ReturnType<typeof createSourceSaveService>["save"]>>) { assert.ok(value.ok, JSON.stringify(value)); return value; }
function errorCode(code: SourceSaveError["code"]) { return (e: unknown) => e instanceof SourceSaveError && e.code === code; }

test("product catalog permission is separate and remains closed before any detail read or write", async (t) => {
  const h = await fixture(t), product = createSourceAlbumSaveService(h.db, h.auth);
  assert.equal(catalogAdmissionPolicy("zophar").persistence.status, "unknown");
  failure(await product.save(h.request(), h.own), "policy_disabled"); h.empty();
  h.policy.persistence = { status: "unknown" };
  const spy = t.mock.method(h.detail, "getAlbum"); failure(await h.service.save(h.request(), h.own), "policy_disabled");
  assert.equal(spy.mock.callCount(), 0); h.empty();
});

test("an allowed live profile still cannot enter synthetic storage or relabel live data", async (t) => {
  const h = await fixture(t); h.policy.sampleKind = "live-capture";
  const service = createSourceSaveService(h.db, { ...h.deps, sampleKind: "live-capture" });
  const spy = t.mock.method(h.detail, "getAlbum"); failure(await service.save(h.request(), h.own), "storage_unavailable");
  assert.equal(spy.mock.callCount(), 0); h.policy.sampleKind = "synthetic";
  const response = envelope(await h.detail.getAlbum(input)); assert.ok(response.result.ok);
  response.sampleKind = "live-capture"; response.result.provenance.sampleKind = "live-capture";
  assert.throws(() => admitSourceAlbum(parseSourceSaveInput(h.request()), response, h.policy, h.clock.now()), errorCode("invalid_response")); h.empty();
});

test("input admits only explicit source keys, observation precondition and private fields", async (t) => {
  const h = await fixture(t), original = h.request();
  for (const bad of [{ ...original, userId: h.bob.id }, { ...original, sampleKind: "synthetic" }, { ...original, data: h.value.data },
    { ...original, pageUrl: h.value.data.pageUrl }, { ...original, externalKey: "../secret" }, { ...original, expectedFingerprint: "" },
    { ...original, titleOverride: h.value.data.title.repeat(400) }, { ...original, note: "한".repeat(10000) + "더" }]) {
    failure(await h.service.save(bad, h.own), "invalid_input");
  }
  h.empty();
});

test("actual cookie and session precondition are mandatory, and request fields are snapshotted", async (t) => {
  const h = await fixture(t);
  for (const [headers, code] of [[new Headers(), "unauthorized"], [new Headers({ cookie: "better-auth.session_token=forged" }), "unauthorized"],
    [new Headers({ cookie: h.own.get("cookie")! }), "session_required"], [new Headers({ cookie: h.own.get("cookie")!, "x-loopshelf-session": "wrong" }), "session_changed"]] as const)
    failure(await h.service.save(h.request(), headers), code);
  const unlock = await acquireDatabase(h.db), request = { ...h.request(), note: "original" }, headers = new Headers(h.own);
  const saving = h.service.save(request, headers); request.note = "mutated"; headers.set("cookie", h.other.get("cookie")!); unlock();
  const result = success(await saving); assert.equal(result.item.note, "original");
  assert.equal(new CatalogLibraryStore(h.db).list(h.bob.id).items.length, 0);
});

test("atomic detail ingestion and personal save preserve repeated rows, unknown lengths and explicit private content", async (t) => {
  const h = await fixture(t), first = success(await h.service.save({ ...h.request(), note: "my note", favorite: true }, h.own));
  assert.equal(first.created, true); assert.equal(first.sampleKind, "synthetic"); assert.equal(first.item.titleOverride, null);
  const catalog = await new CatalogStore(h.db).getAlbum(first.item.entity.id);
  assert.equal(catalog.tracks.length, 4); assert.equal(new Set(catalog.tracks.map((v) => v.id)).size, 4);
  assert.equal(catalog.tracks[0]!.displayNumber, catalog.tracks[3]!.displayNumber); assert.equal(catalog.tracks[0]!.durationMs, null);
  assert.equal(first.item.note, "my note");
  const again = success(await h.service.save({ ...h.request(), note: "must not overwrite", titleOverride: "Other" }, h.own));
  assert.equal(again.created, false); assert.deepEqual(again.item, first.item); assert.equal(again.observationId, first.observationId);
  verifyDatabase(h.db);
});

test("simultaneous saves share catalog identity while two real accounts keep private IDs and ownership", async (t) => {
  const h = await fixture(t), results = await Promise.all([h.service.save(h.request(), h.own), h.service.save(h.request(), h.own), h.service.save(h.request(), h.other)]);
  const [a, again, b] = results.map(success); assert.ok(a && again && b);
  assert.equal(a.item.id, again.item.id); assert.notEqual(a.item.id, b.item.id); assert.equal(a.item.entity.id, b.item.entity.id);
  assert.throws(() => new CatalogLibraryStore(h.db).get(h.bob.id, a.item.id));
  assert.equal(new CatalogLibraryStore(h.db).list(h.alice.id).items.length, 1); verifyDatabase(h.db);
});

test("changed keyless tracks become a review observation without rebinding saved track or album UUIDs", async (t) => {
  const h = await fixture(t), first = success(await h.service.save(h.request(), h.own)), store = new CatalogStore(h.db);
  const before = await store.getAlbum(first.item.entity.id);
  const trackSave = await withDatabase(h.db, async () => new CatalogLibraryStore(h.db).create(h.alice.id, { entityId: before.tracks[0]!.id, note: "keep this version" }));
  await h.clock.advance(1000); h.value.provenance.capturedAt = new Date(h.clock.now()).toISOString(); h.value.provenance.parsedAt = h.value.provenance.capturedAt;
  h.value.data.tracks[0]!.title = "Different version";
  const result = success(await h.service.save(h.request(), h.own));
  assert.equal(result.item.id, first.item.id); assert.equal(result.trackState, "review_required");
  assert.deepEqual((await store.getAlbum(before.id)).tracks, before.tracks);
  assert.deepEqual(new CatalogLibraryStore(h.db).get(h.alice.id, trackSave.item.id), trackSave.item);
});

test("a changed observation must be selected again and cannot create catalog rows", async (t) => {
  const h = await fixture(t), request = h.request(); h.value.data.title = "Changed after the selection";
  failure(await h.service.save(request, h.own), "snapshot_changed"); h.empty();
});

test("past detail cannot silently save a newer shared title or regress the selected baseline", async (t) => {
  const h = await fixture(t), newer = structuredClone(h.value); newer.provenance.capturedAt = new Date(h.clock.now() + 1000).toISOString();
  newer.provenance.parsedAt = newer.provenance.capturedAt; newer.data.title = "New shared title";
  const { delivery: _d, ...dto } = newer; await new CatalogStore(h.db).ingestSynthetic(dto); await h.clock.advance(1001);
  const before = h.snapshot(); failure(await h.service.save(h.request(), h.own), "snapshot_changed"); assert.deepEqual(h.snapshot(), before);
});

test("stale data, refresh failure, parser mismatch and expired retention do not authorize persistence", async (t) => {
  const h = await fixture(t), base = envelope(await h.detail.getAlbum(input)), request = parseSourceSaveInput(h.request());
  const cases: [SourceSaveError["code"], (v: SourceAlbumResponse) => void][] = [
    ["refresh_required", (v) => { if (v.result.ok) v.result.delivery.freshness = "stale"; }],
    ["refresh_required", (v) => { if (v.result.ok) v.result.refreshFailure = { ok: false, code: "network_error", stage: "transport" }; }],
    ["invalid_response", (v) => { if (v.result.ok) v.result.provenance.parserVersion = "other"; }],
    ["policy_changed", (v) => { v.policy.revision = "other"; }],
    ["policy_disabled", (v) => { v.policy.cache = { allowed: false, code: "policy_disabled" }; }],
    ["invalid_response", (v) => { if (v.result.ok) v.result.data.externalKey = "nes/other"; }],
  ];
  for (const [code, mutate] of cases) { const value = structuredClone(base); mutate(value); assert.throws(() => admitSourceAlbum(request, value, h.policy, h.clock.now()), errorCode(code)); }
  const limited = structuredClone(h.policy); assert.equal(limited.persistence.status, "allowed");
  if (limited.persistence.status === "allowed") limited.persistence.maxRetentionMs = 500;
  assert.equal(admitSourceAlbum(request, base, limited, h.clock.now()).retainUntil, new Date(h.clock.now() + 500).toISOString());
  assert.throws(() => admitSourceAlbum(request, base, limited, h.clock.now() + 500), errorCode("result_expired")); h.empty();
});

test("incomplete catalog permission evidence and future review dates stay closed", async (t) => {
  const h = await fixture(t); assert.ok(h.policy.persistence.status === "allowed");
  const original = structuredClone(h.policy.persistence);
  for (const change of [{ evidence: [] }, { reviewedAt: "2099-01-01T00:00:00Z" }, { maxRetentionMs: 0 }, { maxRetentionMs: 31 * 86400_000 }]) {
    h.policy.persistence = { ...original, ...change }; failure(await h.service.save(h.request(), h.own), "policy_disabled"); h.empty();
  }
});

test("policy changes while waiting invalidate the save even when all permission flags remain allowed", async (t) => {
  const h = await fixture(t), held = await h.hold(), saving = h.service.save(h.request(), h.own);
  await held.entered; h.policy.revision = "changed"; held.release(); failure(await saving, "policy_changed"); h.empty();
  held.mock.mock.restore();
  const again = await h.hold(), next = h.service.save(h.request(), h.own); await again.entered;
  assert.ok(h.policy.persistence.status === "allowed"); h.policy.persistence.maxRetentionMs = 110000; // Same revision, different rule.
  again.release(); failure(await next, "policy_changed"); h.empty();
});

test("removal during detail wait prevents resurrection and retains existing personal content", async (t) => {
  const h = await fixture(t), first = success(await h.service.save({ ...h.request(), titleOverride: "Private title", note: "keep" }, h.own));
  const held = await h.hold(), saving = h.service.save(h.request(), h.own); await held.entered;
  await new CatalogStore(h.db).removeSource({ sourceEntityId: first.item.entity.sourceEntityId, reason: "rights_request" });
  held.release(); failure(await saving, "content_removed");
  const kept = new CatalogLibraryStore(h.db).get(h.alice.id, first.item.id);
  assert.equal(kept.title, "Private title"); assert.equal(kept.note, "keep"); assert.equal(kept.entity.contentState, "removed");
});

test("source failures never become empty successful albums or personal saves", async (t) => {
  const h = await fixture(t), response = envelope(await h.detail.getAlbum(input));
  response.result = { ok: false, code: "parse_changed", stage: "parser" }; response.status = "failed";
  t.mock.method(h.detail, "getAlbum", async () => response);
  failure(await h.service.save(h.request(), h.own), "source_error"); h.empty();
});

test("a private write failure rolls back newly allocated catalog IDs and observations", async (t) => {
  const h = await fixture(t); h.db.exec("CREATE TRIGGER fail_test_save BEFORE INSERT ON library_item BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
  failure(await h.service.save(h.request(), h.own), "database_error"); h.empty();
  h.db.exec("DROP TRIGGER fail_test_save"); success(await h.service.save(h.request(), h.own)); verifyDatabase(h.db);
});

test("failed save by a second account rolls back refreshed shared metadata and preserves the first library", async (t) => {
  const h = await fixture(t), first = success(await h.service.save({ ...h.request(), note: "unchanged private text" }, h.own));
  const before = h.snapshot(); await h.clock.advance(1000);
  h.value.provenance.capturedAt = new Date(h.clock.now()).toISOString(); h.value.provenance.parsedAt = h.value.provenance.capturedAt;
  h.value.data.title = "New title that must roll back";
  h.db.exec("CREATE TRIGGER fail_second_save BEFORE INSERT ON library_item BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  failure(await h.service.save(h.request(), h.other), "database_error"); assert.deepEqual(h.snapshot(), before);
  assert.deepEqual(new CatalogLibraryStore(h.db).get(h.alice.id, first.item.id), first.item); verifyDatabase(h.db);
});

test("post-write expiration rolls back catalog changes and personal rows", async (t) => {
  const h = await fixture(t), response = envelope(await h.detail.getAlbum(input)), request = parseSourceSaveInput(h.request());
  const admitted = admitSourceAlbum(request, response, h.policy, h.clock.now()); let checks = 0;
  await assert.rejects(withDatabase(h.db, async () => commitSyntheticSourceSave(h.db, h.alice.id, request, admitted, () => {
    if (++checks === 2) throw new SourceSaveError("result_expired");
  })), errorCode("result_expired")); h.empty();
  assert.throws(() => new CatalogStore(h.db).ingestSyntheticInTransaction(admitted.metadata), /transaction/u);
});

test("network wait releases the database and real logout prevents any final save", async (t) => {
  const h = await fixture(t), held = await h.hold(), saving = h.service.save(h.request(), h.own); await held.entered;
  await withDatabase(h.db, async () => { await h.auth.api.signOut({ headers: h.own }); });
  held.release(); failure(await saving, "unauthorized"); h.empty();
});

test("a different actual session at final authentication cannot select another account as the owner", async (t) => {
  const h = await fixture(t), original = h.auth.api.getSession; let calls = 0;
  t.mock.method(h.auth.api, "getSession", (options: { headers: Headers }) => original(++calls === 2 ? { headers: h.other } : options));
  failure(await h.service.save(h.request(), h.own), "session_changed"); h.empty();
});

test("password reset revokes the waiting session, but another still-valid login does not revoke it", async (t) => {
  const h = await fixture(t), held = await h.hold(), saving = h.service.save(h.request(), h.own); await held.entered;
  await h.login(h.bob.email); held.release(); success(await saving); held.mock.mock.restore();
  const next = await h.hold(), pending = h.service.save(h.request(), h.own); await next.entered;
  await resetAccountPassword(h.db, config, { email: h.alice.email, password: "another-test-password-123" });
  const before = h.snapshot(); next.release(); failure(await pending, "unauthorized"); assert.deepEqual(h.snapshot(), before);
});

test("policy withdrawal while final authentication waits cannot commit a held album", async (t) => {
  const h = await fixture(t), entered = deferred<void>(), release = deferred<void>(), original = h.auth.api.getSession; let calls = 0;
  t.mock.method(h.auth.api, "getSession", async (options: { headers: Headers }) => {
    const session = await original(options); if (++calls === 2) { entered.resolve(); await release.promise; } return session;
  });
  const saving = h.service.save(h.request(), h.own); await entered.promise;
  h.policy.persistence = { status: "denied" }; release.resolve(); failure(await saving, "policy_disabled"); h.empty();
});

test("cancellation during source or database wait discards late replies and queued writes", async (t) => {
  const h = await fixture(t), held = await h.hold(), controller = new AbortController();
  const saving = h.service.save(h.request(), h.own, controller.signal); await held.entered; controller.abort();
  failure(await saving, "cancelled"); held.release(); await tick(); h.empty(); held.mock.mock.restore();
  const unlock = await acquireDatabase(h.db), next = new AbortController(), queued = h.service.save(h.request(), h.own, next.signal);
  next.abort(); failure(await queued, "cancelled"); unlock(); await tick(); h.empty();
});

test("total deadline covers initial authentication and source waits without late persistence", async (t) => {
  const h = await fixture(t), held = await h.hold(), saving = h.service.save(h.request(), h.own); await held.entered;
  await h.clock.advance(12000); failure(await saving, "timeout"); held.release(); await tick(); h.empty();
  const unlock = await acquireDatabase(h.db), queued = h.service.save(h.request(), h.own);
  await h.clock.advance(12000); failure(await queued, "timeout"); unlock(); await tick(); h.empty();
});

test("retention is measured from capture and can expire during final authentication", async (t) => {
  const h = await fixture(t); assert.ok(h.policy.persistence.status === "allowed"); h.policy.persistence.maxRetentionMs = 500;
  const entered = deferred<void>(), release = deferred<void>(), original = h.auth.api.getSession; let calls = 0;
  t.mock.method(h.auth.api, "getSession", async (options: { headers: Headers }) => {
    const result = await original(options); if (++calls === 2) { entered.resolve(); await release.promise; } return result;
  });
  const saving = h.service.save(h.request(), h.own); await entered.promise; await h.clock.advance(500); release.resolve();
  failure(await saving, "result_expired"); h.empty();
});

test("the final authentication wait has the same total deadline and cannot write after timeout", async (t) => {
  const h = await fixture(t), entered = deferred<void>(), release = deferred<void>(), original = h.auth.api.getSession; let calls = 0;
  t.mock.method(h.auth.api, "getSession", async (options: { headers: Headers }) => {
    const result = await original(options); if (++calls === 2) { entered.resolve(); await release.promise; } return result;
  });
  const saving = h.service.save(h.request(), h.own); await entered.promise; await h.clock.advance(12000);
  failure(await saving, "timeout"); release.resolve(); await tick(); h.empty();
});

test("expired real sessions are rechecked after the detail wait", async (t) => {
  const h = await fixture(t), held = await h.hold(), saving = h.service.save(h.request(), h.own); await held.entered;
  await withDatabase(h.db, async () => { h.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(new Date(0).toISOString(), h.own.get("x-loopshelf-session")); });
  held.release(); failure(await saving, "unauthorized"); h.empty();
});

test("bounded active saves reject excess work and release slots after cancellation", async (t) => {
  const h = await fixture(t), unlock = await acquireDatabase(h.db), controller = new AbortController();
  const requests = Array.from({ length: SOURCE_SAVE_LIMITS.maxActive }, () => h.service.save(h.request(), h.own, controller.signal));
  failure(await h.service.save(h.request(), h.own), "queue_full"); controller.abort();
  for (const result of await Promise.all(requests)) failure(result, "cancelled"); unlock(); await tick();
  success(await h.service.save(h.request(), h.own)); verifyDatabase(h.db);
});

test("admitted source saves persist the original policy and capture deadline; retries never renew them", async (t) => {
  const h = await fixture(t), result = success(await h.service.save(h.request(), h.own));
  const lease = h.db.prepare("SELECT retention_revision,expires_at,sample_kind FROM catalog_observation WHERE id=?").get(result.observationId);
  assert.deepEqual(lease, { retention_revision: h.policy.revision, expires_at: h.value.delivery.expiresAt, sample_kind: "synthetic" });
  await h.clock.advance(1000);
  const again = success(await h.service.save(h.request(), h.own)); assert.equal(again.observationId, result.observationId);
  assert.deepEqual(h.db.prepare("SELECT retention_revision,expires_at,sample_kind FROM catalog_observation WHERE id=?").get(result.observationId), lease);
  const before = h.snapshot(); assert.ok(h.policy.persistence.status === "allowed"); h.policy.persistence.maxRetentionMs = 30000;
  failure(await h.service.save(h.request(), h.own), "catalog_unavailable"); assert.deepEqual(h.snapshot(), before);
});

test("expired baseline stays review-required after a fresh source save with an identical keyless list", async (t) => {
  const h = await fixture(t), first = success(await h.service.save(h.request(), h.own));
  const initial = await new CatalogStore(h.db).getAlbum(first.item.entity.id);
  await withDatabase(h.db, async () => reconcileCatalogRetention(h.db, Date.parse(h.value.delivery.expiresAt)));
  await h.clock.advance(1000); h.value.provenance.capturedAt = new Date(h.clock.now()).toISOString(); h.value.provenance.parsedAt = h.value.provenance.capturedAt;
  const next = success(await h.service.save(h.request(), h.own)); assert.equal(next.item.id, first.item.id); assert.equal(next.trackState, "review_required");
  const album = await new CatalogStore(h.db).getAlbum(first.item.entity.id); assert.equal(album.id, initial.id); assert.deepEqual(album.tracks, []);
  assert.deepEqual(h.db.prepare("SELECT id FROM track ORDER BY position").all(), initial.tracks.map((track) => ({ id: track.id })));
});

test("personal JSON cannot restore an admitted lease or external metadata after expiry", async (t) => {
  const h = await fixture(t), saved = success(await h.service.save({ ...h.request(), note: "keep me" }, h.own));
  const { CatalogTransfer } = await import("../src/library/catalog-transfer.ts");
  const transfer = new CatalogTransfer(h.db, config.secret), archive = transfer.export(h.alice.id);
  await withDatabase(h.db, async () => reconcileCatalogRetention(h.db, Date.parse(h.value.delivery.expiresAt)));
  const library = new CatalogLibraryStore(h.db); library.delete(h.alice.id, saved.item.id, { version: saved.item.version });
  transfer.import(h.alice.id, archive, transfer.preview(h.alice.id, archive).token!);
  const restored = library.get(h.alice.id, saved.item.id);
  assert.equal(restored.entity.id, saved.item.entity.id); assert.equal(restored.entity.contentState, "expired"); assert.equal(restored.note, "keep me");
  assert.equal((h.db.prepare("SELECT data_json FROM catalog_observation WHERE id=?").get(saved.observationId) as { data_json: string }).data_json, "{}");
});
