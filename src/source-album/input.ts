import { z } from "zod";
import { requestUrl } from "../sources/transport/requests.ts";

const schema = z.object({ sourceId: z.enum(["khinsider", "zophar"]), externalKey: z.string().min(1).max(1024) }).strict();
export type SourceAlbumInput = z.infer<typeof schema>;
export function parseSourceAlbumInput(input: unknown): SourceAlbumInput {
  const value = schema.parse(input);
  // Exact source keys, never arbitrary URLs or normalized titles. Preserve spaces and Unicode in valid keys.
  requestUrl({ ...value, kind: "album" });
  return value;
}
