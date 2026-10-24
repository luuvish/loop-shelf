import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { migrate, loadMigrations } from "../src/database/migrate.ts";
import { BookmarkStore, LibraryError } from "../src/library/bookmarks.ts";
import { LibraryTransfer, TransferError, parseArchive } from "../src/library/transfer.ts";
import { ARCHIVE_MAX_BYTES, ARCHIVE_MAX_ITEMS, type BookmarkArchive } from "../src/shared/transfer.ts";

function fixture(t: TestContext, beforeImportMigration = false) {
  const db = openDatabase(":memory:"); migrate(db, beforeImportMigration ? loadMigrations().slice(0, 3) : loadMigrations()); t.after(() => db.close());
  const a = randomUUID(), b = randomUUID();
  for (const id of [a, b]) db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)')
    .run(id, "Test", `${id}@example.test`, "now", "now");
  const store = new BookmarkStore(db), transfer = new LibraryTransfer(db, "test-only-transfer-secret");
  const add = (owner: string, n: number) => store.create(owner, { title: `日本語 음악 ${n}`, note: `Private note ${n}\n원래 메모`, favorite: n % 2 === 0,
    url: `https://www.zophar.net/music/snes/transfer-${n}.html` }).item;
  return { db, store, transfer, a, b, add };
}
const code = (value: TransferError["code"]) => (error: unknown) => error instanceof TransferError && error.code === value;
function newArchive(): BookmarkArchive {
  return { format: "loopshelf-bookmarks", schemaVersion: 1, exportedAt: "2026-01-02T03:04:05.000Z", bookmarks: [{
    id: randomUUID(), entityId: randomUUID(), title: "Restored title", url: "https://downloads.khinsider.com/game-soundtracks/album/restore-example",
    note: "メモ 😀\nPrivate", favorite: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  }], connections: [] };
}

test("JSON restores stable IDs, original private fields, dates, groups and search into a different installation", (t) => {
  const from = fixture(t), to = fixture(t);
  const root = from.add(from.a, 1), member = from.add(from.a, 2);
  from.add(from.b, 3);
  from.store.connect(from.a, root.id, { version: root.version, memberId: member.id, memberVersion: member.version });
  const archive = from.transfer.export(from.a);
  assert.equal(archive.bookmarks.length, 2); assert.equal(archive.connections.length, 1);
  assert.deepEqual(Object.keys(archive).sort(), ["bookmarks", "connections", "exportedAt", "format", "schemaVersion"]);
  assert.ok(!JSON.stringify(archive).includes(from.b)); assert.ok(!JSON.stringify(archive).includes(from.a));
  const preview = to.transfer.preview(to.a, JSON.parse(JSON.stringify(archive)));
  assert.equal(preview.addCount, 2); assert.equal(preview.conflictCount, 0);
  assert.deepEqual(to.transfer.import(to.a, archive, preview.token!), { added: 2, skipped: 0, connectionsAdded: 1 });
  const restored = to.transfer.export(to.a);
  assert.deepEqual(restored.bookmarks, archive.bookmarks); assert.deepEqual(restored.connections, archive.connections);
  assert.deepEqual(to.store.list(to.a, { q: member.note.slice(0, 14) }).items.map((item) => item.id), [root.id]);
  assert.equal(to.store.list(to.b).items.length, 0);
  const group = to.store.connections(to.a, root.id);
  const detached = to.store.disconnect(to.a, root.id, { version: group.root.version, memberId: member.id, memberVersion: group.members[0]!.version }).detached;
  assert.equal(detached.id, member.id); assert.equal(detached.note, member.note); assert.equal(detached.favorite, member.favorite);
  assert.equal(to.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM source_entity").get()!.n, 0);
});

test("export includes all private original records beyond UI pagination and never exports credentials or audit", (t) => {
  const { a, b, add, transfer } = fixture(t);
  for (let i = 0; i < 65; i++) add(a, i);
  add(b, 200);
  const archive = transfer.export(a);
  assert.equal(archive.bookmarks.length, 65);
  for (const item of archive.bookmarks) assert.deepEqual(Object.keys(item).sort(), ["createdAt", "entityId", "favorite", "id", "note", "title", "updatedAt", "url"]);
  assert.equal(transfer.export(b).bookmarks.length, 1);
});

test("identical re-import is a no-op; changed content, URLs and membership are explicit conflicts", (t) => {
  const { a, b, add, transfer, store, db } = fixture(t);
  const root = add(a, 1), member = add(a, 2);
  store.connect(a, root.id, { version: root.version, memberId: member.id, memberVersion: member.version });
  const archive = transfer.export(a), before = store.get(a, root.id);
  const preview = transfer.preview(a, archive);
  assert.deepEqual(transfer.import(a, archive, preview.token!), { added: 0, skipped: 2, connectionsAdded: 0 });
  assert.deepEqual(store.get(a, root.id), before);
  assert.equal(db.prepare<[], { n: number }>("SELECT count(*) AS n FROM bookmark_connection_event").get()!.n, 1);
  for (const change of [
    (file: BookmarkArchive) => { file.bookmarks[0]!.note += " changed"; },
    (file: BookmarkArchive) => { file.connections = []; },
    (file: BookmarkArchive) => { file.connections[0]!.connectedAt = "2020-01-01T00:00:00.000Z"; },
  ]) {
    const file = structuredClone(archive); change(file);
    const result = transfer.preview(a, file); assert.ok(result.conflictCount > 0); assert.equal(result.token, null);
  }
  const duplicate = newArchive(); duplicate.bookmarks[0]!.url = root.url;
  assert.equal(transfer.preview(a, duplicate).conflicts[0]!.reason, "source_conflict");
  const other = transfer.preview(b, archive);
  assert.equal(other.conflictCount, 2); assert.equal(other.conflicts[0]!.reason, "id_conflict");
  assert.equal(transfer.export(b).bookmarks.length, 0);
});

test("preview binds the user, full file, current revisions and expiry; changed or replayed previews cannot write", (t) => {
  const { a, b, transfer, store, add } = fixture(t);
  const archive = newArchive(), token = transfer.preview(a, archive).token!;
  assert.throws(() => transfer.import(b, archive, token), code("preview_stale"));
  const changed = structuredClone(archive); changed.bookmarks[0]!.note = "changed after checking";
  assert.throws(() => transfer.import(a, changed, token), code("preview_stale"));
  assert.throws(() => transfer.import(a, archive, token.slice(0, -1)), code("preview_stale"));
  const now = Date.now(); t.mock.method(Date, "now", () => now + 11 * 60 * 1000);
  assert.throws(() => transfer.import(a, archive, token), code("preview_stale")); t.mock.restoreAll();
  const extra = add(a, 1);
  assert.throws(() => transfer.import(a, archive, token), code("preview_stale"));
  const fresh = transfer.preview(a, archive).token!;
  // Even equal content edited back to its initial value has a new revision.
  store.update(a, extra.id, { version: extra.version, note: extra.note });
  assert.throws(() => transfer.import(a, archive, fresh), code("preview_stale"));
  const valid = transfer.preview(a, archive).token!;
  transfer.import(a, archive, valid);
  assert.throws(() => transfer.import(a, archive, valid), code("preview_stale"));
  const retry = transfer.preview(a, archive);
  assert.deepEqual(transfer.import(a, archive, retry.token!), { added: 0, skipped: 1, connectionsAdded: 0 });
});

test("schema validation rejects owner injection, unsafe URLs, invalid IDs, duplicate sources, dates, cycles and oversize", (t) => {
  const { a, transfer } = fixture(t);
  for (const bad of [null, {}, { ...newArchive(), schemaVersion: 2 }, { ...newArchive(), userId: a },
    { ...newArchive(), bookmarks: Array(ARCHIVE_MAX_ITEMS + 1).fill(newArchive().bookmarks[0]) },
  ]) assert.throws(() => transfer.preview(a, bad), code("invalid_archive"));
  for (const change of [
    (file: BookmarkArchive) => { file.bookmarks[0]!.url = "https://evil.example/audio.mp3"; },
    (file: BookmarkArchive) => { file.bookmarks[0]!.url += "?token=secret"; },
    (file: BookmarkArchive) => { file.bookmarks[0]!.title = " trimmed "; },
    (file: BookmarkArchive) => { file.bookmarks[0]!.note = "\ud800"; },
    (file: BookmarkArchive) => { file.bookmarks[0]!.id = "invalid-id"; },
    (file: BookmarkArchive) => { file.bookmarks[0]!.createdAt = "2027-01-01T00:00:00.000Z"; },
    (file: BookmarkArchive) => { file.bookmarks.push({ ...file.bookmarks[0]! }); },
    (file: BookmarkArchive) => { file.bookmarks.push({ ...file.bookmarks[0]!, id: randomUUID(), entityId: randomUUID() }); },
    (file: BookmarkArchive) => { file.connections.push({ parentId: file.bookmarks[0]!.id, memberId: randomUUID(), connectedAt: file.exportedAt }); },
    (file: BookmarkArchive) => { file.connections.push({ parentId: file.bookmarks[0]!.id, memberId: file.bookmarks[0]!.id, connectedAt: file.exportedAt }); },
  ]) { const file = newArchive(); change(file); assert.throws(() => parseArchive(file), code("invalid_archive")); }
  const cycle = newArchive(); cycle.bookmarks.push({ ...newArchive().bookmarks[0]!, url: "https://www.zophar.net/music/snes/cycle.html" });
  cycle.connections = [{ parentId: cycle.bookmarks[0]!.id, memberId: cycle.bookmarks[1]!.id, connectedAt: cycle.exportedAt },
    { parentId: cycle.bookmarks[1]!.id, memberId: cycle.bookmarks[0]!.id, connectedAt: cycle.exportedAt }];
  assert.throws(() => parseArchive(cycle), code("invalid_archive"));
  const oversizedGroup = newArchive();
  for (let n = 0; n < 20; n++) {
    const member = { ...newArchive().bookmarks[0]!, url: `https://www.zophar.net/music/snes/limit-${n}.html` };
    oversizedGroup.bookmarks.push(member); oversizedGroup.connections.push({ parentId: oversizedGroup.bookmarks[0]!.id, memberId: member.id, connectedAt: oversizedGroup.exportedAt });
  }
  assert.throws(() => parseArchive(oversizedGroup), code("invalid_archive"));
  const large = newArchive(); large.bookmarks[0]!.note = "x".repeat(ARCHIVE_MAX_BYTES);
  assert.throws(() => parseArchive(large), code("archive_too_large"));
  assert.deepEqual(transfer.export(a).bookmarks, []);
});

test("UTF-8 byte limits cover full export and the resulting shelf; oversized transfers never truncate data", (t) => {
  const { a, store, transfer } = fixture(t);
  const note = "音".repeat(10000);
  for (let i = 0; i < 270; i++) store.create(a, { title: `Item ${i}`, note, url: `https://www.zophar.net/music/snes/byte-limit-${i}.html` });
  const archive = transfer.export(a); assert.equal(archive.bookmarks.length, 270);
  const incoming = newArchive(); incoming.bookmarks = [];
  for (let i = 270; i < 290; i++) incoming.bookmarks.push({ ...newArchive().bookmarks[0]!, note, url: `https://www.zophar.net/music/snes/byte-limit-${i}.html` });
  assert.throws(() => transfer.preview(a, incoming), code("archive_too_large"));
  assert.equal(transfer.export(a).bookmarks.length, 270);
  // Manual bookmarks remain available even if their total grows beyond the JSON transfer bound.
  for (const item of incoming.bookmarks) store.create(a, { title: item.title, url: item.url, note: item.note });
  assert.throws(() => transfer.export(a), code("archive_too_large"));
  assert.equal(store.list(a, { offset: 270 }).items.length, 20);
});

test("a failed import rolls back every item, index, connection, revision allocation and audit event", (t) => {
  const from = fixture(t), to = fixture(t);
  const root = from.add(from.a, 1), member = from.add(from.a, 2);
  from.store.connect(from.a, root.id, { version: root.version, memberId: member.id, memberVersion: member.version });
  const archive = from.transfer.export(from.a), token = to.transfer.preview(to.a, archive).token!;
  const revision = to.db.prepare("SELECT value FROM library_revision").get();
  to.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON bookmark_connection BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  assert.throws(() => to.transfer.import(to.a, archive, token), /forced failure/);
  assert.deepEqual(to.db.prepare("SELECT value FROM library_revision").get(), revision);
  for (const table of ["entity", "bookmark", "library_item", "bookmark_search", "bookmark_connection", "bookmark_connection_event"])
    assert.equal(to.db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0, table);
  to.db.exec("DROP TRIGGER fail_import");
  assert.equal(to.transfer.import(to.a, archive, token).added, 2);
});

test("delete then restore never reuses a version held by an old editor, including after repeated restoration", (t) => {
  const { a, store, transfer, add } = fixture(t);
  let original = add(a, 1);
  const archive = transfer.export(a);
  for (let i = 0; i < 3; i++) {
    store.delete(a, original.id, original.version);
    transfer.import(a, archive, transfer.preview(a, archive).token!);
    const restored = store.get(a, original.id);
    assert.ok(restored.version > original.version);
    assert.throws(() => store.update(a, original.id, { version: original.version, note: "stale editor" }), (error: unknown) => error instanceof LibraryError && error.code === "conflict");
    original = restored;
  }
});

test("0004 upgrades an existing connected shelf without changing its records and seeds above existing revisions", (t) => {
  const { a, db, store, transfer, add } = fixture(t, true);
  const root = add(a, 1), member = add(a, 2);
  store.connect(a, root.id, { version: root.version, memberId: member.id, memberVersion: member.version });
  db.prepare("UPDATE library_item SET version = 9000000000000 WHERE id = ?").run(root.id);
  const before = store.connections(a, root.id), archive = transfer.export(a);
  const audit = db.prepare("SELECT * FROM bookmark_connection_event").all();
  migrate(db);
  assert.deepEqual(store.connections(a, root.id), before);
  assert.deepEqual(transfer.export(a).bookmarks, archive.bookmarks);
  assert.deepEqual(db.prepare("SELECT * FROM bookmark_connection_event").all(), audit);
  const incoming = newArchive();
  transfer.import(a, incoming, transfer.preview(a, incoming).token!);
  assert.ok(store.get(a, incoming.bookmarks[0]!.id).version > before.root.version);
});

test("new and identical groups can be combined without changing the existing group or unrelated private items", (t) => {
  const { a, add, transfer, store } = fixture(t);
  const root = add(a, 1), member = add(a, 2), unrelated = add(a, 3);
  store.connect(a, root.id, { version: root.version, memberId: member.id, memberVersion: member.version });
  const archive = transfer.export(a); archive.bookmarks = archive.bookmarks.filter((item) => item.id !== unrelated.id);
  archive.bookmarks.push(...newArchive().bookmarks);
  const before = store.connections(a, root.id), preview = transfer.preview(a, archive);
  assert.deepEqual(transfer.import(a, archive, preview.token!), { added: 1, skipped: 2, connectionsAdded: 0 });
  assert.deepEqual(store.connections(a, root.id), before); assert.deepEqual(store.get(a, unrelated.id), unrelated);
  const incompatible = transfer.export(a); incompatible.connections.push({ parentId: root.id, memberId: unrelated.id, connectedAt: archive.exportedAt });
  assert.ok(transfer.preview(a, incompatible).conflictCount >= 2);
});
