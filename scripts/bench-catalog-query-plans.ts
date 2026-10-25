// Experimental indexes/plans are confined to this new disposable synthetic database.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate } from "../src/database/migrate.ts";
import { withDatabase } from "../src/database/access.ts";
import { seedBenchmark } from "./benchmarks/catalog-fixture.ts";
import { distribution, round } from "./benchmarks/database-timing.ts";
import { trackQuery } from "../src/catalog/track-query.ts";

const { values } = parseArgs({ options: { albums: { type: "string", default: "10000" }, samples: { type: "string", default: "5" }, output: { type: "string" } }, strict: true });
const albums = Number(values.albums), samples = Number(values.samples);
assert.ok(Number.isInteger(albums) && albums >= 20 && albums <= 10000);
assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 30);
const dir = mkdtempSync(join(tmpdir(), "loopshelf-query-probe-")), db = openDatabase(join(dir, "catalog.sqlite"));
const prepare = db.prepare;
try {
  // This probe compares 0014 baseline SQL from an evidence file, even after product SQL advances.
  migrate(db, loadMigrations().filter((m) => m.name <= "0014_catalog_track_search.sql"));
  const users = [randomUUID(), randomUUID()];
  for (const id of users) db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,\'Probe\',?,0,\'now\',\'now\')').run(id, `${id}@example.test`);
  await seedBenchmark(db, users[0]!, users[1]!, albums, 10, (n) => process.stderr.write(`Seeded ${n}/${albums}\n`));
  const evidenceFile = new URL("../docs/evidence/2026-10-25-catalog-concurrency-final.json", import.meta.url);
  const evidence = JSON.parse(readFileSync(evidenceFile, "utf8")) as { plans: Record<string, { sql: string }[]> };
  const cursorSql = evidence.plans.tracks!.find((q) => q.sql.includes("@afterTitle"))!.sql;
  const firstSql = cursorSql.replace("AND normalize_search(t.title)>=@afterTitle\n    AND (normalize_search(t.title),e.sourceId,e.externalKey,b.position,t.id)>(@afterTitle,@afterSource,@afterKey,@afterPosition,@afterId)", "").replace("LIMIT @limit ", "LIMIT @limit OFFSET @offset");
  const albumSql = evidence.plans.albums!.find((q) => q.sql.includes("ORDER BY normalize_search(a.title)"))!.sql;
  const firstParams = { q: "synthetic", limit: 13, offset: 0 };
  const first = db.prepare(firstSql).all(firstParams) as { id: string; sortTitle: string; sourceId: string; externalKey: string; position: number }[];
  assert.equal(first.length, 13); const anchor = first[11]!;
  const probes = [{ name: "tracks-first", sql: firstSql, args: [firstParams] },
    { name: "tracks-next", sql: cursorSql, args: [{ q: "synthetic", limit: 13, afterTitle: anchor.sortTitle, afterSource: anchor.sourceId, afterKey: anchor.externalKey, afterPosition: anchor.position, afterId: anchor.id }] },
    { name: "albums-first", sql: albumSql, args: [firstParams] }];
  const before = probes.map((p) => { const statement = db.prepare(p.sql); return Reflect.apply(statement.all, statement, p.args); });
  const variants = [
    { name: "baseline", setup: "", transform: (s: string) => s },
    { name: "album-title-index", setup: "CREATE INDEX probe_album_title_idx ON album(normalize_search(title),id)", transform: (s: string) => s },
    { name: "observation-covering-auto", setup: "CREATE INDEX probe_observation_read_idx ON catalog_observation(id,content_state,tracks_sha256,captured_at,parser_version,expires_at)", transform: (s: string) => s },
    { name: "observation-covering-forced", setup: "", transform: (s: string) => s.replace(/catalog_observation (title_evidence|adopted|latest|retained_title) ON/gu, "catalog_observation $1 INDEXED BY probe_observation_read_idx ON") },
    { name: "observation-covering-inline", setup: "", transform: (s: string) => s.replace(/catalog_observation (title_evidence|adopted|latest|retained_title) ON/gu, "catalog_observation $1 INDEXED BY probe_observation_read_idx ON").replace("eligible AS MATERIALIZED", "eligible AS NOT MATERIALIZED") },
    { name: "bounded-source-window", setup: "DROP INDEX probe_observation_read_idx", transform: (s: string) => s },
  ];
  const measurements = [];
  for (const variant of variants) {
    if (variant.setup) db.exec(variant.setup);
    const rows = [];
    for (const [i, probe] of probes.entries()) {
      const window = variant.name === "bounded-source-window" && probe.name.startsWith("tracks");
      const sql = window ? trackQuery("", "window", probe.name === "tracks-next") : variant.transform(probe.sql), times: number[] = [];
      const params = probe.args[0]!;
      const titleSql = `SELECT normalize_search(title) AS title FROM track INDEXED BY catalog_track_search_title_idx
        WHERE instr(normalize_search(title),@q)>0 ${probe.name === "tracks-next" ? "AND normalize_search(title)>=@afterTitle" : ""} ORDER BY normalize_search(title) LIMIT 1`;
      const windowArgs = { ...params, firstTitle: anchor.sortTitle };
      const run = () => {
        if (window) { const title = db.prepare(titleSql).get(params) as { title: string }; windowArgs.firstTitle = title.title; }
        const statement = db.prepare(sql), result = Reflect.apply(statement.all, statement, window ? [windowArgs] : probe.args) as unknown[];
        if (window && result.length < params.limit) {
          const fallback = db.prepare(probe.sql); return Reflect.apply(fallback.all, fallback, probe.args);
        }
        return result;
      };
      assert.deepEqual(run(), before[i]);
      for (let n = 0; n < 2 + samples; n++) {
        const elapsed = await withDatabase(db, async () => { const start = performance.now(); run(); return performance.now() - start; });
        if (n >= 2) times.push(elapsed);
      }
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
      rows.push({ name: probe.name, ...distribution(times), samplesMs: times.map(round), sql, ...(window ? { titleSql, fallbackSql: probe.sql } : {}), plan: Reflect.apply(plan.all, plan, window ? [windowArgs] : probe.args) });
      process.stderr.write(`${variant.name}/${probe.name}: ${rows.at(-1)!.p95Ms} ms\n`);
    }
    measurements.push({ variant: variant.name, setup: variant.setup, rows });
  }
  const report = { measuredAt: new Date().toISOString(), environment: { cpu: cpus()[0]?.model, node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS version").get() },
    method: { albums, tracks: albums * 10, samples, warmups: 2, concurrency: 1, analyze: false, cache: "warm, same disposable connection; variants run in listed order", scope: "SQL preparation and execution only; actual rows equal baseline; no auth/projection/TCP", preliminary: true },
    baselineEvidenceSha256: createHash("sha256").update(readFileSync(evidenceFile)).digest("hex"), measurements };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) writeFileSync(values.output, json, { flag: "wx", mode: 0o600 }); else process.stdout.write(json);
} finally { db.prepare = prepare; db.close(); rmSync(dir, { recursive: true, force: true }); }
