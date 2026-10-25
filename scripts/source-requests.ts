import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { z } from "zod";
import { databasePath } from "../src/config.ts";
import { openDatabase } from "../src/database/connection.ts";
import { assertMigrated } from "../src/database/migrate.ts";
import { deferSourceRequests, recoverSourceRequest } from "../src/sources/transport/sqlite-coordinator.ts";

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: {
    source: { type: "string" }, token: { type: "string" }, "reviewed-retry-at": { type: "string" }, "confirm-workers-stopped": { type: "boolean" },
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !["inspect", "recover", "defer"].includes(command ?? "")) throw new Error("Use inspect, recover or defer");
  const sourceId = z.enum(["khinsider", "zophar"]).parse(values.source);
  if (command === "inspect" && Object.keys(values).length !== 1) throw new Error("inspect accepts only --source");
  if (command === "defer" && values.token !== undefined) throw new Error("defer cannot release a token");
  const waiting = command !== "inspect" ? {
    sourceId,
    retryAt: Date.parse(z.iso.datetime({ offset: true }).parse(values["reviewed-retry-at"])),
  } : undefined;
  const recovery = command === "recover" ? { ...waiting!, token: z.uuid().parse(values.token) } : undefined;
  if (waiting && values["confirm-workers-stopped"] !== true) throw new Error("Stop ALL workers and review upstream waiting requirements, then pass --confirm-workers-stopped");
  if (!existsSync(databasePath())) throw new Error("Database does not exist");
  const db = openDatabase(databasePath());
  try {
    assertMigrated(db);
    const result = recovery ? await recoverSourceRequest(db, recovery) : waiting ? await deferSourceRequests(db, waiting) : db.transaction(() => ({
      state: db.prepare("SELECT * FROM source_request_state WHERE source_id=?").get(sourceId),
      tickets: db.prepare("SELECT token,owner_id,phase,expires_at FROM source_request_ticket WHERE source_id=? ORDER BY sequence").all(sourceId),
    })).deferred();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { db.close(); }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Source coordination operation failed"}\n`);
  process.exitCode = 1;
}
