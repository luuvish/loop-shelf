// Synthetic catalog setup belongs only to the isolated browser harness, never the application server.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { CatalogStore } from "../../src/catalog/store.ts";
import { CatalogLibraryStore } from "../../src/library/catalog.ts";
import { attachSyntheticRetention, reconcileCatalogRetention } from "../../src/catalog/retention.ts";
import { withDatabase } from "../../src/database/access.ts";
import { inspectCapturedPage } from "../../src/sources/parsers.ts";
import type { AlbumDetail, ParseResult } from "../../src/sources/types.ts";

function detail(key: string, title: string) {
  const pageUrl = `https://www.zophar.net/music/nintendo-snes-spc/${key}.html`;
  const result = inspectCapturedPage({ sourceId: "zophar", kind: "album", status: 200, sampleKind: "synthetic", capturedAt: "2026-10-18T14:00:00Z", url: pageUrl,
    headers: { "content-type": "text/html" }, html: readFileSync(new URL("../fixtures/zophar-album.html", import.meta.url), "utf8") });
  assert.ok(result.ok);
  const value = result as Extract<ParseResult, { ok: true }> & { data: AlbumDetail }; value.data.title = title; return value;
}
export async function seedCatalog(db: Database.Database, userId: string, prefix: string) {
  const catalog = new CatalogStore(db), library = new CatalogLibraryStore(db);
  const save = (entityId: string, fields = {}) => withDatabase(db, async () => library.create(userId, { entityId, ...fields }).item);
  for (let i = 1; i <= 10; i++) {
    const [filler] = await catalog.ingestSynthetic(detail(`${prefix}-extra-${i}`, `[합성] 다른 앨범 ${String(i).padStart(2, "0")}`));
    await save(filler!.albumId, i === 10 ? { note: "만료 뒤에도 남는 개인 메모" } : {});
    if (i === 10) await withDatabase(db, async () => db.transaction(() => {
      attachSyntheticRetention(db, filler!.observationId, "browser-synthetic-v1", "2026-10-18T15:00:00.000Z");
      reconcileCatalogRetention(db, Date.parse("2026-10-18T15:00:00.000Z"));
    }).immediate());
  }
  const original = detail(`${prefix}-main`, "[합성] 星の記憶 — 기억의 앨범");
  const [ingested] = await catalog.ingestSynthetic(original), album = await catalog.getAlbum(ingested!.albumId);
  const root = await save(album.id, { note: "日本語 기억과 메모", favorite: true });
  await save(album.tracks[2]!.id, { titleOverride: "[합성] 순서가 바뀐 곡" });
  await save(album.tracks[1]!.id, { titleOverride: "[합성] 누락된 곡", note: "누락 뒤에도 남는 개인 메모" });
  const next = detail(`${prefix}-main`, original.data.title); next.provenance.capturedAt = "2026-10-18T14:01:00Z";
  next.data.tracks = [next.data.tracks[2]!, next.data.tracks[0]!, next.data.tracks[3]!]; next.data.tracks.forEach((row, i) => row.position = i + 1);
  const [pending] = await catalog.ingestSynthetic(next);
  await catalog.adoptTrackList({ requestId: randomUUID(), albumId: album.id, expectedTracksObservationId: album.tracksObservationId,
    observationId: pending!.observationId, assignments: [album.tracks[2]!.id, album.tracks[0]!.id, album.tracks[3]!.id].map((trackId, i) => ({ position: i + 1, trackId })), missingTrackIds: [album.tracks[1]!.id] });
  const [removed] = await catalog.ingestSynthetic(detail(`${prefix}-removed`, "[합성] 제거 전에만 보이는 제목"));
  await save(removed!.albumId, { note: "제거 뒤에도 보존할 개인 내용" });
  await withDatabase(db, async () => library.connect(userId, root.id, { version: root.version, sourceEntityId: removed!.sourceEntityId }));
  await catalog.removeSource({ sourceEntityId: removed!.sourceEntityId, reason: "policy_change" });

  const summary = inspectCapturedPage({ sourceId: "khinsider", kind: "search", status: 200, sampleKind: "synthetic", capturedAt: "2026-10-18T14:00:00Z", url: "https://downloads.khinsider.com/search?search=sample", headers: { "content-type": "text/html" }, html: readFileSync(new URL("../fixtures/khinsider-search.html", import.meta.url), "utf8") });
  assert.ok(summary.ok); await catalog.ingestSynthetic(summary);
  const browse = detail(`${prefix}-browse`, "[합성] 새로 발견한 앨범");
  // Thirteen rows exercise bounded detail paging; repeated labels still have separate identities.
  browse.data.tracks = Array.from({ length: 13 }, (_, i) => ({ ...browse.data.tracks[i % 4]!, position: i + 1, snapshotLocator: `row:${i + 1}`, title: `[합성] 새 곡 ${String(i + 1).padStart(2, "0")}` }));
  await catalog.ingestSynthetic(browse);

}
