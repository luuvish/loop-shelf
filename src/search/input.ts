import { z } from "zod";
import { requestUrl } from "../sources/transport/requests.ts";

export const searchSourceIds = ["khinsider", "zophar"] as const;
const schema = z.object({ q: z.string().min(1).max(200),
  sources: z.array(z.enum(searchSourceIds)).max(2).refine((ids) => new Set(ids).size === ids.length).default([]),
  limit: z.number().int().min(1).max(100).default(12), offset: z.number().int().min(0).max(100000).default(0),
}).strict();
export type SearchInput = z.infer<typeof schema>;
export function parseSearchInput(input: unknown): SearchInput {
  const options = schema.parse(input);
  options.q = requestUrl({ sourceId: "khinsider", kind: "search", query: options.q }).searchParams.get("search")!;
  return options;
}
