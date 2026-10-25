// SQL experiments only, in a new disposable synthetic DB. Never open .env or an existing DB.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate } from "../src/database/migrate.ts";
import { seedBenchmark } from "./benchmarks/catalog-fixture.ts";
import { distribution, round } from "./benchmarks/database-timing.ts";

const { values } = parseArgs({ options: { albums: { type: "string", default: "10000" }, samples: { type: "string", default: "5" }, output: { type: "string" } }, strict: true });
const albums = Number(values.albums), samples = Number(values.samples);
assert.ok(Number.isInteger(albums) && albums >= 20 && albums <= 10000);
assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 30);
const dir = mkdtempSync(join(tmpdir(), "loopshelf-offset-probe-")), db = openDatabase(join(dir, "catalog.sqlite"));
try {
  migrate(db, loadMigrations().slice(0, 15));
  const users = [randomUUID(), randomUUID()];
  for (const id of users) db.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'Probe',?,0,'now','now')`).run(id, `${id}@example.test`);
  await seedBenchmark(db, users[0]!, users[1]!, albums, 10, (n) => process.stderr.write(`Seeded ${n}/${albums}\n`));
  const evidence = readFileSync(new URL("../docs/evidence/2026-10-25-search-profile-catalog.json", import.meta.url));
  const baseline = JSON.parse(evidence.toString()) as { measurements: { name: string; queries: { sql: string }[] }[] };
  const sql = baseline.measurements.find((m) => m.name === "tracks-deep-page")!.queries.find((q) => q.sql.startsWith("WITH eligible"))!.sql;
  const params = { q: "synthetic", limit: 101, offset: albums * 10 - 100 };
  const expected = db.prepare(sql).all(params);
  const from = "FROM track t INDEXED BY catalog_track_search_title_idx CROSS JOIN eligible e ON e.albumId=t.album_id\n    CROSS JOIN catalog_track_binding b ON b.observation_id=e.observationId AND b.track_id=t.id";
  assert.ok(sql.includes(from));
  const albumFirst = (s: string, indexed = false) => s.replace(from, `FROM eligible e CROSS JOIN catalog_track_binding b ON b.observation_id=e.observationId
    CROSS JOIN track t ${indexed ? "INDEXED BY probe_track_album_title" : ""} ON t.id=b.track_id AND t.album_id=e.albumId`);
  const covers = (s: string) => s.replace("catalog_track_binding b ON", "catalog_track_binding b INDEXED BY probe_binding_cover ON")
    .replace("entity track_entity ON", "entity track_entity INDEXED BY probe_entity_cover ON")
    .replace("catalog_track_origin origin ON", "catalog_track_origin origin INDEXED BY probe_origin_cover ON");
  const inactiveSet = (s: string) => s.replace("CROSS JOIN entity track_entity ON track_entity.id=t.id", "")
    .replace("WHERE track_entity.lifecycle='active' AND", "WHERE t.id NOT IN (SELECT id FROM entity NOT INDEXED WHERE lifecycle<>'active') AND");
  const hoistOrigins = (s: string) => inactiveSet(s).replace("WITH eligible", `WITH origin_sources AS MATERIALIZED (
    SELECT o.track_id AS trackId,f.source_entity_id AS sourceEntityId
    FROM catalog_track_origin o CROSS JOIN catalog_observation f ON f.id=o.observation_id
  ), eligible`).replace("JOIN catalog_track_origin origin ON origin.track_id=t.id\n    JOIN catalog_observation first_seen ON first_seen.id=origin.observation_id AND first_seen.source_entity_id=e.sourceEntityId",
    "JOIN origin_sources os ON os.trackId=t.id AND os.sourceEntityId=e.sourceEntityId");
  const variants = [
    { name: "baseline", setup: "", transform: (s: string) => s },
    { name: "album-first", setup: "", transform: (s: string) => albumFirst(s) },
    { name: "album-title-index", setup: "CREATE INDEX probe_track_album_title ON track(album_id,normalize_search(title),id)", transform: (s: string) => s.replace(from, `FROM eligible e CROSS JOIN track t INDEXED BY probe_track_album_title ON t.album_id=e.albumId
    CROSS JOIN catalog_track_binding b ON b.observation_id=e.observationId AND b.track_id=t.id`) },
    { name: "covering-lookups", setup: `CREATE INDEX probe_binding_cover ON catalog_track_binding(observation_id,track_id,position);
      CREATE INDEX probe_entity_cover ON entity(id,lifecycle); CREATE INDEX probe_origin_cover ON catalog_track_origin(track_id,observation_id);`, transform: covers },
    { name: "album-first-covering", setup: "", transform: (s: string) => covers(albumFirst(s)) },
    { name: "album-title-covering", setup: "", transform: (s: string) => covers(s.replace(from, `FROM eligible e CROSS JOIN track t INDEXED BY probe_track_album_title ON t.album_id=e.albumId
    CROSS JOIN catalog_track_binding b ON b.observation_id=e.observationId AND b.track_id=t.id`)) },
    { name: "inactive-set", setup: "DROP INDEX probe_binding_cover; DROP INDEX probe_entity_cover; DROP INDEX probe_origin_cover; DROP INDEX probe_track_album_title;", transform: inactiveSet },
    { name: "hoisted-origins", setup: "", transform: hoistOrigins },
    { name: "cache-64-baseline", setup: "PRAGMA cache_size=-65536", transform: (s: string) => s },
    { name: "cache-64-inactive-set", setup: "", transform: inactiveSet },
    { name: "cache-64-hoisted-origins", setup: "", transform: hoistOrigins },
    { name: "materialized-search", setup: `PRAGMA cache_size=-16000;
      CREATE TABLE probe_search AS SELECT id,sortTitle,sourceId,externalKey,position,albumId FROM (${sql.replaceAll("@q", "'synthetic'").replaceAll("@limit", "-1").replaceAll("@offset", "0")});
      CREATE INDEX probe_search_order ON probe_search(sortTitle,sourceId,externalKey,position,id);`,
      transform: (s: string) => s.replace("WITH eligible", `WITH page_ids AS MATERIALIZED (
        SELECT * FROM probe_search WHERE instr(sortTitle,@q)>0 ORDER BY sortTitle,sourceId,externalKey,position,id LIMIT @limit OFFSET @offset
      ), eligible`).replace("FROM album a CROSS JOIN", "FROM (SELECT DISTINCT albumId FROM page_ids) p CROSS JOIN album a ON a.id=p.albumId CROSS JOIN")
        .replace(from, `FROM page_ids p CROSS JOIN track t ON t.id=p.id CROSS JOIN eligible e ON e.albumId=t.album_id
          CROSS JOIN catalog_track_binding b ON b.observation_id=e.observationId AND b.track_id=t.id`)
        .replace("ORDER BY sortTitle,e.sourceId,e.externalKey,b.position,t.id LIMIT @limit OFFSET @offset", "ORDER BY sortTitle,e.sourceId,e.externalKey,b.position,t.id LIMIT @limit") },
  ];
  const measurements = [];
  for (const variant of variants) {
    if (variant.setup) db.exec(variant.setup);
    const query = variant.transform(sql); assert.deepEqual(db.prepare(query).all(params), expected);
    const raw = [];
    for (let i = 0; i < samples + 2; i++) { const start = performance.now(); db.prepare(query).all(params); if (i >= 2) raw.push(performance.now() - start); }
    const result = { name: variant.name, setup: variant.setup, sql: query, ...distribution(raw), samplesMs: raw.map(round), plan: db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(params) };
    measurements.push(result); process.stderr.write(`${variant.name}: ${result.p95Ms} ms\n`);
  }
  const report = { measuredAt: new Date().toISOString(), environment: { cpu: cpus()[0]?.model, node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS version").get() },
    method: { albums, tracks: albums * 10, samples, warmups: 2, concurrency: 1, analyze: false, cache: "warm same connection; variants in listed order", scope: "SQL prepare/execute; exact baseline rows; no auth/projection/TCP", preliminary: true },
    baselineSha256: createHash("sha256").update(evidence).digest("hex"), params, measurements };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) writeFileSync(values.output, json, { flag: "wx", mode: 0o600 }); else process.stdout.write(json);
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
