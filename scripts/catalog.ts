import { parseArgs } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { databasePath } from "../src/config.ts";
import { openDatabase } from "../src/database/connection.ts";
import { assertMigrated } from "../src/database/migrate.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogError } from "../src/catalog/input.ts";
import { MAX_ADOPTION_INPUT_BYTES } from "../src/catalog/adoption.ts";
import { rebuildCatalogSearchIndex } from "../src/catalog/search-index.ts";

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    "source-entity-id": { type: "string" }, reason: { type: "string" }, "album-id": { type: "string" }, input: { type: "string" },
  } });
  const command = positionals[0];
  const valid = command === "remove" ? values["source-entity-id"] && values.reason && !values["album-id"] && !values.input
    : command === "review" ? values["album-id"] && !values["source-entity-id"] && !values.reason && !values.input
      : command === "reindex" ? Object.keys(values).length === 0
        : command === "adopt" && values.input && !values["album-id"] && !values["source-entity-id"] && !values.reason;
  if (positionals.length !== 1 || !valid)
    throw new Error("Usage: catalog.ts remove --source-entity-id UUID --reason rights_request|policy_change | review --album-id UUID | adopt --input plan.json | reindex");
  let plan: unknown;
  if (command === "adopt") {
    if (!statSync(values.input!).isFile() || statSync(values.input!).size > MAX_ADOPTION_INPUT_BYTES)
      throw new CatalogError("invalid_input", "Adoption input must be a JSON file of at most 1 MiB");
    const content = readFileSync(values.input!);
    if (content.length > MAX_ADOPTION_INPUT_BYTES) throw new CatalogError("invalid_input", "Adoption file exceeds 1 MiB");
    try { plan = JSON.parse(content.toString("utf8")); }
    catch { throw new CatalogError("invalid_input", "Invalid adoption JSON"); }
  }
  if (!existsSync(databasePath())) throw new Error("Database does not exist");
  const db = openDatabase(databasePath());
  try {
    assertMigrated(db);
    const store = new CatalogStore(db);
    const result = command === "reindex" ? await rebuildCatalogSearchIndex(db) : command === "remove" ? await store.removeSource({ sourceEntityId: values["source-entity-id"], reason: values.reason })
      : command === "review" ? await store.getTrackReview(values["album-id"]!) : await store.adoptTrackList(plan);
    // Review intentionally includes synthetic metadata; mutation receipts contain IDs only.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { db.close(); }
} catch (error) {
  process.stderr.write(`${error instanceof CatalogError ? error.code + ": " : ""}${error instanceof Error ? error.message : "Catalog operation failed"}\n`);
  process.exitCode = 1;
}
