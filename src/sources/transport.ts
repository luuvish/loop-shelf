import { productAccess } from "./policies.ts";
import { createTransport } from "./transport/engine.ts";
import { createNodeOpener, resolveSourceHost } from "./transport/node-driver.ts";

export type { SourceRequest, TransportResult, TransportCode } from "./transport/contracts.ts";

/** One process-wide scheduler. No per-request factory, policy override, or environment bypass. */
export const captureSourcePage = createTransport({
  authorize(request) {
    const decision = productAccess(request.sourceId, request.kind);
    if (!decision.allowed) return decision;
    // A future activation also needs reviewed, current robots/path rules and source quotas.
    // There is deliberately no permissive default while that contract is unimplemented.
    return { allowed: false, code: "policy_disabled" };
  },
  resolve: resolveSourceHost,
  open: createNodeOpener(),
  clock: {
    now: () => performance.timeOrigin + performance.now(),
    timer(ms, callback) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
  },
  sampleKind: "live-capture",
});
