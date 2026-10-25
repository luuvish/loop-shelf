import { createHash } from "node:crypto";
import type { PageKind, SourceId } from "./types.ts";

export type PolicyOperation = "search" | "album" | "cache" | "display" | "artwork" | "directAudio" | "embed";
interface PolicyDecision {
  status: "allowed" | "denied" | "unknown";
  evidence: readonly string[];
  reviewedAt: string;
}
export interface SourceAssessment {
  policy: Readonly<Record<PolicyOperation, PolicyDecision>>;
  technical: Readonly<Record<PageKind, "sample-verified" | "blocked">>;
}

function unknownPolicy(evidence: string[]): SourceAssessment["policy"] {
  const decision: PolicyDecision = { status: "unknown", evidence, reviewedAt: "2026-10-18" };
  return { search: decision, album: decision, cache: decision, display: decision,
    artwork: decision, directAudio: decision, embed: decision };
}

export const sourceAssessments: Readonly<Record<SourceId, SourceAssessment>> = {
  khinsider: {
    policy: unknownPolicy(["https://downloads.khinsider.com/robots.txt", "https://downloads.khinsider.com/faq"]),
    technical: { search: "sample-verified", album: "blocked" },
  },
  zophar: {
    policy: unknownPolicy(["https://www.zophar.net/legal.html", "https://www.zophar.net/robots.txt"]),
    technical: { search: "sample-verified", album: "sample-verified" },
  },
};

export function sourceAssessmentRevision(source: SourceId): string {
  return createHash("sha256").update(JSON.stringify(sourceAssessments[source])).digest("hex");
}

/** Product code must check this BEFORE transport, cache writes, or cached display. */
export function productAccess(source: SourceId, operation: PolicyOperation):
  { allowed: true } | { allowed: false; code: "policy_disabled" | "blocked"; reason: string } {
  const assessment = sourceAssessments[source];
  if (assessment.policy[operation].status !== "allowed")
    return { allowed: false, code: "policy_disabled", reason: `${operation}: permission is not established` };
  if ((operation === "search" || operation === "album") && assessment.technical[operation] === "blocked")
    return { allowed: false, code: "blocked", reason: "Access is blocked" };
  return { allowed: true };
}
