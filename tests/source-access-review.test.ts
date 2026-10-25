import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { test } from "node:test";
import { ACCESS_REVIEW_VERSION, ROBOTS_REVIEW_MAX_AGE_MS, accessReviewRevision, evaluateCaptureReview,
  inspectReviewedPermission, parseAccessReview, type ReviewContext, type ReviewDecision, type SourceAccessReview } from "../src/sources/access-review.ts";
import { sourceAssessments, sourceAssessmentRevision } from "../src/sources/policies.ts";
import { metadataPolicy } from "../src/sources/adapters.ts";
import { productTransportAccess, productReviewRevision } from "../src/sources/review-policy.ts";
import { catalogAdmissionPolicy } from "../src/source-save/policy.ts";
import { getSourceCapture, captureSourcePage } from "../src/sources/transport.ts";
import { createTransport } from "../src/sources/transport/engine.ts";
import { SOURCE_USER_AGENT } from "../src/sources/transport/node-driver.ts";
import { requestUrl } from "../src/sources/transport/requests.ts";
import type { SourceRequest, TransportDependencies } from "../src/sources/transport/contracts.ts";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";

const now = Date.parse("2026-10-25T00:00:00.000Z"), iso = (value: number) => new Date(value).toISOString();
const search = { sourceId: "zophar", kind: "search", query: "synthetic" } as const;
const album = { sourceId: "zophar", kind: "album", externalKey: "snes/synthetic" } as const;
const context = (): ReviewContext => ({ sourceId: "zophar", sampleKind: "synthetic", assessmentRevision: sourceAssessmentRevision("zophar"), now });
const evidence = () => ({ kind: "operator-permission" as const, reference: "synthetic-only:offline-review", sha256: "a".repeat(64),
  observedAt: iso(now - 20_000), authority: "source-operator" as const, scope: "Synthetic assertion for the exact listed targets; no actual permission." });
function review(): SourceAccessReview {
  const allowed = () => ({ status: "allowed" as const, evidence: evidence(), maxRetentionMs: null });
  const unknown = () => ({ status: "unknown" as const, evidence: null, maxRetentionMs: null });
  return { version: ACCESS_REVIEW_VERSION, sourceId: "zophar", sampleKind: "synthetic", assessmentRevision: sourceAssessmentRevision("zophar"),
    userAgent: SOURCE_USER_AGENT, reviewedAt: iso(now - 10_000), expiresAt: iso(now + 60_000),
    permissions: { search: allowed(), album: allowed(), cache: unknown(), display: unknown(), catalog: unknown() },
    robots: { url: "https://www.zophar.net/robots.txt", sha256: "b".repeat(64), observedAt: iso(now - 20_000),
      expiresAt: iso(now + 5000), httpStatus: 200, method: "manual-exact-target", productToken: "LoopShelf" },
    targets: [search, album].map((request) => ({ kind: request.kind, url: requestUrl(request).href, robots: "allowed", basis: "Synthetic manual check of all applicable rules." })),
    quota: { status: "allowed", evidence: evidence(), scope: "source-origin-single-installation", minIntervalMs: 3000, maxConcurrent: 1,
      accounting: "all-attempts-including-failures-and-redirects", windowLimits: [], otherConstraints: "none-reviewed" } };
}
function capture(value: unknown = review(), overrides: Partial<ReviewContext> = {}, request: SourceRequest = search, url = requestUrl(request)) {
  return evaluateCaptureReview(value, { ...context(), ...overrides }, request, url);
}
function denied(value: ReviewDecision, reason: string) {
  assert.equal(value.allowed, false); if (value.allowed) throw new Error("Expected denial");
  assert.equal(value.code, "policy_disabled"); assert.equal(value.reason, reason);
}

test("exact reviewed synthetic search and album pass independently of downstream permissions", () => {
  const value = review();
  for (const request of [search, album]) {
    const decision = capture(value, {}, request); assert.ok(decision.allowed);
    assert.equal(decision.expiresAt, now + 5000); assert.equal(decision.maxRetentionMs, null);
    assert.equal(decision.revision, accessReviewRevision(value));
  }
  for (const operation of ["cache", "display", "catalog"] as const)
    denied(inspectReviewedPermission(value, context(), operation, album, requestUrl(album)), "permission_unknown");
});

test("missing or malformed reviews never become permissive defaults", () => {
  denied(capture(null), "review_missing");
  for (const value of [{}, [], true, { ...review(), enable: true }, { ...review(), version: "v0" }, { ...review(), userAgent: "Mozilla/5.0" },
    { ...review(), targets: [{ ...review().targets[0], prefix: "/search" }] }]) denied(capture(value), "review_invalid");
  denied(capture(review(), { now: NaN }), "review_invalid");
});

test("source, sample kind and current assessment revision cannot be substituted", () => {
  for (const changes of [{ sourceId: "khinsider" as const }, { sampleKind: "live-capture" as const }, { assessmentRevision: "c".repeat(64) }])
    denied(capture(review(), changes), "review_mismatch");
  denied(capture(review(), {}, { ...search, sourceId: "khinsider" }), "target_unreviewed");
});

test("review and robots expiry have exact boundaries and never permit future reviews", () => {
  const value = review();
  assert.ok(capture(value, { now: Date.parse(value.reviewedAt) }).allowed);
  denied(capture(value, { now: Date.parse(value.reviewedAt) - 1 }), "review_expired");
  assert.ok(capture(value, { now: now + 4999 }).allowed);
  denied(capture(value, { now: now + 5000 }), "robots_expired");
  denied(capture(value, { now: Date.parse(value.expiresAt) }), "review_expired");
});

test("evidence time, digest, canonical timestamps and robots lifetime are validated", () => {
  for (const mutate of [
    (v: SourceAccessReview) => { v.expiresAt = v.reviewedAt; },
    (v: SourceAccessReview) => { v.reviewedAt = "2026-10-24"; },
    (v: SourceAccessReview) => { v.permissions.search.evidence!.sha256 = "unknown"; },
    (v: SourceAccessReview) => { v.permissions.search.evidence!.observedAt = iso(now); },
    (v: SourceAccessReview) => { v.quota.evidence!.observedAt = iso(now); },
    (v: SourceAccessReview) => { v.robots.observedAt = iso(now); },
    (v: SourceAccessReview) => { v.robots.expiresAt = v.robots.observedAt; },
    (v: SourceAccessReview) => { v.robots.expiresAt = iso(Date.parse(v.robots.observedAt) + ROBOTS_REVIEW_MAX_AGE_MS + 1); },
    (v: SourceAccessReview) => { v.robots.url = "https://www.zophar.net/other/robots.txt"; },
  ]) { const value = review(); mutate(value); denied(capture(value), "review_invalid"); }
});

test("robots and quota evidence cannot masquerade as collection permission", () => {
  const value = review();
  for (const kind of ["robots-snapshot", "published-quota", "http-200", "third-party-parser"])
    denied(capture({ ...value, permissions: { ...value.permissions, search: { ...value.permissions.search, evidence: { ...evidence(), kind } } } }), "review_invalid");
  for (const status of ["unknown", "denied"] as const) {
    value.permissions.search.status = status;
    denied(capture(value), `permission_${status}`);
  }
  value.permissions.search.status = "allowed"; value.permissions.search.evidence = null;
  denied(capture(value), "review_invalid");
});

test("exact target scope includes operation, query, spelling and safe redirects", () => {
  const value = review();
  denied(capture(value, {}, { ...search, query: "other" }), "target_unreviewed");
  denied(capture(value, {}, search, new URL("https://www.zophar.net/search?search=%73ynthetic")), "target_unreviewed");
  denied(inspectReviewedPermission(value, context(), "album", search, requestUrl(search)), "target_unreviewed");
  denied(inspectReviewedPermission(value, context(), "catalog", search, requestUrl(search)), "target_unreviewed");
  for (const url of ["https://www.zophar.net/search?search=synthetic&page=2", "https://evil.test/search?search=synthetic",
    "http://www.zophar.net/search?search=synthetic", "https://www.zophar.net/music/snes/../synthetic.html",
    "https://user@www.zophar.net/search?search=synthetic", "https://www.zophar.net/search?search=synthetic#x"])
    denied(capture(value, {}, search, new URL(url)), "target_unreviewed");
});

test("malformed or duplicate targets are rejected as a whole, including out of scope URLs", () => {
  for (const url of ["https://www.zophar.net/search?search=synthetic&page=2", "https://evil.test/search?search=synthetic", "/search?search=synthetic",
    "https://www.zophar.net/search?search=synthetic&search=synthetic", "https://www.zophar.net/music/snes/%2e%2e/secret.html"]) {
    const value = review(); value.targets[0]!.url = url; denied(capture(value), "review_invalid");
  }
  const value = review(); value.targets.push({ ...value.targets[0]! }); denied(capture(value), "review_invalid");
});

test("each KHInsider canonical alias needs an explicit review, without changing technical block", () => {
  const value = review(); value.sourceId = "khinsider"; value.assessmentRevision = sourceAssessmentRevision("khinsider");
  value.robots.url = "https://downloads.khinsider.com/robots.txt";
  const request = { sourceId: "khinsider", kind: "album", externalKey: "synthetic" } as const;
  value.targets = [{ kind: "album", url: requestUrl(request).href, robots: "allowed", basis: "synthetic" }];
  const ctx = { sourceId: "khinsider" as const, assessmentRevision: value.assessmentRevision };
  assert.ok(capture(value, ctx, request).allowed);
  denied(capture(value, ctx, request, new URL(requestUrl(request).href + "/")), "target_unreviewed");
  assert.equal(sourceAssessments.khinsider.technical.album, "blocked");
  assert.equal(productTransportAccess(request, requestUrl(request)).allowed, false);
});

test("missing, failed and forbidden robots observations cannot imply permission", () => {
  for (const httpStatus of [null, 301, 403, 404, 429, 500, 503]) {
    const value = review(); value.robots.httpStatus = httpStatus; denied(capture(value), "robots_unverified");
  }
  const value = review(); value.targets[0]!.robots = "unknown"; denied(capture(value), "robots_unverified");
  value.targets[0]!.robots = "denied"; denied(capture(value), "robots_denied");
});

test("unverified or unenforceable quotas fail without treating defaults as official quotas", () => {
  for (const status of ["unknown", "denied"] as const) {
    const value = review(); value.quota.status = status; denied(capture(value), "quota_unverified");
  }
  const absent = review(); absent.quota.evidence = null; denied(capture(absent), "review_invalid");
  for (const changes of [{ minIntervalMs: 3001 }, { minIntervalMs: null }, { maxConcurrent: null },
    { scope: "shared-group" as const }, { scope: "multiple-installations" as const }, { scope: "unknown" as const },
    { accounting: "unknown" as const }, { otherConstraints: "unreviewed" as const }, { otherConstraints: "present" as const },
    { windowLimits: [{ requests: 20, windowMs: 60_000 }] }]) {
    const value = review(); Object.assign(value.quota, changes); denied(capture(value), "quota_unsupported");
  }
  const compatible = review(); compatible.quota.minIntervalMs = 1000; compatible.quota.maxConcurrent = 2;
  assert.ok(capture(compatible).allowed); // Existing enforcement is stricter; no limit is relaxed.
});

test("retention claims require a duration and do not grant collection or each other", () => {
  const value = review(); value.permissions.cache = { status: "allowed", evidence: evidence(), maxRetentionMs: 60_000 };
  const result = inspectReviewedPermission(value, context(), "cache", album, requestUrl(album));
  assert.ok(result.allowed); assert.equal(result.maxRetentionMs, 60_000);
  denied(inspectReviewedPermission(value, context(), "display", album, requestUrl(album)), "permission_unknown");
  denied(inspectReviewedPermission(value, context(), "catalog", album, requestUrl(album)), "permission_unknown");
  value.permissions.search.status = "denied"; denied(capture(value), "permission_denied");
  value.permissions.cache.maxRetentionMs = null; assert.equal(parseAccessReview(value), null);
  const other = review(); other.permissions.search.maxRetentionMs = 1000; assert.equal(parseAccessReview(other), null);
});

test("revision binds evidence, expiry, permissions, targets and quota with stable object ordering", () => {
  const value = review(), hash = accessReviewRevision(value);
  assert.equal(accessReviewRevision(Object.fromEntries(Object.entries(value).reverse())), hash);
  for (const mutate of [
    (v: SourceAccessReview) => { v.permissions.search.evidence!.sha256 = "c".repeat(64); },
    (v: SourceAccessReview) => { v.permissions.display.status = "denied"; },
    (v: SourceAccessReview) => { v.expiresAt = iso(now + 59_000); },
    (v: SourceAccessReview) => { v.robots.sha256 = "d".repeat(64); },
    (v: SourceAccessReview) => { v.targets[0]!.basis = "re-reviewed"; },
    (v: SourceAccessReview) => { v.quota.minIntervalMs = 1000; },
  ]) { const next = review(); mutate(next); assert.notEqual(accessReviewRevision(next), hash); }
});

function harness(mutate: (stage: string, state: { review: SourceAccessReview | null; now: number }) => void = () => {}) {
  const state = { review: review() as SourceAccessReview | null, now }, events: string[] = [];
  const stage = (name: string) => { events.push(name); mutate(name, state); };
  const deps: TransportDependencies = {
    sampleKind: "synthetic", clock: { now: () => state.now, timer: () => () => {} },
    authorize: (request, url) => evaluateCaptureReview(state.review, { ...context(), now: state.now }, request, url),
    coordinator: { async acquire() { stage("acquire"); return {
      async beginAttempt() { stage("begin"); }, async assertRunning() { stage("running"); },
      async rateLimit() { throw new Error("unused"); }, async endAttempt() { stage("end"); }, async release() { stage("release"); },
    }; } },
    async resolve() { stage("dns"); return [{ address: "93.184.215.14", family: 4 }]; },
    async open() { stage("open"); return { status: 200, headers: { "content-type": "text/html" },
      body: { async *[Symbol.asyncIterator]() { yield Buffer.from("<html>synthetic</html>"); stage("body"); } }, close() { stage("close"); } }; },
  };
  return { state, events, deps, capture: createTransport(deps) };
}

test("structured review can complete a synthetic transport without populating product registry", async () => {
  const h = harness(), result = await h.capture(search); assert.ok(result.ok);
  assert.equal(result.page.sampleKind, "synthetic"); assert.equal(h.events.filter((name) => name === "open").length, 1);
  assert.equal(productTransportAccess(search, requestUrl(search)).allowed, false);
});

for (const stage of ["acquire", "begin", "dns", "body", "end", "release"]) {
  test(`review expiry after ${stage} prevents capture success or further network access`, async () => {
    const h = harness((name, state) => { if (name === stage) state.now = now + 5000; });
    assert.deepEqual(await h.capture(search), { ok: false, code: "policy_disabled" });
    if (["acquire", "begin"].includes(stage)) assert.equal(h.events.includes("dns"), false);
    if (["acquire", "begin", "dns"].includes(stage)) assert.equal(h.events.includes("open"), false);
  });
}

test("even replacement with another valid allow review cannot authorize an in-flight response", async () => {
  for (const where of ["acquire", "dns", "body", "release"]) {
    const h = harness((name, state) => { if (name === where) state.review!.permissions.search.evidence!.sha256 = "c".repeat(64); });
    assert.deepEqual(await h.capture(search), { ok: false, code: "policy_disabled" });
    assert.ok(capture(h.state.review).allowed); // A new request may be reviewed separately.
  }
});

test("removing a review while queued or revoking permission while reading discards the response", async () => {
  for (const where of ["acquire", "body", "release"]) {
    const h = harness((name, state) => { if (name === where) state.review = null; });
    assert.deepEqual(await h.capture(search), { ok: false, code: "policy_disabled" });
  }
  const h = harness((name, state) => { if (name === "body") state.review!.permissions.search.status = "denied"; });
  assert.deepEqual(await h.capture(search), { ok: false, code: "policy_disabled" });
});

test("same-resource redirects do not inherit robots approval from the initial spelling", async () => {
  const h = harness();
  h.deps.open = async () => { h.events.push("open"); return { status: 302, headers: { location: "/search?search=%73ynthetic" },
    body: { async *[Symbol.asyncIterator]() {} }, close() {} }; };
  assert.deepEqual(await createTransport(h.deps)(search), { ok: false, code: "policy_disabled" });
  assert.equal(h.events.filter((name) => name === "dns").length, 1);
  assert.equal(h.events.filter((name) => name === "open").length, 1);
});

test("product policies, live guard, reservations and caches stay closed with synthetic review support", async (t) => {
  const before = JSON.stringify(sourceAssessments), db = openDatabase(":memory:"); migrate(db); t.after(() => db.close());
  const dns = t.mock.method(Resolver.prototype, "resolve4", () => { throw new Error("Unexpected network"); });
  const states = db.prepare("SELECT * FROM source_request_state").all();
  for (const sourceId of ["khinsider", "zophar"] as const) {
    assert.equal(metadataPolicy(sourceId, "search").revision, productReviewRevision(sourceId));
    assert.equal(catalogAdmissionPolicy(sourceId).persistence.status, "unknown");
    for (const request of [{ sourceId, kind: "search", query: "synthetic" },
      { sourceId, kind: "album", externalKey: sourceId === "zophar" ? "snes/synthetic" : "synthetic" }] as SourceRequest[]) {
      const policy = metadataPolicy(sourceId, request.kind);
      assert.equal(policy.collect.allowed, false); assert.equal(policy.cache.allowed, false); assert.equal(policy.display.allowed, false);
      assert.deepEqual(await captureSourcePage(request), { ok: false, code: "policy_disabled" });
      assert.deepEqual(await getSourceCapture(db)(request), { ok: false, code: "policy_disabled" });
    }
  }
  assert.equal(dns.mock.callCount(), 0); assert.equal(JSON.stringify(sourceAssessments), before);
  assert.deepEqual(db.prepare("SELECT * FROM source_request_state").all(), states);
  assert.deepEqual(db.prepare("SELECT * FROM source_request_ticket").all(), []);
  assert.deepEqual(db.prepare("SELECT * FROM source_metadata_cache").all(), []);
});
