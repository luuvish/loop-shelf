import type { AdapterFailure, MetadataDelivery, MetadataPolicy } from "../sources/adapters/contracts.ts";
import type { AlbumDetail, Provenance, SourceAlbumRef } from "../sources/types.ts";

export interface SourceAlbumFailure {
  ok: false;
  code: AdapterFailure["code"] | "database_error" | "source_error" | "result_expired";
  stage: AdapterFailure["stage"] | "album";
  httpStatus?: number;
  retryAt?: number;
}
export interface SourceAlbumDelivery extends MetadataDelivery { data: AlbumDetail }
export interface SourceAlbumResponse {
  ok: true;
  ref: SourceAlbumRef;
  sampleKind: Provenance["sampleKind"];
  status: "complete" | "partial" | "failed";
  termination: "settled" | "deadline";
  completedAt: string;
  elapsedMs: number;
  policy: MetadataPolicy;
  result: SourceAlbumDelivery | SourceAlbumFailure;
}
export type SourceAlbumResult = SourceAlbumResponse | { ok: false; code: "invalid_input" | "cancelled" | "queue_full" };
