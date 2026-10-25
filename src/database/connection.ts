import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Also required by snapshot connections when checking or updating expression indexes. */
export function registerDatabaseFunctions(db: Database.Database): void {
  db.function("normalize_search", { deterministic: true }, (value: unknown) => normalizeSearch(String(value ?? "")));
}

export function openDatabase(filename: string): Database.Database {
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new Database(filename, { timeout: 5000 });
  try {
    registerDatabaseFunctions(db);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
