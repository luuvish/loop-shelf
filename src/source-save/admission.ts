import type { SourceSaveCode } from "../shared/source-save.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseSourceAlbumInput } from "../source-album/input.ts";
import { validateMetadata } from "../sources/metadata.ts";
import type { SourceAlbumDelivery, SourceAlbumResponse } from "../shared/source-album.ts";
import type { SourceId, Provenance } from "../sources/types.ts";

const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]/u.test(s));
const schema = z.object({ sourceId: z.enum(["khinsider", "zophar"]), externalKey: z.string().min(1).max(1024),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  titleOverride: text(300).nullable().default(null), note: z.string().max(10000).refine((s) => !s.includes("\0")).default(""),
  favorite: z.boolean().default(false),
}).strict();
export type SourceSaveInput = z.infer<typeof schema>;
export class SourceSaveError extends Error {
  readonly code: SourceSaveCode;
  constructor(code: SourceSaveError["code"]) { super(code); this.code = code; }
}
export function parseSourceSaveInput(input: unknown): SourceSaveInput {
  try {
    const encoded = JSON.stringify(input);
    if (!encoded || Buffer.byteLength(encoded) > 32768) throw new Error("Too large");
    const value = schema.parse(input); parseSourceAlbumInput({ sourceId: value.sourceId, externalKey: value.externalKey }); return value;
  } catch { throw new SourceSaveError("invalid_input"); }
}

// Cache/display permission does not grant catalog retention. This policy has its own evidence and revision.
export interface CatalogAdmissionPolicy {
  sourceId: SourceId; sampleKind: Provenance["sampleKind"]; revision: string; metadataRevision: string; parserVersion: string;
  persistence: { status: "unknown" | "denied" } | { status: "allowed"; evidence: readonly string[]; reviewedAt: string; maxRetentionMs: number };
}
export function requireCatalogPermission(policy: CatalogAdmissionPolicy, sourceId: SourceId, sampleKind: Provenance["sampleKind"], now: number) {
  const permission = policy.persistence;
  if (policy.sourceId !== sourceId || policy.sampleKind !== sampleKind) throw new SourceSaveError("invalid_response");
  if (permission.status !== "allowed") throw new SourceSaveError("policy_disabled");
  if (!policy.revision || !policy.metadataRevision || !policy.parserVersion || !Number.isFinite(now)
    || !permission.evidence.length || permission.evidence.some((s) => !s.trim())
    || !Number.isFinite(Date.parse(permission.reviewedAt)) || Date.parse(permission.reviewedAt) > now
    || !Number.isSafeInteger(permission.maxRetentionMs) || permission.maxRetentionMs <= 0 || permission.maxRetentionMs > 30 * 86400_000)
    throw new SourceSaveError("policy_disabled");
}

/** A precondition for the exact observation, not an identity, permission, or bearer token. */
export function sourceDetailFingerprint(value: SourceAlbumDelivery): string {
  const { delivery: _delivery, refreshFailure: _failure, ...raw } = value;
  const metadata = validateMetadata(raw);
  if (metadata.data.kind !== "album") throw new SourceSaveError("invalid_response");
  const { parsedAt: _parsedAt, ...capture } = metadata.provenance;
  return createHash("sha256").update(JSON.stringify({ data: metadata.data, capture, warnings: metadata.warnings })).digest("hex");
}

/** Called after a server-owned detail recheck, inside the final database boundary. Never accepts browser metadata. */
export function admitSourceAlbum(input: SourceSaveInput, value: SourceAlbumResponse, policy: CatalogAdmissionPolicy, now: number) {
  requireCatalogPermission(policy, input.sourceId, policy.sampleKind, now);
  try {
    if (!value.ok || !value.result.ok || value.status !== "complete" || value.termination !== "settled") throw new SourceSaveError("refresh_required");
    const result = value.result, { delivery, refreshFailure, ...raw } = result, dto = validateMetadata(raw);
    if (dto.data.kind !== "album" || value.ref.sourceId !== input.sourceId || value.ref.externalKey !== input.externalKey
      || value.ref.pageUrl !== dto.data.pageUrl || dto.data.sourceId !== input.sourceId || dto.data.externalKey !== input.externalKey
      || value.sampleKind !== policy.sampleKind || dto.provenance.sampleKind !== policy.sampleKind
      || dto.provenance.parserVersion !== policy.parserVersion) throw new SourceSaveError("invalid_response");
    if (value.policy.revision !== policy.metadataRevision) throw new SourceSaveError("policy_changed");
    if (!value.policy.display.allowed || !value.policy.cache.allowed || delivery.from === "transport" && !value.policy.collect.allowed)
      throw new SourceSaveError("policy_disabled");
    if (!["cache", "transport"].includes(delivery.from) || !["fresh", "stale"].includes(delivery.freshness)) throw new SourceSaveError("invalid_response");
    const captured = Date.parse(dto.provenance.capturedAt), parsed = Date.parse(dto.provenance.parsedAt);
    const fresh = Date.parse(delivery.freshUntil), expires = Date.parse(delivery.expiresAt);
    if (![captured, parsed, fresh, expires].every(Number.isFinite) || captured > parsed || parsed > now || fresh < captured || expires < fresh)
      throw new SourceSaveError("invalid_response");
    const retention = policy.persistence.status === "allowed" ? policy.persistence.maxRetentionMs : 0;
    const retainUntil = Math.min(expires, captured + retention);
    if (retainUntil <= now) throw new SourceSaveError("result_expired");
    if (fresh <= now || delivery.freshness !== "fresh" || refreshFailure) throw new SourceSaveError("refresh_required");
    if (sourceDetailFingerprint(result) !== input.expectedFingerprint) throw new SourceSaveError("snapshot_changed");
    return { metadata: dto, policyRevision: policy.revision, retainUntil: new Date(retainUntil).toISOString() };
  } catch (error) {
    if (error instanceof SourceSaveError) throw error;
    throw new SourceSaveError("invalid_response");
  }
}
