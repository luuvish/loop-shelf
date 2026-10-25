import type Database from "better-sqlite3";
import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

const queues = new WeakMap<Database.Database, Promise<void>>();
// Internal timing only: never publish SQL, paths, parameters, users or credentials.
// No clock reads when there is no in-process subscriber; no HTTP/env control.
export const databaseTurnChannel = channel("loopshelf.database.turn");
export interface DatabaseTurnTiming { waitMs: number; heldMs: number }

/** Keep async auth transactions from interleaving with synchronous repository transactions. */
export async function acquireDatabase(db: Database.Database): Promise<() => void> {
  const queuedAt = databaseTurnChannel.hasSubscribers ? performance.now() : null;
  const previous = queues.get(db) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  queues.set(db, current);
  await previous;
  const acquiredAt = queuedAt === null ? null : performance.now();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (queues.get(db) === current) queues.delete(db);
    unlock();
    if (queuedAt !== null && acquiredAt !== null) {
      databaseTurnChannel.publish({ waitMs: acquiredAt - queuedAt, heldMs: performance.now() - acquiredAt } satisfies DatabaseTurnTiming);
    }
  };
}

export async function withDatabase<T>(db: Database.Database, action: () => Promise<T>): Promise<T> {
  const release = await acquireDatabase(db);
  try { return await action(); } finally { release(); }
}
