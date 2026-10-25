import { parseHttpDate } from "../http-date.ts";
import { TRANSPORT_LIMITS } from "./contracts.ts";

export function cooldownUntil(header: string | undefined, now: number): number {
  if (header && /^\d+$/.test(header.trim()))
    return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(now + Number(header.trim()) * 1000));
  const date = header ? parseHttpDate(header) : NaN;
  return Number.isFinite(date) && date > now ? date : Math.ceil(now + TRANSPORT_LIMITS.fallbackCooldownMs);
}
