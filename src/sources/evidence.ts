import type { CapturedPage, ParseResult } from "./types.ts";

/** Small audit record; excludes source HTML, cover art, track names and audio URLs. */
export function summarizeCapture(page: CapturedPage, result: ParseResult) {
  const headers = Object.fromEntries(Object.entries(page.headers).map(([key, value]) => [key.toLowerCase(), value]));
  const record = {
    sourceId: page.sourceId, kind: page.kind, url: page.url, capturedAt: page.capturedAt,
    sampleKind: page.sampleKind, httpStatus: page.status,
    headers: {
      contentType: headers["content-type"] ?? null,
      accessControlAllowOrigin: headers["access-control-allow-origin"] ?? null,
      contentSecurityPolicy: headers["content-security-policy"] ?? null,
      xFrameOptions: headers["x-frame-options"] ?? null,
      retryAfter: headers["retry-after"] ?? null,
    },
  };
  if (!result.ok) return { ...record, parse: { ok: false, code: result.code, message: result.message } };
  const data = result.data;
  const labels = data.kind === "album" ? data.tracks.map((track) => track.displayNumber).filter((n) => n !== null) : [];
  return { ...record, provenance: result.provenance, parse: { ok: true, warnings: result.warnings,
    ...(data.kind === "search" ? { reportedCount: data.reportedCount, parsedCount: data.albums.length,
      nextPageUrl: data.nextPageUrl, coverage: data.coverage, resultLimit: data.resultLimit }
      : { externalKey: data.externalKey, trackCount: data.tracks.length, platforms: data.platforms,
        duplicateDisplayNumberCount: labels.length - new Set(labels).size,
        missingDurationCount: data.tracks.filter((track) => track.durationSeconds === null).length,
        claimLabels: data.sourceClaims.map((claim) => claim.label), playback: data.playback }),
  } };
}
