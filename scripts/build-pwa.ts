import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Only build-owned public files enter the worker. Never crawl the server's data directories. */
export async function buildPwa(root: string) {
  const assets = (await readdir(join(root, "assets"))).filter((name) => /^[\w-]+\.(js|css)$/u.test(name)).sort();
  const paths = ["/index.html", "/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-180.png", ...assets.map((name) => `/assets/${name}`)];
  const entries = await Promise.all(paths.map(async (url) => ({ url, sha256: digest(await readFile(join(root, url))) })));
  const source = stripTypeScriptTypes(await readFile(new URL("../worker/service-worker.ts", import.meta.url), "utf8"));
  const version = digest(JSON.stringify(entries) + source).slice(0, 20);
  await writeFile(join(root, "sw.js"), `const PRECACHE = ${JSON.stringify(entries)};\nconst VERSION = ${JSON.stringify(version)};\n${source}`);
  return { version, entries };
}
