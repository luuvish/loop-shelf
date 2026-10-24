import type { CatalogLibraryItem } from "./catalog-library.ts";

export type SourceSaveCode = "invalid_input" | "unauthorized" | "session_required" | "session_changed" | "policy_disabled" | "policy_changed"
  | "storage_unavailable" | "invalid_response" | "snapshot_changed" | "result_expired" | "refresh_required" | "content_removed"
  | "catalog_unavailable" | "cancelled" | "timeout" | "queue_full" | "source_error" | "database_error";
export type SourceSaveSelection = { status: "available"; expectedFingerprint: string; validUntil: string; retainUntil: string }
  | { status: "unavailable"; code: SourceSaveCode };
export interface SourceSaveSuccess {
  ok: true; sampleKind: "synthetic"; created: boolean; item: CatalogLibraryItem;
  observationId: string; trackState: "unchanged" | "review_required";
}
