import { productTransportAccess } from "./review-policy.ts";
import { createTransport } from "./transport/engine.ts";
import { createNodeOpener, resolveSourceHost } from "./transport/node-driver.ts";
import type Database from "better-sqlite3";
import { createSqliteCoordinator } from "./transport/sqlite-coordinator.ts";
import type { TransportDependencies } from "./transport/contracts.ts";

export type { SourceRequest, TransportResult, TransportCode } from "./transport/contracts.ts";

/** Fixed product policy/drivers. Database-bound instances share durable source reservations. */
const dependencies: TransportDependencies = {
  authorize: productTransportAccess,
  resolve: resolveSourceHost,
  open: createNodeOpener(),
  clock: {
    now: () => performance.timeOrigin + performance.now(),
    timer(ms, callback) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
  },
  sampleKind: "live-capture",
};
// Unbound calls stay policy-disabled; product adapters always use the database-bound facade.
export const captureSourcePage = createTransport(dependencies);
const instances = new WeakMap<Database.Database, ReturnType<typeof createTransport>>();
export function getSourceCapture(db: Database.Database): ReturnType<typeof createTransport> {
  let capture = instances.get(db);
  if (!capture) {
    capture = createTransport({ ...dependencies, coordinator: createSqliteCoordinator(db) });
    instances.set(db, capture);
  }
  return capture;
}
