import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate, assertMigrated } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase } from "../src/database/backup.ts";
import { BookmarkStore, LibraryError } from "../src/library/bookmarks.ts";
import type { Bookmark } from "../src/shared/bookmarks.ts";

function fixture(t: TestContext, old = false) {
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-connections-"));
  const path = join(directory, "library.sqlite");
  const db = openDatabase(path); migrate(db, old ? loadMigrations().slice(0, 2) : loadMigrations());
  const a = randomUUID(), b = randomUUID();
  for (const owner of [a, b]) db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)')
    .run(owner, "Test", `${owner}@example.test`, "now", "now");
  t.after(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = new BookmarkStore(db);
  const add = (owner: string, number: number, overrides = {}) => store.create(owner, {
    title: `Private ${number}`, url: `https://www.zophar.net/music/snes/connection-${number}.html`, ...overrides,
  }).item;
  return { db, store, add, a, b, directory, path };
}
const data = (root: Bookmark, member: Bookmark) => ({ version: root.version, memberId: member.id, memberVersion: member.version });
const code = (expected: LibraryError["code"]) => (error: unknown) => error instanceof LibraryError && error.code === expected;
const content = ({ id, entityId, title, url, note, favorite, createdAt }: Bookmark) => ({ id, entityId, title, url, note, favorite, createdAt });

test("connection and disconnection preserve every original identity and private field", (t) => {
  const { db, store, add, a, b } = fixture(t);
  const root = add(a, 1, { title: "Representative", note: "Keep root note", favorite: false });
  const member = add(a, 2, { title: "Original version", note: "Keep member note", favorite: true });
  const otherUser = add(b, 2, { note: "Other owner's private note" });
  const group = store.connect(a, root.id, data(root, member));
  assert.deepEqual(content(group.root), content(root)); assert.deepEqual(content(group.members[0]!), content(member));
  assert.equal(group.root.sourceCount, 2); assert.equal(group.members[0]!.rootId, root.id);
  assert.deepEqual(store.list(a).items.map((item) => item.id), [root.id]);
  assert.deepEqual(store.connections(a, member.id), group);
  const duplicate = store.create(a, { title: "Do not replace", url: member.url });
  assert.equal(duplicate.created, false); assert.equal(duplicate.item.id, member.id); assert.equal(duplicate.item.rootId, root.id);
  assert.throws(() => store.delete(a, root.id, group.root.version), code("grouped_bookmark"));
  assert.throws(() => store.delete(a, member.id, group.members[0]!.version), code("grouped_bookmark"));
  const separated = store.disconnect(a, root.id, data(group.root, group.members[0]!));
  assert.deepEqual(content(separated.group.root), content(root)); assert.deepEqual(content(separated.detached), content(member));
  assert.equal(separated.detached.rootId, member.id); assert.equal(store.list(a).items.length, 2);
  assert.deepEqual(store.get(b, otherUser.id), otherUser);
  assert.equal(db.prepare<[], { n: number }>("SELECT count(*) AS n FROM source_entity").get()!.n, 0);
  assert.equal(db.prepare<[], { n: number }>("SELECT count(*) AS n FROM user_source_link").get()!.n, 0);
  assert.deepEqual(db.prepare("SELECT action FROM bookmark_connection_event ORDER BY id").all(), [{ action: "connect" }, { action: "disconnect" }]);
});

test("private group search includes every source without duplicate roots or changed favorite semantics", (t) => {
  const { store, add, a, b } = fixture(t);
  const root = add(a, 1, { note: "shared word", favorite: false });
  const member = add(a, 2, { title: "별의 정원", note: 'ＡＢＣ 日本語 shared word 100% "quoted"', favorite: true });
  const standalone = add(a, 3, { note: "shared word", favorite: true });
  const group = store.connect(a, root.id, data(root, member));
  for (const q of ["별", "정원", "日本語", "abc", '"quoted"', "100%"])
    assert.deepEqual(store.list(a, { q }).items.map((item) => item.id), [root.id], q);
  assert.deepEqual(store.list(b, { q: "abc" }).items, []);
  assert.equal(store.list(a, { q: "shared word" }).items.length, 2);
  const first = store.list(a, { q: "shared word", limit: 1 });
  const second = store.list(a, { q: "shared word", limit: 1, offset: first.nextOffset });
  assert.notEqual(first.items[0]!.id, second.items[0]!.id); assert.equal(second.nextOffset, null);
  assert.deepEqual(store.list(a, { favorite: "true" }).items.map((item) => item.id), [standalone.id]);
  assert.deepEqual(store.list(a, { standalone: "true" }).items.map((item) => item.id), [standalone.id]);
  store.update(a, member.id, { version: group.members[0]!.version, title: "Changed member", note: "New searchable note" });
  assert.equal(store.list(a, { q: "日本語" }).items.length, 0);
  assert.equal(store.list(a, { q: "New searchable" }).items[0]!.id, root.id);
  const fresh = store.connections(a, root.id);
  store.disconnect(a, root.id, data(fresh.root, fresh.members[0]!));
  assert.equal(store.list(a, { q: "New searchable" }).items[0]!.id, member.id);
});

test("ownership, both versions, and flat grouping are checked before connection changes", (t) => {
  const { store, add, a, b } = fixture(t);
  const root = add(a, 1), member = add(a, 2), third = add(a, 3), alien = add(b, 4);
  assert.throws(() => store.connect(b, root.id, data(root, member)), code("not_found"));
  assert.throws(() => store.connect(a, root.id, data(root, alien)), code("not_found"));
  assert.throws(() => store.connections(b, member.id), code("not_found"));
  assert.throws(() => store.connect(a, root.id, data(root, root)), code("invalid_connection"));
  assert.throws(() => store.connect(a, root.id, { ...data(root, member), userId: b }));
  const group = store.connect(a, root.id, data(root, member));
  assert.throws(() => store.connect(a, root.id, data(root, third)), code("conflict"));
  assert.throws(() => store.connect(a, third.id, data(third, group.root)), code("grouped_bookmark"));
  assert.throws(() => store.connect(a, member.id, data(group.members[0]!, third)), code("grouped_bookmark"));
  assert.throws(() => store.connect(a, root.id, data(group.root, group.members[0]!)), code("grouped_bookmark"));
  assert.throws(() => store.disconnect(b, root.id, data(group.root, group.members[0]!)), code("not_found"));
  assert.throws(() => store.disconnect(a, third.id, data(third, group.members[0]!)), code("conflict"));
  const changed = store.update(a, member.id, { version: group.members[0]!.version, note: "Another tab" });
  assert.equal(store.get(a, root.id).version, group.root.version + 1);
  assert.throws(() => store.disconnect(a, root.id, data(group.root, changed)), code("conflict"));
  assert.throws(() => store.disconnect(a, root.id, data(store.get(a, root.id), group.members[0]!)), code("conflict"));
  const fresh = store.connections(a, root.id);
  store.disconnect(a, root.id, data(fresh.root, changed));
  assert.equal(store.get(a, member.id).note, "Another tab");
});

test("SQL enforces same-owner private bookmarks, non-nesting, immutable identities and group bounds", (t) => {
  const { db, store, add, a, b } = fixture(t);
  const root = add(a, 0), member = add(a, 1), third = add(a, 2), alien = add(b, 3);
  const insert = db.prepare("INSERT INTO bookmark_connection VALUES (?, ?, ?, 'now')");
  assert.throws(() => insert.run(alien.id, root.id, a), /private bookmarks|FOREIGN KEY/);
  assert.throws(() => insert.run(root.id, root.id, a), /CHECK/);
  insert.run(member.id, root.id, a);
  assert.throws(() => insert.run(third.id, member.id, a), /nested/);
  assert.throws(() => insert.run(root.id, third.id, a), /nested/);
  assert.throws(() => db.prepare("UPDATE bookmark_connection SET parent_id=?").run(third.id), /disconnect/);
  assert.throws(() => db.prepare("UPDATE library_item SET entity_id=? WHERE id=?").run(third.entityId, root.id), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM library_item WHERE id=?").run(root.id), /FOREIGN KEY/);
  const album = randomUUID(), albumItem = randomUUID();
  db.prepare("INSERT INTO entity VALUES (?, 'album', 'active', 'now')").run(album);
  db.prepare("INSERT INTO album(id,title) VALUES (?, 'Public album')").run(album);
  db.prepare("INSERT INTO library_item(id,user_id,entity_id,created_at,updated_at) VALUES (?, ?, ?, 'now', 'now')").run(albumItem, a, album);
  assert.throws(() => insert.run(albumItem, root.id, a), /private bookmarks/);
  for (let n = 4; n < 22; n++) insert.run(add(a, n).id, root.id, a);
  assert.equal(store.get(a, root.id).sourceCount, 20);
  assert.throws(() => insert.run(third.id, root.id, a), /limit/);
  assert.throws(() => store.connect(a, root.id, data(store.get(a, root.id), third)), code("connection_limit"));
});

test("failed group writes roll back membership, audit and versions together", (t) => {
  const { db, store, add, a } = fixture(t);
  const root = add(a, 1), member = add(a, 2);
  db.exec("CREATE TRIGGER simulate_failure BEFORE UPDATE ON library_item BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
  assert.throws(() => store.connect(a, root.id, data(root, member)), /simulated/);
  assert.equal(db.prepare<[], { n: number }>("SELECT count(*) AS n FROM bookmark_connection").get()!.n, 0);
  assert.equal(db.prepare<[], { n: number }>("SELECT count(*) AS n FROM bookmark_connection_event").get()!.n, 0);
  assert.deepEqual(store.get(a, root.id), root); assert.deepEqual(store.get(a, member.id), member);
  db.exec("DROP TRIGGER simulate_failure");
  const group = store.connect(a, root.id, data(root, member));
  db.exec("CREATE TRIGGER simulate_failure BEFORE UPDATE ON library_item BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
  assert.throws(() => store.disconnect(a, root.id, data(group.root, group.members[0]!)), /simulated/);
  assert.deepEqual(store.connections(a, root.id), group);
  assert.equal(db.prepare<[], { n: number }>("SELECT count(*) AS n FROM bookmark_connection_event").get()!.n, 1);
});

test("upgrade from the previous schema preserves existing bookmarks and search", (t) => {
  const { db, store, a } = fixture(t, true);
  const entityId = randomUUID(), itemId = randomUUID();
  db.prepare("INSERT INTO entity(id,kind,created_at) VALUES (?, 'bookmark', 'before-upgrade')").run(entityId);
  db.prepare(`INSERT INTO bookmark(entity_id,owner_id,source_id,external_key,entered_title,page_url)
    VALUES (?, ?, 'zophar', 'snes/old', 'Old title', 'https://www.zophar.net/music/snes/old.html')`).run(entityId, a);
  db.prepare(`INSERT INTO library_item(id,user_id,entity_id,note,favorite,created_at,updated_at)
    VALUES (?, ?, ?, 'Old private note', 1, 'before-upgrade', 'before-upgrade')`).run(itemId, a, entityId);
  assert.throws(() => assertMigrated(db), /mismatch/);
  migrate(db); assertMigrated(db);
  const item = store.get(a, itemId);
  assert.equal(item.entityId, entityId); assert.equal(item.note, "Old private note"); assert.equal(item.favorite, true);
  assert.equal(item.version, 1); assert.equal(item.rootId, item.id); assert.equal(item.sourceCount, 1);
  assert.equal(store.list(a, { q: "private" }).items[0]!.id, itemId);
});

test("backup and restore preserve grouping and permit later separation with original IDs", async (t) => {
  const { db, store, add, a, b, directory } = fixture(t);
  const root = add(a, 1, { note: "Root" }), member = add(a, 2, { note: "Member", favorite: true });
  const group = store.connect(a, root.id, data(root, member));
  const backup = join(directory, "backup.sqlite"), restored = join(directory, "restored.sqlite");
  await backupDatabase(db, backup); await restoreDatabase(backup, restored);
  const copy = openDatabase(restored);
  try {
    assertMigrated(copy); const recovered = new BookmarkStore(copy);
    assert.deepEqual(recovered.connections(a, root.id), group);
    assert.deepEqual(recovered.list(b).items, []);
    const result = recovered.disconnect(a, root.id, data(group.root, group.members[0]!));
    assert.deepEqual(content(result.detached), content(member));
    assert.deepEqual(content(result.group.root), content(root));
    assert.equal(recovered.list(a).items.length, 2);
    assert.equal(copy.prepare<[], { n: number }>("SELECT count(*) AS n FROM bookmark_connection_event").get()!.n, 2);
  } finally { copy.close(); }
});
