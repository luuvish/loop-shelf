import { createHash } from "node:crypto";
import { metadataPolicy } from "../sources/adapters.ts";
import { PARSER_VERSION } from "../sources/parsers.ts";
import type { SourceId } from "../sources/types.ts";
import type { CatalogAdmissionPolicy } from "./admission.ts";

/** No env/HTTP override. Live persistence also needs expiry/removal-aware storage before activation. */
export function catalogAdmissionPolicy(sourceId: SourceId): CatalogAdmissionPolicy {
  const rule = { sourceId, sampleKind: "live-capture" as const, metadataRevision: metadataPolicy(sourceId, "album").revision,
    parserVersion: PARSER_VERSION, persistence: { status: "unknown" as const } };
  return { ...rule, revision: createHash("sha256").update(JSON.stringify(rule)).digest("hex") };
}
