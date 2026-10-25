import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeAlbumUrl, origins } from "./urls.ts";
import type { CapturedPage, SourceId } from "./types.ts";
import { SOURCE_USER_AGENT } from "./transport/node-driver.ts";
import { redirectUrl, requestUrl } from "./transport/requests.ts";
import { TRANSPORT_LIMITS, type SourceRequest } from "./transport/contracts.ts";

export const ACCESS_REVIEW_VERSION = "exact-target-review-v1";
export const ROBOTS_REVIEW_MAX_AGE_MS = 24 * 60 * 60_000;
const timestamp = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(2000);
const status = z.enum(["allowed", "denied", "unknown"]);
const evidenceFields = {
  reference: text, sha256: digest, observedAt: timestamp,
  // An explicit operator review assertion, not inferred from HTTP status or a URL.
  authority: z.literal("source-operator"), scope: text,
};
const permission = z.strictObject({
  status,
  evidence: z.strictObject({ ...evidenceFields, kind: z.enum(["published-permission", "operator-permission"]) }).nullable(),
  maxRetentionMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});
const schema = z.strictObject({
  version: z.literal(ACCESS_REVIEW_VERSION), sourceId: z.enum(["khinsider", "zophar"]),
  sampleKind: z.enum(["synthetic", "live-capture"]), assessmentRevision: digest,
  reviewedAt: timestamp, expiresAt: timestamp, userAgent: z.literal(SOURCE_USER_AGENT),
  permissions: z.strictObject({ search: permission, album: permission, cache: permission, display: permission, catalog: permission }),
  robots: z.strictObject({
    url: z.string().max(4096), sha256: digest, observedAt: timestamp, expiresAt: timestamp,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    method: z.literal("manual-exact-target"), productToken: z.literal("LoopShelf"),
  }),
  // No regex, prefix, query sorting or decoded URL matching can expand a reviewed target.
  targets: z.array(z.strictObject({ kind: z.enum(["search", "album"]), url: z.string().max(4096), robots: status, basis: text })).max(200),
  quota: z.strictObject({
    status,
    evidence: z.strictObject({ ...evidenceFields, kind: z.enum(["published-quota", "operator-permission"]) }).nullable(),
    scope: z.enum(["source-origin-single-installation", "shared-group", "multiple-installations", "unknown"]),
    accounting: z.enum(["all-attempts-including-failures-and-redirects", "unknown"]),
    minIntervalMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    maxConcurrent: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    windowLimits: z.array(z.strictObject({ requests: z.number().int().positive(), windowMs: z.number().int().positive() })).max(20),
    otherConstraints: z.enum(["none-reviewed", "unreviewed", "present"]),
  }),
});
export type SourceAccessReview = z.infer<typeof schema>;
export type ReviewedOperation = keyof SourceAccessReview["permissions"];
export interface ReviewContext {
  sourceId: SourceId;
  sampleKind: CapturedPage["sampleKind"];
  assessmentRevision: string;
  now: number;
}
export type ReviewReason = "review_missing" | "review_invalid" | "review_mismatch" | "review_expired"
  | "target_unreviewed" | "permission_unknown" | "permission_denied" | "robots_unverified" | "robots_expired"
  | "robots_denied" | "quota_unverified" | "quota_unsupported";
export type ReviewDecision = { allowed: false; code: "policy_disabled"; reason: ReviewReason }
  | { allowed: true; revision: string; expiresAt: number; maxRetentionMs: number | null };
const deny = (reason: ReviewReason): Extract<ReviewDecision, { allowed: false }> => ({ allowed: false, code: "policy_disabled", reason });

/** Canonical key order makes evidence changes (including scopes and expiries) affect the revision. */
export function accessReviewRevision(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
    return input;
  }
  return createHash("sha256").update(JSON.stringify({ version: ACCESS_REVIEW_VERSION, review: canonical(value ?? null) })).digest("hex");
}

/** Shape/temporal consistency only. Evidence authenticity and manual robots conclusions need human review. */
export function parseAccessReview(input: unknown): SourceAccessReview | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return null;
  const value = parsed.data, reviewed = Date.parse(value.reviewedAt), expiry = Date.parse(value.expiresAt);
  if (reviewed >= expiry || value.robots.url !== `${origins[value.sourceId]}/robots.txt`
    || Date.parse(value.robots.observedAt) > reviewed || Date.parse(value.robots.expiresAt) <= Date.parse(value.robots.observedAt)
    || Date.parse(value.robots.expiresAt) > Date.parse(value.robots.observedAt) + ROBOTS_REVIEW_MAX_AGE_MS) return null;
  for (const [operation, decision] of Object.entries(value.permissions)) {
    if (decision.status === "allowed" && !decision.evidence) return null;
    if (decision.evidence && Date.parse(decision.evidence.observedAt) > reviewed) return null;
    if (["cache", "catalog"].includes(operation)) {
      if (decision.status === "allowed" && decision.maxRetentionMs === null) return null;
    } else if (decision.maxRetentionMs !== null) return null;
  }
  if (value.quota.status === "allowed" && !value.quota.evidence
    || value.quota.evidence && Date.parse(value.quota.evidence.observedAt) > reviewed) return null;
  const targets = new Set<string>();
  for (const target of value.targets) {
    if (targets.has(target.url)) return null;
    targets.add(target.url);
    try {
      const url = new URL(target.url);
      if (url.href !== target.url) return null;
      const request: SourceRequest = target.kind === "search"
        ? { sourceId: value.sourceId, kind: "search", query: url.searchParams.get("search") ?? "" }
        : { sourceId: value.sourceId, kind: "album", externalKey: normalizeAlbumUrl(value.sourceId, target.url)?.externalKey ?? "" };
      redirectUrl(request, requestUrl(request), target.url);
    } catch { return null; }
  }
  return value;
}
function checked(input: unknown, context: ReviewContext): SourceAccessReview | Extract<ReviewDecision, { allowed: false }> {
  if (input === null || input === undefined) return deny("review_missing");
  const value = parseAccessReview(input);
  if (!value || !Number.isFinite(context.now)) return deny("review_invalid");
  if (value.sourceId !== context.sourceId || value.sampleKind !== context.sampleKind
    || value.assessmentRevision !== context.assessmentRevision) return deny("review_mismatch");
  if (context.now < Date.parse(value.reviewedAt) || context.now >= Date.parse(value.expiresAt)) return deny("review_expired");
  return value;
}
function targetMatches(value: SourceAccessReview, request: SourceRequest, url: URL) {
  try {
    if (request.sourceId !== value.sourceId) return;
    redirectUrl(request, requestUrl(request), url.href);
    return value.targets.find((target) => target.kind === request.kind && target.url === url.href);
  } catch { return; }
}
function permissionDecision(value: SourceAccessReview, operation: ReviewedOperation): ReviewDecision {
  const rule = value.permissions[operation];
  if (rule.status !== "allowed") return deny(rule.status === "denied" ? "permission_denied" : "permission_unknown");
  return { allowed: true, revision: accessReviewRevision(value), expiresAt: Date.parse(value.expiresAt), maxRetentionMs: rule.maxRetentionMs };
}

/** Diagnostic permission claim only; does not enable cache, display, persistence or playback. */
export function inspectReviewedPermission(input: unknown, context: ReviewContext, operation: ReviewedOperation,
  request: SourceRequest, url: URL): ReviewDecision {
  const value = checked(input, context);
  if ("allowed" in value) return value;
  if ((operation === "search" || operation === "album") && operation !== request.kind || operation === "catalog" && request.kind !== "album"
    || !targetMatches(value, request, url)) return deny("target_unreviewed");
  return permissionDecision(value, operation);
}

/** All gates are independent. No network, registry writes or permission inference from a robots Allow. */
export function evaluateCaptureReview(input: unknown, context: ReviewContext, request: SourceRequest, url: URL): ReviewDecision {
  const value = checked(input, context);
  if ("allowed" in value) return value;
  const target = targetMatches(value, request, url);
  if (!target) return deny("target_unreviewed");
  const permission = permissionDecision(value, request.kind);
  if (!permission.allowed) return permission;
  if (value.robots.httpStatus !== 200 || target.robots === "unknown") return deny("robots_unverified");
  if (context.now >= Date.parse(value.robots.expiresAt)) return deny("robots_expired");
  if (target.robots !== "allowed") return deny("robots_denied");
  const quota = value.quota;
  if (quota.status !== "allowed") return deny("quota_unverified");
  // Only constraints actually enforced by the existing durable coordinator can pass.
  if (quota.scope !== "source-origin-single-installation" || quota.accounting !== "all-attempts-including-failures-and-redirects"
    || quota.minIntervalMs === null || quota.minIntervalMs > TRANSPORT_LIMITS.intervalMs || quota.maxConcurrent === null
    || quota.maxConcurrent < 1 || quota.windowLimits.length || quota.otherConstraints !== "none-reviewed") return deny("quota_unsupported");
  return { ...permission, expiresAt: Math.min(permission.expiresAt, Date.parse(value.robots.expiresAt)) };
}
