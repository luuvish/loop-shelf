import { normalizeAlbumUrl, origins } from "../urls.ts";
import { TransportFault, type SourceRequest } from "./contracts.ts";

export function requestUrl(request: SourceRequest): URL {
  if (!request || !["khinsider", "zophar"].includes(request.sourceId)) throw new TransportFault("invalid_input");
  const origin = origins[request.sourceId];
  if (request.kind === "search") {
    if (typeof request.query !== "string" || !request.query.trim() || request.query.length > 200
      || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(request.query))
      throw new TransportFault("invalid_input");
    const url = new URL("/search", origin);
    url.searchParams.set("search", request.query.trim());
    if (request.sourceId === "khinsider") url.searchParams.set("type", "album");
    return url;
  }
  if (request.kind !== "album" || typeof request.externalKey !== "string" || request.externalKey.length > 1024
    || /[\ud800-\udfff]/u.test(request.externalKey)) throw new TransportFault("invalid_input");
  const parts = request.externalKey.split("/");
  if (parts.length !== (request.sourceId === "khinsider" ? 1 : 2)
    || parts.some((part) => !part || /[\\?#%\u0000-\u001f\u007f]/u.test(part) || [".", ".."].includes(part)))
    throw new TransportFault("invalid_input");
  const path = request.sourceId === "khinsider" ? `/game-soundtracks/album/${encodeURIComponent(parts[0]!)}`
    : `/music/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}.html`;
  const ref = normalizeAlbumUrl(request.sourceId, origin + path);
  if (!ref || ref.externalKey !== request.externalKey) throw new TransportFault("invalid_input");
  return new URL(ref.pageUrl);
}

/** Only spelling/canonicalization of the SAME resource may redirect. No pagination or mirrors. */
export function redirectUrl(request: SourceRequest, current: URL, location: string): URL {
  const rawPath = location.split(/[?#]/, 1)[0] ?? "";
  if (!location || location.length > 4096 || /[\\\u0000-\u0020\u007f]/u.test(location)
    || /%(?:2e|2f|5c)/i.test(rawPath) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath))
    throw new TransportFault("redirect_rejected");
  let next: URL;
  try { next = new URL(location, current); } catch { throw new TransportFault("redirect_rejected"); }
  const initial = requestUrl(request);
  if (next.origin !== initial.origin || next.username || next.password || next.hash)
    throw new TransportFault("redirect_rejected");
  if (request.kind === "album") {
    if (next.search || normalizeAlbumUrl(request.sourceId, next.href)?.pageUrl !== initial.href)
      throw new TransportFault("redirect_rejected");
  } else {
    const expected = [...initial.searchParams].sort();
    const actual = [...next.searchParams].sort();
    if (next.pathname !== initial.pathname || JSON.stringify(expected) !== JSON.stringify(actual))
      throw new TransportFault("redirect_rejected");
  }
  return next;
}
