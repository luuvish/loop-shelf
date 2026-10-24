import type Database from "better-sqlite3";

// Capture real executed statements/parameters outside timed probes, including nested projections.
export function queryPlans(db: Database.Database, run: () => unknown) {
  const prepare = db.prepare, plans = new Map<string, { sql: string; calls: number; plan: unknown[] }>();
  db.prepare = ((sql: string) => {
    const statement = prepare.call(db, sql);
    return new Proxy(statement, { get(target, key) {
      if (key !== "all" && key !== "get") return Reflect.get(target, key);
      return (...args: unknown[]) => {
        const previous = plans.get(sql);
        if (previous) previous.calls++;
        else {
          const explain = prepare.call(db, `EXPLAIN QUERY PLAN ${sql}`);
          plans.set(sql, { sql, calls: 1, plan: Reflect.apply(explain.all, explain, args) as unknown[] });
        }
        return Reflect.apply(target[key], target, args);
      };
    } });
  }) as typeof db.prepare;
  try { run(); return [...plans.values()]; } finally { db.prepare = prepare; }
}
