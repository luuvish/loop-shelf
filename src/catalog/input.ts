import { MAX_METADATA_BYTES, MetadataError, validateMetadata, type Metadata } from "../sources/metadata.ts";
export type { AlbumObservationData } from "../sources/metadata.ts";

export class CatalogError extends Error {
  readonly code: "invalid_input" | "parse_failure" | "policy_disabled" | "not_found" | "unmanaged_source" | "source_suppressed" | "observation_conflict" | "removal_conflict"
    | "review_not_required" | "stale_review" | "invalid_mapping" | "adoption_conflict" | "sample_kind_conflict" | "content_expired" | "retention_conflict" | "cursor_invalidated";
  constructor(code: CatalogError["code"], message: string) { super(message); this.code = code; }
}

export const MAX_CATALOG_INPUT_BYTES = MAX_METADATA_BYTES;
export type CatalogInput = Metadata;

/** Offline development boundary. Live persistence requires a separate reviewed policy path. */
export function validateSyntheticResult(input: unknown): CatalogInput {
  let value: Metadata;
  try { value = validateMetadata(input); }
  catch (error) {
    if (error instanceof MetadataError) throw new CatalogError(error.code, error.message);
    throw error;
  }
  if (value.provenance.sampleKind !== "synthetic")
    throw new CatalogError("policy_disabled", "Only synthetic offline fixtures may be persisted by this service");
  return value;
}
