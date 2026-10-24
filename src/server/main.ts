import { databasePath, serverConfig } from "../config.ts";
import { openDatabase } from "../database/connection.ts";
import { buildApp } from "./app.ts";
import { registerWeb } from "./web.ts";
import type { FastifyInstance } from "fastify";

const db = openDatabase(databasePath());
let app: FastifyInstance | undefined;
try {
  const config = serverConfig();
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  app = await buildApp(db, config);
  app.addHook("onClose", async () => { if (db.open) db.close(); });
  await registerWeb(app, process.argv.includes("--dev"));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app?.close(); });
  await app.listen({ host: "127.0.0.1", port });
  process.stdout.write(`LoopShelf listening at ${config.baseURL}\n`);
} catch (error) {
  await app?.close();
  if (db.open) db.close();
  process.stderr.write(`${error instanceof Error ? error.message : "Startup failed"}\n`);
  process.exitCode = 1;
}
