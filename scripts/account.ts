import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { databasePath, serverConfig } from "../src/config.ts";
import { openDatabase } from "../src/database/connection.ts";
import { assertMigrated } from "../src/database/migrate.ts";
import { createAccount, resetAccountPassword } from "../src/auth/accounts.ts";

// Passwords are read from stdin, never command-line arguments or environment variables.
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += String(chunk);
      if (input.length > 1024) throw new Error("Password input too large");
    }
    return input.replace(/\r?\n$/, "");
  }
  process.stderr.write("Password (12–128 characters, hidden): ");
  const muted = new (await import("node:stream")).Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true });
  try { return await reader.question(""); }
  finally { reader.close(); process.stderr.write("\n"); }
}

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    email: { type: "string" }, name: { type: "string" },
  } });
  if (!["create", "reset-password"].includes(positionals[0] ?? "") || !values.email)
    throw new Error("Usage: account.ts create --email EMAIL --name NAME | reset-password --email EMAIL");
  const config = serverConfig();
  const db = openDatabase(databasePath());
  try {
    assertMigrated(db);
    const password = await readPassword();
    if (positionals[0] === "create") {
      const user = await createAccount(db, config, { email: values.email, name: values.name, password });
      process.stdout.write(`Account created: ${user.id}\n`);
    } else {
      await resetAccountPassword(db, config, { email: values.email, password });
      process.stdout.write("Password reset; existing sessions revoked.\n");
    }
  } finally { db.close(); }
} catch {
  // Do not echo validation input, passwords, reset tokens, or credential rows.
  process.stderr.write("Account operation failed. Check command options, configuration and account state.\n");
  process.exitCode = 1;
}
