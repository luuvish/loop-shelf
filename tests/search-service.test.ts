import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { CatalogStore } from "../src/catalog/store.ts";
import type { CatalogIngestedAlbum } from "../src/catalog/types.ts";
import { acquireDatabase, withDatabase } from "../src/database/access.ts";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { getSearchService } from "../src/search.ts";
import { readLocalAlbums } from "../src/search/local.ts";
import { createSearchService, SEARCH_LIMITS } from "../src/search/service.ts";
import type { SearchResult, SearchResponse, SearchDelivery } from "../src/shared/search.ts";
import type { SourceAdapter } from "../src/sources/adapters.ts";
import type { AdapterResult, MetadataPolicy } from "../src/sources/adapters/contracts.ts";
import { createMetadataService } from "../src/sources/adapters/service.ts";
import { inspectCapturedPage, PARSER_VERSION } from "../src/sources/parsers.ts";
import { requestUrl } from "../src/sources/transport/requests.ts";
import type { TransportClock, TransportResult } from "../src/sources/transport/contracts.ts";
import type { SourceId } from "../src/sources/types.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { queryPlans } from "../scripts/benchmarks/query-plans.ts";

const tick = () => setImmediate();
class Clock implements TransportClock {
  time = Date.parse("2026-10-24T01:00:00Z");
  timers = new Set<{ at: number; callback: () => void }>();
  now = () => this.time;
  timer(ms: number, callback: () => void) {
    const timer = { at: this.time + ms, callback }; this.timers.add(timer);
    return () => { this.timers.delete(timer); };
  }
  async advance(ms: number) {
    const end = this.time + ms; await tick();
    while (true) {
      const next = [...this.timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      this.time = next.at; this.timers.delete(next); next.callback(); await tick();
    }
    this.time = end; await tick();
  }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
function allowed(): MetadataPolicy { return { revision: "synthetic-policy-v1", collect: { allowed: true }, cache: { allowed: true }, display: { allowed: true } }; }
function response(result: SearchResult): SearchResponse { assert.ok(result.ok, JSON.stringify(result)); return result; }
function source(result: SearchResponse, id: SourceId) { return result.sources.find((row) => row.sourceId === id)!.result; }
function failure(result: { ok: boolean }, code: string) { assert.ok(!result.ok); assert.equal((result as { code?: string }).code, code); }
function delivery(sourceId: SourceId, query: string, now: number): SearchDelivery {
  const album = syntheticAlbum(sourceId === "zophar" ? 1 : 0, 1);
  assert.equal(album.data.kind, "album");
  if (album.data.kind !== "album") throw new Error("Expected album fixture");
  const { sourceId: id, externalKey, pageUrl, title, titleKind, platforms, sourceCategory, sourceYearLabel } = album.data;
  return { ok: true, data: { kind: "search", albums: [{ sourceId: id, externalKey, pageUrl, title, titleKind, platforms, sourceCategory, sourceYearLabel }],
    reportedCount: 1, nextPageUrl: null, coverage: "reported-count-matches", resultLimit: null },
  provenance: { ...album.provenance, pageUrl: requestUrl({ sourceId, kind: "search", query }).href,
    capturedAt: new Date(now).toISOString(), parsedAt: new Date(now).toISOString() }, warnings: [],
  delivery: { from: "transport", freshness: "fresh", freshUntil: new Date(now + 60_000).toISOString(), expiresAt: new Date(now + 120_000).toISOString() } };
}
function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const clock = new Clock(), policies = { khinsider: allowed(), zophar: allowed() };
  const calls: { sourceId: SourceId; q: string; signal?: AbortSignal | undefined }[] = [];
  const adapter = (sourceId: SourceId): Pick<SourceAdapter, "searchAlbums"> => ({ searchAlbums: async (q, signal) => {
    calls.push({ sourceId, q, signal }); return delivery(sourceId, q, clock.now());
  } });
  const adapters = { khinsider: adapter("khinsider"), zophar: adapter("zophar") };
  const deps = { sampleKind: "synthetic" as const, adapters, policy: (id: SourceId) => policies[id], clock };
  return { db, clock, policies, calls, adapters, deps, catalog: new CatalogStore(db), service: createSearchService(db, deps) };
}

test("local-only search preserves catalog identity and adopted-title evidence without external calls or writes", async (t) => {
  const h = fixture(t), [saved] = await h.catalog.ingestSynthetic(syntheticAlbum(0, 3));
  const changes = h.db.prepare("SELECT total_changes() AS n").get();
  const result = response(await h.service.search({ q: "기억" }));
  assert.equal(result.status, "complete"); assert.equal(result.sampleKind, "synthetic"); assert.equal(result.termination, "settled");
  assert.ok(result.local.ok); assert.equal(result.local.items[0]!.id, saved!.albumId);
  assert.equal(result.local.items[0]!.sourceEntityId, saved!.sourceEntityId);
  assert.equal(result.local.items[0]!.provenance.capturedAt, "2026-10-24T00:00:00.000Z");
  assert.equal(result.local.items[0]!.titleKind, "album-title"); assert.equal(result.local.freshness, "not-revalidated");
  assert.deepEqual(result.sources, []); assert.equal(h.calls.length, 0); assert.equal(h.clock.timers.size, 0);
  assert.deepEqual(h.db.prepare("SELECT total_changes() AS n").get(), changes);
});

test("same titles and source keys remain separate local/source buckets without invented global identities", async (t) => {
  const h = fixture(t);
  for (const index of [0, 1]) {
    const value = syntheticAlbum(index, 1); value.data.kind === "album" && (value.data.title = "Same title");
    await h.catalog.ingestSynthetic(value);
  }
  for (const id of ["khinsider", "zophar"] as const) h.adapters[id].searchAlbums = async (q) => {
    const value = delivery(id, q, h.clock.now()); value.data.albums[0]!.title = "Same title"; return value;
  };
  const result = response(await h.service.search({ q: "Same", sources: ["zophar", "khinsider"] }));
  assert.equal(result.status, "complete"); assert.ok(result.local.ok); assert.equal(result.local.items.length, 2);
  assert.notEqual(result.local.items[0]!.id, result.local.items[1]!.id);
  assert.deepEqual(result.sources.map((row) => row.sourceId), ["khinsider", "zophar"]);
  for (const row of result.sources) {
    assert.ok(row.result.ok); assert.equal(row.result.data.albums.length, 1); assert.ok(!("id" in row.result.data.albums[0]!));
    assert.equal(row.result.provenance.sampleKind, "synthetic");
  }
  assert.ok(!("total" in result));
});

test("only explicitly selected sources run, with trimmed but otherwise unchanged queries", async (t) => {
  const h = fixture(t);
  response(await h.service.search({ q: "  ＡＢＣ  星  ", sources: ["zophar"] }));
  assert.deepEqual(h.calls.map(({ sourceId, q }) => ({ sourceId, q })), [{ sourceId: "zophar", q: "ＡＢＣ  星" }]);
});

test("invalid input and pre-cancellation never access adapters or create timers", async (t) => {
  const h = fixture(t);
  for (const input of [{}, { q: "" }, { q: "   " }, { q: "a\nb" }, { q: "\ud800" }, { q: "a".repeat(201) },
    { q: "x", sources: ["zophar", "zophar"] }, { q: "x", sources: ["unknown"] }, { q: "x", limit: 101 },
    { q: "x", offset: -1 }, { q: "x", userId: "another-user" }, { q: "x", sampleKind: "synthetic" }])
    failure(await h.service.search(input), "invalid_input");
  const controller = new AbortController(); controller.abort();
  failure(await h.service.search({ q: "x" }, controller.signal), "cancelled");
  assert.equal(h.calls.length, 0); assert.equal(h.clock.timers.size, 0);
});

test("local search uses literal NFKC substrings for one/two-character Korean, Japanese and wildcard characters", async (t) => {
  const h = fixture(t), value = syntheticAlbum(0, 1);
  value.data.kind === "album" && (value.data.title = "ＡＢＣ 기억 星の 100%_Mix 'quoted'");
  await h.catalog.ingestSynthetic(value);
  for (const q of ["abc", "기", "기억", "星", "星の", "%_", "'quoted'"]) {
    const result = response(await h.service.search({ q })); assert.ok(result.local.ok); assert.equal(result.local.items.length, 1, q);
  }
  const result = response(await h.service.search({ q: "unrelated%" })); assert.ok(result.local.ok); assert.equal(result.local.items.length, 0);
});

test("local pagination is independent of remote ranking, reported counts and unverified next pages", async (t) => {
  const h = fixture(t);
  for (const i of [0, 1, 2]) await h.catalog.ingestSynthetic(syntheticAlbum(i, 1));
  const remote = delivery("zophar", "Album", h.clock.now());
  remote.data.reportedCount = 27; remote.data.coverage = "partial-or-changed";
  remote.data.nextPageUrl = "https://www.zophar.net/search?search=Album&page=2";
  let calls = 0; h.adapters.zophar.searchAlbums = async () => { calls++; return remote; };
  const one = response(await h.service.search({ q: "Album", sources: ["zophar"], limit: 1 }));
  const two = response(await h.service.search({ q: "Album", limit: 1, offset: 1 }));
  assert.ok(one.local.ok && two.local.ok); assert.equal(one.local.nextOffset, 1); assert.notEqual(one.local.items[0]!.id, two.local.items[0]!.id);
  const z = source(one, "zophar"); assert.ok(z.ok); assert.equal(z.data.reportedCount, 27); assert.equal(z.data.nextPageUrl, remote.data.nextPageUrl);
  assert.equal(one.status, "partial"); assert.equal(calls, 1);
});

test("unavailable, blocked and removed catalog entries are excluded and removal cannot be reactivated", async (t) => {
  const h = fixture(t);
  const entries: CatalogIngestedAlbum[] = [];
  for (const i of [0, 1, 2, 3]) entries.push((await h.catalog.ingestSynthetic(syntheticAlbum(i, 1)))[0]!);
  h.db.prepare("UPDATE entity SET lifecycle='unavailable' WHERE id=?").run(entries[0]!.albumId);
  h.db.prepare("UPDATE source_entity SET availability='blocked' WHERE id=?").run(entries[1]!.sourceEntityId);
  await h.catalog.removeSource({ sourceEntityId: entries[2]!.sourceEntityId, reason: "policy_change" });
  assert.throws(() => h.db.prepare("UPDATE source_entity SET availability='available' WHERE id=?").run(entries[2]!.sourceEntityId));
  const result = response(await h.service.search({ q: "Album" })); assert.ok(result.local.ok);
  assert.deepEqual(result.local.items.map((row) => row.id), [entries[3]!.albumId]);
});

test("later search labels never replace adopted detail titles or their provenance", async (t) => {
  const h = fixture(t); await h.catalog.ingestSynthetic(syntheticAlbum(1, 1));
  const summary = delivery("zophar", "sample", h.clock.now()); summary.data.albums[0]!.title = "New search label";
  summary.data.albums[0]!.titleKind = "source-display-label";
  const { delivery: ignored, ...dto } = summary; void ignored;
  await h.catalog.ingestSynthetic(dto);
  const result = response(await h.service.search({ q: "Album" })); assert.ok(result.local.ok);
  assert.equal(result.local.items[0]!.titleKind, "album-title");
  assert.equal(result.local.items[0]!.provenance.capturedAt, "2026-10-24T00:00:00.000Z");
  assert.ok(!result.local.items[0]!.title.includes("New search label"));
});

test("public local projection never joins personal tables or exposes saved IDs, notes or overrides", async (t) => {
  const h = fixture(t), [saved] = await h.catalog.ingestSynthetic(syntheticAlbum(0, 1));
  const userId = randomUUID(), now = new Date().toISOString();
  h.db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)')
    .run(userId, "Secret name", `${userId}@example.test`, now, now);
  const item = new CatalogLibraryStore(h.db).create(userId, { entityId: saved!.albumId, titleOverride: "Secret override", note: "Private secret", favorite: true }).item;
  const result = response(await h.service.search({ q: "Album" })), json = JSON.stringify(result);
  for (const secret of [userId, item.id, "Secret override", "Private secret", "savedItemId"]) assert.ok(!json.includes(secret));
  const none = response(await h.service.search({ q: "Private" })); assert.ok(none.local.ok); assert.equal(none.local.items.length, 0);
  const plans = queryPlans(h.db, () => readLocalAlbums(h.db, { q: "Album", limit: 12, offset: 0 }, "synthetic"));
  assert.ok(plans.every(({ sql }) => !/library_item|user_source_link|catalog_detached/u.test(sql)));
  assert.ok(plans.every(({ plan }) => !plan.some((row) => /^SCAN e(?:\s|$)/u.test((row as { detail: string }).detail))));
});

test("source failures retain their codes and retry hints without hiding valid local results", async (t) => {
  const h = fixture(t); await h.catalog.ingestSynthetic(syntheticAlbum(0, 1));
  h.adapters.khinsider.searchAlbums = async () => ({ ok: false, code: "blocked", stage: "transport", httpStatus: 403 });
  h.adapters.zophar.searchAlbums = async () => ({ ok: false, code: "rate_limited", stage: "transport", httpStatus: 429, retryAt: h.clock.now() + 60000 });
  const result = response(await h.service.search({ q: "Album", sources: ["khinsider", "zophar"] }));
  assert.equal(result.status, "partial"); assert.ok(result.local.ok); assert.equal(result.local.items.length, 1);
  failure(source(result, "khinsider"), "blocked"); const z = source(result, "zophar"); failure(z, "rate_limited");
  assert.ok(!z.ok); assert.equal(z.httpStatus, 429); assert.equal(z.retryAt, h.clock.now() + 60000);
});

test("normal zero is complete but parse failure has no fabricated empty album list", async (t) => {
  const h = fixture(t), empty = delivery("zophar", "none", h.clock.now()); empty.data.albums = []; empty.data.reportedCount = 0;
  h.adapters.zophar.searchAlbums = async () => empty;
  const result = response(await h.service.search({ q: "none", sources: ["zophar"] }));
  assert.equal(result.status, "complete"); const z = source(result, "zophar"); assert.ok(z.ok); assert.deepEqual(z.data.albums, []);
  h.adapters.zophar.searchAlbums = async () => ({ ok: false, code: "parse_changed", stage: "parser" });
  const broken = response(await h.service.search({ q: "none", sources: ["zophar"] })); assert.equal(broken.status, "partial");
  failure(source(broken, "zophar"), "parse_changed"); assert.ok(!("data" in source(broken, "zophar")));
});

test("an adapter rejection is isolated and never exposes exception details", async (t) => {
  const h = fixture(t); h.adapters.khinsider.searchAlbums = async () => { throw new Error("private transport detail"); };
  const result = response(await h.service.search({ q: "Album", sources: ["khinsider", "zophar"] }));
  failure(source(result, "khinsider"), "source_error"); assert.ok(source(result, "zophar").ok); assert.equal(result.status, "partial");
  assert.ok(!JSON.stringify(result).includes("private transport detail"));
});

test("a non-cooperative slow source is cancelled at eleven seconds, preserving other and local results within twelve", async (t) => {
  const h = fixture(t); await h.catalog.ingestSynthetic(syntheticAlbum(0, 1));
  let observed: AbortSignal | undefined; const pending = deferred<AdapterResult>();
  h.adapters.khinsider.searchAlbums = async (_q, signal) => { observed = signal; return pending.promise; };
  let settled = false;
  const work = h.service.search({ q: "Album", sources: ["khinsider", "zophar"] }).then((result) => { settled = true; return result; });
  await h.clock.advance(SEARCH_LIMITS.sourceBudgetMs - 1); assert.equal(settled, false);
  await h.clock.advance(1); const result = response(await work);
  assert.equal(result.elapsedMs, 11000); assert.equal(result.termination, "deadline"); assert.equal(result.status, "partial");
  failure(source(result, "khinsider"), "timeout"); assert.ok(source(result, "zophar").ok); assert.ok(result.local.ok); assert.equal(result.local.items.length, 1);
  assert.ok(observed?.aborted); const before = JSON.stringify(result);
  pending.resolve(delivery("khinsider", "Album", h.clock.now())); await tick(); assert.equal(JSON.stringify(result), before); assert.equal(h.clock.timers.size, 0);
});

test("database queue wait shares the twelve-second deadline and abandoned work never reads after unlocking", async (t) => {
  const h = fixture(t), release = await acquireDatabase(h.db);
  const prepare = t.mock.method(h.db, "prepare");
  const work = h.service.search({ q: "Album", sources: ["zophar"] });
  await h.clock.advance(12000); const result = response(await work);
  assert.equal(result.elapsedMs, 12000); assert.equal(result.termination, "deadline"); failure(result.local, "timeout"); failure(source(result, "zophar"), "timeout");
  assert.equal(result.status, "failed"); const calls = prepare.mock.callCount(); release(); await tick(); assert.equal(prepare.mock.callCount(), calls);
  assert.equal(h.clock.timers.size, 0);
});

test("caller cancellation discards all results, aborts pending sources and releases capacity", async (t) => {
  const h = fixture(t), controller = new AbortController(), pending = deferred<AdapterResult>(); let observed: AbortSignal | undefined;
  h.adapters.zophar.searchAlbums = async (_q, signal) => { observed = signal; return pending.promise; };
  const work = h.service.search({ q: "Album", sources: ["zophar"] }, controller.signal); await tick(); controller.abort();
  failure(await work, "cancelled"); assert.ok(observed?.aborted); assert.equal(h.clock.timers.size, 0);
  pending.resolve(delivery("zophar", "Album", h.clock.now())); await tick(); response(await h.service.search({ q: "Album" }));
});

test("active search admission is bounded without queuing or starting extra source calls", async (t) => {
  const h = fixture(t), controllers = Array.from({ length: SEARCH_LIMITS.maxActive }, () => new AbortController()); let calls = 0;
  h.adapters.zophar.searchAlbums = async () => { calls++; return new Promise(() => {}); };
  const work = controllers.map((c) => h.service.search({ q: "Album", sources: ["zophar"] }, c.signal)); await tick();
  failure(await h.service.search({ q: "Album", sources: ["zophar"] }), "queue_full"); assert.equal(calls, SEARCH_LIMITS.maxActive);
  controllers.forEach((c) => c.abort()); for (const result of await Promise.all(work)) failure(result, "cancelled");
  assert.equal(h.clock.timers.size, 0); response(await h.service.search({ q: "Album" }));
});

test("policy revocation while another source is pending suppresses already received metadata", async (t) => {
  const h = fixture(t), pending = deferred<AdapterResult>(); h.adapters.zophar.searchAlbums = async () => pending.promise;
  const work = h.service.search({ q: "Album", sources: ["khinsider", "zophar"] }); await tick();
  h.policies.khinsider.display = { allowed: false, code: "policy_disabled" }; h.policies.khinsider.revision = "revoked";
  pending.resolve(delivery("zophar", "Album", h.clock.now())); const result = response(await work);
  failure(source(result, "khinsider"), "policy_disabled"); assert.ok(source(result, "zophar").ok);
  assert.equal(result.sources[0]!.policy.revision, "revoked");
});

test("changed policy revisions require a new search even if permissions remain allowed", async (t) => {
  const h = fixture(t), pending = deferred<AdapterResult>(); h.adapters.zophar.searchAlbums = async () => pending.promise;
  const work = h.service.search({ q: "Album", sources: ["zophar"] }); await tick(); h.policies.zophar.revision = "v2";
  pending.resolve(delivery("zophar", "Album", h.clock.now())); failure(source(response(await work), "zophar"), "policy_changed");
});

test("cache display can remain allowed without collection, but transport and unpermitted cache results are rejected", async (t) => {
  const h = fixture(t), value = delivery("zophar", "Album", h.clock.now());
  h.policies.zophar.collect = { allowed: false, code: "policy_disabled" };
  h.adapters.zophar.searchAlbums = async () => value;
  failure(source(response(await h.service.search({ q: "Album", sources: ["zophar"] })), "zophar"), "policy_disabled");
  value.delivery.from = "cache";
  assert.ok(source(response(await h.service.search({ q: "Album", sources: ["zophar"] })), "zophar").ok);
  h.policies.zophar.cache = { allowed: false, code: "policy_disabled" };
  failure(source(response(await h.service.search({ q: "Album", sources: ["zophar"] })), "zophar"), "policy_disabled");
});

test("a local query error remains a failure without suppressing independently checked source metadata", async (t) => {
  const h = fixture(t), original = h.db.prepare;
  t.mock.method(h.db, "prepare", function (sql: string) {
    if (sql.startsWith("SELECT a.id FROM album")) throw new Error("private database details");
    return original.call(h.db, sql);
  });
  const result = response(await h.service.search({ q: "Album", sources: ["zophar"] }));
  failure(result.local, "database_error"); assert.ok(source(result, "zophar").ok); assert.equal(result.status, "partial");
  assert.ok(!JSON.stringify(result).includes("private database details"));
});

test("removed metadata waiting for another source is rejected and current local removal wins", async (t) => {
  const h = fixture(t), [saved] = await h.catalog.ingestSynthetic(syntheticAlbum(0, 1));
  const pending = deferred<AdapterResult>(); h.adapters.zophar.searchAlbums = async () => pending.promise;
  const work = h.service.search({ q: "Album", sources: ["khinsider", "zophar"] }); await tick();
  await h.catalog.removeSource({ sourceEntityId: saved!.sourceEntityId, reason: "policy_change" });
  pending.resolve(delivery("zophar", "Album", h.clock.now())); const result = response(await work);
  failure(source(result, "khinsider"), "content_removed"); assert.ok(result.local.ok); assert.deepEqual(result.local.items, []);
});

test("fresh cache aging while waiting becomes stale, without changing capture time or refreshing the expiry", async (t) => {
  const h = fixture(t), pending = deferred<AdapterResult>(), cached = delivery("khinsider", "Album", h.clock.now());
  cached.delivery.from = "cache"; cached.delivery.freshUntil = new Date(h.clock.now() + 1000).toISOString();
  h.adapters.khinsider.searchAlbums = async () => cached; h.adapters.zophar.searchAlbums = async () => pending.promise;
  const work = h.service.search({ q: "Album", sources: ["khinsider", "zophar"] }); await h.clock.advance(1000);
  pending.resolve(delivery("zophar", "Album", h.clock.now())); const result = response(await work), k = source(result, "khinsider");
  assert.ok(k.ok); assert.equal(k.delivery.freshness, "stale"); assert.equal(k.provenance.capturedAt, cached.provenance.capturedAt);
  assert.equal(k.delivery.expiresAt, cached.delivery.expiresAt); assert.equal(result.status, "partial");
});

test("expired held cache is rejected rather than exposed or reported as zero", async (t) => {
  const h = fixture(t), pending = deferred<AdapterResult>(), cached = delivery("khinsider", "Album", h.clock.now());
  cached.delivery.from = "cache"; cached.delivery.freshUntil = cached.delivery.expiresAt = new Date(h.clock.now() + 1000).toISOString();
  h.adapters.khinsider.searchAlbums = async () => cached; h.adapters.zophar.searchAlbums = async () => pending.promise;
  const work = h.service.search({ q: "Album", sources: ["khinsider", "zophar"] }); await h.clock.advance(1000);
  pending.resolve(delivery("zophar", "Album", h.clock.now())); failure(source(response(await work), "khinsider"), "result_expired");
});

test("stale refresh failures and parser warnings remain visible without manufacturing global counts", async (t) => {
  const h = fixture(t), cached = delivery("zophar", "Album", h.clock.now() - 61000);
  cached.delivery.from = "cache"; cached.delivery.freshness = "stale"; cached.refreshFailure = { ok: false, code: "timeout", stage: "transport" };
  cached.warnings = ["Synthetic partial evidence"];
  h.adapters.zophar.searchAlbums = async () => cached;
  const result = response(await h.service.search({ q: "Album", sources: ["zophar"] })), z = source(result, "zophar");
  assert.ok(z.ok); assert.equal(z.refreshFailure?.code, "timeout"); assert.deepEqual(z.warnings, cached.warnings); assert.equal(result.status, "partial");
});

test("wrong source, query, page kind and sample kind cannot be mislabeled as successful search", async (t) => {
  const h = fixture(t);
  for (const mutate of [
    (v: SearchDelivery) => { v.provenance.sourceId = "khinsider"; },
    (v: SearchDelivery) => { v.provenance.pageUrl = "https://www.zophar.net/search?search=other"; },
    (v: SearchDelivery) => { v.provenance.sampleKind = "live-capture"; },
    (v: SearchDelivery) => { v.delivery.expiresAt = "invalid-date"; },
  ]) {
    const invalid = delivery("zophar", "Album", h.clock.now()); mutate(invalid); h.adapters.zophar.searchAlbums = async () => invalid;
    failure(source(response(await h.service.search({ q: "Album", sources: ["zophar"] })), "zophar"), "invalid_response");
  }
  const album = syntheticAlbum(1, 1), timing = delivery("zophar", "Album", h.clock.now()).delivery;
  h.adapters.zophar.searchAlbums = async () => ({ ...album, delivery: timing });
  failure(source(response(await h.service.search({ q: "Album", sources: ["zophar"] })), "zophar"), "invalid_response");
});

test("live product service never exposes synthetic catalog or requests disabled sites", async (t) => {
  const h = fixture(t); await h.catalog.ingestSynthetic(syntheticAlbum(0, 1));
  const dns = t.mock.method(Resolver.prototype, "resolve4", () => { throw new Error("No network"); });
  const service = getSearchService(h.db); assert.equal(service, getSearchService(h.db));
  const result = response(await service.search({ q: "Album", sources: ["khinsider", "zophar"] }));
  assert.equal(result.sampleKind, "live-capture"); assert.equal(result.status, "failed"); failure(result.local, "sample_kind_unavailable");
  for (const row of result.sources) { failure(row.result, "policy_disabled"); assert.equal(row.policy.display.allowed, false); }
  assert.equal(dns.mock.callCount(), 0); assert.deepEqual(h.db.prepare("SELECT * FROM source_metadata_cache").all(), []);
});

test("an individual integrated search cancellation keeps another real Adapter subscriber and its cache write alive", async (t) => {
  const h = fixture(t), pending = deferred<TransportResult>(); let captures = 0; let observed: AbortSignal | undefined;
  const metadata = createMetadataService(h.db, { sampleKind: "synthetic", policy: () => allowed(), clock: h.clock,
    parser: { version: PARSER_VERSION, parse: inspectCapturedPage }, capture: async (_request, signal) => { captures++; observed = signal; return pending.promise; } });
  h.adapters.zophar.searchAlbums = (q, signal) => metadata.get({ sourceId: "zophar", kind: "search", query: q }, signal);
  const a = new AbortController(), b = new AbortController();
  const first = h.service.search({ q: "sample", sources: ["zophar"] }, a.signal), second = h.service.search({ q: "sample", sources: ["zophar"] }, b.signal);
  await tick(); assert.equal(captures, 1); a.abort(); failure(await first, "cancelled"); assert.ok(!observed?.aborted);
  pending.resolve({ ok: true, page: { sourceId: "zophar", kind: "search", url: "https://www.zophar.net/search?search=sample", status: 200,
    headers: { "content-type": "text/html" }, capturedAt: new Date(h.clock.now()).toISOString(), sampleKind: "synthetic",
    html: readFileSync(new URL("./fixtures/zophar-search.html", import.meta.url), "utf8") } });
  const result = response(await second); assert.ok(source(result, "zophar").ok);
  assert.equal(h.db.prepare("SELECT * FROM source_metadata_cache").all().length, 1);
  const cached = source(response(await h.service.search({ q: "sample", sources: ["zophar"] })), "zophar");
  assert.ok(cached.ok); assert.equal(cached.delivery.from, "cache"); assert.equal(captures, 1); assert.equal(h.clock.timers.size, 0);
});

test("last integrated subscriber cancellation prevents a late real Adapter capture from writing cache", async (t) => {
  const h = fixture(t), pending = deferred<TransportResult>(); let observed: AbortSignal | undefined;
  const metadata = createMetadataService(h.db, { sampleKind: "synthetic", policy: () => allowed(), clock: h.clock,
    parser: { version: PARSER_VERSION, parse: inspectCapturedPage }, capture: async (_request, signal) => { observed = signal; return pending.promise; } });
  h.adapters.zophar.searchAlbums = (q, signal) => metadata.get({ sourceId: "zophar", kind: "search", query: q }, signal);
  const controller = new AbortController(), work = h.service.search({ q: "sample", sources: ["zophar"] }, controller.signal);
  await tick(); controller.abort(); failure(await work, "cancelled"); assert.ok(observed?.aborted);
  pending.resolve({ ok: true, page: { sourceId: "zophar", kind: "search", url: "https://www.zophar.net/search?search=sample", status: 200,
    headers: { "content-type": "text/html" }, capturedAt: new Date(h.clock.now()).toISOString(), sampleKind: "synthetic",
    html: readFileSync(new URL("./fixtures/zophar-search.html", import.meta.url), "utf8") } });
  await tick(); await withDatabase(h.db, async () => { assert.deepEqual(h.db.prepare("SELECT * FROM source_metadata_cache").all(), []); });
  assert.equal(h.clock.timers.size, 0);
});

test("held results are checked again after an authentication wait, preserving current local and removal decisions", async (t) => {
  const h = fixture(t), [saved] = await h.catalog.ingestSynthetic(syntheticAlbum(0, 1));
  const input = { q: "Album", sources: ["khinsider"] }, result = response(await h.service.search(input));
  assert.ok(result.local.ok); assert.equal(result.local.items.length, 1); assert.ok(source(result, "khinsider").ok);
  await h.catalog.removeSource({ sourceEntityId: saved!.sourceEntityId, reason: "policy_change" });
  const checked = response(await withDatabase(h.db, async () => h.service.recheck(input, result)));
  assert.ok(checked.local.ok); assert.deepEqual(checked.local.items, []); failure(source(checked, "khinsider"), "content_removed");
  assert.equal(checked.status, "partial");
});

test("held results crossing expiry during authentication cannot be delivered with a new timestamp", async (t) => {
  const h = fixture(t), input = { q: "Album", sources: ["zophar"] }, result = response(await h.service.search(input));
  await h.clock.advance(120000);
  const checked = response(await withDatabase(h.db, async () => h.service.recheck(input, result)));
  failure(source(checked, "zophar"), "result_expired"); assert.equal(checked.elapsedMs, 120000);
});

test("held result policy and sample context are rechecked without fetching, ingesting or accepting a different request", async (t) => {
  const h = fixture(t), input = { q: "Album", sources: ["zophar"] }, result = response(await h.service.search(input));
  h.policies.zophar.display = { allowed: false, code: "policy_disabled" };
  await withDatabase(h.db, async () => {
    const checked = response(h.service.recheck(input, result)); failure(source(checked, "zophar"), "policy_disabled");
    assert.throws(() => h.service.recheck({ q: "another", sources: ["zophar"] }, result));
    assert.throws(() => h.service.recheck({ q: "Album" }, result));
    assert.throws(() => h.service.recheck(input, { ...result, sampleKind: "live-capture" }));
  });
  assert.equal(h.calls.length, 1); assert.deepEqual(h.db.prepare("SELECT * FROM entity").all(), []);
});
