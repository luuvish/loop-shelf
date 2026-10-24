import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { TestContext } from "node:test";
import { openDatabase } from "../../src/database/connection.ts";
import { migrate } from "../../src/database/migrate.ts";
import { createSourceAlbumService } from "../../src/source-album/service.ts";
import type { SourceAlbumDelivery, SourceAlbumResponse, SourceAlbumResult } from "../../src/shared/source-album.ts";
import type { MetadataPolicy } from "../../src/sources/adapters/contracts.ts";
import type { SourceAdapter } from "../../src/sources/adapters.ts";
import type { SourceId } from "../../src/sources/types.ts";
import type { TransportClock } from "../../src/sources/transport/contracts.ts";
import { syntheticAlbum } from "../../scripts/benchmarks/catalog-fixture.ts";

export const input = { sourceId: "zophar" as const, externalKey: "nintendo-snes-spc/benchmark-00001" };
export const tick = () => setImmediate();
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
export class Clock implements TransportClock {
  time = Date.parse("2026-10-24T01:00:00Z");
  timers = new Set<{ at: number; callback: () => void }>();
  now = () => this.time;
  timer(ms: number, callback: () => void) { const timer = { at: this.time + ms, callback }; this.timers.add(timer); return () => { this.timers.delete(timer); }; }
  async advance(ms: number) {
    const end = this.time + ms; await tick();
    while (true) { const next = [...this.timers].sort((a, b) => a.at - b.at)[0]; if (!next || next.at > end) break;
      this.time = next.at; this.timers.delete(next); next.callback(); await tick(); }
    this.time = end; await tick();
  }
}
export function allowed(): MetadataPolicy { return { revision: "synthetic-policy-v1", collect: { allowed: true }, cache: { allowed: true }, display: { allowed: true } }; }
export function envelope(value: SourceAlbumResult): SourceAlbumResponse { assert.ok(value.ok, JSON.stringify(value)); return value; }
export function failure(value: { ok: boolean }, code: string) { assert.ok(!value.ok, JSON.stringify(value)); assert.equal((value as { code?: string }).code, code); }
export function delivery(now: number): SourceAlbumDelivery {
  const value = syntheticAlbum(1, 4); assert.equal(value.data.kind, "album");
  if (value.data.kind !== "album") throw new Error("Expected album fixture");
  return { ...value, data: value.data, provenance: { ...value.provenance, capturedAt: new Date(now).toISOString(), parsedAt: new Date(now).toISOString() },
    delivery: { from: "transport", freshness: "fresh", freshUntil: new Date(now + 60_000).toISOString(), expiresAt: new Date(now + 120_000).toISOString() } };
}
export function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const clock = new Clock(), policies = { khinsider: allowed(), zophar: allowed() };
  const calls: { sourceId: SourceId; key: string; signal: AbortSignal | undefined }[] = [];
  const adapter = (sourceId: SourceId): Pick<SourceAdapter, "getAlbum"> => ({ getAlbum: async (key, signal) => {
    calls.push({ sourceId, key, signal }); return delivery(clock.now());
  } });
  const adapters = { khinsider: adapter("khinsider"), zophar: adapter("zophar") };
  const deps = { sampleKind: "synthetic" as const, adapters, policy: (sourceId: SourceId) => policies[sourceId], clock };
  return { db, clock, policies, calls, adapters, deps, service: createSourceAlbumService(db, deps) };
}
