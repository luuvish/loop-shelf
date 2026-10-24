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
import { withDatabase } from "../src/database/access.ts";
import { createAccount } from "../src/auth/accounts.ts";
import { buildApp } from "../src/server/app.ts";
import { CatalogBrowseStore } from "../src/catalog/browse.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { queryPlans } from "./benchmarks/query-plans.ts";
import { fixtureVersion, seedBenchmark } from "./benchmarks/catalog-fixture.ts";

const { values } = parseArgs({ options: { albums: { type: "string", default: "10000" }, tracks: { type: "string", default: "10" },
  samples: { type: "string", default: "30" }, output: { type: "string" } }, strict: true });
function integer(value: string, min: number, max: number) { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`); return n; }
const albums = integer(values.albums, 20, 10000), tracks = integer(values.tracks, 1, 100), samples = integer(values.samples, 3, 100);
const codeFiles = ["src/catalog/retention.ts", "src/catalog/album-query.ts", "src/catalog/browse.ts", "src/catalog/entities.ts", "src/library/catalog.ts", "scripts/benchmarks/catalog-fixture.ts", "scripts/benchmarks/query-plans.ts", "scripts/bench-catalog.ts"];
const code = Object.fromEntries(codeFiles.map((file) => [file, createHash("sha256").update(readFileSync(new URL(`../${file}`, import.meta.url))).digest("hex")]));
const directory = mkdtempSync(join(tmpdir(), "loopshelf-bench-")), filename = join(directory, "catalog.sqlite");
const db = openDatabase(filename), config = { baseURL: "http://127.0.0.1:3000", secret: randomBytes(32).toString("hex") };
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

const round = (n: number) => Math.round(n * 1000) / 1000;
function stats(times: number[], firstMs: number) {
  const sorted = [...times].sort((a, b) => a - b);
  return { firstMs: round(firstMs), p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]!), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]!),
    maxMs: round(sorted.at(-1)!), samplesMs: times.map(round) };
}
try {
  migrate(db);
  const password = randomBytes(24).toString("hex");
  const owner = await createAccount(db, config, { name: "Benchmark", email: "benchmark@example.test", password });
  const other = await createAccount(db, config, { name: "Other", email: "other@example.test", password });
  const seedStart = performance.now();
  const fixture = await seedBenchmark(db, owner.id, other.id, albums, tracks, (count) => process.stderr.write(`Seeded ${count}/${albums} synthetic albums\n`));
  const seedMs = performance.now() - seedStart;
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.equal(count("album"), albums); assert.equal(count("track"), albums * tracks);
  assert.equal(count("catalog_track_binding"), albums * tracks);
  assert.equal(count("library_item"), fixture.counts.personal - fixture.counts.detached + fixture.counts.otherPersonal);
  assert.equal(count("catalog_detached_item"), fixture.counts.detached); assert.equal(count("user_source_link"), fixture.counts.links);
  verifyDatabase(db); db.pragma("wal_checkpoint(TRUNCATE)");
  const browse = new CatalogBrowseStore(db), library = new CatalogLibraryStore(db), last = String(albums - 1).padStart(5, "0");
  const cases = [
    { name: "albums-first", run: () => browse.list(owner.id, {}) },
    { name: "albums-common", run: () => browse.list(owner.id, { q: "Synthetic" }) },
    { name: "albums-selective", run: () => browse.list(owner.id, { q: `Album ${last}` }) },
    { name: "albums-no-match", run: () => browse.list(owner.id, { q: "absent-title" }) },
    { name: "albums-korean-1", run: () => browse.list(owner.id, { q: "숲" }) },
    { name: "albums-japanese-2", run: () => browse.list(owner.id, { q: "記憶" }) },
    { name: "albums-normalized", run: () => browse.list(owner.id, { q: "fantasy" }) },
    { name: "albums-literal", run: () => browse.list(owner.id, { q: "%_" }) },
    { name: "albums-source-page", run: () => browse.list(owner.id, { sourceId: "zophar", offset: 100, limit: 100 }) },
    { name: "albums-deep-page", run: () => browse.list(owner.id, { offset: Math.max(0, albums - 100), limit: 100 }) },
    { name: "album-tracks", run: () => browse.detail(owner.id, fixture.albumIds.at(-1)!, { limit: 100 }) },
    { name: "candidates-first", run: () => browse.candidates(owner.id, fixture.savedIds[0]!, {}) },
    { name: "candidates-no-match", run: () => browse.candidates(owner.id, fixture.savedIds[0]!, { q: "absent-title" }) },
    { name: "library-first", run: () => library.list(owner.id, { limit: 12 }) },
    { name: "library-no-match", run: () => library.list(owner.id, { q: "absent-title", limit: 12 }) },
    { name: "library-private-note", run: () => library.list(owner.id, { q: "private-00003", limit: 12 }) },
    { name: "library-short", run: () => library.list(owner.id, { q: "記憶", limit: 12 }) },
    { name: "library-source-title", run: () => library.list(owner.id, { q: `Album ${last}`, limit: 12 }) },
    { name: "library-unresolved", run: () => library.list(owner.id, { q: "미연결", limit: 12 }) },
    { name: "library-filter-page", run: () => library.list(owner.id, { kind: "track", favorite: "true", limit: 100, offset: 100 }) },
    { name: "library-deep-page", run: () => library.list(owner.id, { offset: Math.max(0, fixture.counts.personal - 100), limit: 100 }) },
  ];
  const measurements = [];
  for (const item of cases) {
    const measure = async () => withDatabase(db, async () => { const start = performance.now(); item.run(); return performance.now() - start; });
    const firstMs = await measure(); for (let i = 0; i < 3; i++) await measure();
    const times = []; for (let i = 0; i < samples; i++) times.push(await measure());
    const result = { name: item.name, layer: "service", ...stats(times, firstMs), queries: queryPlans(db, item.run) };
    measurements.push(result); process.stderr.write(`${item.name}: p95 ${result.p95Ms} ms\n`);
  }
  app = await buildApp(db, config);
  const signIn = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { host: "127.0.0.1:3000", origin: config.baseURL }, payload: { email: owner.email, password } });
  assert.equal(signIn.statusCode, 200);
  const headers = { host: "127.0.0.1:3000", cookie: signIn.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") };
  for (const url of ["/api/catalog/albums?q=absent-title", `/api/catalog/albums/${fixture.albumIds.at(-1)}`, "/api/library/catalog?q=absent-title"]) {
    const measure = async () => { const start = performance.now(), response = await app!.inject({ url, headers }); const elapsed = performance.now() - start;
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers["cache-control"], "no-store"); return elapsed; };
    const firstMs = await measure(); for (let i = 0; i < 3; i++) await measure();
    const times = []; for (let i = 0; i < samples; i++) times.push(await measure());
    measurements.push({ name: url.replace(fixture.albumIds.at(-1)!, ":albumId"), layer: "authenticated-inject", ...stats(times, firstMs), queries: [] });
  }
  const report = { measuredAt: new Date().toISOString(), fixtureVersion, fixture: fixture.counts, seedMs: round(seedMs), databaseBytes: statSync(filename).size,
    environment: { node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS version").get(), platform: platform(), release: release(), arch: process.arch,
      cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: round(totalmem() / 1024 ** 3), pragmas: Object.fromEntries(["journal_mode", "synchronous", "cache_size", "page_size", "automatic_index"].map((key) => [key, db.pragma(key, { simple: true })])) },
    method: { samples, warmups: 3, percentile: "nearest-rank", concurrency: 1, analyze: false,
      cache: "same connection after service ingestion; warm OS cache; first is not a cold-disk measurement", timing: "service includes query preparation and projection; authenticated-inject includes auth/serialization but not TCP/browser or queue contention" },
    migrations: db.prepare("SELECT name,sha256 FROM schema_migration ORDER BY name").all(),
    code,
    targetMs: 300, passed: measurements.every((row) => row.p95Ms <= 300), measurements };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) writeFileSync(values.output, json, { flag: "wx", mode: 0o600 }); else process.stdout.write(json);
  process.stderr.write(`Complete: ${report.passed ? "within" : "outside"} 300 ms p95 target; temporary DB will be removed.\n`);
} finally {
  if (app) await app.close(); db.close(); rmSync(directory, { recursive: true, force: true });
}
