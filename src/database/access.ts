import type Database from "better-sqlite3";

const queues = new WeakMap<Database.Database, Promise<void>>();

/** Keep async auth transactions from interleaving with synchronous repository transactions. */
export async function acquireDatabase(db: Database.Database): Promise<() => void> {
  const previous = queues.get(db) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  queues.set(db, current);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (queues.get(db) === current) queues.delete(db);
    unlock();
  };
}

export async function withDatabase<T>(db: Database.Database, action: () => Promise<T>): Promise<T> {
  const release = await acquireDatabase(db);
  try { return await action(); } finally { release(); }
}
