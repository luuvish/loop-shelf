import type Database from "better-sqlite3";
import { validateMetadata, type Metadata } from "../metadata.ts";
import { redirectUrl, requestUrl } from "../transport/requests.ts";
import type { SourceRequest } from "../transport/contracts.ts";
import type { CapturedPage, SourceId } from "../types.ts";
import { AdapterFault, CACHE_LIMITS } from "./contracts.ts";
import type { Retention } from "./retention.ts";

export interface CacheContext {
  request: SourceRequest;
  sampleKind: CapturedPage["sampleKind"];
  parserVersion: string;
  policyRevision: string;
}
export interface CacheEntry { metadata: Metadata; capturedAt: number; freshUntil: number; expiresAt: number }
export function locator(request: SourceRequest): string {
  return request.kind === "search" ? request.query.trim() : request.externalKey;
}
function params(context: CacheContext) {
  return [context.request.sourceId, context.request.kind, locator(context.request), context.sampleKind];
}

/** Also prevents a bad capture/old cache from being attributed to a different request or fixture mode. */
export function validateContext(input: unknown, context: CacheContext): Metadata {
  const value = validateMetadata(input);
  const { provenance, data } = value;
  if (provenance.sourceId !== context.request.sourceId || data.kind !== context.request.kind
    || provenance.sampleKind !== context.sampleKind || provenance.parserVersion !== context.parserVersion)
    throw new AdapterFault("invalid_response", "parser");
  redirectUrl(context.request, requestUrl(context.request), provenance.pageUrl);
  return value;
}

/** Synchronous operations; caller owns withDatabase. No network or async transactions here. */
export class MetadataCache {
  readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }
  purgeSource(source: SourceId) { this.db.prepare("DELETE FROM source_metadata_cache WHERE source_id=?").run(source); }
  delete(context: CacheContext) {
    this.db.prepare("DELETE FROM source_metadata_cache WHERE source_id=? AND kind=? AND request_key=? AND sample_kind=?").run(...params(context));
  }
  isRemoved(source: SourceId, key: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM catalog_removal r JOIN source_entity s ON s.id=r.source_entity_id
      WHERE s.source_id=? AND s.external_key=? AND s.external_kind='album'`).get(source, key));
  }
  checkRemoval(context: CacheContext, metadata?: Metadata) {
    const keys = metadata ? (metadata.data.kind === "album" ? [metadata.data.externalKey] : metadata.data.albums.map((a) => a.externalKey))
      : context.request.kind === "album" ? [context.request.externalKey] : [];
    if (keys.some((key) => this.isRemoved(context.request.sourceId, key))) {
      this.delete(context);
      throw new AdapterFault("content_removed", "cache");
    }
  }
  read(context: CacheContext, now: number): CacheEntry | undefined {
    this.db.prepare("DELETE FROM source_metadata_cache WHERE expires_at<=?").run(now);
    this.checkRemoval(context);
    const row = this.db.prepare(`SELECT parser_version, policy_revision, captured_at, fresh_until, expires_at, payload
      FROM source_metadata_cache WHERE source_id=? AND kind=? AND request_key=? AND sample_kind=?`).get(...params(context)) as {
        parser_version: string; policy_revision: string; captured_at: number; fresh_until: number; expires_at: number; payload: string;
      } | undefined;
    if (!row) return;
    // Retain a previous parser's last good value until expiry, but never serve it with a new parser/policy.
    if (row.parser_version !== context.parserVersion || row.policy_revision !== context.policyRevision) return;
    let metadata: Metadata;
    try {
      metadata = validateContext(JSON.parse(row.payload), context);
      const expected = this.entry(metadata);
      if (row.captured_at !== expected.capturedAt || row.fresh_until > expected.freshUntil || row.expires_at > expected.expiresAt
        || row.captured_at > now) throw new Error("Invalid cache age");
    } catch { this.delete(context); return; }
    this.checkRemoval(context, metadata);
    return { metadata, capturedAt: row.captured_at, freshUntil: row.fresh_until, expiresAt: row.expires_at };
  }
  entry(metadata: Metadata, retention?: Retention): CacheEntry {
    const capturedAt = Date.parse(metadata.provenance.capturedAt);
    const empty = metadata.data.kind === "search" && metadata.data.reportedCount === 0;
    const fresh = empty ? CACHE_LIMITS.emptyMs : metadata.data.kind === "search" ? CACHE_LIMITS.searchFreshMs : CACHE_LIMITS.albumFreshMs;
    const maxAge = empty ? CACHE_LIMITS.emptyMs : metadata.data.kind === "search" ? CACHE_LIMITS.searchMaxAgeMs : CACHE_LIMITS.albumMaxAgeMs;
    const freshUntil = capturedAt + Math.min(fresh, retention?.maxAgeMs ?? Infinity);
    const expiresAt = capturedAt + Math.min(maxAge, retention?.maxAgeMs ?? Infinity);
    return { metadata, capturedAt, freshUntil, expiresAt: retention?.staleAllowed === false ? freshUntil : expiresAt };
  }
  write(context: CacheContext, metadata: Metadata, now: number, retention?: Retention): CacheEntry {
    const entry = this.entry(metadata, retention);
    if (entry.capturedAt > now || entry.expiresAt <= now) throw new AdapterFault("invalid_response", "parser");
    this.checkRemoval(context, metadata);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO source_metadata_cache VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id,kind,request_key,sample_kind) DO UPDATE SET parser_version=excluded.parser_version,
        policy_revision=excluded.policy_revision,captured_at=excluded.captured_at,fresh_until=excluded.fresh_until,
        expires_at=excluded.expires_at,payload=excluded.payload
        WHERE excluded.captured_at >= source_metadata_cache.captured_at`).run(...params(context), context.parserVersion, context.policyRevision,
          entry.capturedAt, entry.freshUntil, entry.expiresAt, JSON.stringify(metadata));
      this.db.prepare("DELETE FROM source_metadata_cache WHERE expires_at<=?").run(now);
      const rows = this.db.prepare(`SELECT rowid, length(CAST(payload AS BLOB)) AS bytes FROM source_metadata_cache
        ORDER BY captured_at DESC, rowid DESC`).all() as { rowid: number; bytes: number }[];
      let bytes = 0;
      for (const [index, row] of rows.entries()) {
        bytes += row.bytes;
        if (index >= CACHE_LIMITS.maxRows || bytes > CACHE_LIMITS.maxBytes)
          this.db.prepare("DELETE FROM source_metadata_cache WHERE rowid=?").run(row.rowid);
      }
    }).immediate();
    return entry;
  }
}
