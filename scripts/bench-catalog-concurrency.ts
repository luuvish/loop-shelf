// Local authenticated inject only. No .env, existing DB, remote requests or fixture HTTP endpoints.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { verifyDatabase } from "../src/database/backup.ts";
import { createAccount } from "../src/auth/accounts.ts";
import { buildApp } from "../src/server/app.ts";
import { CatalogTrackSearchStore } from "../src/catalog/track-search.ts";
import { CatalogBrowseStore } from "../src/catalog/browse.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import type { CatalogTrackSearchPage } from "../src/shared/catalog-track-search.ts";
import type { CatalogLibraryItem, CatalogLibraryPage } from "../src/shared/catalog-library.ts";
import type { CatalogAlbumDetail, CatalogAlbumPage } from "../src/shared/catalog-browse.ts";
import { fixtureVersion, seedBenchmark } from "./benchmarks/catalog-fixture.ts";
import { blockProfilePrefix, prepareProfile, profileAlbum, referenceFile, searchProfiles, type SearchProfile } from "./benchmarks/search-profiles.ts";
import { queryPlans } from "./benchmarks/query-plans.ts";
import { distribution, observeDatabaseTiming, round, type RequestTiming } from "./benchmarks/database-timing.ts";

const { values } = parseArgs({ options: { albums: { type: "string", default: "10000" }, tracks: { type: "string", default: "10" },
  samples: { type: "string", default: "30" }, profile: { type: "string", default: "repeated" }, output: { type: "string" } }, strict: true });
function integer(value: string, min: number, max: number) { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`); return n; }
const albums = integer(values.albums, 20, 10000), tracks = integer(values.tracks, 1, 100), samples = integer(values.samples, 3, 30);
if (!searchProfiles.includes(values.profile as SearchProfile)) throw new Error("Unknown search profile");
const profile = values.profile as SearchProfile;
if (profile === "boundary" && tracks < 2) throw new Error("Boundary profile requires at least two track titles per album");
const levels = [1, 4, 8], warmups = 2, kinds = ["tracks", "albums", "private-list", "private-write", "session", "album-detail"] as const;
type Kind = typeof kinds[number];
interface Sample extends RequestTiming { kind: Kind; ordinal: number; batch: number; slot: number; account: "owner" | "other" }
const codeFiles = ["src/database/access.ts", "src/database/connection.ts", "src/database/backup.ts", "src/auth/options.ts", "src/server/app.ts",
  "src/catalog/track-search.ts", "src/catalog/track-query.ts", "src/catalog/search-index.ts", "src/catalog/track-search-cursor.ts", "src/catalog/album-query.ts", "src/catalog/browse.ts", "src/catalog/entities.ts",
  "src/catalog/retention.ts", "src/library/catalog.ts", "scripts/benchmarks/catalog-fixture.ts", "scripts/benchmarks/query-plans.ts",
  "scripts/benchmarks/search-profiles.ts", referenceFile, "scripts/benchmarks/database-timing.ts", "scripts/bench-catalog-concurrency.ts"];
const code = Object.fromEntries(codeFiles.map((file) => [file, createHash("sha256").update(readFileSync(new URL(`../${file}`, import.meta.url))).digest("hex")]));
const directory = mkdtempSync(join(tmpdir(), "loopshelf-concurrency-")), filename = join(directory, "catalog.sqlite");
const db = openDatabase(filename), config = { baseURL: "http://127.0.0.1:3000", secret: randomBytes(32).toString("hex") };
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const observer = observeDatabaseTiming();
try {
  migrate(db);
  const password = randomBytes(24).toString("hex");
  const owner = await createAccount(db, config, { name: "Benchmark owner", email: "owner@example.test", password });
  const other = await createAccount(db, config, { name: "Benchmark other", email: "other@example.test", password });
  const seedStart = performance.now();
  const fixture = await seedBenchmark(db, owner.id, other.id, albums, tracks, (count) => process.stderr.write(`Seeded ${count}/${albums} synthetic albums\n`), profileAlbum(profile, albums));
  blockProfilePrefix(db, profile, albums);
  const seedMs = performance.now() - seedStart;
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.equal(count("album"), albums); assert.equal(count("track"), albums * tracks); assert.equal(count("catalog_track_binding"), albums * tracks);
  assert.equal(count("library_item"), fixture.counts.personal - fixture.counts.detached + fixture.counts.otherPersonal);
  assert.equal(count("catalog_detached_item"), fixture.counts.detached); assert.equal(count("user_source_link"), fixture.counts.links);
  verifyDatabase(db); db.pragma("wal_checkpoint(TRUNCATE)");
  app = await buildApp(db, config);
  async function login(account: typeof owner) {
    const base = { host: "127.0.0.1:3000", origin: config.baseURL };
    const response = await app!.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: base, payload: { email: account.email, password } });
    assert.equal(response.statusCode, 200);
    const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = await app!.inject({ url: "/api/auth/get-session", headers: { ...base, cookie } });
    assert.equal(session.statusCode, 200); assert.equal(session.json().user.id, account.id);
    return { ...base, cookie, "x-loopshelf-session": session.json().session.id as string };
  }
  const headers = [await login(owner), await login(other)], accounts = [owner, other];
  const library = new CatalogLibraryStore(db), browse = new CatalogBrowseStore(db), search = new CatalogTrackSearchStore(db);
  const ownedIds = accounts.map((account) => new Set((db.prepare(`SELECT id FROM library_item WHERE user_id=? UNION ALL SELECT id FROM catalog_detached_item WHERE user_id=?`).all(account.id, account.id) as { id: string }[]).map((row) => row.id)));
  const writable = accounts.map((account) => (db.prepare("SELECT id FROM library_item WHERE user_id=? ORDER BY id LIMIT 8").all(account.id) as { id: string }[]).map((row) => library.get(account.id, row.id)));
  const albumId = fixture.albumIds.at(-1)!;
  const profileSetup = performance.now(), prepared = prepareProfile(db, profile);
  for (let slot = 0; slot < prepared.inputs.length; slot++) prepared.assertPage(search.search(prepared.inputs[slot]), slot);
  const profileSetupMs = round(performance.now() - profileSetup);
  const expectedAlbums = accounts.map((account) => browse.list(account.id, { q: "Synthetic", limit: 12 }).items);
  const expectedDetail = accounts.map((account) => browse.detail(account.id, albumId, { limit: 12 }));
  const plans = {
    tracks: queryPlans(db, () => search.search(prepared.inputs[1])),
    tracksFirst: queryPlans(db, () => search.search(prepared.inputs[0])),
    albums: queryPlans(db, () => browse.list(owner.id, { q: "Synthetic", limit: 12 })),
    privateList: queryPlans(db, () => library.list(owner.id, { limit: 12 })),
  };
  // Never loosen the auth route's 100/min limit: 3 * (30 + 2) session probes + 2 setup reads = 98 maximum.
  // Within each burst every request starts before awaiting the burst; the next burst waits for all completions.
  async function run(concurrency: number, repeats: number): Promise<Sample[]> {
    const output: Sample[] = [];
    const total = kinds.length * repeats;
    for (let start = 0, batch = 0; start < total; start += concurrency, batch++) {
      const jobs = Array.from({ length: Math.min(concurrency, total - start) }, (_, slot) => {
        const ordinal = start + slot, cycle = Math.floor(ordinal / kinds.length), kind = kinds[ordinal % kinds.length]!;
        const accountIndex = cycle % 2, account = accounts[accountIndex]!, ownHeaders = headers[accountIndex]!;
        const target = writable[accountIndex]![Math.floor(cycle / 2) % writable[accountIndex]!.length]!;
        const trackInput = prepared.inputs[cycle % 2]!;
        const query = new URLSearchParams(Object.entries(trackInput).map(([key, value]) => [key, String(value)]));
        const note = `concurrency-${accountIndex}-${cycle}-${target.version}`;
        const url = kind === "tracks" ? `/api/catalog/tracks?${query}` : kind === "albums" ? "/api/catalog/albums?q=Synthetic&limit=12"
          : kind === "private-list" ? "/api/library/catalog?limit=12" : kind === "private-write" ? `/api/library/catalog/${target.id}`
          : kind === "session" ? "/api/auth/get-session" : `/api/catalog/albums/${albumId}?limit=12`;
        return (async () => {
          const { value: response, timing } = await observer.measure(() => app!.inject({ url, headers: ownHeaders,
            ...(kind === "private-write" ? { method: "PATCH" as const, payload: { version: target.version, note } } : {}) }));
          assert.equal(response.statusCode, 200, `${kind}: ${response.statusCode}`);
          assert.equal(response.headers["cache-control"], "no-store"); assert.ok(timing.turns >= 1, `Missing DB correlation: ${kind}`);
          if (kind === "session") {
            const result = response.json(); assert.equal(result.user.id, account.id); assert.equal(result.session.id, ownHeaders["x-loopshelf-session"]);
          } else {
            assert.equal(response.headers["x-loopshelf-user"], account.id); assert.equal(response.headers["x-loopshelf-session"], ownHeaders["x-loopshelf-session"]);
            if (kind === "tracks") { const result = response.json<CatalogTrackSearchPage>(); prepared.assertPage(result, cycle % 2); }
            if (kind === "albums") assert.deepEqual(response.json<CatalogAlbumPage>().items, expectedAlbums[accountIndex]);
            if (kind === "album-detail") assert.deepEqual(response.json<CatalogAlbumDetail>(), expectedDetail[accountIndex]);
            if (kind === "private-list") { const items = response.json<CatalogLibraryPage>().items; assert.ok(items.length); for (const item of items) assert.ok(ownedIds[accountIndex]!.has(item.id)); }
            if (kind === "private-write") {
              const item = response.json<CatalogLibraryItem>(); assert.equal(item.id, target.id); assert.equal(item.entity.id, target.entity.id);
              assert.equal(item.note, note); assert.ok(item.version > target.version);
              assert.equal(item.favorite, target.favorite); assert.equal(item.titleOverride, target.titleOverride);
              Object.assign(target, item);
            }
          }
          return { kind, ordinal, batch, slot, account: accountIndex === 0 ? "owner" as const : "other" as const, ...timing };
        })();
      });
      // Finish every request, including after an assertion failure, before closing the DB.
      const settled = await Promise.allSettled(jobs);
      for (const result of settled) { if (result.status === "rejected") throw result.reason; output.push(result.value); }
    }
    return output;
  }
  const measurements = [];
  for (const concurrency of levels) {
    await run(concurrency, warmups);
    const started = performance.now(), raw = await run(concurrency, samples), elapsed = performance.now() - started;
    const byKind = kinds.map((kind) => {
      const rows = raw.filter((row) => row.kind === kind); assert.equal(rows.length, samples);
      return { kind, count: rows.length, total: distribution(rows.map((r) => r.totalMs)), wait: distribution(rows.map((r) => r.waitMs)),
        held: distribution(rows.map((r) => r.heldMs)), outside: distribution(rows.map((r) => r.outsideMs)) };
    });
    measurements.push({ concurrency, requests: raw.length, elapsedMs: round(elapsed), requestsPerSecond: round(raw.length * 1000 / elapsed),
      total: distribution(raw.map((r) => r.totalMs)), byKind,
      samples: raw.map((row) => ({ ...row, totalMs: round(row.totalMs), waitMs: round(row.waitMs), heldMs: round(row.heldMs), outsideMs: round(row.outsideMs) })) });
    process.stderr.write(`Concurrency ${concurrency}: ${raw.length} requests, p95 ${measurements.at(-1)!.total.p95Ms} ms\n`);
  }
  // Post-measurement ownership check, never count expected denials as fast successful samples.
  const crossRead = await app.inject({ url: `/api/library/catalog/${writable[0]![0]!.id}`, headers: headers[1]! });
  assert.equal(crossRead.statusCode, 404);
  const crossWrite = await app.inject({ method: "PATCH", url: `/api/library/catalog/${writable[0]![0]!.id}`, headers: headers[1]!, payload: { version: writable[0]![0]!.version, note: "must-not-write" } });
  assert.equal(crossWrite.statusCode, 404); assert.equal(library.get(owner.id, writable[0]![0]!.id).note, writable[0]![0]!.note);
  verifyDatabase(db); db.pragma("wal_checkpoint(TRUNCATE)");
  const report = { measuredAt: new Date().toISOString(), fixtureVersion, fixture: fixture.counts, searchProfile: prepared.summary, profileSetupMs, seedMs: round(seedMs), databaseBytes: statSync(filename).size,
    environment: { node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS version").get(), platform: platform(), release: release(), arch: process.arch,
      cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: round(totalmem() / 1024 ** 3), pragmas: Object.fromEntries(["journal_mode", "synchronous", "cache_size", "page_size", "automatic_index"].map((key) => [key, db.pragma(key, { simple: true })])) },
    method: { layer: "authenticated-inject", levels, samplesPerKind: samples, warmupsPerKind: warmups, percentile: "nearest-rank", analyze: false,
      scheduler: "bounded simultaneous bursts; fixed rotating six-operation mix, alternating real accounts; next burst after all settlements; final burst may be partial",
      cache: "same connection after ingestion and two warmup cycles per level; warm OS cache; not cold-disk",
      timing: "total starts before inject and ends after response; wait includes queue/resumption; held includes async auth and synchronous queries; outside includes dispatch/serialization/event-loop contention; TCP/browser excluded",
      workload: "equal tracks/albums/private-list/private-write/session/album-detail; two profile-specific track pages alternate (see searchProfile); one SQLite connection/process",
      limits: "unchanged authentication quotas; at most 98 get-session calls including setup; no unbounded arrival-rate/load or deployment claim" },
    checks: { exactPublicPages: true, independentTrackReference: true, ownPrivateIds: true, writesPreserveIdsAndOtherFields: true, crossUserReadAndWriteDenied: true, integrityAndForeignKeys: true },
    migrations: db.prepare("SELECT name,sha256 FROM schema_migration ORDER BY name").all(), code, plans,
    targetMs: 300, passed: measurements.every((m) => m.byKind.every((k) => k.total.p95Ms <= 300)), measurements };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) writeFileSync(values.output, json, { flag: "wx", mode: 0o600 }); else process.stdout.write(json);
  process.stderr.write(`Complete: ${report.passed ? "within" : "outside"} 300 ms p95 reference; temporary DB will be removed.\n`);
} finally {
  observer.close(); if (app) await app.close(); db.close(); rmSync(directory, { recursive: true, force: true });
}
