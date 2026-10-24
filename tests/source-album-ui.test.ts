import { test } from "node:test";
import assert from "node:assert/strict";
import { validSourceAlbumResponse } from "../web/source-album-response.ts";
import { albumResponse } from "./browser/source-album-fixture.ts";
import type { SourceAlbumResponse } from "../src/shared/source-album.ts";

const original = () => albumResponse({ sourceId: "zophar", externalKey: "nes/star" });
const selection = { ref: original().ref, sampleKind: "synthetic" as const };
test("detail display preserves repeated numbers, row order and unknown values", () => {
  const value = original(); assert.equal(validSourceAlbumResponse(value, selection), true);
  assert.ok(value.result.ok); assert.equal(value.result.data.tracks[0]!.displayNumber, value.result.data.tracks[1]!.displayNumber);
  assert.equal(value.result.data.tracks[0]!.durationSeconds, null);
});
test("detail display rejects another key, sample kind or active external URL", () => {
  for (const mutate of [
    (v: SourceAlbumResponse) => { v.ref.externalKey = "nes/other"; },
    (v: SourceAlbumResponse) => { v.sampleKind = "live-capture"; },
    (v: SourceAlbumResponse) => { if (v.result.ok) v.result.provenance.sampleKind = "live-capture"; },
    (v: SourceAlbumResponse) => { if (v.result.ok) v.result.data.pageUrl = "javascript:alert(1)"; },
    (v: SourceAlbumResponse) => { if (v.result.ok) v.result.provenance.pageUrl = "https://www.zophar.net/music/nes/other.html"; },
    (v: SourceAlbumResponse) => { v.policy.display = { allowed: false, code: "policy_disabled" }; },
  ]) { const value = original(); mutate(value); assert.equal(validSourceAlbumResponse(value, selection), false); }
});
test("detail display refuses empty, ambiguous or expired rows instead of inventing zero tracks", () => {
  for (const mutate of [
    (v: SourceAlbumResponse) => { if (v.result.ok) v.result.data.tracks = []; },
    (v: SourceAlbumResponse) => { if (v.result.ok) v.result.data.tracks[1]!.snapshotLocator = "row:1"; },
    (v: SourceAlbumResponse) => { if (v.result.ok) v.result.data.tracks[1]!.position = 1; },
    (v: SourceAlbumResponse) => { if (v.result.ok) v.result.delivery.expiresAt = v.completedAt; },
    (v: SourceAlbumResponse) => { if (v.result.ok) v.result.data.tracks[0]!.durationSeconds = -1; },
  ]) { const value = original(); mutate(value); assert.equal(validSourceAlbumResponse(value, selection), false); }
  assert.equal(validSourceAlbumResponse(null as unknown as SourceAlbumResponse, selection), false);
});
test("policy failure without metadata may answer synthetic selection but cannot be a success", () => {
  const value = original(); value.sampleKind = "live-capture"; value.status = "failed";
  value.result = { ok: false, code: "policy_disabled", stage: "policy" };
  assert.equal(validSourceAlbumResponse(value, selection), true);
  value.status = "complete"; assert.equal(validSourceAlbumResponse(value, selection), false);
});
