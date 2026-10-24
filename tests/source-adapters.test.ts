import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate, assertMigrated } from "../src/database/migrate.ts";
import { acquireDatabase, withDatabase } from "../src/database/access.ts";
import { backupDatabase, restoreDatabase } from "../src/database/backup.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { getSourceAdapters } from "../src/sources/adapters.ts";
import { createMetadataService } from "../src/sources/adapters/service.ts";
import { MetadataCache, type CacheContext } from "../src/sources/adapters/cache.ts";
import { CACHE_LIMITS as limits, type AdapterDependencies, type AdapterResult, type MetadataPolicy } from "../src/sources/adapters/contracts.ts";
import { retentionFromHeaders } from "../src/sources/adapters/retention.ts";
import { sourceAssessments } from "../src/sources/policies.ts";
import { inspectCapturedPage, PARSER_VERSION } from "../src/sources/parsers.ts";
import { validateMetadata } from "../src/sources/metadata.ts";
import type { CapturedPage } from "../src/sources/types.ts";
import { requestUrl } from "../src/sources/transport/requests.ts";
import type { SourceRequest, TransportClock, TransportResult } from "../src/sources/transport/contracts.ts";

const search: SourceRequest = { sourceId: "zophar", kind: "search", query: "sample" };
const album: SourceRequest = { sourceId: "zophar", kind: "album", externalKey: "nintendo-snes-spc/sample" };
const tick = () => setImmediate();
class Clock implements TransportClock {
  time = Date.parse("2026-10-24T00:00:00Z");
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
function page(request: SourceRequest, now: number, file?: string): CapturedPage {
  return { sourceId: request.sourceId, kind: request.kind, url: requestUrl(request).href, status: 200,
    headers: { "content-type": "text/html" }, capturedAt: new Date(now).toISOString(), sampleKind: "synthetic",
    html: readFileSync(new URL(`./fixtures/${file ?? `${request.sourceId}-${request.kind}`}.html`, import.meta.url), "utf8") };
}
function allowed(): MetadataPolicy { return { revision: "synthetic-policy-v1", collect: { allowed: true }, cache: { allowed: true }, display: { allowed: true } }; }
function fixture(t: TestContext, provided?: Database.Database) {
  const db = provided ?? openDatabase(":memory:");
  if (!provided) { migrate(db); t.after(() => db.close()); }
  const clock = new Clock(), policy = allowed(), calls: { request: SourceRequest; signal: AbortSignal }[] = [];
  const deps: AdapterDependencies = { sampleKind: "synthetic", policy: () => policy, clock,
    parser: { version: PARSER_VERSION, parse: inspectCapturedPage },
    capture: async (request, signal) => { calls.push({ request, signal }); return { ok: true, page: page(request, clock.now()) }; } };
  return { db, clock, policy, calls, deps, service: createMetadataService(db, deps) };
}
function success(result: AdapterResult) { assert.ok(result.ok, JSON.stringify(result)); return result; }
function failed(result: AdapterResult, code: string) { assert.ok(!result.ok); assert.equal(result.code, code); return result; }
function rows(db: Database.Database) { return db.prepare("SELECT * FROM source_metadata_cache ORDER BY rowid").all(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }

test("product adapters preserve unknown policies, capability distinctions and zero DNS/cache writes", async (t) => {
  const h = fixture(t), before = JSON.stringify(sourceAssessments);
  const dns = t.mock.method(Resolver.prototype, "resolve4", () => { throw new Error("No network"); });
  const adapters = getSourceAdapters(h.db); assert.equal(getSourceAdapters(h.db), adapters);
  for (const adapter of Object.values(adapters)) {
    failed(await adapter.searchAlbums("sample"), "policy_disabled");
    failed(await adapter.getAlbum(adapter.capabilities().sourceId === "zophar" ? "snes/sample" : "sample"), "policy_disabled");
  }
  assert.equal(adapters.khinsider.capabilities().parser.album, false);
  assert.equal(adapters.zophar.capabilities().parser.album, true);
  const capabilities = adapters.zophar.capabilities(); capabilities.policy.search.status = "allowed";
  assert.equal(JSON.stringify(sourceAssessments), before); assert.equal(dns.mock.callCount(), 0); assert.deepEqual(rows(h.db), []);
});

test("KH search and Zophar search/detail retain source DTOs; unsupported KH detail never captures", async (t) => {
  const h = fixture(t);
  for (const request of [search, album, { sourceId: "khinsider", kind: "search", query: "sample" } as const]) {
    const result = success(await h.service.get(request));
    assert.equal(result.provenance.sourceId, request.sourceId); assert.equal(result.data.kind, request.kind);
    assert.equal(result.delivery.from, "transport"); assert.equal(result.provenance.sampleKind, "synthetic");
    if (result.data.kind === "album") {
      assert.equal(result.data.tracks.length, 4); assert.equal(result.data.tracks[1]?.displayNumber, result.data.tracks[2]?.displayNumber);
      assert.equal(result.data.playback, "unverified");
    }
  }
  failed(await h.service.get({ sourceId: "khinsider", kind: "album", externalKey: "sample" }), "unsupported");
  assert.equal(h.calls.length, 3); assert.equal(rows(h.db).length, 3);
  assert.equal((h.db.prepare("SELECT count(*) AS n FROM entity").get() as { n: number }).n, 0);
  const payload = (h.db.prepare("SELECT payload FROM source_metadata_cache LIMIT 1").get() as { payload: string }).payload;
  assert.ok(!payload.includes("<html") && !payload.includes('"html"') && !payload.includes("set-cookie"));
});

test("fresh cache avoids capture, preserves capture time and isolates returned object mutations", async (t) => {
  const h = fixture(t), first = success(await h.service.get(search));
  first.data.kind === "search" && (first.data.albums[0]!.title = "tampered");
  const next = success(await h.service.get({ ...search, kind: "search", query: " sample " }));
  assert.equal(next.delivery.from, "cache"); assert.equal(next.delivery.freshness, "fresh");
  assert.equal(next.provenance.capturedAt, first.provenance.capturedAt); assert.equal(h.calls.length, 1);
  assert.ok(next.data.kind === "search" && next.data.albums[0]!.title !== "tampered");
});

test("request keys keep source, kind, case, internal spaces and Unicode variants separate", async (t) => {
  const h = fixture(t);
  for (const query of ["sample", "Sample", "two spaces", "two  spaces", "Ａ", "A", "星"])
    success(await h.service.get({ sourceId: "zophar", kind: "search", query }));
  success(await h.service.get(album));
  success(await h.service.get({ sourceId: "khinsider", kind: "search", query: "sample" }));
  assert.equal(rows(h.db).length, 9); assert.equal(h.calls.length, 9);
});

test("invalid requests and pre-cancellation create neither flights, cache rows nor capture", async (t) => {
  const h = fixture(t), c = new AbortController(); c.abort();
  failed(await h.service.get(search, c.signal), "cancelled");
  for (const query of ["", "x".repeat(201), "a\nb"]) failed(await h.service.get({ sourceId: "zophar", kind: "search", query }), "invalid_input");
  failed(await h.service.get({ ...album, kind: "album", externalKey: "https://evil.example/a" }), "invalid_input");
  assert.equal(h.calls.length, 0); assert.equal(h.clock.timers.size, 0); assert.deepEqual(rows(h.db), []);
});

test("normal zero is cached for fifteen minutes, then failures never reuse it as a stale zero", async (t) => {
  const h = fixture(t); let count = 0;
  h.deps.capture = async () => { count++; return { ok: true, page: page(search, h.clock.now(), "zophar-empty") }; };
  const zero = success(await h.service.get(search)); assert.ok(zero.data.kind === "search" && zero.data.albums.length === 0);
  await h.clock.advance(limits.emptyMs - 1); assert.equal(success(await h.service.get(search)).delivery.from, "cache");
  assert.equal(count, 1); await h.clock.advance(1);
  h.deps.capture = async () => ({ ok: false, code: "timeout" });
  failed(await h.service.get(search), "timeout"); assert.deepEqual(rows(h.db), []);
});

test("partial pages remain partial and are not followed as unverified pagination", async (t) => {
  const h = fixture(t); let count = 0;
  h.deps.capture = async () => { count++; const p = page(search, h.clock.now()); p.html = p.html.replace("Found 2 music files.", "Found 9 music files."); return { ok: true, page: p }; };
  const result = success(await h.service.get(search)); assert.ok(result.data.kind === "search");
  assert.equal(result.data.coverage, "partial-or-changed"); assert.ok(result.warnings.includes("reported_count_mismatch"));
  assert.equal(count, 1); assert.equal(success(await h.service.get(search)).delivery.from, "cache");
});

test("search and album refresh at different TTLs; failed refresh preserves last-good bytes and age", async (t) => {
  const h = fixture(t); success(await h.service.get(search)); success(await h.service.get(album));
  const original = rows(h.db); await h.clock.advance(limits.searchFreshMs);
  h.deps.capture = async () => ({ ok: false, code: "http_error", httpStatus: 503 });
  const stale = success(await h.service.get(search)); assert.equal(stale.delivery.freshness, "stale");
  assert.equal(stale.refreshFailure?.httpStatus, 503); assert.deepEqual(rows(h.db), original);
  assert.equal(success(await h.service.get(album)).delivery.freshness, "fresh");
  await h.clock.advance(limits.albumFreshMs - limits.searchFreshMs);
  failed(await h.service.get(search), "http_error");
  assert.equal(success(await h.service.get(album)).delivery.freshness, "stale");
  await h.clock.advance(limits.albumMaxAgeMs - limits.albumFreshMs);
  failed(await h.service.get(album), "http_error"); assert.deepEqual(rows(h.db), []);
});

test("parser change, timeout and 429 retain explicit stale failure without changing stored metadata", async (t) => {
  for (const code of ["parse_changed", "timeout", "rate_limited"] as const) {
    const h = fixture(t); success(await h.service.get(search)); const original = rows(h.db);
    await h.clock.advance(limits.searchFreshMs);
    h.deps.capture = async () => code === "parse_changed"
      ? { ok: true, page: { ...page(search, h.clock.now()), html: "<h1>Changed layout</h1>" } }
      : { ok: false, code, ...(code === "rate_limited" ? { retryAt: h.clock.now() + 60_000 } : {}) };
    const result = success(await h.service.get(search)); assert.equal(result.refreshFailure?.code, code);
    assert.equal(result.delivery.freshness, "stale"); assert.deepEqual(rows(h.db), original);
  }
});

test("successful refresh replaces metadata and age; 403/404/410/challenge never fall back to stale", async (t) => {
  const h = fixture(t); const first = success(await h.service.get(search)); await h.clock.advance(limits.searchFreshMs);
  const next = success(await h.service.get(search)); assert.notEqual(next.provenance.capturedAt, first.provenance.capturedAt);
  assert.equal(next.delivery.from, "transport");
  for (const status of [403, 404, 410, 200]) {
    const f = fixture(t); success(await f.service.get(search)); await f.clock.advance(limits.searchFreshMs);
    f.deps.capture = async () => status === 200 ? { ok: true, page: { ...page(search, f.clock.now()), html: "<title>Just a moment...</title>" } }
      : { ok: false, code: status === 403 ? "blocked" : "not_found", httpStatus: status };
    failed(await f.service.get(search), status === 403 || status === 200 ? "blocked" : "not_found"); assert.deepEqual(rows(f.db), []);
  }
});

test("collection, cache and display decisions are independent; denied display purges and never captures", async (t) => {
  const h = fixture(t); success(await h.service.get(search));
  h.policy.collect = { allowed: false, code: "blocked" };
  assert.equal(success(await h.service.get(search)).delivery.from, "cache"); assert.equal(h.calls.length, 1);
  h.policy.cache = { allowed: false, code: "policy_disabled" }; h.policy.revision = "v2";
  failed(await h.service.get(search), "blocked"); assert.deepEqual(rows(h.db), []);
  h.policy.collect = { allowed: true };
  assert.equal(success(await h.service.get(search)).delivery.from, "transport"); assert.deepEqual(rows(h.db), []);
  h.policy.display = { allowed: false, code: "policy_disabled" }; const n = h.calls.length;
  failed(await h.service.get(search), "policy_disabled"); assert.equal(h.calls.length, n);
});

test("policy and parser revisions invalidate serving old cache without converting it to fresh data", async (t) => {
  for (const change of ["policy", "parser"]) {
    const h = fixture(t); success(await h.service.get(search)); const before = rows(h.db);
    if (change === "policy") h.policy.revision = "v2";
    else h.deps.parser.version = "future-parser";
    h.deps.capture = async () => ({ ok: false, code: "timeout" });
    failed(await h.service.get(search), "timeout"); assert.deepEqual(rows(h.db), before);
    if (change === "parser") h.deps.parser.parse = (p) => {
      const result = inspectCapturedPage(p); if (result.ok) result.provenance.parserVersion = "future-parser"; return result;
    };
    await h.clock.advance(1); h.deps.capture = async () => ({ ok: true, page: page(search, h.clock.now()) });
    success(await h.service.get(search)); assert.notDeepEqual(rows(h.db), before);
  }
});

test("policy revocation while capture is pending discards result and purges earlier cached pages", async (t) => {
  const h = fixture(t); success(await h.service.get(album)); const pending = deferred<TransportResult>();
  h.deps.capture = () => pending.promise;
  const request = h.service.get(search); await tick();
  h.policy.revision = "revoked"; h.policy.display = { allowed: false, code: "policy_disabled" };
  pending.resolve({ ok: true, page: page(search, h.clock.now()) });
  failed(await request, "policy_disabled"); assert.deepEqual(rows(h.db), []);
});

test("response identity, fixture mode, parser version and malformed DTO cannot contaminate cache", async (t) => {
  for (const mutate of [(p: CapturedPage) => { p.sampleKind = "live-capture"; }, (p: CapturedPage) => { p.kind = "album"; },
    (p: CapturedPage) => { p.url = "https://www.zophar.net/search?search=other"; },
    (p: CapturedPage) => { p.capturedAt = "2099-01-01T00:00:00Z"; }]) {
    const h = fixture(t); h.deps.capture = async () => { const p = page(search, h.clock.now()); mutate(p); return { ok: true, page: p }; };
    failed(await h.service.get(search), "invalid_response"); assert.deepEqual(rows(h.db), []);
  }
  const h = fixture(t); h.deps.parser.version = "different";
  failed(await h.service.get(search), "invalid_response"); assert.deepEqual(rows(h.db), []);
});

test("fixture and live namespaces are isolated even with otherwise identical allowed test contracts", async (t) => {
  const h = fixture(t); success(await h.service.get(search));
  const live = createMetadataService(h.db, { ...h.deps, sampleKind: "live-capture",
    capture: async () => ({ ok: true, page: { ...page(search, h.clock.now()), sampleKind: "live-capture" } }) });
  assert.equal(success(await live.get(search)).delivery.from, "transport"); assert.equal(rows(h.db).length, 2);
  assert.equal(success(await h.service.get(search)).provenance.sampleKind, "synthetic");
});

test("identical requests share capture; cancelling one subscriber preserves the other's work and isolated result", async (t) => {
  const h = fixture(t), pending = deferred<TransportResult>(); let signal!: AbortSignal; let count = 0;
  h.deps.capture = (_r, s) => { signal = s; count++; return pending.promise; };
  const a = new AbortController(), first = h.service.get(search, a.signal), second = h.service.get(search), third = h.service.get(search);
  await tick(); assert.equal(count, 1); a.abort(); failed(await first, "cancelled"); assert.equal(signal.aborted, false);
  pending.resolve({ ok: true, page: page(search, h.clock.now()) });
  const two = success(await second), three = success(await third);
  two.warnings.push("caller mutation"); assert.ok(!three.warnings.includes("caller mutation"));
  assert.equal(rows(h.db).length, 1); assert.equal(h.clock.timers.size, 0);
});

test("last cancellation aborts shared work, late response cannot cache and a new subscriber starts fresh", async (t) => {
  const h = fixture(t), pending = deferred<TransportResult>(); let signal!: AbortSignal;
  h.deps.capture = (_r, s) => { signal = s; return pending.promise; };
  const a = new AbortController(), first = h.service.get(search, a.signal); await tick(); a.abort();
  failed(await first, "cancelled"); assert.ok(signal.aborted);
  h.deps.capture = async () => ({ ok: true, page: { ...page(search, h.clock.now()), html: "<h1>changed</h1>" } });
  failed(await h.service.get(search), "parse_changed");
  pending.resolve({ ok: true, page: page(search, h.clock.now()) }); await tick(); assert.deepEqual(rows(h.db), []);
});

test("flight count and subscribers are bounded, while distinct source/key work remains independent", async (t) => {
  const h = fixture(t), c = new AbortController();
  h.deps.capture = () => new Promise(() => {});
  const requests = Array.from({ length: limits.maxFlights }, (_, i) => h.service.get({ sourceId: "zophar", kind: "search", query: String(i) }, c.signal));
  failed(await h.service.get(search), "queue_full");
  const subscribers = Array.from({ length: limits.maxSubscribers - 1 }, () => h.service.get({ sourceId: "zophar", kind: "search", query: "0" }, c.signal));
  failed(await h.service.get({ sourceId: "zophar", kind: "search", query: "0" }), "queue_full");
  c.abort(); for (const result of await Promise.all([...requests, ...subscribers])) failed(result, "cancelled");
  await tick(); assert.equal(h.clock.timers.size, 0);
});

test("deadline includes DB waiting and a capture that ignores cancellation, without late writes", async (t) => {
  const h = fixture(t), unlock = await acquireDatabase(h.db);
  const waiting = h.service.get(search); await h.clock.advance(limits.deadlineMs); failed(await waiting, "timeout");
  unlock(); await tick(); assert.equal(h.calls.length, 0);
  const pending = deferred<TransportResult>(); h.deps.capture = () => pending.promise;
  const request = h.service.get(search); await h.clock.advance(limits.deadlineMs); failed(await request, "timeout");
  pending.resolve({ ok: true, page: page(search, h.clock.now()) }); await tick(); assert.deepEqual(rows(h.db), []);
});

test("capture does not hold the shared DB boundary and completion rechecks after another transaction", async (t) => {
  const h = fixture(t), pending = deferred<TransportResult>(); h.deps.capture = () => pending.promise;
  const request = h.service.get(search); await tick();
  await withDatabase(h.db, async () => { h.db.exec("CREATE TABLE independent_work(id INTEGER)"); });
  const unlock = await acquireDatabase(h.db); pending.resolve({ ok: true, page: page(search, h.clock.now()) }); await tick();
  assert.deepEqual(rows(h.db), []); h.policy.revision = "changed"; unlock(); failed(await request, "policy_changed");
});

test("HTTP retention honors no-store/private/no-cache, shorter lifetimes, age and revalidation", async (t) => {
  for (const directive of ["no-store", "private", 'private="Set-Cookie"', "no-cache", "max-age=bad", "max-age=0"]) {
    const h = fixture(t); h.deps.capture = async () => ({ ok: true, page: { ...page(search, h.clock.now()), headers: { "content-type": "text/html", "cache-control": directive } } });
    success(await h.service.get(search)); assert.deepEqual(rows(h.db), []);
  }
  const h = fixture(t); h.deps.capture = async () => ({ ok: true, page: { ...page(search, h.clock.now()),
    headers: { "content-type": "text/html", "cache-control": 'public, max-age="60", s-maxage=30', age: "10" } } });
  const result = success(await h.service.get(search)); assert.equal(Date.parse(result.delivery.expiresAt), h.clock.now() + 20_000);
  await h.clock.advance(20_000); h.deps.capture = async () => ({ ok: false, code: "timeout" }); failed(await h.service.get(search), "timeout");
  const r = retentionFromHeaders({ expires: new Date(h.clock.now() + 5000).toUTCString() }, h.clock.now()); assert.equal(r.maxAgeMs, 5000);
  assert.equal(retentionFromHeaders({ vary: "*" }, h.clock.now()).store, false);
  assert.equal(retentionFromHeaders({ vary: "Cookie" }, h.clock.now()).store, false);
  assert.equal(retentionFromHeaders({ vary: "Accept-Encoding, User-Agent" }, h.clock.now()).store, true);
  assert.equal(retentionFromHeaders({ date: "Sat Oct 24 00:00:00 2026", expires: "Sat Oct 24 00:01:00 2026" }, h.clock.now()).maxAgeMs, 40_000);
  const revalidate = fixture(t); revalidate.deps.capture = async () => ({ ok: true, page: { ...page(search, revalidate.clock.now()), headers: { "content-type": "text/html", "cache-control": "must-revalidate" } } });
  success(await revalidate.service.get(search)); await revalidate.clock.advance(limits.searchFreshMs);
  revalidate.deps.capture = async () => ({ ok: false, code: "timeout" }); failed(await revalidate.service.get(search), "timeout");
});

test("corrupt cache is discarded and repaired; a failed cache write rolls back and keeps prior metadata", async (t) => {
  const h = fixture(t); success(await h.service.get(search));
  h.db.prepare("UPDATE source_metadata_cache SET payload='{}'").run();
  assert.equal(success(await h.service.get(search)).delivery.from, "transport");
  const original = rows(h.db); await h.clock.advance(limits.searchFreshMs);
  h.db.exec("CREATE TRIGGER fail_cache BEFORE UPDATE ON source_metadata_cache BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  failed(await h.service.get(search), "cache_error"); assert.deepEqual(rows(h.db), original);
});

test("bounded cache evicts old entries without changing personal or catalog tables", async (t) => {
  const h = fixture(t), cache = new MetadataCache(h.db);
  for (let i = 0; i <= limits.maxRows; i++) {
    const request: SourceRequest = { sourceId: "zophar", kind: "search", query: String(i) };
    const metadata = validateMetadata(inspectCapturedPage(page(request, h.clock.now() + i)));
    cache.write({ request, sampleKind: "synthetic", parserVersion: PARSER_VERSION, policyRevision: h.policy.revision }, metadata, h.clock.now() + i);
  }
  assert.equal(rows(h.db).length, limits.maxRows);
  assert.equal(h.db.prepare("SELECT 1 FROM source_metadata_cache WHERE request_key='0'").get(), undefined);
  assert.equal((h.db.prepare("SELECT count(*) AS n FROM entity").get() as { n: number }).n, 0);
});

test("catalog removal purges related detail and source searches; pending/cached references cannot resurrect content", async (t) => {
  const h = fixture(t), catalog = new CatalogStore(h.db);
  const [saved] = await catalog.ingestSynthetic(inspectCapturedPage(page(album, h.clock.now())));
  success(await h.service.get(search)); success(await h.service.get(album));
  success(await h.service.get({ sourceId: "khinsider", kind: "search", query: "sample" }));
  await h.clock.advance(limits.searchFreshMs);
  const pending = deferred<TransportResult>(); h.deps.capture = () => pending.promise;
  const request = h.service.get(search); await tick();
  await catalog.removeSource({ sourceEntityId: saved!.sourceEntityId, reason: "rights_request" });
  assert.equal(rows(h.db).length, 1);
  pending.resolve({ ok: true, page: page(search, h.clock.now()) }); failed(await request, "content_removed");
  failed(await h.service.get(album), "content_removed"); assert.equal(rows(h.db).length, 1);
  assert.equal((await catalog.getAlbum(saved!.albumId)).id, saved!.albumId);
});

test("0011 upgrade, reopen and backup recovery preserve cache provenance and durable removal", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-metadata-cache-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "source.sqlite"), db = openDatabase(path); migrate(db, loadMigrations().slice(0, 10));
  const catalog = new CatalogStore(db), [saved] = await catalog.ingestSynthetic(inspectCapturedPage(page(album, Date.parse("2026-10-24T00:00:00Z"))));
  const before = db.prepare("SELECT * FROM entity ORDER BY id").all(); migrate(db); assertMigrated(db);
  assert.deepEqual(db.prepare("SELECT * FROM entity ORDER BY id").all(), before);
  const h = fixture(t, db); success(await h.service.get(search));
  await catalog.removeSource({ sourceEntityId: saved!.sourceEntityId, reason: "policy_change" });
  success(await h.service.get({ sourceId: "khinsider", kind: "search", query: "sample" }));
  const expected = rows(db), backup = join(dir, "backup.sqlite"), restored = join(dir, "restored.sqlite");
  await backupDatabase(db, backup); await restoreDatabase(backup, restored); db.close();
  const reopened = openDatabase(path), recovered = openDatabase(restored); t.after(() => { reopened.close(); recovered.close(); });
  assert.deepEqual(rows(reopened), expected); assert.deepEqual(rows(recovered), expected);
  const recovery = fixture(t, recovered); failed(await recovery.service.get(album), "content_removed");
  assert.equal(success(await recovery.service.get({ sourceId: "khinsider", kind: "search", query: "sample" })).delivery.from, "cache");
});

test("older delayed capture cannot overwrite a newer stored observation", async (t) => {
  const h = fixture(t), cache = new MetadataCache(h.db);
  const context: CacheContext = { request: search, sampleKind: "synthetic", parserVersion: PARSER_VERSION, policyRevision: h.policy.revision };
  const old = validateMetadata(inspectCapturedPage(page(search, h.clock.now())));
  const newer = validateMetadata(inspectCapturedPage(page(search, h.clock.now() + 1000)));
  cache.write(context, newer, h.clock.now() + 1000); const expected = rows(h.db);
  cache.write(context, old, h.clock.now() + 1000); assert.deepEqual(rows(h.db), expected);
});

test("source transport/parser exceptions become explicit refresh failures, not empty results", async (t) => {
  const h = fixture(t); success(await h.service.get(search)); await h.clock.advance(limits.searchFreshMs);
  h.deps.capture = async () => { throw new Error("upstream internal detail"); };
  assert.equal(success(await h.service.get(search)).refreshFailure?.code, "network_error");
  h.deps.capture = async () => ({ ok: true, page: page(search, h.clock.now()) });
  h.deps.parser.parse = () => { throw new Error("parser internal detail"); };
  assert.equal(success(await h.service.get(search)).refreshFailure?.code, "parse_changed");
});

test("total cache bytes are bounded even below the entry count cap", async (t) => {
  const h = fixture(t), cache = new MetadataCache(h.db);
  for (let i = 0; i < 9; i++) {
    const request: SourceRequest = { sourceId: "zophar", kind: "album", externalKey: `nintendo-snes-spc/large-${i}` };
    const metadata = validateMetadata(inspectCapturedPage(page(request, h.clock.now() + i)));
    assert.ok(metadata.data.kind === "album");
    const template = metadata.data.tracks[0]!;
    metadata.data.tracks = Array.from({ length: 4500 }, (_, j) => ({ ...template, position: j + 1, snapshotLocator: `row:${j}`, title: "x".repeat(1000) }));
    cache.write({ request, sampleKind: "synthetic", parserVersion: PARSER_VERSION, policyRevision: h.policy.revision }, metadata, h.clock.now() + i);
  }
  const result = h.db.prepare("SELECT count(*) AS n,sum(length(CAST(payload AS BLOB))) AS bytes FROM source_metadata_cache").get() as { n: number; bytes: number };
  assert.ok(result.n > 0 && result.n < 9); assert.ok(result.bytes <= limits.maxBytes);
});

test("cached metadata cannot extend its TTL or change request identity through edited persisted JSON", async (t) => {
  const h = fixture(t); success(await h.service.get(search));
  h.db.exec("UPDATE source_metadata_cache SET fresh_until=fresh_until+1000");
  assert.equal(success(await h.service.get(search)).delivery.from, "transport");
  h.db.exec(`UPDATE source_metadata_cache SET payload=json_set(payload,'$.provenance.pageUrl','https://www.zophar.net/search?search=other')`);
  assert.equal(success(await h.service.get(search)).delivery.from, "transport");
  assert.equal(h.calls.length, 3);
});
