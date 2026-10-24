import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { databasePath } from "../src/config.ts";
import { openDatabase } from "../src/database/connection.ts";
import { assertMigrated, migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  input: { type: "string" }, output: { type: "string" },
} });
try {
  const command = positionals[0];
  if (positionals.length !== 1 || !["migrate", "backup", "restore"].includes(command ?? ""))
    throw new Error("Usage: database.ts migrate | backup --output PATH | restore --input PATH --output NEW_PATH");
  if (command === "restore") {
    if (!values.input || !values.output) throw new Error("restore requires --input and --output (a new file)");
    await restoreDatabase(values.input, values.output);
    process.stdout.write("Restore verified; sessions, verification tokens and session-owned undo receipts removed. Sign in again after recovery.\nStop the server before switching DATABASE_PATH to the new file.\n");
  } else {
    if (command === "backup" && !existsSync(databasePath())) throw new Error("Database does not exist");
    const db = openDatabase(databasePath());
    try {
      if (command === "migrate") {
        let pending = false;
        try { assertMigrated(db); } catch { pending = true; }
        if (pending && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()) {
          const output = `${databasePath()}.backups/${new Date().toISOString().replaceAll(":", "-")}.sqlite`;
          await backupDatabase(db, output);
          process.stdout.write(`Pre-migration backup verified: ${output}\n`);
        }
        migrate(db);
        verifyDatabase(db);
        process.stdout.write("Migrations and database integrity verified.\n");
      } else if (command === "backup") {
        if (!values.output) throw new Error("backup requires --output (a new file)");
        assertMigrated(db);
        await backupDatabase(db, values.output);
        process.stdout.write("Backup verified.\n");
      } else throw new Error("Usage: database.ts migrate | backup --output PATH | restore --input PATH --output NEW_PATH");
    } finally { db.close(); }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Database operation failed"}\n`);
  process.exitCode = 1;
}
