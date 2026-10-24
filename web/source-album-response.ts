import type { SourceAlbumResponse } from "../src/shared/source-album.ts";
import type { Provenance, SourceAlbumRef } from "../src/sources/types.ts";
import { normalizeAlbumUrl } from "../src/sources/urls.ts";

export interface SourceAlbumSelection { ref: SourceAlbumRef; sampleKind: Provenance["sampleKind"] }
const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const decision = (value: { allowed: boolean; code?: string }) => value.allowed === true || value.allowed === false && ["blocked", "policy_disabled"].includes(value.code ?? "");

/** Client display/context checks, not collection permission or catalog identity validation. */
export function validSourceAlbumResponse(value: SourceAlbumResponse, selection: SourceAlbumSelection): boolean {
  try {
    const { ref, result, policy } = value, expected = selection.ref;
    if (value.ok !== true || ref.sourceId !== expected.sourceId || ref.externalKey !== expected.externalKey || ref.pageUrl !== expected.pageUrl
      || normalizeAlbumUrl(ref.sourceId, ref.pageUrl)?.pageUrl !== ref.pageUrl
      || !["synthetic", "live-capture"].includes(value.sampleKind) || !["complete", "partial", "failed"].includes(value.status)
      || !["settled", "deadline"].includes(value.termination) || !date(value.completedAt) || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0
      || ![policy.collect, policy.cache, policy.display].every(decision)) return false;
    // A product policy failure has no metadata and may answer a selection from a synthetic fixture.
    if (result.ok === false) return value.status === "failed" && text(result.code, 100) && text(result.stage, 100)
      && (result.retryAt === undefined || Number.isFinite(result.retryAt) && result.retryAt >= 0);
    if (result.ok !== true || value.sampleKind !== selection.sampleKind || value.status === "failed" || !policy.display.allowed) return false;
    const { data, provenance, delivery } = result;
    if (data.kind !== "album" || data.sourceId !== ref.sourceId || data.externalKey !== ref.externalKey || data.pageUrl !== ref.pageUrl
      || !text(data.title, 1000) || data.titleKind !== "album-title" || data.playback !== "unverified" || data.releaseDate !== null
      || provenance.sourceId !== ref.sourceId || provenance.sampleKind !== value.sampleKind
      || normalizeAlbumUrl(ref.sourceId, provenance.pageUrl)?.pageUrl !== ref.pageUrl || !provenance.pageUrl.startsWith("https://")
      || !date(provenance.capturedAt) || !date(provenance.parsedAt) || !date(delivery.freshUntil) || !date(delivery.expiresAt)
      || !["cache", "transport"].includes(delivery.from) || !["fresh", "stale"].includes(delivery.freshness)
      || delivery.from === "cache" && !policy.cache.allowed || delivery.from === "transport" && !policy.collect.allowed
      || Date.parse(delivery.freshUntil) < Date.parse(provenance.capturedAt) || Date.parse(delivery.expiresAt) < Date.parse(delivery.freshUntil)
      || Date.parse(delivery.expiresAt) <= Date.parse(value.completedAt)) return false;
    if (!Array.isArray(data.platforms) || data.platforms.length > 100 || !data.platforms.every((v) => text(v, 300))
      || ![data.sourceCategory, data.sourceYearLabel].every((v) => v === null || text(v, 1000))
      || !Array.isArray(data.sourceClaims) || data.sourceClaims.length > 100 || !data.sourceClaims.every((v) => text(v.label, 1000) && text(v.value, 10000))
      || !Array.isArray(result.warnings) || result.warnings.length > 100 || !result.warnings.every((v) => text(v, 1000))) return false;
    if (result.refreshFailure && (result.refreshFailure.ok !== false || !text(result.refreshFailure.code, 100)
      || result.refreshFailure.retryAt !== undefined && (!Number.isFinite(result.refreshFailure.retryAt) || result.refreshFailure.retryAt < 0))) return false;
    return Array.isArray(data.tracks) && data.tracks.length > 0 && data.tracks.length <= 5000
      && new Set(data.tracks.map((row) => row.snapshotLocator)).size === data.tracks.length
      && data.tracks.every((row, index) => row.externalKey === null && row.position === index + 1 && text(row.snapshotLocator, 300)
        && text(row.title, 1000) && row.discLabel === null && (row.displayNumber === null || text(row.displayNumber, 100))
        && (row.durationLabel === null || text(row.durationLabel, 300))
        && (row.durationSeconds === null || Number.isSafeInteger(row.durationSeconds) && row.durationSeconds >= 0));
  } catch { return false; }
}
