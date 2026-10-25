import type { SourceAlbumResponse } from "../src/shared/source-album.ts";
import type { SourceSaveSelection, SourceSaveSuccess } from "../src/shared/source-save.ts";
import type { CatalogLibraryItem } from "../src/shared/catalog-library.ts";
import type { SourceAlbumSelection } from "./source-album-response.ts";

const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(v);
const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const codes = new Set(["invalid_input", "unauthorized", "session_required", "session_changed", "policy_disabled", "policy_changed", "storage_unavailable",
  "invalid_response", "snapshot_changed", "result_expired", "refresh_required", "content_removed", "catalog_unavailable", "cancelled", "timeout", "queue_full", "source_error", "database_error"]);
/** Invalid/missing save guidance never enables a write; otherwise-valid detail remains readable. */
export function saveSelection(raw: unknown, value: SourceAlbumResponse): SourceSaveSelection {
  const invalid: SourceSaveSelection = { status: "unavailable", code: "invalid_response" };
  try {
    const v = raw as SourceSaveSelection;
    if (v.status === "unavailable") return Object.keys(v).sort().join() === "code,status" && codes.has(v.code) ? v : invalid;
    if (v.status !== "available" || Object.keys(v).sort().join() !== "expectedFingerprint,retainUntil,status,validUntil"
      || !/^[a-f0-9]{64}$/u.test(v.expectedFingerprint) || !date(v.validUntil) || !date(v.retainUntil)) return invalid;
    if (!value.result.ok || value.sampleKind !== "synthetic" || value.status !== "complete" || value.termination !== "settled") return invalid;
    const { delivery, refreshFailure, provenance } = value.result;
    if (delivery.freshness !== "fresh" || refreshFailure || !value.policy.display.allowed || !value.policy.cache.allowed
      || delivery.from === "transport" && !value.policy.collect.allowed) return invalid;
    const valid = Date.parse(v.validUntil), retain = Date.parse(v.retainUntil), captured = Date.parse(provenance.capturedAt);
    if (valid <= Date.parse(value.completedAt) || retain <= captured || retain > captured + 30 * 86400_000
      || retain > Date.parse(delivery.expiresAt) || valid !== Math.min(retain, Date.parse(delivery.freshUntil))) return invalid;
    return v;
  } catch { return invalid; }
}
/** Only fields used by the save/recovery UI. Never matches by title or adopts a returned URL. */
export function validSavedSourceItem(item: CatalogLibraryItem, selection: SourceAlbumSelection): boolean {
  try {
    const e = item.entity, ref = selection.ref;
    return uuid(item.id) && uuid(e.id) && e.kind === "album" && e.albumId === e.id && uuid(e.sourceEntityId)
      && e.sourceId === ref.sourceId && e.externalKey === ref.externalKey && e.pageUrl === ref.pageUrl && e.sampleKind === selection.sampleKind
      && ["active", "expired", "removed", "unresolved"].includes(e.contentState)
      && (item.titleOverride === null || text(item.titleOverride, 300) && !!item.titleOverride.trim())
      && text(item.note, 10000) && typeof item.favorite === "boolean" && Number.isSafeInteger(item.version) && item.version > 0
      && date(item.createdAt) && date(item.updatedAt);
  } catch { return false; }
}
export function validSourceSaveSuccess(value: SourceSaveSuccess, selection: SourceAlbumSelection): boolean {
  return value?.ok === true && value.sampleKind === "synthetic" && selection.sampleKind === value.sampleKind && typeof value.created === "boolean"
    && uuid(value.observationId) && ["unchanged", "review_required"].includes(value.trackState) && validSavedSourceItem(value.item, selection);
}
