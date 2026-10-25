// Test-only IPC worker: real process/SQLite connection, synthetic DNS/HTTP, never real sockets.
import { openDatabase } from "../../src/database/connection.ts";
import { createTransport } from "../../src/sources/transport/engine.ts";
import { createSqliteCoordinator } from "../../src/sources/transport/sqlite-coordinator.ts";
import type { SourceId } from "../../src/sources/types.ts";

const db = openDatabase(process.argv[2]!);
const pending = new Map<string, () => void>();
const jobs = new Map<string, { id: string; source: SourceId; hold?: boolean; status?: number; retryAfter?: string }>();
const send = (message: unknown) => process.send?.(message);
const capture = createTransport({
  coordinator: createSqliteCoordinator(db), sampleKind: "synthetic", authorize: () => ({ allowed: true }),
  clock: { now: () => performance.timeOrigin + performance.now(), timer(ms, fn) { const id = setTimeout(fn, ms); return () => clearTimeout(id); } },
  async resolve(host) { send({ event: "dns", source: host.includes("zophar") ? "zophar" : "khinsider", at: Date.now() }); return [{ address: "93.184.215.14", family: 4 }]; },
  async open(url) {
    const job = jobs.get(url.searchParams.get("search")!)!;
    send({ event: "open", id: job.id, at: Date.now() });
    return { status: job.status ?? 200, headers: { "content-type": "text/html", ...(job.retryAfter ? { "retry-after": job.retryAfter } : {}) },
      body: { async *[Symbol.asyncIterator]() {
        if (job.hold) await new Promise<void>((resolve) => pending.set(job.id, resolve));
        yield Buffer.from("<html>synthetic</html>");
      } }, close() { send({ event: "close", id: job.id, at: Date.now() }); } };
  },
});
process.on("message", (message: { kind: string; id: string; source: SourceId; hold?: boolean; status?: number; retryAfter?: string }) => {
  if (message.kind === "release") { pending.get(message.id)?.(); pending.delete(message.id); return; }
  if (message.kind !== "start") return;
  jobs.set(message.id, message);
  void capture({ sourceId: message.source, kind: "search", query: message.id }).then((result) => {
    send({ event: "result", id: message.id, result, at: Date.now() }); jobs.delete(message.id);
  });
});
process.on("disconnect", () => process.exit(0));
send({ event: "ready" });
