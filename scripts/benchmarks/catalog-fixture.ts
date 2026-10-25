// Benchmark-only synthetic data. Never imported by the application or loaded into an existing DB.
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { CatalogStore } from "../../src/catalog/store.ts";
import { CatalogLibraryStore } from "../../src/library/catalog.ts";
import { CatalogTransfer } from "../../src/library/catalog-transfer.ts";
import { withDatabase } from "../../src/database/access.ts";
import type { CatalogInput } from "../../src/catalog/input.ts";
import type { CatalogArchive } from "../../src/shared/catalog-transfer.ts";

export const fixtureVersion = "catalog-scale-v1";
export function syntheticAlbum(index: number, tracks: number): CatalogInput {
  const key = `benchmark-${String(index).padStart(5, "0")}`, sourceId = index % 2 ? "zophar" : "khinsider";
  const externalKey = sourceId === "zophar" ? `nintendo-snes-spc/${key}` : key;
  const pageUrl = sourceId === "zophar" ? `https://www.zophar.net/music/${externalKey}.html` : `https://downloads.khinsider.com/game-soundtracks/album/${externalKey}`;
  const theme = ["기억의 숲", "星の記憶", "Adventure", "Ｆａｎｔａｓｙ", "100%_Mix"];
  const data: Extract<CatalogInput["data"], { kind: "album" }> = { kind: "album", sourceId, externalKey, pageUrl, title: `[Synthetic] ${theme[index % theme.length]} Album ${String(index).padStart(5, "0")}`,
    titleKind: "album-title" as const, platforms: ["Synthetic platform"], sourceCategory: null, sourceYearLabel: null,
    sourceClaims: [], releaseDate: null, playback: "unverified" as const,
    tracks: Array.from({ length: tracks }, (_, i) => ({ externalKey: null, snapshotLocator: `row:${i + 1}`, position: i + 1,
      displayNumber: String(i % 3 + 1), discLabel: null, title: `[Synthetic] ${theme[i % theme.length]} Track ${i + 1}`,
      durationLabel: "2:00", durationSeconds: 120 })) };
  return { ok: true, data, provenance: { sourceId, pageUrl, capturedAt: "2026-10-24T00:00:00.000Z", parsedAt: "2026-10-24T00:00:00.000Z",
    parserVersion: fixtureVersion, bodySha256: createHash("sha256").update(JSON.stringify(data)).digest("hex"), sampleKind: "synthetic" }, warnings: [] };
}

export async function seedBenchmark(db: Database.Database, owner: string, other: string, albums: number, tracks: number, progress: (count: number) => void = () => {},
  makeAlbum: (index: number, tracks: number) => CatalogInput = syntheticAlbum) {
  const catalog = new CatalogStore(db), library = new CatalogLibraryStore(db);
  const albumIds: string[] = [], sourceIds: string[] = [], savedIds: string[] = [];
  const saveCount = Math.min(4900, albums - 2);
  for (let i = 0; i < albums; i++) {
    const [result] = await catalog.ingestSynthetic(makeAlbum(i, tracks));
    albumIds.push(result!.albumId); sourceIds.push(result!.sourceEntityId);
    await withDatabase(db, async () => {
      if (i < saveCount) {
        const entityId = i % 2 ? (db.prepare("SELECT id FROM track WHERE album_id=? ORDER BY position LIMIT 1").get(result!.albumId) as { id: string }).id : result!.albumId;
        savedIds.push(library.create(owner, { entityId, note: `내 기록 日本語 private-${String(i).padStart(5, "0")}`, favorite: i % 3 === 0 }).item.id);
      }
      if (i < Math.min(1000, saveCount)) library.create(other, { entityId: result!.albumId, note: "other-account-secret" });
    });
    if ((i + 1) % 500 === 0) progress(i + 1);
  }
  // A bounded set of personal source judgments exercises the EXISTS search branch.
  const links = Math.min(100, Math.floor(saveCount / 2));
  const destinations = Array.from({ length: links }, (_, i) => albums - 1 - i);
  // At some small scales an album would link to itself. Swap two destinations to retain uniqueness.
  for (let i = 0; i < links; i++) if (destinations[i] === i * 2) {
    const next = (i + 1) % links;
    [destinations[i], destinations[next]] = [destinations[next]!, destinations[i]!];
  }
  await withDatabase(db, async () => {
    for (let i = 0; i < links; i++) {
      const item = library.get(owner, savedIds[i * 2]!);
      library.connect(owner, item.id, { version: item.version, sourceEntityId: sourceIds[destinations[i]!]! });
    }
    const now = "2026-10-24T00:00:00.000Z";
    const archive: CatalogArchive = { format: "loopshelf-catalog", schemaVersion: 1, sampleKind: "synthetic", exportedAt: now,
      items: Array.from({ length: Math.min(100, albums) }, (_, i) => { const entityId = randomUUID(), key = `detached-${i}`; return {
        id: randomUUID(), reference: { entityId, kind: "album", albumId: entityId, source: { id: randomUUID(), sourceId: "khinsider", externalKey: key,
          pageUrl: `https://downloads.khinsider.com/game-soundtracks/album/${key}` } }, titleOverride: null, note: `미연결 개인 기록 ${i}`, favorite: false,
        createdAt: now, updatedAt: now, sourceLinks: [],
      }; }) };
    const transfer = new CatalogTransfer(db, "benchmark-only-transfer-secret-at-least-32-characters");
    transfer.import(owner, archive, transfer.preview(owner, archive).token!);
  });
  return { albumIds, savedIds, counts: { albums, tracks: albums * tracks, personal: saveCount + Math.min(100, albums), otherPersonal: Math.min(1000, saveCount), links, detached: Math.min(100, albums) } };
}
