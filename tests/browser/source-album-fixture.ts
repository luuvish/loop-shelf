// Browser response data only. Never enables a product policy or writes a catalog row.
import type { SourceAlbumResponse } from "../../src/shared/source-album.ts";
import type { SourceId } from "../../src/sources/types.ts";

export interface AlbumQuery { sourceId: SourceId; externalKey: string }
export function albumResponse(input: AlbumQuery): SourceAlbumResponse {
  const pageUrl = input.sourceId === "khinsider"
    ? `https://downloads.khinsider.com/game-soundtracks/album/${input.externalKey}`
    : `https://www.zophar.net/music/${input.externalKey}.html`;
  const captured = Date.now() - 60_000;
  return {
    ok: true, ref: { ...input, pageUrl }, sampleKind: "synthetic", status: "complete", termination: "settled",
    completedAt: new Date().toISOString(), elapsedMs: 10,
    policy: { revision: "browser-synthetic-v1", collect: { allowed: true }, cache: { allowed: true }, display: { allowed: true } },
    result: {
      ok: true, data: { ...input, pageUrl, kind: "album", title: "[합성] 星の記憶 — 상세 앨범 제목", titleKind: "album-title",
        platforms: ["NES"], sourceCategory: "[합성] 게임 음악", sourceYearLabel: "1989?", releaseDate: null, playback: "unverified",
        sourceClaims: [{ label: "출처 게임명", value: '<img src=x onerror="alert(1)">' }],
        tracks: Array.from({ length: 21 }, (_, i) => ({ externalKey: null, snapshotLocator: `row:${i + 1}`, position: i + 1,
          displayNumber: i < 2 ? "01" : String(i + 1), discLabel: null, title: `[합성] 곡 ${i + 1} — 星の記憶`,
          durationLabel: i === 0 ? null : i === 1 ? "반복 / ?" : "1:23", durationSeconds: i < 2 ? null : 83 })) },
      provenance: { sourceId: input.sourceId, pageUrl, capturedAt: new Date(captured).toISOString(), parsedAt: new Date(captured + 1).toISOString(),
        sampleKind: "synthetic", parserVersion: "browser-synthetic-v1", bodySha256: "a".repeat(64) },
      warnings: ["[합성] 원문 길이 일부 미확인"],
      delivery: { from: "cache", freshness: "fresh", freshUntil: new Date(captured + 3_600_000).toISOString(), expiresAt: new Date(captured + 86_400_000).toISOString() },
    },
  };
}
