import type { SourceSaveCode } from "../shared/source-save.ts";

const statuses: Record<SourceSaveCode, number> = {
  invalid_input: 400, unauthorized: 401, session_required: 428, session_changed: 401,
  policy_disabled: 503, storage_unavailable: 503, policy_changed: 409, snapshot_changed: 409,
  result_expired: 409, refresh_required: 409, content_removed: 409, catalog_unavailable: 409,
  invalid_response: 502, source_error: 502, database_error: 500, cancelled: 408, timeout: 504, queue_full: 429,
};
export const sourceSaveStatus = (code: SourceSaveCode): number => statuses[code];
