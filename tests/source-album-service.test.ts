import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CatalogStore } from "../src/catalog/store.ts";
import { acquireDatabase, withDatabase } from "../src/database/access.ts";
import { getSourceAlbumService } from "../src/source-album.ts";
import { SOURCE_ALBUM_LIMITS as limits } from "../src/source-album/service.ts";
import type { AdapterResult } from "../src/sources/adapters/contracts.ts";
import { createMetadataService } from "../src/sources/adapters/service.ts";
import { PARSER_VERSION, inspectCapturedPage } from "../src/sources/parsers.ts";
import { requestUrl } from "../src/sources/transport/requests.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { deferred, delivery, envelope, failure, fixture, input, tick } from "./helpers/source-album.ts";

test("source album preserves source title, repeated display numbers, unknown values and evidence without creating identities", async (t) => {
  const h = fixture(t), before = h.db.prepare("SELECT total_changes() AS n").get();
  const value = delivery(h.clock.now()); value.data.tracks[0]!.durationLabel = null; value.data.tracks[0]!.durationSeconds = null;
  value.data.sourceClaims = [{ label: "Developer", value: "[Synthetic] claimed developer" }];
  h.adapters.zophar.getAlbum = async () => value;
  const response = envelope(await h.service.getAlbum(input)); assert.equal(response.status, "complete"); assert.ok(response.result.ok);
  assert.deepEqual(response.result, value); assert.equal(response.ref.pageUrl, value.data.pageUrl);
  assert.deepEqual(response.result.data.tracks.map((r) => r.displayNumber), ["1", "2", "3", "1"]);
  assert.equal(response.result.data.playback, "unverified"); assert.equal(response.sampleKind, "synthetic");
  assert.deepEqual(h.db.prepare("SELECT total_changes() AS n").get(), before); assert.equal(h.clock.timers.size, 0);
});

test("source album accepts exact Unicode keys but rejects URL, traversal and injection inputs without reading adapters", async (t) => {
  const h = fixture(t);
  for (const bad of [null, {}, { ...input, externalKey: "" }, { ...input, externalKey: "../bad" }, { ...input, externalKey: "nes/a%2fb" },
    { ...input, externalKey: "https://attacker.test/a" }, { ...input, externalKey: "nes/a?b" }, { ...input, externalKey: "nes/a\\b" },
    { ...input, externalKey: "nes/\ud800" }, { ...input, externalKey: "x".repeat(1025) }, { ...input, sourceId: "unknown" },
    { ...input, url: "https://attacker.test" }, { ...input, sampleKind: "synthetic" }, { ...input, userId: "forged" }, { ...input, title: "search label" }])
    failure(await h.service.getAlbum(bad), "invalid_input");
  assert.equal(h.calls.length, 0); assert.equal(h.clock.timers.size, 0);
  h.adapters.zophar.getAlbum = async (key) => { const value = delivery(h.clock.now());
    value.data.externalKey = key; value.data.pageUrl = value.provenance.pageUrl = requestUrl({ ...input, externalKey: key, kind: "album" }).href; return value; };
  assert.ok(envelope(await h.service.getAlbum({ ...input, externalKey: "nes/ 星의 음악 " })).result.ok);
});

test("product detail stays policy-disabled without DNS, cache population or synthetic catalog exposure", async (t) => {
  const h = fixture(t); await new CatalogStore(h.db).ingestSynthetic(syntheticAlbum(1, 2));
  const dns = t.mock.method(Resolver.prototype, "resolve4", () => { throw new Error("No external network"); });
  const service = getSourceAlbumService(h.db); assert.equal(getSourceAlbumService(h.db), service);
  for (const request of [input, { sourceId: "khinsider", externalKey: "benchmark-00000" }]) {
    const response = envelope(await service.getAlbum(request)); failure(response.result, "policy_disabled");
    assert.equal(response.sampleKind, "live-capture"); assert.equal(response.status, "failed"); assert.ok(!JSON.stringify(response).includes("Synthetic"));
  }
  assert.equal(dns.mock.callCount(), 0); assert.deepEqual(h.db.prepare("SELECT * FROM source_metadata_cache").all(), []);
});

test("display and collection policy gates stop adapter calls before fetching", async (t) => {
  const h = fixture(t); h.policies.zophar.display = { allowed: false, code: "blocked" };
  failure(envelope(await h.service.getAlbum(input)).result, "blocked");
  h.policies.zophar.display = { allowed: true }; h.policies.zophar.collect = h.policies.zophar.cache = { allowed: false, code: "policy_disabled" };
  failure(envelope(await h.service.getAlbum(input)).result, "policy_disabled"); assert.equal(h.calls.length, 0);
});

test("failures remain failures, including unsupported detail, blocked, missing page, parser and rate limits", async (t) => {
  const h = fixture(t);
  for (const code of ["unsupported", "blocked", "not_found", "parse_changed", "rate_limited"] as const) {
    const expected = { ok: false as const, code, stage: "transport" as const, httpStatus: 429, retryAt: h.clock.now() + 3000 };
    h.adapters.zophar.getAlbum = async () => expected;
    const response = envelope(await h.service.getAlbum(input)); assert.deepEqual(response.result, expected); assert.equal(response.status, "failed");
  }
  h.adapters.zophar.getAlbum = async () => { throw new Error("Secret exception"); };
  failure(envelope(await h.service.getAlbum(input)).result, "source_error");
});

test("wrong source/key/sample/kind, empty track list, extra identity and playback fields never become album success", async (t) => {
  const h = fixture(t);
  const mutators = [
    (v: ReturnType<typeof delivery>) => { v.provenance.sampleKind = "live-capture"; },
    (v: ReturnType<typeof delivery>) => { v.provenance.sourceId = "khinsider"; },
    (v: ReturnType<typeof delivery>) => { v.data.externalKey = "nes/other"; },
    (v: ReturnType<typeof delivery>) => { v.provenance.pageUrl = "https://www.zophar.net/search?search=star"; },
    (v: ReturnType<typeof delivery>) => { v.data.tracks = []; },
    (v: ReturnType<typeof delivery>) => { Object.assign(v.data, { id: "invented-uuid" }); },
    (v: ReturnType<typeof delivery>) => { Object.assign(v.data.tracks[0]!, { audioUrl: "https://attacker.test/a.mp3" }); },
    (v: ReturnType<typeof delivery>) => { Object.assign(v.data, { kind: "search" }); },
  ];
  for (const change of mutators) { const value = delivery(h.clock.now()); change(value); h.adapters.zophar.getAlbum = async () => value;
    failure(envelope(await h.service.getAlbum(input)).result, "invalid_response"); }
});

test("delivery and failure fields are bounded validated data, not an escape for raw content or invalid cache age", async (t) => {
  const h = fixture(t);
  const values: unknown[] = [{ ok: false, code: "network_error", stage: "transport", html: "SECRET HTML" },
    { ok: false, code: "rate_limited", stage: "transport", retryAt: Infinity },
    { ...delivery(h.clock.now()), delivery: { from: "cache", freshness: "fresh", freshUntil: "bad", expiresAt: "bad" } },
    delivery(h.clock.now() + 1), { ...delivery(h.clock.now()), refreshFailure: { ok: false, code: "bad", stage: "transport" } }];
  for (const value of values) { h.adapters.zophar.getAlbum = async () => value as AdapterResult;
    failure(envelope(await h.service.getAlbum(input)).result, "invalid_response"); }
});

test("stale cache keeps capture evidence and refresh failure, without extending its lifetime", async (t) => {
  const h = fixture(t), value = delivery(h.clock.now() - 70_000); value.delivery.from = "cache";
  value.refreshFailure = { ok: false, code: "timeout", stage: "transport" }; h.adapters.zophar.getAlbum = async () => value;
  const response = envelope(await h.service.getAlbum(input)); assert.equal(response.status, "partial"); assert.ok(response.result.ok);
  assert.equal(response.result.delivery.freshness, "stale"); assert.equal(response.result.provenance.capturedAt, value.provenance.capturedAt);
  assert.equal(response.result.delivery.expiresAt, value.delivery.expiresAt); assert.deepEqual(response.result.refreshFailure, value.refreshFailure);
});

test("cache-only display is allowed but transport results require collection permission", async (t) => {
  const h = fixture(t); h.policies.zophar.collect = { allowed: false, code: "policy_disabled" };
  failure(envelope(await h.service.getAlbum(input)).result, "policy_disabled");
  h.adapters.zophar.getAlbum = async () => { const value = delivery(h.clock.now()); value.delivery.from = "cache"; return value; };
  assert.ok(envelope(await h.service.getAlbum(input)).result.ok);
  h.policies.zophar.collect = { allowed: true }; h.policies.zophar.cache = { allowed: false, code: "blocked" };
  failure(envelope(await h.service.getAlbum(input)).result, "blocked");
});

test("removal during a pending detail discards the held tracks; later requests do not call adapters", async (t) => {
  const h = fixture(t), catalog = new CatalogStore(h.db), [saved] = await catalog.ingestSynthetic(syntheticAlbum(1, 4));
  const waiting = deferred<AdapterResult>(), entered = deferred<void>();
  const spy = t.mock.method(h.adapters.zophar, "getAlbum", async () => { entered.resolve(); return waiting.promise; });
  const pending = h.service.getAlbum(input); await entered.promise;
  await catalog.removeSource({ sourceEntityId: saved!.sourceEntityId, reason: "rights_request" });
  waiting.resolve(delivery(h.clock.now())); failure(envelope(await pending).result, "content_removed");
  failure(envelope(await h.service.getAlbum(input)).result, "content_removed"); assert.equal(spy.mock.callCount(), 1);
});

test("held detail is rechecked for policy revisions, display/cache permissions, expiry and request context", async (t) => {
  const h = fixture(t), original = envelope(await h.service.getAlbum(input));
  await withDatabase(h.db, async () => {
    for (const changed of [{ ...h.policies.zophar, revision: "v2" }, { ...h.policies.zophar, display: { allowed: false as const, code: "blocked" as const } }]) {
      const before = h.policies.zophar; h.policies.zophar = changed;
      failure(envelope(h.service.recheck(input, original)).result, changed.display.allowed ? "policy_changed" : "blocked"); h.policies.zophar = before;
    }
    assert.throws(() => h.service.recheck({ ...input, externalKey: "nes/other" }, original));
    assert.throws(() => h.service.recheck(input, { ...original, sampleKind: "live-capture" }));
    const changed = structuredClone(original); if (changed.result.ok) changed.result.data.externalKey = "nes/other";
    failure(envelope(h.service.recheck(input, changed)).result, "invalid_response");
  });
  await h.clock.advance(120_000);
  failure(envelope(await withDatabase(h.db, async () => h.service.recheck(input, original))).result, "result_expired");
  assert.equal(h.calls.length, 1);
});

test("a final database error cannot return the held album as a success", async (t) => {
  const h = fixture(t), original = envelope(await h.service.getAlbum(input));
  const spy = t.mock.method(h.db, "prepare", () => { throw new Error("Private SQLite error"); });
  failure(envelope(await withDatabase(h.db, async () => h.service.recheck(input, original))).result, "database_error"); spy.mock.restore();
});

test("pre-cancellation and cancellation during a slow adapter return no metadata, ignoring late replies", async (t) => {
  const h = fixture(t), aborted = new AbortController(); aborted.abort(); failure(await h.service.getAlbum(input, aborted.signal), "cancelled");
  assert.equal(h.calls.length, 0);
  const waiting = deferred<AdapterResult>(), entered = deferred<AbortSignal>();
  h.adapters.zophar.getAlbum = async (_key, signal) => { entered.resolve(signal!); return waiting.promise; };
  const controller = new AbortController(), pending = h.service.getAlbum(input, controller.signal), signal = await entered.promise;
  controller.abort(); failure(await pending, "cancelled"); assert.ok(signal.aborted);
  waiting.resolve(delivery(h.clock.now())); await tick(); assert.equal(h.clock.timers.size, 0);
  assert.equal((h.db.prepare("SELECT count(*) AS n FROM source_metadata_cache").get() as { n: number }).n, 0);
});

test("source budget cancels a non-cooperative adapter and returns explicit timeout", async (t) => {
  const h = fixture(t), entered = deferred<AbortSignal>();
  h.adapters.zophar.getAlbum = async (_key, signal) => { entered.resolve(signal!); return new Promise(() => {}); };
  const pending = h.service.getAlbum(input), signal = await entered.promise; await h.clock.advance(limits.sourceBudgetMs);
  const response = envelope(await pending); failure(response.result, "timeout"); assert.equal(response.termination, "deadline"); assert.ok(signal.aborted);
  assert.equal(response.elapsedMs, limits.sourceBudgetMs); assert.equal(h.clock.timers.size, 0);
});

test("initial and final database queues are bounded; late queued work cannot access metadata", async (t) => {
  const h = fixture(t), release = await acquireDatabase(h.db), prepare = t.mock.method(h.db, "prepare");
  const pending = h.service.getAlbum(input); await h.clock.advance(limits.deadlineMs);
  failure(envelope(await pending).result, "timeout"); release(); await tick(); assert.equal(prepare.mock.callCount(), 0); prepare.mock.restore();
  const entered = deferred<void>(); let unlock = () => {};
  h.adapters.zophar.getAlbum = async () => { unlock = await acquireDatabase(h.db); entered.resolve(); return delivery(h.clock.now()); };
  const final = h.service.getAlbum(input); await entered.promise; await h.clock.advance(limits.deadlineMs);
  failure(envelope(await final).result, "timeout"); const spy = t.mock.method(h.db, "prepare"); unlock(); await tick(); assert.equal(spy.mock.callCount(), 0);
});

test("admission bounds internal album reads and releases slots after cancellation", async (t) => {
  const h = fixture(t), controllers = Array.from({ length: limits.maxActive }, () => new AbortController());
  h.adapters.zophar.getAlbum = async () => new Promise(() => {});
  const pending = controllers.map((c) => h.service.getAlbum(input, c.signal));
  failure(await h.service.getAlbum(input), "queue_full"); controllers.forEach((c) => c.abort());
  for (const result of await Promise.all(pending)) failure(result, "cancelled");
  h.adapters.zophar.getAlbum = async () => delivery(h.clock.now()); assert.ok(envelope(await h.service.getAlbum(input)).result.ok);
});

test("real offline Adapter parses and caches detail; KHInsider still returns unsupported under allowed test policy", async (t) => {
  const h = fixture(t); let calls = 0;
  const metadata = createMetadataService(h.db, { sampleKind: "synthetic", clock: h.clock, policy: (source) => h.policies[source],
    parser: { version: PARSER_VERSION, parse: inspectCapturedPage }, capture: async (request) => { calls++; return { ok: true, page: {
      sourceId: request.sourceId, kind: "album", url: requestUrl(request).href, capturedAt: new Date(h.clock.now()).toISOString(), sampleKind: "synthetic",
      status: 200, headers: { "content-type": "text/html" }, html: readFileSync(new URL("./fixtures/zophar-album.html", import.meta.url), "utf8") } }; } });
  for (const id of ["khinsider", "zophar"] as const) h.adapters[id].getAlbum = (externalKey, signal) => metadata.get({ sourceId: id, externalKey, kind: "album" }, signal);
  const live = envelope(await h.service.getAlbum(input)); assert.ok(live.result.ok); assert.equal(live.result.delivery.from, "transport");
  const cached = envelope(await h.service.getAlbum(input)); assert.ok(cached.result.ok); assert.equal(cached.result.delivery.from, "cache"); assert.equal(calls, 1);
  failure(envelope(await h.service.getAlbum({ sourceId: "khinsider", externalKey: "album" })).result, "unsupported"); assert.equal(calls, 1);
  assert.equal((h.db.prepare("SELECT count(*) AS n FROM album").get() as { n: number }).n, 0);
  h.policies.zophar.display = { allowed: false, code: "policy_disabled" };
  failure(envelope(await h.service.getAlbum(input)).result, "policy_disabled");
  assert.deepEqual(h.db.prepare("SELECT * FROM source_metadata_cache").all(), []); assert.equal(calls, 1);
});

test("detail callers share Adapter work; cancelling one keeps the other, cancelling the last prevents late cache writes", async (t) => {
  const h = fixture(t); let count = 0, entered = deferred<AbortSignal>(), release = deferred<void>();
  const metadata = createMetadataService(h.db, { sampleKind: "synthetic", clock: h.clock, policy: (id) => h.policies[id],
    parser: { version: PARSER_VERSION, parse: inspectCapturedPage }, capture: async (request, signal) => {
      count++; entered.resolve(signal); await release.promise;
      return { ok: true, page: { sourceId: request.sourceId, kind: "album", url: requestUrl(request).href,
        capturedAt: new Date(h.clock.now()).toISOString(), sampleKind: "synthetic", status: 200, headers: { "content-type": "text/html" },
        html: readFileSync(new URL("./fixtures/zophar-album.html", import.meta.url), "utf8") } };
    } });
  h.adapters.zophar.getAlbum = (externalKey, signal) => metadata.get({ sourceId: "zophar", externalKey, kind: "album" }, signal);
  const controller = new AbortController(), first = h.service.getAlbum(input, controller.signal), shared = await entered.promise;
  const second = h.service.getAlbum(input); await tick(); controller.abort(); failure(await first, "cancelled"); assert.ok(!shared.aborted);
  release.resolve(); assert.ok(envelope(await second).result.ok); assert.equal(count, 1);
  entered = deferred<AbortSignal>(); release = deferred<void>();
  const last = new AbortController(), pending = h.service.getAlbum({ ...input, externalKey: "nes/late" }, last.signal), signal = await entered.promise;
  last.abort(); failure(await pending, "cancelled"); assert.ok(signal.aborted); release.resolve(); await tick();
  assert.equal((h.db.prepare("SELECT count(*) AS n FROM source_metadata_cache").get() as { n: number }).n, 1);
  assert.equal((h.db.prepare("SELECT count(*) AS n FROM source_metadata_cache WHERE request_key='nes/late'").get() as { n: number }).n, 0);
});
