import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate } from "../src/database/migrate.ts";
import { BookmarkStore } from "../src/library/bookmarks.ts";

test("operator CLI initializes, provisions, resets, backs up and restores; upgrades back up first", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "main.sqlite");
  const env = { ...process.env, DATABASE_PATH: path, APP_ORIGIN: "http://127.0.0.1:3000", BETTER_AUTH_SECRET: randomBytes(32).toString("hex") };
  function run(script: string, args: string[], input = "") {
    const result = spawnSync(process.execPath, [script, ...args], { env, input, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes("test-password"));
    return result.stdout;
  }
  run("scripts/database.ts", ["migrate"]);
  run("scripts/account.ts", ["create", "--email", "operator-test@example.test", "--name", "Test"], "initial-test-password\n");
  run("scripts/account.ts", ["reset-password", "--email", "operator-test@example.test"], "replacement-test-password\n");
  const db = openDatabase(path);
  let itemId: string, owner: string;
  try {
    owner = (db.prepare('SELECT id FROM "user"').get() as { id: string }).id;
    itemId = new BookmarkStore(db).create(owner, { title: "CLI sample", url: "https://www.zophar.net/music/system/sample.html", note: "Persist me" }).item.id;
    run("scripts/database.ts", ["backup", "--output", join(directory, "backup.sqlite")]);
  } finally { db.close(); }
  run("scripts/database.ts", ["restore", "--input", join(directory, "backup.sqlite"), "--output", join(directory, "restored.sqlite")]);
  const restored = openDatabase(join(directory, "restored.sqlite"));
  try { assert.equal(new BookmarkStore(restored).get(owner, itemId).note, "Persist me"); }
  finally { restored.close(); }
  const oldPath = join(directory, "old.sqlite");
  const old = openDatabase(oldPath);
  try { migrate(old, loadMigrations().slice(0, 1)); } finally { old.close(); }
  env.DATABASE_PATH = oldPath;
  const output = run("scripts/database.ts", ["migrate"]);
  assert.match(output, /Pre-migration backup verified/);
  assert.equal(readdirSync(`${oldPath}.backups`).length, 1);
});
