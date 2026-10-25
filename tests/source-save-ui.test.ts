import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { saveSelection, validSavedSourceItem, validSourceSaveSuccess } from "../web/source-save-response.ts";
import { albumResponse } from "./browser/source-album-fixture.ts";
import type { SourceSaveSuccess, SourceSaveSelection } from "../src/shared/source-save.ts";

const detail = () => albumResponse({ sourceId: "zophar", externalKey: "nes/star" });
const selection = { ref: detail().ref, sampleKind: "synthetic" as const };
function ready(value = detail()): SourceSaveSelection {
  assert.ok(value.result.ok);
  return { status: "available", expectedFingerprint: "a".repeat(64), validUntil: value.result.delivery.freshUntil, retainUntil: value.result.delivery.expiresAt };
}
function saved(): SourceSaveSuccess {
  const entityId = randomUUID();
  return { ok: true, sampleKind: "synthetic", created: true, observationId: randomUUID(), trackState: "unchanged", item: {
    id: randomUUID(), entity: { id: entityId, albumId: entityId, kind: "album", title: "Synthetic", sampleKind: "synthetic", identity: "source-provisional",
      contentState: "active", lifecycle: "active", presence: "album", position: null, durationMs: null, sourceEntityId: randomUUID(),
      ...selection.ref, sourceAvailability: "unverified" }, title: "Synthetic", titleOverride: null, note: "private", favorite: false, version: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceLinks: [],
  } };
}
test("save guidance requires fresh matching synthetic detail and bounded server-relative deadlines", () => {
  const value = detail(), guidance = ready(value); assert.deepEqual(saveSelection(guidance, value), guidance);
  assert.deepEqual(saveSelection({ status: "unavailable", code: "policy_disabled" }, value), { status: "unavailable", code: "policy_disabled" });
  for (const raw of [undefined, null, {}, { ...guidance, expectedFingerprint: "bad" }, { ...guidance, validUntil: "2099-01-01" },
    { ...guidance, retainUntil: "2099-01-01" }, { ...guidance, validUntil: value.completedAt }, { ...guidance, allowed: true },
    { status: "unavailable", code: "not-a-code" }, { status: "unavailable", code: "policy_disabled", expectedFingerprint: "a".repeat(64) }])
    assert.deepEqual(saveSelection(raw, value), { status: "unavailable", code: "invalid_response" });
});
test("stale, failed, partial, revoked and unsupported live guidance cannot enable saving", () => {
  for (const change of [
    (v: ReturnType<typeof detail>) => { v.status = "partial"; }, (v: ReturnType<typeof detail>) => { v.termination = "deadline"; },
    (v: ReturnType<typeof detail>) => { v.sampleKind = "live-capture"; }, (v: ReturnType<typeof detail>) => { v.policy.cache = { allowed: false, code: "policy_disabled" }; },
    (v: ReturnType<typeof detail>) => { if (v.result.ok) v.result.delivery.freshness = "stale"; },
    (v: ReturnType<typeof detail>) => { if (v.result.ok) v.result.refreshFailure = { ok: false, code: "network_error", stage: "transport" }; },
    (v: ReturnType<typeof detail>) => { v.result = { ok: false, code: "content_removed", stage: "cache" }; },
  ]) { const value = detail(), guidance = ready(value); change(value); assert.equal(saveSelection(guidance, value).status, "unavailable"); }
});
test("saved result validation binds the selected source, sample kind and personal shape without title matching", () => {
  const value = saved(); assert.equal(validSourceSaveSuccess(value, selection), true);
  value.created = false; value.item.titleOverride = "personal title"; value.item.title = "different current title"; assert.equal(validSourceSaveSuccess(value, selection), true);
  for (const change of [
    (v: SourceSaveSuccess) => { v.item.entity.externalKey = "nes/other"; }, (v: SourceSaveSuccess) => { v.item.entity.pageUrl = "javascript:alert(1)"; },
    (v: SourceSaveSuccess) => { v.item.entity.sampleKind = "live-capture"; }, (v: SourceSaveSuccess) => { v.item.entity.albumId = randomUUID(); },
    (v: SourceSaveSuccess) => { v.item.id = "bad"; }, (v: SourceSaveSuccess) => { v.item.version = 0; },
    (v: SourceSaveSuccess) => { v.observationId = "bad"; }, (v: SourceSaveSuccess) => { v.item.note = "x".repeat(10001); },
  ]) { const changed = structuredClone(value); change(changed); assert.equal(validSourceSaveSuccess(changed, selection), false); }
  assert.equal(validSourceSaveSuccess(null as unknown as SourceSaveSuccess, selection), false);
});
test("recovery keeps unavailable private items while rejecting missing or malformed personal fields", () => {
  const item = saved().item;
  for (const state of ["active", "removed", "expired", "unresolved"] as const) { item.entity.contentState = state; assert.equal(validSavedSourceItem(item, selection), true); }
  item.favorite = undefined as unknown as boolean; assert.equal(validSavedSourceItem(item, selection), false);
  assert.equal(validSavedSourceItem(null as unknown as typeof item, selection), false);
});
