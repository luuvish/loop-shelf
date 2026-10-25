import { accessReviewRevision, evaluateCaptureReview } from "./access-review.ts";
import { productAccess, sourceAssessmentRevision } from "./policies.ts";
import type { SourceId } from "./types.ts";
import type { AccessDecision, SourceRequest } from "./transport/contracts.ts";

// Intentionally empty: no reviewed permission/robots/quota bundle exists for either real source.
// No HTTP, environment, database or CLI loader may replace these entries.
const productReviews = Object.freeze({ khinsider: null, zophar: null });

export function productReviewRevision(source: SourceId): string {
  return accessReviewRevision({ assessmentRevision: sourceAssessmentRevision(source), review: productReviews[source] });
}

export function productTransportAccess(request: SourceRequest, url: URL): AccessDecision {
  const policy = productAccess(request.sourceId, request.kind);
  if (!policy.allowed) return policy;
  return evaluateCaptureReview(productReviews[request.sourceId], {
    sourceId: request.sourceId, sampleKind: "live-capture", assessmentRevision: sourceAssessmentRevision(request.sourceId), now: Date.now(),
  }, request, url);
}
