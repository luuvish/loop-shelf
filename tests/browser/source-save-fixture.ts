// Loaded ONLY by the dedicated temporary save E2E servers. Never imported by product code.
import type Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { authOptions, type AuthConfig } from "../../src/auth/options.ts";
import { getSourceAlbumService } from "../../src/source-album.ts";
import { createSourceAlbumService } from "../../src/source-album/service.ts";
import { getSourceAlbumSaveService } from "../../src/source-save.ts";
import { createSourceSaveService } from "../../src/source-save/service.ts";
import { albumResponse } from "./source-album-fixture.ts";
import type { SourceAlbumDelivery } from "../../src/shared/source-album.ts";
import type { SourceId } from "../../src/sources/types.ts";

export async function installSourceSaveFixture(db: Database.Database, config: AuthConfig) {
  const auth = betterAuth(authOptions(db, config)); await auth.$context;
  const clock = { now: () => Date.now(), timer(ms: number, callback: () => void) { const id = setTimeout(callback, ms); return () => clearTimeout(id); } };
  const policy = { revision: "browser-synthetic-v1", collect: { allowed: true as const }, cache: { allowed: true as const }, display: { allowed: true as const } };
  const albums = new Map<string, SourceAlbumDelivery>();
  const adapter = (sourceId: SourceId) => ({ getAlbum: async (externalKey: string) => {
    const key = `${sourceId}:${externalKey}`;
    let value = albums.get(key);
    if (!value) {
      const response = albumResponse({ sourceId, externalKey }); if (!response.result.ok) throw new Error("Expected synthetic detail");
      value = response.result; albums.set(key, value);
    }
    return structuredClone(value);
  } });
  const detail = createSourceAlbumService(db, { sampleKind: "synthetic", clock, policy: () => policy,
    adapters: { khinsider: adapter("khinsider"), zophar: adapter("zophar") } });
  const save = createSourceSaveService(db, { auth, detail, clock, sampleKind: "synthetic", policy: (sourceId) => ({
    sourceId, sampleKind: "synthetic", revision: "browser-save-v1", metadataRevision: policy.revision, parserVersion: "browser-synthetic-v1",
    persistence: { status: "allowed", evidence: ["generated E2E data only"], reviewedAt: "2026-10-23T00:00:00Z", maxRetentionMs: 86400_000 },
  }) });
  const productDetail = getSourceAlbumService(db), productSave = getSourceAlbumSaveService(db, auth);
  productDetail.getAlbum = detail.getAlbum; productDetail.recheck = detail.recheck;
  productSave.selection = save.selection; productSave.save = save.save;
}
