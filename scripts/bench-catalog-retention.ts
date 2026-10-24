// Isolated query-cost probe; never opens an operating DB or contacts a source.
import { performance } from "node:perf_hooks";
import { cpus, platform, totalmem } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { reconcileCatalogRetention } from "../src/catalog/retention.ts";
import { syntheticAlbum } from "./benchmarks/catalog-fixture.ts";
import { queryPlans } from "./benchmarks/query-plans.ts";

const { values } = parseArgs({ options: { output: { type: "string" } }, strict: true });
const db = openDatabase(":memory:");
try {
  migrate(db);
  const sample = syntheticAlbum(1, 10), now = Date.now();
  sample.provenance.capturedAt = new Date(now - 1000).toISOString(); sample.provenance.parsedAt = sample.provenance.capturedAt;
  await new CatalogStore(db).ingestSynthetic(sample);
  // Synthetic history distribution: 10,000 observations of one album, 10 rows per stored DTO.
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<9999)
    INSERT INTO catalog_observation(id,source_entity_id,kind,sample_kind,page_url,captured_at,parsed_at,parser_version,body_sha256,fingerprint,data_sha256,tracks_sha256,data_json,warnings_json)
    SELECT printf('probe-%d',i),source_entity_id,kind,sample_kind,page_url,captured_at,parsed_at,parser_version,body_sha256,printf('%064d',i),data_sha256,tracks_sha256,data_json,warnings_json FROM n CROSS JOIN catalog_observation`);
  const index = (db.prepare("SELECT sql FROM sqlite_schema WHERE name='catalog_observation_retention_idx'").get() as { sql: string }).sql;
  const measure = () => {
    for (let i = 0; i < 3; i++) reconcileCatalogRetention(db, now);
    const times: number[] = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); reconcileCatalogRetention(db, now); times.push(performance.now() - start); }
    const sorted = times.toSorted((a, b) => a - b);
    return { p50Ms: sorted[14], p95Ms: sorted[28], samplesMs: times, queries: queryPlans(db, () => reconcileCatalogRetention(db, now)) };
  };
  const measurements = [];
  for (const distribution of ["legacy-unleased", "future-synthetic-lease"]) {
    if (distribution === "future-synthetic-lease") db.prepare("UPDATE catalog_observation SET retention_revision='probe-only',expires_at=?").run(new Date(now + 3600000).toISOString());
    db.exec("DROP INDEX catalog_observation_retention_idx"); const withoutIndex = measure();
    db.exec(index); measurements.push({ distribution, withoutIndex, withIndex: measure() });
  }
  const files = ["src/catalog/retention.ts", "migrations/0012_catalog_retention.sql", "scripts/bench-catalog-retention.ts"];
  const report = { measuredAt: new Date().toISOString(), fixture: { sampleKind: "synthetic", albums: 1, tracks: 10, observations: 10000, retainedDtoRows: 100000 },
    environment: { node: process.version, sqlite: db.prepare("SELECT sqlite_version() AS version").get(), platform: platform(), arch: process.arch, cpu: cpus()[0]?.model, memoryGiB: totalmem() / 1024 ** 3 },
    method: { concurrency: 1, storage: "in-memory", analyze: false, warmups: 3, samples: 30, percentile: "nearest-rank", scope: "retention reconciliation only, no expiration writes, network, auth or browser" },
    code: Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(new URL(`../${file}`, import.meta.url))).digest("hex")])), measurements };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.output) writeFileSync(values.output, json, { flag: "wx", mode: 0o600 }); else process.stdout.write(json);
} finally { db.close(); }
