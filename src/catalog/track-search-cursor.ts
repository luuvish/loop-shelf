import { createHash } from "node:crypto";
import { z } from "zod";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const payloadSchema = z.object({ v: z.literal(1), id: z.uuid(), context: z.string().regex(/^[a-f0-9]{64}$/u),
  anchor: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

// A bounded continuation hint, never authentication or a snapshot. No titles/keys are copied into it.
export const trackCursorSchema = z.string().min(1).max(384).regex(/^[A-Za-z0-9_-]+$/u).transform((value, ctx) => {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("Non-canonical cursor");
    return payloadSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid track cursor" }); return z.NEVER;
  }
});
export function trackCursorContext(options: { q: string; sourceId?: string | undefined; limit: number }): string {
  return digest([options.q, options.sourceId ?? null, options.limit]);
}
export interface TrackCursorAnchor {
  id: string; sortTitle: string; sourceId: string; externalKey: string; position: number;
  albumId: string; sourceEntityId: string; observationId: string;
}
export function trackAnchorFingerprint(row: TrackCursorAnchor): string {
  return digest([row.id, row.sortTitle, row.sourceId, row.externalKey, row.position, row.albumId, row.sourceEntityId, row.observationId]);
}
export function encodeTrackCursor(row: TrackCursorAnchor, context: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id: row.id, context, anchor: trackAnchorFingerprint(row) })).toString("base64url");
}
