import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { inspectCapturedPage, MAX_HTML_BYTES } from "../src/sources/parsers.ts";
import { summarizeCapture } from "../src/sources/evidence.ts";
import type { CapturedPage } from "../src/sources/types.ts";

const usage = `Offline only. No network requests are made.
node scripts/inspect-source.ts --source khinsider|zophar --kind search|album \\
  --input capture.html --headers capture.headers --url https://... \\
  --captured-at ISO_TIMESTAMP --sample-kind live-capture|synthetic [--summary]
Exit codes: 0 parsed, 1 capture rejected, 2 invalid CLI input.
`;

try {
  const { values } = parseArgs({ options: {
    source: { type: "string" }, kind: { type: "string" }, input: { type: "string" },
    headers: { type: "string" }, url: { type: "string" }, "captured-at": { type: "string" },
    "sample-kind": { type: "string" }, summary: { type: "boolean" }, help: { type: "boolean" },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    process.stdout.write(usage);
  } else {
    const sourceId = values.source;
    const kind = values.kind;
    const sampleKind = values["sample-kind"];
    if ((sourceId !== "khinsider" && sourceId !== "zophar") || (kind !== "search" && kind !== "album")
      || (sampleKind !== "live-capture" && sampleKind !== "synthetic") || !values.input || !values.headers
      || !values.url || !values["captured-at"]) throw new Error("Required options are missing or invalid");
    for (const [file, limit] of [[values.input, MAX_HTML_BYTES], [values.headers, 64 * 1024]] as const) {
      const metadata = await stat(file);
      if (!metadata.isFile() || metadata.size > limit) throw new Error("Capture file is not regular or exceeds size limit");
    }
    const headerText = await readFile(values.headers, "utf8");
    let status = 0;
    let headers: Record<string, string> = {};
    for (const line of headerText.split(/\r?\n/)) {
      const statusLine = /^HTTP\/\S+ (\d{3})\b/.exec(line);
      if (statusLine) { status = Number(statusLine[1]); headers = {}; continue; }
      const separator = line.indexOf(":");
      if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
    }
    if (!status) throw new Error("Capture headers have no HTTP status");
    const page: CapturedPage = { sourceId, kind, sampleKind, url: values.url,
      capturedAt: values["captured-at"], html: await readFile(values.input, "utf8"), status, headers };
    const result = inspectCapturedPage(page);
    process.stdout.write(`${JSON.stringify(values.summary ? summarizeCapture(page, result) : result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid input"}\n${usage}`);
  process.exitCode = 2;
}
