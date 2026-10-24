import type { PageKind, SourceAlbumRef, SourceId } from "./types.ts";

export const origins: Record<SourceId, string> = {
  khinsider: "https://downloads.khinsider.com",
  zophar: "https://www.zophar.net",
};

function sourceUrl(source: SourceId, value: string): URL | null {
  try {
    const url = new URL(value, origins[source]);
    if (url.origin !== origins[source] || url.username || url.password) return null;
    // Path restrictions must not reject legitimate search text such as NieR/Automata.
    const rawPath = value.split(/[?#]/, 1)[0] ?? "";
    if (/[\\\u0000-\u0020\u007f]/u.test(value) || /%(?:2f|5c|2e)/i.test(rawPath)) return null;
    if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) return null;
    return url;
  } catch {
    return null;
  }
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !/[\/\\?#%\u0000-\u001f\u007f]/u.test(decoded) && ![".", ".."].includes(decoded)
      ? decoded : null;
  } catch {
    return null;
  }
}

/** Source keys are locators, not LoopShelf entity IDs. No fetch is performed. */
export function normalizeAlbumUrl(source: SourceId, value: string): SourceAlbumRef | null {
  const url = sourceUrl(source, value);
  if (!url) return null;
  if (source === "khinsider") {
    const match = /^\/game-soundtracks\/album\/([^/]+)\/?$/.exec(url.pathname);
    const slug = match?.[1] ? decodeSegment(match[1]) : null;
    return slug ? { sourceId: source, externalKey: slug,
      pageUrl: `${origins[source]}/game-soundtracks/album/${encodeURIComponent(slug)}` } : null;
  }
  const match = /^\/music\/([^/]+)\/([^/]+)\.html$/.exec(url.pathname);
  const system = match?.[1] ? decodeSegment(match[1]) : null;
  const slug = match?.[2] ? decodeSegment(match[2]) : null;
  if (!system || !slug || ["year", "developer", "publisher"].includes(system)) return null;
  return { sourceId: source, externalKey: `${system}/${slug}`,
    pageUrl: `${origins[source]}/music/${encodeURIComponent(system)}/${encodeURIComponent(slug)}.html` };
}

export function isPageUrl(source: SourceId, kind: PageKind, value: string): boolean {
  const url = sourceUrl(source, value);
  if (!url) return false;
  if (kind === "album") return normalizeAlbumUrl(source, value) !== null;
  return url.pathname === "/search" && url.searchParams.getAll("search").length === 1
    && Boolean(url.searchParams.get("search")?.trim())
    && (!url.searchParams.has("type") || url.searchParams.get("type") === "album");
}

export function normalizeNextPage(source: SourceId, href: string, current: string): string | null {
  try {
    const next = new URL(href, current);
    const previous = new URL(current);
    if (!sourceUrl(source, href) || !isPageUrl(source, "search", next.href)
      || next.searchParams.get("search") !== previous.searchParams.get("search")) return null;
    next.hash = "";
    return next.href === previous.href ? null : next.href;
  } catch {
    return null;
  }
}
