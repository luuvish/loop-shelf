import Database from "better-sqlite3";
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { reconcileCatalogRetention } from "../catalog/retention.ts";

export function verifyDatabase(db: Database.Database): void {
  const checks = db.pragma("integrity_check") as { integrity_check: string }[];
  if (checks.length !== 1 || checks[0]?.integrity_check !== "ok" || (db.pragma("foreign_key_check") as unknown[]).length)
    throw new Error("Database integrity verification failed");
}

/** SQLite online backup includes committed WAL data. Existing files are never replaced. */
export async function backupDatabase(db: Database.Database, destination: string): Promise<void> {
  await writeSnapshot(db, destination);
}

async function writeSnapshot(db: Database.Database, destination: string, prepare?: (copy: Database.Database) => void): Promise<void> {
  const output = resolve(destination);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  closeSync(openSync(output, "wx", 0o600));
  try {
    await db.backup(output);
    const copy = new Database(output, { fileMustExist: true });
    try {
      // A portable snapshot must not need WAL/SHM sidecars just to be opened.
      copy.pragma("journal_mode = DELETE");
      copy.pragma("foreign_keys = ON");
      if (prepare) copy.transaction(() => prepare(copy)).immediate();
      reconcileCatalogRetention(copy);
      verifyDatabase(copy);
    } finally { copy.close(); }
  } catch (error) {
    unlinkSync(output);
    throw error;
  }
}

/** Restore to a NEW path. A past snapshot must never revive a revoked login or reset token. */
export async function restoreDatabase(source: string, destination: string): Promise<void> {
  const snapshot = new Database(resolve(source), { readonly: true, fileMustExist: true });
  try {
    verifyDatabase(snapshot);
    await writeSnapshot(snapshot, destination, (copy) => {
      // FK cascades also discard session-owned deletion receipts. Account credentials and library IDs remain intact.
      copy.exec('DELETE FROM "session"; DELETE FROM "verification";');
    });
  }
  finally { snapshot.close(); }
}
