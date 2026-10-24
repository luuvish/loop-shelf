import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { assertMigrated, loadMigrations, migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { BookmarkStore, LibraryError } from "../src/library/bookmarks.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-db-"));
  const path = join(dir, "main.sqlite");
  const db = openDatabase(path);
  migrate(db);
  const a = randomUUID(), b = randomUUID();
  for (const user of [a, b]) db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)')
    .run(user, "Test", `${user}@example.test`, new Date().toISOString(), new Date().toISOString());
  t.after(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, path, dir, a, b, store: new BookmarkStore(db) };
}
const input = { title: "별의 정원 ゲーム音楽", url: "https://www.zophar.net/music/nintendo-snes-spc/example.html", note: "private note", favorite: true };
const notFound = (error: unknown) => error instanceof LibraryError && error.code === "not_found";
const conflict = (error: unknown) => error instanceof LibraryError && error.code === "conflict";

test("migrations enable FK/WAL/FTS5 and are idempotent", (t) => {
  const { db } = fixture(t);
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  db.exec("CREATE VIRTUAL TABLE temp.unicode_probe USING fts5(text, tokenize='unicode61'); INSERT INTO unicode_probe VALUES ('hello world')");
  assert.ok(db.prepare("SELECT 1 FROM unicode_probe WHERE unicode_probe MATCH 'hello'").get());
  migrate(db); assertMigrated(db); verifyDatabase(db);
  assert.equal((db.prepare("SELECT count(*) AS n FROM schema_migration").get() as { n: number }).n, loadMigrations().length);
});

test("changed or unknown migrations fail closed; a failed batch rolls back", (t) => {
  const { db } = fixture(t);
  const migrations = loadMigrations();
  assert.throws(() => migrate(db, [{ ...migrations[0]!, sql: migrations[0]!.sql + " -- changed" }, migrations[1]!]), /history mismatch/);
  assert.throws(() => migrate(db, []), /history mismatch/);
  assert.throws(() => migrate(db, [...migrations,
    { name: "9998_good.sql", sql: "CREATE TABLE should_rollback(id TEXT)" },
    { name: "9999_bad.sql", sql: "INVALID SQL" }]), /syntax/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='should_rollback'").get(), undefined);
  assertMigrated(db);
});

test("same normalized source is idempotent per owner without overwriting personal data", (t) => {
  const { store, a, b, db } = fixture(t);
  const first = store.create(a, input);
  const duplicate = store.create(a, { ...input, url: input.url + "?utm_source=test#player", title: "overwrite", note: "overwrite" });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.item.id, first.item.id);
  assert.equal(duplicate.item.title, input.title);
  assert.equal(duplicate.item.note, input.note);
  const other = store.create(b, input).item;
  assert.notEqual(other.id, first.item.id);
  assert.notEqual(other.entityId, first.item.entityId);
  assert.equal((db.prepare("SELECT count(*) AS n FROM source_entity").get() as { n: number }).n, 0);
});

test("ownership is enforced for list, search, read, update and delete", (t) => {
  const { store, a, b } = fixture(t);
  const item = store.create(a, input).item;
  assert.deepEqual(store.list(b).items, []);
  assert.deepEqual(store.list(b, { q: "private" }).items, []);
  assert.throws(() => store.get(b, item.id), notFound);
  assert.throws(() => store.update(b, item.id, { title: "stolen", version: 1 }), notFound);
  assert.throws(() => store.delete(b, item.id, 1), notFound);
  assert.equal(store.get(a, item.id).note, input.note);
});

test("editing URL retains UUIDs and private fields; stale versions and duplicate targets conflict", (t) => {
  const { store, a } = fixture(t);
  const initial = store.create(a, input).item;
  const second = store.create(a, { ...input, url: "https://downloads.khinsider.com/game-soundtracks/album/another" }).item;
  assert.throws(() => store.update(a, initial.id, { url: second.url, version: 1 }), conflict);
  const updated = store.update(a, initial.id, { url: "https://downloads.khinsider.com/game-soundtracks/album/new-location", title: "New", version: 1 });
  assert.equal(updated.id, initial.id); assert.equal(updated.entityId, initial.entityId);
  assert.equal(updated.note, initial.note); assert.equal(updated.favorite, true);
  assert.equal(updated.version, 2);
  assert.throws(() => store.update(a, initial.id, { note: "stale", version: 1 }), conflict);
  assert.throws(() => store.delete(a, initial.id, 1), conflict);
});

test("trigram and short-query fallback search private titles/notes literally and update atomically", (t) => {
  const { store, a, b, db } = fixture(t);
  const item = store.create(a, { ...input, note: "ＡＢＣ secret 100% _value_ \"quote\"" }).item;
  for (const q of ["별", "정원", "ゲーム音", "abc", '"quote"', "100%", "_value_"])
    assert.equal(store.list(a, { q }).items[0]?.id, item.id, q);
  assert.deepEqual(store.list(b, { q: "secret" }).items, []);
  assert.deepEqual(store.list(a, { q: '" OR secret OR "' }).items, []);
  const updated = store.update(a, item.id, { title: "Changed", note: "new memo", favorite: false, version: 1 });
  assert.equal(store.list(a, { q: "secret" }).items.length, 0);
  assert.equal(store.list(a, { q: "new memo" }).items.length, 1);
  assert.equal(store.list(a, { favorite: "true" }).items.length, 0);
  store.delete(a, item.id, updated.version);
  for (const table of ["bookmark", "library_item", "entity", "bookmark_search"])
    assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
});

test("pagination is deterministic and bounded", (t) => {
  const { store, a } = fixture(t);
  for (let i = 0; i < 4; i++) store.create(a, { ...input, url: input.url.replace("example", `example-${i}`) });
  const first = store.list(a, { limit: "2" });
  assert.equal(first.nextOffset, 2);
  const second = store.list(a, { limit: 2, offset: first.nextOffset });
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4);
  assert.throws(() => store.list(a, { limit: 1000000 }));
});

test("unsupported URLs and owner injection are rejected before writes", (t) => {
  const { store, a, b, db } = fixture(t);
  for (const url of ["javascript:alert(1)", "http://www.zophar.net/music/a/b.html", "https://127.0.0.1/private",
    "/music/a/b.html", "https://www.zophar.net.evil.test/music/a/b.html", "https://www.zophar.net/music/a/b.mp3"])
    assert.throws(() => store.create(a, { ...input, url }));
  assert.throws(() => store.create(a, { ...input, userId: b }));
  assert.equal((db.prepare("SELECT count(*) AS n FROM entity").get() as { n: number }).n, 0);
});

test("failed creation rolls back entity and index writes", (t) => {
  const { store, db } = fixture(t);
  assert.throws(() => store.create(randomUUID(), input), /FOREIGN KEY/);
  for (const table of ["bookmark", "library_item", "entity", "bookmark_search"])
    assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
});

test("catalog schema separates identity, versions, repeated track labels and source keys", (t) => {
  const { db } = fixture(t);
  const album = randomUUID(), recording = randomUUID();
  for (const [entity, kind] of [[album, "album"], [recording, "recording"]])
    db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,?,?)").run(entity, kind, new Date().toISOString());
  db.prepare("INSERT INTO album(id,title) VALUES (?,?)").run(album, "Same title");
  db.prepare("INSERT INTO recording(id,title) VALUES (?,?)").run(recording, "Different version");
  assert.throws(() => db.prepare("INSERT INTO game(id,title) VALUES (?,?)").run(album, "Wrong kind"), /FOREIGN KEY/);
  for (const position of [1, 2]) {
    const track = randomUUID();
    db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?,'track',?)").run(track, new Date().toISOString());
    db.prepare("INSERT INTO track(id,album_id,recording_id,position,track_label,title) VALUES (?,?,?,?,?,?)")
      .run(track, album, position === 1 ? null : recording, position, "102", position === 1 ? "Main" : "Looped");
  }
  const tracks = db.prepare("SELECT track_label, duration_ms, recording_id FROM track ORDER BY position").all() as Record<string, unknown>[];
  assert.equal(tracks.length, 2); assert.equal(tracks[0]?.duration_ms, null); assert.equal(tracks[0]?.recording_id, null);
  const source = randomUUID();
  db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,entity_id,page_url) VALUES (?,'zophar','album','system/slug',?,?)")
    .run(source, album, "https://www.zophar.net/music/system/slug.html");
  assert.throws(() => db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,page_url) VALUES (?,'zophar','album','system/slug','url')")
    .run(randomUUID()), /UNIQUE/);
  db.prepare("UPDATE source_entity SET page_url=?,availability='removed' WHERE id=?").run("https://www.zophar.net/music/system/new.html", source);
  assert.ok(db.prepare("SELECT 1 FROM album WHERE id=?").get(album));
  assert.ok(db.prepare("SELECT 1 FROM source_url_history WHERE source_entity_id=?").get(source));
});

test("SQL constraints prevent another owner attaching a private bookmark or source link", (t) => {
  const { store, db, a, b } = fixture(t);
  const item = store.create(a, input).item;
  assert.throws(() => db.prepare("INSERT INTO library_item(id,user_id,entity_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(randomUUID(), b, item.entityId, "now", "now"), /ownership mismatch/);
  assert.throws(() => db.prepare("UPDATE bookmark SET owner_id=? WHERE entity_id=?").run(b, item.entityId), /immutable/);
  const source = randomUUID();
  db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,page_url) VALUES (?,'zophar','album','system/slug','url')").run(source);
  assert.throws(() => db.prepare("INSERT INTO user_source_link VALUES (?,?,?,?)").run(b, item.id, source, "now"), /FOREIGN KEY/);
  db.prepare("INSERT INTO user_source_link VALUES (?,?,?,?)").run(a, item.id, source, "now");
  db.prepare("UPDATE source_entity SET availability='removed' WHERE id=?").run(source);
  assert.equal(store.get(a, item.id).note, input.note);
});

test("reopen, online WAL backup and restore preserve IDs, notes, search and ownership", async (t) => {
  const { store, db, path, dir, a, b } = fixture(t);
  const item = store.create(a, input).item;
  const backup = join(dir, "snapshot.sqlite"), restored = join(dir, "restored.sqlite");
  await backupDatabase(db, backup);
  await assert.rejects(backupDatabase(db, backup), /EEXIST/);
  store.update(a, item.id, { note: "after backup", version: 1 });
  await restoreDatabase(backup, restored);
  await assert.rejects(restoreDatabase(backup, path), /EEXIST/);
  const copy = openDatabase(restored);
  try {
    migrate(copy); verifyDatabase(copy);
    const recovered = new BookmarkStore(copy);
    assert.deepEqual(recovered.get(a, item.id), item);
    assert.equal(recovered.list(a, { q: "private" }).items.length, 1);
    assert.deepEqual(recovered.list(b).items, []);
  } finally { copy.close(); }
  db.close();
  const reopened = openDatabase(path);
  try {
    assertMigrated(reopened);
    assert.equal(new BookmarkStore(reopened).get(a, item.id).note, "after backup");
  } finally { reopened.close(); }
});

test("failed recovery removes its incomplete output without changing the snapshot or an existing destination", async (t) => {
  const { db, dir } = fixture(t);
  // Valid SQLite but missing a required auth table: cleanup must fail closed.
  db.exec('DROP TABLE verification');
  const source = join(dir, "incomplete.sqlite"), destination = join(dir, "failed.sqlite");
  await backupDatabase(db, source);
  const original = readFileSync(source);
  await assert.rejects(restoreDatabase(source, destination), /no such table: verification/);
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readFileSync(source), original);
  await assert.rejects(restoreDatabase(source, source), /EEXIST/);
  assert.deepEqual(readFileSync(source), original);
});

test("old auth snapshots restore without sessions and explicitly upgrade to the current schema", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-old-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, "old.sqlite"));
  const snapshot = join(dir, "backup.sqlite"), destination = join(dir, "restored.sqlite");
  try { migrate(db, loadMigrations().slice(0, 1)); await backupDatabase(db, snapshot); }
  finally { db.close(); }
  const original = readFileSync(snapshot);
  await restoreDatabase(snapshot, destination);
  const restored = openDatabase(destination);
  try {
    assert.throws(() => assertMigrated(restored), /mismatch/);
    migrate(restored); assertMigrated(restored); verifyDatabase(restored);
  } finally { restored.close(); }
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(snapshot), original);
});
