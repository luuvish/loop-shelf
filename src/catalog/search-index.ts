import type Database from "better-sqlite3";
import { withDatabase } from "../database/access.ts";
import { reconcileCatalogRetention } from "./retention.ts";

/** Snapshot/startup verification. Legacy pre-0016 snapshots have no derived search table. */
export function verifyCatalogSearchIndex(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_track_search_index'").get()) return;
  for (const [left, right] of [["catalog_track_search_index", "catalog_track_search_current"], ["catalog_track_search_current", "catalog_track_search_index"]]) {
    if (db.prepare(`SELECT 1 FROM (SELECT * FROM ${left} EXCEPT SELECT * FROM ${right}) LIMIT 1`).get())
      throw new Error("Catalog search index verification failed; rebuild the derived index before resuming service");
  }
}

/** Operator-only rebuild: derived public rows, never UUIDs, observations or private contents. */
export async function rebuildCatalogSearchIndex(db: Database.Database): Promise<{ indexedTracks: number }> {
  return withDatabase(db, async () => {
    reconcileCatalogRetention(db);
    return db.transaction(() => {
      db.exec("DELETE FROM catalog_track_search_index; INSERT INTO catalog_track_search_index SELECT * FROM catalog_track_search_current;");
      verifyCatalogSearchIndex(db);
      return { indexedTracks: (db.prepare("SELECT count(*) AS n FROM catalog_track_search_index").get() as { n: number }).n };
    }).immediate();
  });
}
