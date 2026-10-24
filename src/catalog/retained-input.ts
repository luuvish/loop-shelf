import { z } from "zod";
import { validateMetadata } from "../sources/metadata.ts";
import { catalogAdmissionPolicy } from "../source-save/policy.ts";
import { requireCatalogPermission } from "../source-save/admission.ts";
import { CatalogError } from "./input.ts";

const leaseSchema = z.object({ policyRevision: z.string().min(1).max(200).refine((value) => value === value.trim()), expiresAt: z.iso.datetime({ precision: 3 }) }).strict();
export type CatalogLease = z.infer<typeof leaseSchema>;
/** Server-owned metadata only. A caller cannot supply a live permission or extend capture-based retention. */
export function validateRetainedAlbum(input: unknown, rawLease: unknown, now = Date.now()) {
  let metadata: ReturnType<typeof validateMetadata>, lease: CatalogLease;
  try { metadata = validateMetadata(input); lease = leaseSchema.parse(rawLease); }
  catch { throw new CatalogError("invalid_input", "Invalid retained metadata or lease"); }
  const captured = Date.parse(metadata.provenance.capturedAt), parsed = Date.parse(metadata.provenance.parsedAt), expires = Date.parse(lease.expiresAt);
  if (metadata.data.kind !== "album" || !Number.isFinite(now) || captured > parsed || parsed > now || expires <= captured || expires > captured + 30 * 86400_000)
    throw new CatalogError("invalid_input", "Invalid album retention interval");
  if (expires <= now) throw new CatalogError("content_expired", "The admitted observation has expired");
  if (metadata.provenance.sampleKind === "live-capture") {
    const policy = catalogAdmissionPolicy(metadata.data.sourceId);
    try { requireCatalogPermission(policy, metadata.data.sourceId, "live-capture", now); }
    catch { throw new CatalogError("policy_disabled", "Product catalog retention is not allowed"); }
    if (policy.revision !== lease.policyRevision || policy.parserVersion !== metadata.provenance.parserVersion
      || policy.persistence.status !== "allowed" || expires > captured + policy.persistence.maxRetentionMs)
      throw new CatalogError("retention_conflict", "The current product policy does not admit this lease");
  }
  return { metadata, lease };
}
