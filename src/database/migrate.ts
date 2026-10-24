import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type Database from "better-sqlite3";

export interface Migration { name: string; sql: string }
export function loadMigrations(): Migration[] {
  const directory = new URL("../../migrations/", import.meta.url);
  return readdirSync(directory).filter((name) => /^\d{4}_[\w-]+\.sql$/.test(name)).sort()
    .map((name) => ({ name, sql: readFileSync(new URL(name, directory), "utf8") }));
}

/** An entire pending batch commits together, including the version ledger. */
export function migrate(db: Database.Database, migrations = loadMigrations()): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
      name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL
    ) STRICT`);
    const applied = db.prepare("SELECT name, sha256 FROM schema_migration ORDER BY name").all() as { name: string; sha256: string }[];
    for (const [index, row] of applied.entries()) {
      const migration = migrations[index];
      if (!migration || row.name !== migration.name || row.sha256 !== checksum(migration.sql))
        throw new Error(`Migration history mismatch: ${row.name}. Restore matching code; do not rewrite applied migrations.`);
    }
    for (const migration of migrations.slice(applied.length)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migration VALUES (?, ?, ?)").run(migration.name, checksum(migration.sql), new Date().toISOString());
    }
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("Foreign key check failed after migration");
  }).immediate();
}

function checksum(sql: string): string { return createHash("sha256").update(sql).digest("hex"); }

export function assertMigrated(db: Database.Database): void {
  const migrations = loadMigrations();
  let rows: { name: string; sha256: string }[];
  try { rows = db.prepare("SELECT name, sha256 FROM schema_migration ORDER BY name").all() as typeof rows; }
  catch { throw new Error("Database is not initialized. Run npm run db:migrate first."); }
  if (rows.length !== migrations.length || rows.some((row, i) => row.name !== migrations[i]?.name || row.sha256 !== checksum(migrations[i]!.sql)))
    throw new Error("Database migration mismatch. Back up and run npm run db:migrate with matching code.");
}
