import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { databaseTurnChannel, type DatabaseTurnTiming } from "../../src/database/access.ts";

export interface RequestTiming extends DatabaseTurnTiming { totalMs: number; outsideMs: number; turns: number }
export const round = (n: number) => Math.round(n * 1000) / 1000;
export function distribution(values: number[]) {
  if (!values.length || values.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Expected nonempty finite timings");
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]!), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]!), maxMs: round(sorted.at(-1)!) };
}

/** Benchmark-only correlation; no request/user identifiers enter the diagnostic channel. */
export function observeDatabaseTiming() {
  const scope = new AsyncLocalStorage<{ turns: DatabaseTurnTiming[]; complete: boolean }>();
  const receive = (value: unknown) => {
    const current = scope.getStore();
    if (current && !current.complete) current.turns.push(value as DatabaseTurnTiming);
  };
  databaseTurnChannel.subscribe(receive);
  return {
    async measure<T>(work: () => PromiseLike<T>): Promise<{ value: T; timing: RequestTiming }> {
      const current = { turns: [] as DatabaseTurnTiming[], complete: false };
      return scope.run(current, async () => {
        const start = performance.now();
        try {
          const value = await work(), totalMs = performance.now() - start;
          const waitMs = current.turns.reduce((sum, turn) => sum + turn.waitMs, 0);
          const heldMs = current.turns.reduce((sum, turn) => sum + turn.heldMs, 0);
          if (waitMs + heldMs > totalMs + .1) throw new Error("Overlapping or uncorrelated DB turns in request timing");
          return { value, timing: { totalMs, waitMs, heldMs, outsideMs: Math.max(0, totalMs - waitMs - heldMs), turns: current.turns.length } };
        } finally { current.complete = true; }
      });
    },
    close() { databaseTurnChannel.unsubscribe(receive); scope.disable(); },
  };
}
