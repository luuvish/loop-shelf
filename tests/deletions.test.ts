import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate } from "../src/database/migrate.ts";
import { BookmarkStore, LibraryError, type Bookmark } from "../src/library/bookmarks.ts";
import { BookmarkDeletions, DeletionError } from "../src/library/deletions.ts";
import { LibraryTransfer } from "../src/library/transfer.ts";
import { UNDO_WINDOW_MS } from "../src/shared/deletions.ts";

function fixture(t: TestContext, old = false) {
  const db = openDatabase(":memory:"); migrate(db, old ? loadMigrations().slice(0, 4) : loadMigrations());
  t.after(() => db.close());
  const a = randomUUID(), b = randomUUID(), sa = randomUUID(), sa2 = randomUUID(), sb = randomUUID();
  for (const user of [a, b]) db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)').run(user, "Test", `${user}@example.test`, "now", "now");
  for (const [user, session] of [[a, sa], [a, sa2], [b, sb]]) db.prepare('INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?)').run(session, user, session, "2099-01-01T00:00:00.000Z", "now", "now");
  const store = new BookmarkStore(db), undo = new BookmarkDeletions(db), transfer = new LibraryTransfer(db, "test-only-secret");
  const add = (user = a, slug = randomUUID()) => store.create(user, { title: `음악 ${slug}`, url: `https://www.zophar.net/music/snes/${slug}.html`, note: "日本語 보존 메모", favorite: true }).item;
  const remove = (item: Bookmark, operationId = randomUUID(), now = Date.now()) => undo.delete(a, sa, item.id, { operationId, version: item.version }, now);
  return { db, a, b, sa, sa2, sb, store, undo, transfer, add, remove };
}
const code = (value: DeletionError["code"]) => (error: unknown) => error instanceof DeletionError && error.code === value;

test("undo preserves identity, content, dates and search, with a fresh optimistic revision", (t) => {
  const { store, undo, transfer, db, a, sa, add, remove } = fixture(t);
  const item = add(); const receipt = remove(item);
  assert.throws(() => store.get(a, item.id), LibraryError);
  assert.deepEqual(store.list(a, { q: "日本語" }).items, []); assert.equal(transfer.export(a).bookmarks.length, 0);
  assert.equal(receipt.remainingMs, UNDO_WINDOW_MS);
  const result = undo.restore(a, sa, receipt.id);
  assert.equal(result.restored, true);
  const restored = store.get(a, item.id);
  assert.deepEqual({ ...restored, version: item.version }, item); assert.ok(restored.version > item.version);
  assert.equal(store.list(a, { q: "日本語" }).items[0]!.id, item.id);
  assert.equal((db.prepare("SELECT snapshot FROM bookmark_deletion").get() as { snapshot: unknown }).snapshot, null);
  assert.throws(() => store.update(a, item.id, { version: item.version, note: "stale draft" }), LibraryError);
});

test("delete/restore retries are idempotent and old receipts cannot resurrect a later deletion", (t) => {
  const { a, sa, store, undo, add, remove } = fixture(t);
  const item = add(), now = Date.now(), operation = randomUUID();
  const first = remove(item, operation, now);
  const retry = remove(item, operation, now + 1000);
  assert.equal(retry.id, first.id); assert.equal(retry.expiresAt, first.expiresAt); assert.equal(retry.remainingMs, UNDO_WINDOW_MS - 1000);
  undo.restore(a, sa, first.id);
  const changed = store.update(a, item.id, { version: store.get(a, item.id).version, note: "new edit" });
  assert.equal(undo.restore(a, sa, first.id).restored, false); assert.deepEqual(store.get(a, item.id), changed);
  assert.equal(remove(item, operation).state, "restored");
  const second = remove(changed);
  assert.equal(undo.restore(a, sa, first.id).restored, false); assert.throws(() => store.get(a, item.id), LibraryError);
  assert.equal(undo.restore(a, sa, second.id).restored, true); assert.equal(store.get(a, item.id).note, "new edit");
});

test("undo rejects same-owner source conflicts and global ID conflicts without overwriting", (t) => {
  const { a, b, sa, db, store, undo, transfer, add, remove } = fixture(t);
  const item = add(), archive = transfer.export(a), receipt = remove(item);
  const duplicate = store.create(a, { title: "new source bookmark", url: item.url }).item;
  assert.throws(() => undo.restore(a, sa, receipt.id), code("undo_conflict")); assert.equal(store.get(a, duplicate.id).title, "new source bookmark");
  store.delete(a, duplicate.id, duplicate.version);
  const preview = transfer.preview(b, archive); transfer.import(b, archive, preview.token!);
  assert.throws(() => undo.restore(a, sa, receipt.id), code("undo_conflict")); assert.equal(store.get(b, item.id).note, item.note);
  assert.equal((db.prepare("SELECT state FROM bookmark_deletion").get() as { state: string }).state, "deleted");
});

test("receipts expire exactly, remain session-owned, are bounded, and disappear on logout", (t) => {
  const { db, a, b, sa, sa2, sb, store, undo, add, remove } = fixture(t);
  const now = Date.now(), item = add(), receipt = remove(item, randomUUID(), now);
  assert.throws(() => undo.restore(b, sb, receipt.id, now), code("undo_unavailable"));
  assert.throws(() => undo.restore(a, sa2, receipt.id, now), code("undo_unavailable"));
  assert.throws(() => undo.delete(b, sb, item.id, { operationId: receipt.id, version: item.version }, now), code("undo_unavailable"));
  assert.throws(() => undo.restore(a, sa, receipt.id, now + UNDO_WINDOW_MS), code("undo_unavailable"));
  assert.equal((db.prepare("SELECT count(*) AS n FROM bookmark_deletion").get() as { n: number }).n, 0);
  for (let i = 0; i < 20; i++) remove(add(), randomUUID(), now);
  const kept = add(); assert.throws(() => remove(kept, randomUUID(), now), code("undo_limit")); assert.equal(store.get(a, kept.id).id, kept.id);
  db.prepare('DELETE FROM "session" WHERE id = ?').run(sa);
  assert.equal((db.prepare("SELECT count(*) AS n FROM bookmark_deletion").get() as { n: number }).n, 0);
});

test("failed undo writes roll back every row, search index, receipt and revision", (t) => {
  const { db, a, sa, store, undo, add, remove } = fixture(t);
  const item = add();
  db.exec("CREATE TRIGGER deny_receipt BEFORE INSERT ON bookmark_deletion BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => remove(item), /test failure/); assert.deepEqual(store.get(a, item.id), item);
  db.exec("DROP TRIGGER deny_receipt"); const receipt = remove(item);
  const revision = db.prepare("SELECT value FROM library_revision").get();
  db.exec("CREATE TRIGGER deny_restore BEFORE UPDATE ON bookmark_deletion BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => undo.restore(a, sa, receipt.id), /test failure/);
  assert.throws(() => store.get(a, item.id), LibraryError); assert.deepEqual(db.prepare("SELECT value FROM library_revision").get(), revision);
  assert.equal(store.list(a, { q: "日本語" }).items.length, 0);
  assert.equal((db.prepare("SELECT state FROM bookmark_deletion").get() as { state: string }).state, "deleted");
  db.exec("DROP TRIGGER deny_restore"); undo.restore(a, sa, receipt.id);
  assert.equal(store.get(a, item.id).note, item.note);
});

test("0005 upgrade preserves existing data and deletion keeps group/version guards", (t) => {
  const { db, a, store, add, remove } = fixture(t, true);
  const root = add(), member = add();
  migrate(db); assert.deepEqual(store.get(a, root.id), root);
  const group = store.connect(a, root.id, { version: root.version, memberId: member.id, memberVersion: member.version });
  assert.throws(() => remove(root), (error: unknown) => error instanceof LibraryError && error.code === "conflict");
  assert.throws(() => remove(group.root), (error: unknown) => error instanceof LibraryError && error.code === "grouped_bookmark");
  assert.throws(() => remove(group.members[0]!), (error: unknown) => error instanceof LibraryError && error.code === "grouped_bookmark");
  assert.equal((db.prepare("SELECT count(*) AS n FROM bookmark_deletion").get() as { n: number }).n, 0);
});
