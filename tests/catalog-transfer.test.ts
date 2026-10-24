import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { createAccount } from "../src/auth/accounts.ts";
import { buildApp } from "../src/server/app.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { CatalogTransfer } from "../src/library/catalog-transfer.ts";
import { catalogArchiveV2, parseCatalogArchive } from "../src/library/catalog-archive.ts";
import { LibraryTransfer, TransferError } from "../src/library/transfer.ts";
import { BookmarkStore } from "../src/library/bookmarks.ts";
import { inspectCapturedPage } from "../src/sources/parsers.ts";
import type { AlbumDetail, ParseResult } from "../src/sources/types.ts";
import type { CatalogArchive } from "../src/shared/catalog-transfer.ts";

const config = { baseURL: "http://127.0.0.1:3000", secret: "test-only-catalog-transfer-secret-at-least-32-characters" };
const password = "test-catalog-password-123", headers = { host: "127.0.0.1:3000", origin: config.baseURL };
const code = (value: TransferError["code"]) => (error: unknown) => error instanceof TransferError && error.code === value;
function database(t: TestContext, version?: number) {
  const db = openDatabase(":memory:"); migrate(db, version ? loadMigrations().slice(0, version) : loadMigrations()); t.after(() => db.close());
  const a = randomUUID(), b = randomUUID(), now = new Date().toISOString();
  for (const id of [a, b]) db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)').run(id, "Test", `${id}@example.test`, now, now);
  return { db, a, b, store: new CatalogLibraryStore(db), transfer: new CatalogTransfer(db, config.secret) };
}
function detail(key = "sample") {
  const result = inspectCapturedPage({ sourceId: "zophar", kind: "album", status: 200, sampleKind: "synthetic", capturedAt: "2026-10-18T14:00:00Z",
    url: `https://www.zophar.net/music/nintendo-snes-spc/${key}.html`, headers: { "content-type": "text/html" }, html: readFileSync(new URL("./fixtures/zophar-album.html", import.meta.url), "utf8") });
  assert.ok(result.ok); return result as Extract<ParseResult, { ok: true }> & { data: AlbumDetail };
}
async function seed(db: Database.Database, userId: string) {
  const catalog = new CatalogStore(db), store = new CatalogLibraryStore(db);
  const [a] = await catalog.ingestSynthetic(detail()), album = await catalog.getAlbum(a!.albumId);
  const [other] = await catalog.ingestSynthetic(detail("other"));
  let saved = store.create(userId, { entityId: album.id, note: "나의 日本語 메모", favorite: true }).item;
  saved = store.connect(userId, saved.id, { version: saved.version, sourceEntityId: other!.sourceEntityId });
  const track = store.create(userId, { entityId: album.tracks[1]!.id, titleOverride: "내 트랙 이름" }).item;
  return { catalog, album, other: other!, saved, track };
}
const shared = (db: Database.Database) => ["entity", "album", "track", "source_entity", "assertion", "catalog_observation", "catalog_album_state", "catalog_removal"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const restore = (transfer: CatalogTransfer, userId: string, archive: unknown) => transfer.import(userId, archive, transfer.preview(userId, archive).token!);
function generated(count: number, note = ""): CatalogArchive {
  const now = "2026-10-24T00:00:00.000Z";
  return { format: "loopshelf-catalog", schemaVersion: 1, sampleKind: "synthetic", exportedAt: now,
    items: Array.from({ length: count }, (_, index) => { const id = randomUUID(), key = `sample-${randomUUID()}`; return { id: randomUUID(), reference: { entityId: id, kind: "album", albumId: id,
      source: { id: randomUUID(), sourceId: "khinsider", externalKey: key, pageUrl: `https://downloads.khinsider.com/game-soundtracks/album/${key}` } }, titleOverride: `개인 항목 ${index}`, note, favorite: index % 2 === 0, createdAt: now, updatedAt: now, sourceLinks: [] }; }) };
}

test("catalog files export private fields and minimal references only, without source metadata or another owner's data", async (t) => {
  const { db, a, b, store, transfer } = database(t), { album, saved, track } = await seed(db, a);
  store.create(b, { entityId: album.id, note: "foreign-secret" });
  const before = shared(db), archive = transfer.export(a), text = JSON.stringify(archive);
  assert.equal(archive.items.length, 2); assert.equal(archive.schemaVersion, 2); assert.ok(archive.items.every((item) => item.reference.sampleKind === "synthetic"));
  for (const forbidden of [album.title, album.tracks[0]!.title, "durationMs", "capturedAt", "foreign-secret", "userId", "version", "assertion", "Resource"]) assert.equal(text.includes(forbidden), false, forbidden);
  assert.deepEqual(parseCatalogArchive(archive), archive); assert.deepEqual(shared(db), before);
  assert.equal(archive.items.find((item) => item.id === saved.id)!.titleOverride, null);
  assert.equal(archive.items.find((item) => item.id === track.id)!.reference.source.id, album.sourceEntityId);
  assert.equal(new LibraryTransfer(db, config.secret).export(a).bookmarks.length, 0);
});

test("same-installation restore preserves catalog saves and judgments while assigning fresh optimistic versions", async (t) => {
  const { db, a, store, transfer } = database(t), { saved, track } = await seed(db, a), before = shared(db), archive = transfer.export(a);
  for (const item of [saved, track]) store.delete(a, item.id, { version: item.version });
  const result = restore(transfer, a, archive); assert.equal(result.added, 2); assert.equal(result.unresolved, 0);
  const restored = store.get(a, saved.id); assert.equal(restored.entity.id, saved.entity.id); assert.ok(restored.version > saved.version);
  assert.equal(restored.note, saved.note); assert.equal(restored.titleOverride, null); assert.deepEqual(restored.sourceLinks, saved.sourceLinks);
  assert.throws(() => store.update(a, restored.id, { version: saved.version, note: "stale" }));
  assert.deepEqual(transfer.export(a).items, archive.items); assert.equal(restore(transfer, a, archive).skipped, 2); assert.deepEqual(shared(db), before);
  store.update(a, restored.id, { version: restored.version, note: "Current private edit" });
  const preview = transfer.preview(a, archive); assert.equal(preview.conflictCount, 1); assert.equal(preview.token, null);
});

test("cross-installation restore stays private and unresolved even when the same source URLs already exist", async (t) => {
  const from = database(t), original = await seed(from.db, from.a), archive = from.transfer.export(from.a);
  const to = database(t), local = await seed(to.db, to.b), before = shared(to.db);
  assert.notEqual(local.album.id, original.album.id);
  const preview = to.transfer.preview(to.a, archive); assert.equal(preview.unresolvedCount, 2);
  const result = to.transfer.import(to.a, archive, preview.token!); assert.equal(result.unresolved, 2); assert.deepEqual(shared(to.db), before);
  assert.deepEqual(to.transfer.export(to.a).items, archive.items); assert.equal(restore(to.transfer, to.a, archive).skipped, 2);
  const restored = to.store.get(to.a, original.saved.id); assert.equal(restored.entity.contentState, "unresolved"); assert.equal(restored.title, "원본 미연결 앨범");
  assert.equal(restored.sourceLinks[0]!.source.contentState, "unresolved"); assert.equal(restored.note, original.saved.note); assert.equal(restored.entity.position, null);
  assert.throws(() => to.store.get(to.b, restored.id)); assert.equal(to.store.list(to.a, { kind: "track" }).items.length, 1);
  assert.equal(to.store.list(to.a, { q: "日本語", favorite: "true" }).items[0]!.id, restored.id);
  assert.equal(to.store.list(to.a, { q: original.album.title }).items.length, 0);
  const edited = to.store.update(to.a, restored.id, { version: restored.version, titleOverride: "個人 제목", note: "edited" });
  assert.throws(() => to.store.connect(to.a, edited.id, { version: edited.version, sourceEntityId: local.other.sourceEntityId }));
  const unlinked = to.store.disconnect(to.a, edited.id, { version: edited.version, sourceEntityId: restored.sourceLinks[0]!.source.sourceEntityId });
  assert.equal(unlinked.sourceLinks.length, 0); assert.ok(unlinked.version > edited.version);
  to.store.delete(to.a, unlinked.id, { version: unlinked.version }); assert.throws(() => to.store.get(to.a, unlinked.id));
  assert.deepEqual(shared(to.db), before); verifyDatabase(to.db);
});

test("preview binds private versions, file, user, expiry and catalog availability; removal never resurrects metadata", async (t) => {
  const { db, a, b, store, transfer } = database(t), { catalog, album, saved, track } = await seed(db, a), archive = transfer.export(a);
  let token = transfer.preview(a, archive).token!;
  assert.throws(() => transfer.import(b, archive, token), code("preview_stale"));
  const changed = structuredClone(archive); changed.items[0]!.note += "changed";
  assert.throws(() => transfer.import(a, changed, token), code("preview_stale"));
  assert.throws(() => transfer.import(a, archive, token.slice(0, -1)), code("preview_stale"));
  const now = Date.now; t.mock.method(Date, "now", () => now() + 600001);
  assert.throws(() => transfer.import(a, archive, token), code("preview_stale")); t.mock.restoreAll();
  store.update(a, saved.id, { version: saved.version, note: saved.note });
  assert.throws(() => transfer.import(a, archive, token), code("preview_stale"));
  for (const item of [saved, track]) { const current = store.get(a, item.id); store.delete(a, item.id, { version: current.version }); }
  token = transfer.preview(a, archive).token!;
  await catalog.removeSource({ sourceEntityId: album.sourceEntityId, reason: "policy_change" });
  assert.throws(() => transfer.import(a, archive, token), code("preview_stale"));
  const before = shared(db); assert.equal(restore(transfer, a, archive).unresolved, 0);
  assert.equal(store.get(a, saved.id).entity.contentState, "removed"); assert.equal(store.get(a, track.id).title, "내 트랙 이름");
  assert.equal(JSON.stringify(transfer.export(a)).includes(album.title), false); assert.deepEqual(shared(db), before);
});

test("strict catalog archives reject ambiguous identity claims, unsafe URLs, extra metadata and oversized input", async (t) => {
  const { db, a, transfer } = database(t); await seed(db, a); const archive = transfer.export(a);
  const mutations: ((value: any) => void)[] = [ // Deliberately malformed wire inputs, not production types.
    (v) => v.userId = "forged", (v) => v.schemaVersion = 3, (v) => v.sampleKind = "live",
    (v) => v.items[0].reference.title = "copied metadata", (v) => v.items[0].titleOverride = " padded ",
    (v) => v.items[0].note = "\ud800", (v) => v.items[0].note = "nul\0", (v) => v.items[0].version = 1,
    (v) => v.items[0].createdAt = "2099-01-01T00:00:00.000Z", (v) => v.items[0].reference.source.pageUrl = "https://evil.test/file",
    (v) => v.items[0].reference.source.externalKey = "mismatch", (v) => v.items.push(v.items[0]),
    (v) => v.items[0].id = v.items[0].reference.entityId, (v) => v.items[0].reference.albumId = randomUUID(),
    (v) => { const album = v.items.find((i: any) => i.reference.kind === "album"); album.sourceLinks.push(album.sourceLinks[0]); },
    (v) => { const album = v.items.find((i: any) => i.reference.kind === "album"); album.sourceLinks[0].reference = album.reference; },
    (v) => { const track = v.items.find((i: any) => i.reference.kind === "track"); track.sourceLinks = v.items.find((i: any) => i.reference.kind === "album").sourceLinks; },
  ];
  for (const mutate of mutations) { const invalid = structuredClone(archive); mutate(invalid); assert.throws(() => parseCatalogArchive(invalid), code("invalid_archive")); }
  assert.throws(() => parseCatalogArchive(generated(5001)), code("invalid_archive"));
  assert.throws(() => parseCatalogArchive({ ...generated(1), extra: "가".repeat(3_000_000) }), code("archive_too_large"));
});

test("failed catalog import rolls back private rows, link audit and revision allocation", async (t) => {
  const from = database(t); await seed(from.db, from.a); const archive = from.transfer.export(from.a), to = database(t), before = shared(to.db);
  const revision = to.db.prepare("SELECT * FROM library_revision").all();
  to.db.exec("CREATE TRIGGER injected_catalog_link_failure BEFORE INSERT ON catalog_detached_link BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
  const token = to.transfer.preview(to.a, archive).token!;
  assert.throws(() => to.transfer.import(to.a, archive, token), /injected failure/);
  assert.equal(to.store.list(to.a).items.length, 0); assert.deepEqual(to.db.prepare("SELECT * FROM library_revision").all(), revision);
  assert.equal(to.db.prepare("SELECT * FROM user_source_link_event").all().length, 0); assert.deepEqual(shared(to.db), before);
  to.db.exec("DROP TRIGGER injected_catalog_link_failure"); assert.equal(to.transfer.import(to.a, archive, token).added, 2);
});

test("catalog and bookmark IDs and personal link occupancy cannot collide across resolved and detached stores", async (t) => {
  const { db, a, b, store, transfer } = database(t), { saved, other } = await seed(db, a);
  const bookmarks = new BookmarkStore(db), bookmark = bookmarks.create(a, { title: "개인 북마크", url: "https://downloads.khinsider.com/game-soundtracks/album/bookmark", note: "" }).item;
  const incoming = catalogArchiveV2(generated(1)); incoming.items[0]!.id = bookmark.id;
  assert.equal(transfer.preview(a, incoming).conflicts[0]!.reason, "id_conflict");
  incoming.items[0]!.id = randomUUID(); incoming.items[0]!.sourceLinks = transfer.export(a).items.find((item) => item.id === saved.id)!.sourceLinks;
  assert.equal(transfer.preview(a, incoming).conflicts[0]!.reason, "connection_conflict");
  const token = transfer.preview(b, incoming).token!; transfer.import(b, incoming, token);
  assert.equal(transfer.preview(a, incoming).conflicts[0]!.reason, "id_conflict");
  const bobSaved = store.create(b, { entityId: saved.entity.id }).item;
  assert.throws(() => store.connect(b, bobSaved.id, { version: bobSaved.version, sourceEntityId: other.sourceEntityId }));
  const legacy = new LibraryTransfer(db, config.secret), file = legacy.export(a);
  bookmarks.delete(a, bookmark.id, bookmark.version); file.bookmarks[0]!.id = incoming.items[0]!.id;
  assert.equal(legacy.preview(a, file).conflicts[0]!.reason, "id_conflict");
  const second = generated(1); second.items[0]!.reference.entityId = bookmark.entityId; second.items[0]!.reference.albumId = bookmark.entityId;
  restore(transfer, a, second); // A deleted reference may stay unresolved, but no global bookmark entity is recreated.
  assert.equal(db.prepare("SELECT * FROM entity WHERE id=?").get(bookmark.entityId), undefined); verifyDatabase(db);
});

test("catalog export includes pages beyond UI limits and enforces the resulting UTF-8 archive bound", (t) => {
  const { a, db, store, transfer } = database(t), archive = generated(125);
  assert.equal(restore(transfer, a, archive).added, 125); assert.equal(transfer.export(a).items.length, 125);
  assert.equal(store.list(a, { limit: 100 }).nextOffset, 100); assert.equal(store.list(a, { limit: 100, offset: 100 }).items.length, 25);
  const heavy = generated(250, "가".repeat(10000)); restore(transfer, a, heavy);
  assert.throws(() => transfer.preview(a, generated(100, "가".repeat(10000))), code("archive_too_large"));
  db.prepare("UPDATE catalog_detached_item SET note=?").run("가".repeat(10000));
  assert.throws(() => transfer.export(a), code("archive_too_large"));
});

test("0010 upgrade and full database recovery preserve old rows plus detached identities and ownership", async (t) => {
  const { db, a, b } = database(t, 9), now = new Date().toISOString();
  const catalog = new CatalogStore(db), [album] = await catalog.ingestSynthetic(detail());
  const id = randomUUID(); db.prepare("INSERT INTO library_item(id,user_id,entity_id,note,created_at,updated_at) VALUES (?,?,?,'before migration',?,?)").run(id, a, album!.albumId, now, now);
  const before = db.prepare("SELECT * FROM library_item").all(); migrate(db); assert.deepEqual(db.prepare("SELECT * FROM library_item").all(), before);
  const transfer = new CatalogTransfer(db, config.secret), archive = generated(1); restore(transfer, a, archive);
  const expected = transfer.export(a).items, directory = mkdtempSync(join(tmpdir(), "loopshelf-catalog-transfer-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const backup = join(directory, "backup.sqlite"), destination = join(directory, "restored.sqlite"); await backupDatabase(db, backup); await restoreDatabase(backup, destination);
  const recovered = openDatabase(destination); t.after(() => recovered.close()); verifyDatabase(recovered);
  assert.deepEqual(new CatalogTransfer(recovered, config.secret).export(a).items, expected);
  assert.equal(new CatalogLibraryStore(recovered).list(b).items.length, 0);
  assert.throws(() => recovered.prepare("UPDATE catalog_detached_item SET entity_id=? WHERE id=?").run(randomUUID(), archive.items[0]!.id), /immutable/);
  assert.throws(() => recovered.prepare("INSERT INTO catalog_detached_link VALUES (?,?,?,?,?)").run(archive.items[0]!.id, b, album!.sourceEntityId, JSON.stringify(archive.items[0]!.reference), now));
});

test("catalog transfer HTTP uses real sessions, no-store, ownership, strict inputs and atomic competing imports", async (t) => {
  const db = openDatabase(":memory:"); migrate(db);
  const a = await createAccount(db, config, { name: "Alice", email: "a@example.test", password });
  await createAccount(db, config, { name: "Bob", email: "b@example.test", password });
  await seed(db, a.id); const app = await buildApp(db, config); t.after(async () => { await app.close(); db.close(); });
  async function login(email: string) {
    const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers, payload: { email, password } }); assert.equal(response.statusCode, 200);
    return { ...headers, cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
  }
  const own = await login("a@example.test"), foreign = await login("b@example.test");
  const response = await app.inject({ url: "/api/library/catalog/export", headers: own }); assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  assert.ok(String(response.headers["content-disposition"]).includes("loopshelf-catalog-"));
  assert.equal((await app.inject({ url: "/api/library/catalog/export", headers: foreign })).json().items.length, 0);
  assert.equal((await app.inject({ url: "/api/library/catalog/export", headers })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/library/catalog/export?userId=forged", headers: own })).statusCode, 400);
  const archive = generated(1), previewUrl = "/api/library/import/preview", importUrl = "/api/library/import";
  const token = (await app.inject({ method: "POST", url: previewUrl, headers: own, payload: { archive } })).json().token;
  const session = (await app.inject({ url: "/api/auth/get-session", headers: own })).json().session.id;
  for (const url of [previewUrl, importUrl]) {
    const payload = url === previewUrl ? { archive } : { archive, token };
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, headers: { ...own, origin: "https://evil.test" }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url, headers: { ...foreign, "x-loopshelf-session": session }, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, headers: own, payload: { ...payload, userId: "forged" } })).statusCode, 400);
  }
  const both = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: importUrl, headers: own, payload: { archive, token } })));
  assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 409]);
  const id = archive.items[0]!.id;
  for (const path of [`/api/library/catalog/${id}`, `/api/library/catalog/${id}/sources`, `/api/library/catalog/${id}/source-candidates`])
    assert.equal((await app.inject({ url: path, headers: foreign })).statusCode, 404);
  const current = (await app.inject({ url: `/api/library/catalog/${id}`, headers: own })).json();
  for (const method of ["PATCH", "DELETE"] as const) assert.equal((await app.inject({ method, url: `/api/library/catalog/${id}`, headers: foreign, payload: { version: current.version, ...(method === "PATCH" ? { note: "stolen" } : {}) } })).statusCode, 404);
  const contenders = generated(1), aToken = (await app.inject({ method: "POST", url: previewUrl, headers: own, payload: { archive: contenders } })).json().token;
  const bToken = (await app.inject({ method: "POST", url: previewUrl, headers: foreign, payload: { archive: contenders } })).json().token;
  assert.equal((await app.inject({ method: "POST", url: importUrl, headers: foreign, payload: { archive: contenders, token: bToken } })).statusCode, 200);
  const conflict = await app.inject({ method: "POST", url: importUrl, headers: own, payload: { archive: contenders, token: aToken } });
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().code, "import_conflict");
});
