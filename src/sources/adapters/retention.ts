export interface Retention { store: boolean; maxAgeMs?: number; staleAllowed: boolean }

/** Deliberately more restrictive than a general HTTP cache. No validators or revalidation yet. */
export function retentionFromHeaders(input: Record<string, string>, now: number): Retention {
  const headers = Object.fromEntries(Object.entries(input).map(([key, value]) => [key.toLowerCase(), value]));
  if (headers.vary?.split(",").some((name) => !["accept", "accept-encoding", "user-agent"].includes(name.trim().toLowerCase())))
    return { store: false, staleAllowed: false };
  const directives = (headers["cache-control"] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const forbidden = directives.some((s) => /^(no-store|private|no-cache)(?:\s*=|$)/.test(s));
  const ages = directives.filter((s) => /^(s-maxage|max-age)(?:\s*=|$)/.test(s));
  const parsedAges = ages.map((s) => /^(?:s-maxage|max-age)\s*=\s*"?(\d+)"?$/.exec(s)?.[1]);
  if (forbidden || parsedAges.some((age) => age === undefined)) return { store: false, staleAllowed: false };
  const caps: number[] = parsedAges.map((age) => Number(age) * 1000);
  const date = headers.date ? parseHttpDate(headers.date) : now;
  if (!Number.isFinite(date)) return { store: false, staleAllowed: false };
  if (headers.expires !== undefined) {
    const expires = parseHttpDate(headers.expires);
    if (!Number.isFinite(expires)) return { store: false, staleAllowed: false };
    caps.push(expires - (Number.isFinite(date) ? date : now));
  }
  if (headers.age && !/^\d+$/.test(headers.age)) return { store: false, staleAllowed: false };
  const elapsed = Number(headers.age ?? 0) * 1000 + Math.max(0, now - (Number.isFinite(date) ? date : now));
  const maxAgeMs = caps.length ? Math.max(0, Math.min(...caps) - elapsed) : undefined;
  const staleAllowed = !directives.some((s) => /^(must-revalidate|proxy-revalidate)(?:\s*=|$)/.test(s));
  if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0)) return { store: false, staleAllowed: false };
  return { store: true, staleAllowed, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) };
}
import { parseHttpDate } from "../http-date.ts";
