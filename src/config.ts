import { resolve } from "node:path";
import { z } from "zod";
import type { AuthConfig } from "./auth/options.ts";

export function databasePath(): string { return resolve(process.env.DATABASE_PATH ?? ".local/loopshelf.sqlite"); }
export function serverConfig(): AuthConfig {
  const secret = z.string().min(32).parse(process.env.BETTER_AUTH_SECRET);
  const url = new URL(process.env.APP_ORIGIN ?? "http://127.0.0.1:3000");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && local)))
    throw new Error("APP_ORIGIN must be an HTTPS origin (local HTTP is allowed)");
  return { secret, baseURL: url.origin };
}
