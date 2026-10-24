import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate, assertMigrated } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { withDatabase } from "../src/database/access.ts";
import { createAccount } from "../src/auth/accounts.ts";
import { buildApp } from "../src/server/app.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogLibraryError, CatalogLibraryStore } from "../src/library/catalog.ts";
import { BookmarkStore } from "../src/library/bookmarks.ts";
import { LibraryTransfer } from "../src/library/transfer.ts";
import { inspectCapturedPage } from "../src/sources/parsers.ts";
import type { AlbumDetail, ParseResult } from "../src/sources/types.ts";
import type { CatalogEntry } from "../src/shared/catalog-browse.ts";
import type { CatalogLibraryItem } from "../src/shared/catalog-library.ts";

const config = { baseURL: "http://127.0.0.1:3000", secret: "test-only-catalog-library-secret-at-least-32-characters" };
const baseHeaders = { host: "127.0.0.1:3000", origin: config.baseURL };
const password = "test-only-password-123";
function detail() {
  const result = inspectCapturedPage({ sourceId: "zophar", kind: "album", status: 200, sampleKind: "synthetic", capturedAt: "2026-10-18T14:00:00Z",
    url: "https://www.zophar.net/music/nintendo-snes-spc/sample.html", headers: { "content-type": "text/html" },
    html: readFileSync(new URL("./fixtures/zophar-album.html", import.meta.url), "utf8") });
  assert.ok(result.ok); return result as Extract<ParseResult, { ok: true }> & { data: AlbumDetail };
}
function otherAlbum(index: number) {
  const input = detail(); input.data.externalKey = `nintendo-snes-spc/other-${index}`;
  input.data.pageUrl = `https://www.zophar.net/music/${input.data.externalKey}.html`; input.provenance.pageUrl = input.data.pageUrl;
  input.data.title = `별도 앨범 ${index}`; return input;
}
const rows = (db: Database.Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const sharedTables = ["entity", "album", "track", "source_entity", "assertion", "catalog_observation", "catalog_album_state", "catalog_track_origin", "catalog_track_binding", "catalog_track_adoption"];
const shared = (db: Database.Database) => sharedTables.map((table) => rows(db, table));
const hasCode = (code: CatalogLibraryError["code"]) => (error: unknown) => error instanceof CatalogLibraryError && error.code === code;

async function fixture(t: TestContext) {
  const db = openDatabase(":memory:"); migrate(db);
  const a = await createAccount(db, config, { name: "Alice", email: "alice@example.test", password });
  const b = await createAccount(db, config, { name: "Bob", email: "bob@example.test", password });
  const catalog = new CatalogStore(db), [saved] = await catalog.ingestSynthetic(detail()), album = await catalog.getAlbum(saved!.albumId);
  const [other] = await catalog.ingestSynthetic(otherAlbum(1));
  const app = await buildApp(db, config); t.after(async () => { await app.close(); db.close(); });
  async function login(email: string) {
    const result = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: baseHeaders, payload: { email, password } });
    assert.equal(result.statusCode, 200, result.body);
    return { ...baseHeaders, cookie: result.cookies.map((value) => `${value.name}=${value.value}`).join("; ") };
  }
  const own = await login("alice@example.test"), foreign = await login("bob@example.test");
  const store = new CatalogLibraryStore(db);
  const create = async (entityId: string, headers = own, fields: Record<string, unknown> = {}) => {
    const result = await app.inject({ method: "POST", url: "/api/library/catalog", headers, payload: { entityId, ...fields } });
    assert.ok([200, 201].includes(result.statusCode), result.body); return result.json().item as CatalogLibraryItem;
  };
  return { db, app, a, b, catalog, album, other: other!, store, own, foreign, create };
}

test("real sessions save shared albums and tracks as separate private UUIDs without copying source metadata", async (t) => {
  const { db, app, a, album, own, foreign, create } = await fixture(t), before = shared(db);
  const first = await create(album.id), second = await create(album.id, foreign), track = await create(album.tracks[1]!.id);
  assert.notEqual(first.id, second.id); assert.equal(first.entity.id, second.entity.id);
  assert.equal(first.titleOverride, null); assert.equal(first.entity.sampleKind, "synthetic"); assert.equal(first.entity.identity, "source-provisional");
  assert.equal(track.entity.kind, "track"); assert.equal(track.entity.position, 2); assert.equal(track.entity.albumId, album.id);
  assert.equal(track.entity.sourceEntityId, album.sourceEntityId); assert.deepEqual(first.sourceLinks, []);
  assert.deepEqual(shared(db), before);
  const retry = await app.inject({ method: "POST", url: "/api/library/catalog", headers: own, payload: { entityId: album.id, note: "Do not overwrite", favorite: true, titleOverride: "No" } });
  assert.equal(retry.statusCode, 200); assert.equal(retry.json().created, false); assert.deepEqual(retry.json().item, first);
  const listed = await app.inject({ url: "/api/library/catalog", headers: own });
  assert.equal(listed.headers["cache-control"], "no-store"); assert.equal(listed.headers["x-loopshelf-user"], a.id);
  assert.deepEqual(new Set(listed.json().items.map((row: CatalogLibraryItem) => row.id)), new Set([first.id, track.id]));
  assert.deepEqual((await app.inject({ url: "/api/library/catalog", headers: foreign })).json().items.map((row: CatalogLibraryItem) => row.id), [second.id]);
  assert.equal((db.prepare("SELECT title_override FROM library_item WHERE id=?").get(first.id) as { title_override: string | null }).title_override, null);
});

test("every item and source mutation requires ownership, the actual session, same origin and strict input", async (t) => {
  const { app, album, other, own, foreign, create } = await fixture(t), item = await create(album.id), path = `/api/library/catalog/${item.id}`;
  const session = (await app.inject({ url: "/api/auth/get-session", headers: own })).json().session.id;
  for (const route of [path, `${path}/sources`]) {
    assert.equal((await app.inject({ url: route, headers: foreign })).statusCode, 404);
    assert.equal((await app.inject({ url: route, headers: baseHeaders })).statusCode, 401);
    assert.equal((await app.inject({ url: route, headers: { ...foreign, "x-loopshelf-session": session } })).statusCode, 401);
  }
  const actions = [
    { method: "PATCH" as const, url: path, payload: { version: item.version, note: "Stolen" } },
    { method: "DELETE" as const, url: path, payload: { version: item.version } },
    { method: "POST" as const, url: `${path}/sources`, payload: { version: item.version, sourceEntityId: other.sourceEntityId } },
    { method: "DELETE" as const, url: `${path}/sources`, payload: { version: item.version, sourceEntityId: other.sourceEntityId } },
  ];
  for (const action of actions) {
    assert.equal((await app.inject({ ...action, headers: foreign })).statusCode, 404);
    assert.equal((await app.inject({ ...action, headers: baseHeaders })).statusCode, 401);
    assert.equal((await app.inject({ ...action, headers: { ...own, origin: "https://evil.test" } })).statusCode, 403);
    assert.equal((await app.inject({ ...action, headers: { ...foreign, "x-loopshelf-session": session } })).statusCode, 401);
    assert.equal((await app.inject({ ...action, headers: own, payload: { ...action.payload, userId: "forged" } })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/library/catalog", headers: baseHeaders, payload: { entityId: album.id } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/library/catalog", headers: { ...own, origin: "https://evil.test" }, payload: { entityId: album.id } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/library/catalog", headers: own, payload: { entityId: album.id, userId: "forged" } })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/library/catalog?userId=forged", headers: own })).statusCode, 400);
  assert.equal((await app.inject({ url: `${path}?userId=forged`, headers: own })).statusCode, 400);
  assert.deepEqual((await app.inject({ url: path, headers: own })).json(), item);
  await app.inject({ method: "POST", url: "/api/auth/sign-out", headers: own });
  assert.equal((await app.inject({ url: path, headers: own })).statusCode, 401);
});

test("private overrides and favorite edits are versioned and never modify catalog claims or another owner", async (t) => {
  const { db, app, album, own, foreign, create } = await fixture(t), item = await create(album.id), theirs = await create(album.id, foreign), before = shared(db);
  const path = `/api/library/catalog/${item.id}`;
  const update = await app.inject({ method: "PATCH", url: path, headers: own, payload: { version: item.version, titleOverride: "나만의 제목", note: "나의 메모", favorite: true } });
  assert.equal(update.statusCode, 200); assert.equal(update.json().title, "나만의 제목"); assert.equal(update.json().version, item.version + 1);
  assert.equal((await app.inject({ method: "PATCH", url: path, headers: own, payload: { version: item.version, note: "Old editor" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: path, headers: own, payload: { version: item.version } })).statusCode, 409);
  assert.deepEqual((await app.inject({ url: `/api/library/catalog/${theirs.id}`, headers: foreign })).json(), theirs); assert.deepEqual(shared(db), before);
  const reset = await app.inject({ method: "PATCH", url: path, headers: own, payload: { version: update.json().version, titleOverride: null } });
  assert.equal(reset.json().title, album.title); assert.equal(reset.json().note, "나의 메모"); assert.equal(reset.json().favorite, true);
  for (const fields of [{ titleOverride: "" }, { note: "\0" }, { titleOverride: "x".repeat(301) }, { entityId: randomUUID() }, { url: "https://evil.test" }])
    assert.equal((await app.inject({ method: "PATCH", url: path, headers: own, payload: { version: reset.json().version, ...fields } })).statusCode, 400);
});

test("personal album source links are reversible and isolated without merging saved rows or shared identities", async (t) => {
  const { db, app, album, other, own, foreign, create } = await fixture(t), root = await create(album.id), alsoSaved = await create(other.albumId), theirs = await create(album.id, foreign);
  const before = shared(db), path = `/api/library/catalog/${root.id}/sources`, payload = { version: root.version, sourceEntityId: other.sourceEntityId };
  const response = await app.inject({ method: "POST", url: path, headers: own, payload }); assert.equal(response.statusCode, 200, response.body);
  const linked = response.json() as CatalogLibraryItem; assert.equal(linked.sourceLinks.length, 1); assert.equal(linked.sourceLinks[0]!.relationship, "user-asserted");
  assert.equal(linked.sourceLinks[0]!.source.sourceEntityId, other.sourceEntityId); assert.equal(linked.entity.id, album.id);
  assert.deepEqual((await app.inject({ url: `/api/library/catalog/${alsoSaved.id}`, headers: own })).json(), alsoSaved);
  assert.equal((await app.inject({ url: "/api/library/catalog", headers: own })).json().items.length, 2);
  assert.equal((await app.inject({ method: "POST", url: path, headers: own, payload })).statusCode, 409);
  const retry = await app.inject({ method: "POST", url: path, headers: own, payload: { ...payload, version: linked.version } }); assert.deepEqual(retry.json(), linked);
  assert.equal(rows(db, "user_source_link_event").length, 1);
  const bobLink = await app.inject({ method: "POST", url: `/api/library/catalog/${theirs.id}/sources`, headers: foreign, payload }); assert.equal(bobLink.statusCode, 200);
  const detached = await app.inject({ method: "DELETE", url: path, headers: own, payload: { ...payload, version: linked.version } }); assert.equal(detached.statusCode, 200);
  assert.deepEqual(detached.json().sourceLinks, []); assert.equal(detached.json().id, root.id);
  assert.equal((await app.inject({ url: `/api/library/catalog/${theirs.id}`, headers: foreign })).json().sourceLinks.length, 1);
  assert.deepEqual(shared(db), before); verifyDatabase(db);
});

test("source connections reject self, track guesses, unsupported sources and an occupied personal source", async (t) => {
  const { db, app, album, other, own, create } = await fixture(t), root = await create(album.id), track = await create(album.tracks[0]!.id);
  const connect = (id: string, sourceEntityId: string, version = 1) => app.inject({ method: "POST", url: `/api/library/catalog/${id}/sources`, headers: own, payload: { sourceEntityId, version } });
  assert.equal((await connect(root.id, album.sourceEntityId)).json().code, "invalid_connection");
  assert.equal((await connect(track.id, other.sourceEntityId)).json().code, "invalid_connection");
  assert.equal((await connect(root.id, randomUUID())).statusCode, 404);
  const raw = randomUUID(); db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,page_url) VALUES (?,'zophar','album','unmanaged','https://www.zophar.net/music/snes/unmanaged.html')").run(raw);
  assert.equal((await connect(root.id, raw)).statusCode, 404);
  assert.equal((await connect(root.id, other.sourceEntityId)).statusCode, 200);
  const third = (await new CatalogStore(db).ingestSynthetic(otherAlbum(2)))[0]!; const another = await create(third.albumId);
  assert.equal((await connect(another.id, other.sourceEntityId)).json().code, "conflict");
  assert.equal((await app.inject({ url: `/api/library/catalog/${another.id}`, headers: own })).json().sourceLinks.length, 0);
});

test("pagination, kind/favorite filters and literal multilingual search stay inside the saved owner's library", async (t) => {
  const { app, album, other, own, foreign, create } = await fixture(t);
  const root = await create(album.id, own, { titleOverride: "ＡＢＣ クロノ", note: '특별 메모 100% "quoted"', favorite: true });
  await create(album.tracks[0]!.id); await create(other.albumId, foreign, { note: "private-bob-only" });
  await app.inject({ method: "POST", url: `/api/library/catalog/${root.id}/sources`, headers: own, payload: { version: root.version, sourceEntityId: other.sourceEntityId } });
  for (const q of ["abc", "クロ", "특별", '100% "quoted"', "별도 앨범 1"])
    assert.equal((await app.inject({ url: `/api/library/catalog?q=${encodeURIComponent(q)}`, headers: own })).json().items[0].id, root.id);
  for (const q of ["private-bob-only", "* OR note", "' OR 1=1 --"])
    assert.equal((await app.inject({ url: `/api/library/catalog?q=${encodeURIComponent(q)}`, headers: own })).json().items.length, 0);
  assert.equal((await app.inject({ url: "/api/library/catalog?favorite=true&kind=album", headers: own })).json().items.length, 1);
  const one = (await app.inject({ url: "/api/library/catalog?limit=1", headers: own })).json(); assert.equal(one.nextOffset, 1);
  const two = (await app.inject({ url: "/api/library/catalog?limit=1&offset=1", headers: own })).json(); assert.equal(two.nextOffset, null);
  assert.notEqual(one.items[0].id, two.items[0].id);
  assert.equal((await app.inject({ url: "/api/library/catalog?limit=101", headers: own })).statusCode, 400);
});

test("adoption updates current positions and marks missing saved tracks without changing private rows", async (t) => {
  const { db, catalog, app, album, own, foreign, create } = await fixture(t);
  const track = await create(album.tracks[1]!.id, own, { titleOverride: "내 곡", note: "보존", favorite: true });
  await create(album.tracks[1]!.id, foreign); const keep = await create(album.tracks[2]!.id);
  const privateRows = rows(db, "library_item"), next = detail(); next.provenance.capturedAt = "2026-10-18T14:01:00Z";
  next.data.tracks = [next.data.tracks[2]!, next.data.tracks[0]!, next.data.tracks[3]!]; next.data.tracks.forEach((row, i) => { row.position = i + 1; });
  const [pending] = await catalog.ingestSynthetic(next);
  await catalog.adoptTrackList({ requestId: randomUUID(), albumId: album.id, expectedTracksObservationId: album.tracksObservationId,
    observationId: pending!.observationId, assignments: [album.tracks[2]!.id, album.tracks[0]!.id, album.tracks[3]!.id].map((trackId, i) => ({ position: i + 1, trackId })), missingTrackIds: [track.entity.id] });
  const missing = (await app.inject({ url: `/api/library/catalog/${track.id}`, headers: own })).json();
  assert.equal(missing.entity.presence, "missing"); assert.equal(missing.entity.position, null); assert.equal(missing.title, "내 곡"); assert.equal(missing.version, track.version);
  assert.equal((await app.inject({ url: `/api/library/catalog/${keep.id}`, headers: own })).json().entity.position, 1);
  assert.deepEqual(rows(db, "library_item"), privateRows);
  assert.equal((await app.inject({ method: "POST", url: "/api/library/catalog", headers: own, payload: { entityId: track.entity.id } })).statusCode, 200);
  assert.throws(() => new CatalogLibraryStore(db).create("missing-owner", { entityId: track.entity.id }), hasCode("catalog_unavailable"));
});

test("removal hides derived titles and linked metadata while preserving notes, favorites and removable personal links", async (t) => {
  const { db, catalog, app, album, other, own, foreign, create } = await fixture(t);
  const item = await create(album.id), track = await create(album.tracks[0]!.id, own, { titleOverride: "직접 쓴 제목", note: "개인 내용", favorite: true });
  const otherSaved = await create(other.albumId, foreign); const root = await create(other.albumId);
  const linked = (await app.inject({ method: "POST", url: `/api/library/catalog/${root.id}/sources`, headers: own, payload: { version: root.version, sourceEntityId: album.sourceEntityId } })).json();
  const before = rows(db, "library_item"), links = rows(db, "user_source_link");
  await catalog.removeSource({ sourceEntityId: album.sourceEntityId, reason: "rights_request" });
  assert.deepEqual(rows(db, "library_item"), before); assert.deepEqual(rows(db, "user_source_link"), links);
  const removed = (await app.inject({ url: `/api/library/catalog/${item.id}`, headers: own })).json();
  assert.equal(removed.entity.contentState, "removed"); assert.equal(removed.title, "메타데이터가 제거된 앨범");
  const kept = (await app.inject({ url: `/api/library/catalog/${track.id}`, headers: own })).json();
  assert.equal(kept.title, "직접 쓴 제목"); assert.equal(kept.entity.title, "메타데이터가 제거된 트랙"); assert.equal(kept.entity.durationMs, null);
  const linkedRemoved = (await app.inject({ url: `/api/library/catalog/${root.id}`, headers: own })).json();
  assert.equal(linkedRemoved.sourceLinks[0].source.contentState, "removed");
  assert.equal((await app.inject({ url: `/api/library/catalog?q=${encodeURIComponent(album.title)}`, headers: own })).json().items.length, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/library/catalog", headers: foreign, payload: { entityId: album.id } })).json().code, "catalog_unavailable");
  assert.equal((await app.inject({ method: "POST", url: `/api/library/catalog/${otherSaved.id}/sources`, headers: foreign, payload: { version: otherSaved.version, sourceEntityId: album.sourceEntityId } })).json().code, "catalog_unavailable");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/library/catalog/${item.id}`, headers: own, payload: { version: item.version, note: "삭제 후 메모" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/library/catalog/${root.id}/sources`, headers: own, payload: { version: linked.version, sourceEntityId: album.sourceEntityId } })).statusCode, 200);
});

test("personal deletion removes only owned saves and judgments, leaving shared music and another user's library", async (t) => {
  const { db, app, album, other, own, foreign, create } = await fixture(t), a = await create(album.id), b = await create(album.id, foreign), before = shared(db);
  const linked = (await app.inject({ method: "POST", url: `/api/library/catalog/${a.id}/sources`, headers: own, payload: { version: a.version, sourceEntityId: other.sourceEntityId } })).json();
  assert.equal((await app.inject({ method: "DELETE", url: `/api/library/catalog/${a.id}`, headers: own, payload: { version: linked.version } })).statusCode, 204);
  assert.equal((await app.inject({ url: `/api/library/catalog/${a.id}`, headers: own })).statusCode, 404);
  assert.deepEqual((await app.inject({ url: `/api/library/catalog/${b.id}`, headers: foreign })).json(), b);
  assert.equal(rows(db, "user_source_link").length, 0); assert.equal(rows(db, "user_source_link_event").length, 2); assert.deepEqual(shared(db), before);
  const savedAgain = await create(album.id); assert.notEqual(savedAgain.id, a.id); assert.equal(savedAgain.entity.id, a.entity.id);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/library/catalog/${a.id}`, headers: own, payload: { version: a.version, note: "old" } })).statusCode, 404);
});

test("bookmark APIs, grouping and v1 JSON remain separate and cannot overwrite or export catalog saves", async (t) => {
  const { db, app, a, b, album, own, create } = await fixture(t), saved = await create(album.id, own, { note: "Catalog private" });
  const bookmarks = new BookmarkStore(db), bookmark = bookmarks.create(a.id, { title: "직접 북마크", url: album.pageUrl }).item;
  const transfer = new LibraryTransfer(db, config.secret), archive = transfer.export(a.id);
  assert.deepEqual(archive.bookmarks.map((row) => row.id), [bookmark.id]); assert.ok(!JSON.stringify(archive).includes(saved.id));
  assert.equal((await app.inject({ url: `/api/bookmarks/${saved.id}`, headers: own })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/library/catalog/${bookmark.id}`, headers: own })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/library/catalog", headers: own, payload: { entityId: bookmark.entityId } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `/api/bookmarks/${bookmark.id}/connections`, headers: own, payload: { version: bookmark.version, memberId: saved.id, memberVersion: saved.version } })).statusCode, 404);
  const forged = structuredClone(archive); forged.bookmarks[0]!.id = saved.id; forged.bookmarks[0]!.entityId = saved.entity.id;
  assert.equal(transfer.preview(a.id, forged).conflictCount, 1); assert.equal(transfer.preview(b.id, forged).conflictCount, 1);
  const checked = transfer.preview(a.id, archive); transfer.import(a.id, archive, checked.token!);
  assert.deepEqual(new CatalogLibraryStore(db).get(a.id, saved.id), saved);
});

test("concurrent creates converge and competing private writes serialize through the authenticated DB boundary", async (t) => {
  const { db, app, album, other, own } = await fixture(t);
  const created = await Promise.all([1, 2, 3].map(() => app.inject({ method: "POST", url: "/api/library/catalog", headers: own, payload: { entityId: album.id } })));
  assert.deepEqual(created.map((row) => row.statusCode).sort(), [200, 200, 201]);
  const item = created[0]!.json().item as CatalogLibraryItem; assert.equal(new Set(created.map((row) => row.json().item.id)).size, 1);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const occupied = withDatabase(db, async () => { await gate; });
  const actions = Promise.all([
    app.inject({ method: "PATCH", url: `/api/library/catalog/${item.id}`, headers: own, payload: { version: item.version, note: "Changed" } }),
    app.inject({ method: "POST", url: `/api/library/catalog/${item.id}/sources`, headers: own, payload: { version: item.version, sourceEntityId: other.sourceEntityId } }),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal((db.prepare("SELECT version FROM library_item WHERE id=?").get(item.id) as { version: number }).version, item.version);
  release(); await occupied; assert.deepEqual((await actions).map((row) => row.statusCode).sort(), [200, 409]);
});

test("failed link or edit rolls back private values, version, audit and does not touch the catalog", async (t) => {
  const { db, store, a, album, other } = await fixture(t), saved = store.create(a.id, { entityId: album.id }).item, before = shared(db);
  db.exec("CREATE TRIGGER fail_catalog_touch BEFORE UPDATE OF version ON library_item BEGIN SELECT RAISE(ABORT,'injected private failure'); END");
  assert.throws(() => store.connect(a.id, saved.id, { version: saved.version, sourceEntityId: other.sourceEntityId }), /injected private failure/);
  assert.deepEqual(store.get(a.id, saved.id), saved); assert.equal(rows(db, "user_source_link_event").length, 0);
  assert.throws(() => store.update(a.id, saved.id, { version: saved.version, note: "Rolled back", favorite: true }), /injected private failure/);
  assert.deepEqual(store.get(a.id, saved.id), saved); assert.deepEqual(shared(db), before);
});

test("SQL and service enforce same-owner links, immutable identity and the 20-link bound", async (t) => {
  const { db, store, catalog, a, b, album, other, app, own } = await fixture(t), saved = store.create(a.id, { entityId: album.id }).item;
  assert.throws(() => db.prepare("INSERT INTO user_source_link VALUES (?,?,?,'now')").run(b.id, saved.id, other.sourceEntityId), /FOREIGN KEY/);
  let current = saved;
  for (let i = 2; i < 22; i++) {
    const [source] = await catalog.ingestSynthetic(otherAlbum(i)); current = store.connect(a.id, current.id, { version: current.version, sourceEntityId: source!.sourceEntityId });
  }
  assert.equal(current.sourceLinks.length, 20);
  const candidates = (await app.inject({ url: `/api/library/catalog/${current.id}/source-candidates`, headers: own })).json();
  assert.equal(candidates.remainingSlots, 0); assert.deepEqual(candidates.items, []); assert.equal(candidates.nextOffset, null);
  assert.throws(() => store.connect(a.id, current.id, { version: current.version, sourceEntityId: other.sourceEntityId }), hasCode("connection_limit"));
  assert.throws(() => db.prepare("INSERT INTO user_source_link VALUES (?,?,?,'now')").run(a.id, current.id, other.sourceEntityId), /connection limit/);
  assert.throws(() => db.exec("UPDATE user_source_link SET asserted_at='later'"), /Disconnect/);
  assert.throws(() => db.prepare("UPDATE library_item SET entity_id=? WHERE id=?").run(other.albumId, saved.id), /immutable/);
  assert.throws(() => db.prepare("UPDATE library_item SET user_id=? WHERE id=?").run(b.id, saved.id), /immutable/);
  verifyDatabase(db);
});

test("0009 preserves earlier private catalog rows and full DB recovery retains IDs, links and ownership", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-catalog-library-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "original.sqlite"), db = openDatabase(path); t.after(() => { if (db.open) db.close(); });
  migrate(db, loadMigrations().slice(0, 8));
  const a = await createAccount(db, config, { name: "Alice", email: "alice@example.test", password });
  const b = await createAccount(db, config, { name: "Bob", email: "bob@example.test", password });
  const catalog = new CatalogStore(db), [first] = await catalog.ingestSynthetic(detail()), [other] = await catalog.ingestSynthetic(otherAlbum(1));
  // Seed the historical schema directly; current services require the latest migration.
  const own = { id: randomUUID() }, theirs = { id: randomUUID() }, now = new Date().toISOString();
  db.prepare("INSERT INTO library_item(id,user_id,entity_id,note,favorite,version,created_at,updated_at) VALUES (?,?,?,'Existing private',1,2,?,?)").run(own.id,a.id,first!.albumId,now,now);
  db.prepare("INSERT INTO library_item(id,user_id,entity_id,title_override,created_at,updated_at) VALUES (?,?,?,'Bob title',?,?)").run(theirs.id,b.id,first!.albumId,now,now);
  db.prepare("INSERT INTO user_source_link VALUES (?,?,?,?)").run(a.id,own.id,other!.sourceEntityId,now);
  const linked = { id: own.id, version: 2 };
  const before = rows(db, "library_item"), links = rows(db, "user_source_link"); migrate(db); assertMigrated(db);
  assert.deepEqual(rows(db, "library_item"), before); assert.deepEqual(rows(db, "user_source_link"), links);
  const store = new CatalogLibraryStore(db), expectedOwn = store.get(a.id, own.id), expectedTheirs = store.get(b.id, theirs.id);
  assert.equal(store.get(a.id, own.id).version, linked.version); assert.equal(rows(db, "user_source_link_event").length, 0); // No fabricated old audit events.
  const backup = join(directory, "backup.sqlite"), restored = join(directory, "restored.sqlite"); await backupDatabase(db, backup); await restoreDatabase(backup, restored); db.close();
  for (const file of [path, restored]) {
    const reopened = openDatabase(file);
    try {
      assertMigrated(reopened); verifyDatabase(reopened); const copy = new CatalogLibraryStore(reopened);
      assert.deepEqual(copy.get(a.id, own.id), expectedOwn); assert.deepEqual(copy.get(b.id, theirs.id), expectedTheirs);
      assert.throws(() => copy.get(b.id, own.id), hasCode("not_found"));
      const detached = copy.disconnect(a.id, own.id, { version: linked.version, sourceEntityId: other!.sourceEntityId });
      assert.equal(detached.id, own.id); assert.equal(detached.note, "Existing private"); assert.deepEqual(detached.sourceLinks, []);
    } finally { reopened.close(); }
  }
});

test("catalog browse requires real sessions and reports only the current owner's saved markers", async (t) => {
  const { app, a, album, own, foreign, create } = await fixture(t);
  const saved = await create(album.id, own, { titleOverride: "비공개 제목", note: "비공개 메모" });
  const track = await create(album.tracks[0]!.id);
  for (const url of ["/api/catalog/albums", `/api/catalog/albums/${album.id}`, `/api/library/catalog/${saved.id}/source-candidates`]) {
    assert.equal((await app.inject({ url, headers: baseHeaders })).statusCode, 401);
    const session = (await app.inject({ url: "/api/auth/get-session", headers: own })).json().session.id;
    assert.equal((await app.inject({ url, headers: { ...foreign, "x-loopshelf-session": session } })).statusCode, 401);
    assert.equal((await app.inject({ url: `${url}?userId=forged`, headers: own })).statusCode, 400);
  }
  assert.equal((await app.inject({ url: `/api/library/catalog/${saved.id}/source-candidates`, headers: foreign })).statusCode, 404);
  const response = await app.inject({ url: `/api/catalog/albums/${album.id}`, headers: own });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-loopshelf-user"], a.id); assert.equal(response.json().album.savedItemId, saved.id);
  assert.equal(response.json().tracks[0].savedItemId, track.id); assert.equal(response.json().trackState, "unchanged");
  assert.equal(response.body.includes("비공개"), false);
  const theirs = (await app.inject({ url: `/api/catalog/albums/${album.id}`, headers: foreign })).json();
  assert.equal(theirs.album.savedItemId, null); assert.ok(theirs.tracks.every((row: { savedItemId: null }) => row.savedItemId === null));
  assert.equal((await app.inject({ url: `/api/catalog/albums/${track.entity.id}`, headers: own })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/catalog/albums/not-a-uuid", headers: own })).statusCode, 400);
});

test("catalog browse search is literal, normalized and paginated, with source summaries distinct from loaded details", async (t) => {
  const { catalog, app, own, album, create } = await fixture(t);
  const input = otherAlbum(2); input.data.title = 'ＡＢＣ 星の庭 100% "quoted"';
  const [added] = await catalog.ingestSynthetic(input);
  const summary = inspectCapturedPage({ sourceId: "khinsider", kind: "search", status: 200, sampleKind: "synthetic", capturedAt: "2026-10-18T14:00:00Z", url: "https://downloads.khinsider.com/search?search=sample", headers: { "content-type": "text/html" }, html: readFileSync(new URL("./fixtures/khinsider-search.html", import.meta.url), "utf8") });
  assert.ok(summary.ok); const kh = await catalog.ingestSynthetic(summary);
  const query = async (q: string) => (await app.inject({ url: `/api/catalog/albums?q=${encodeURIComponent(q)}`, headers: own })).json();
  for (const q of ["abc", "星の庭 100%", '100% "quoted"']) assert.equal((await query(q)).items[0].entity.id, added!.albumId);
  for (const q of ["' OR 1=1 --", "* OR title"]) assert.equal((await query(q)).items.length, 0);
  await create(album.id, own, { note: "private-search-only" }); assert.equal((await query("private-search-only")).items.length, 0);
  const first = (await app.inject({ url: "/api/catalog/albums?limit=2", headers: own })).json();
  const second = (await app.inject({ url: "/api/catalog/albums?limit=2&offset=2", headers: own })).json();
  const last = (await app.inject({ url: "/api/catalog/albums?limit=2&offset=4", headers: own })).json();
  assert.equal(first.nextOffset, 2); assert.equal(second.nextOffset, 4); assert.equal(last.nextOffset, null);
  const ids = [...first.items, ...second.items, ...last.items].map((row: CatalogEntry) => row.entity.id); assert.equal(new Set(ids).size, 5);
  assert.equal((await app.inject({ url: "/api/catalog/albums?sourceId=khinsider", headers: own })).json().items.length, 2);
  const detail = (await app.inject({ url: `/api/catalog/albums/${kh[0]!.albumId}`, headers: own })).json();
  assert.equal(detail.trackState, "not_loaded"); assert.deepEqual(detail.tracks, []); assert.equal(detail.nextOffset, null);
  for (const query of ["limit=101", "offset=-1", "sourceId=unknown", "q=" + "a".repeat(201)])
    assert.equal((await app.inject({ url: `/api/catalog/albums?${query}`, headers: own })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/catalog/albums/${album.id}?q=ignored`, headers: own })).statusCode, 400);
});

test("catalog detail shows adopted bindings and repeated labels while changed track lists await review", async (t) => {
  const { app, catalog, album, own } = await fixture(t);
  const get = async (query = "") => (await app.inject({ url: `/api/catalog/albums/${album.id}${query}`, headers: own })).json();
  const before = await get(); assert.equal(before.tracks[1].displayNumber, before.tracks[2].displayNumber);
  const input = detail(); input.provenance.capturedAt = "2026-10-18T14:02:00Z";
  input.data.tracks = [input.data.tracks[2]!, input.data.tracks[0]!, input.data.tracks[3]!]; input.data.tracks.forEach((row, i) => row.position = i + 1);
  const [pending] = await catalog.ingestSynthetic(input);
  const held = await get(); assert.equal(held.trackState, "review_required"); assert.deepEqual(held.tracks, before.tracks);
  await catalog.adoptTrackList({ requestId: randomUUID(), albumId: album.id, expectedTracksObservationId: album.tracksObservationId,
    observationId: pending!.observationId, assignments: [album.tracks[2]!.id, album.tracks[0]!.id, album.tracks[3]!.id].map((trackId, i) => ({ position: i + 1, trackId })), missingTrackIds: [album.tracks[1]!.id] });
  const one = await get("?limit=2"), two = await get("?limit=2&offset=2");
  assert.equal(one.trackState, "unchanged"); assert.equal(one.nextOffset, 2); assert.equal(two.nextOffset, null);
  assert.deepEqual([...one.tracks, ...two.tracks].map((row: CatalogEntry) => [row.entity.id, row.entity.position]), [[album.tracks[2]!.id, 1], [album.tracks[0]!.id, 2], [album.tracks[3]!.id, 3]]);
});

test("removed or blocked catalog metadata cannot reappear in browse, details or candidates", async (t) => {
  const { app, db, catalog, album, other, own, create } = await fixture(t), root = await create(album.id);
  const candidates = `/api/library/catalog/${root.id}/source-candidates`;
  assert.equal((await app.inject({ url: candidates, headers: own })).json().items.length, 1);
  db.prepare("UPDATE source_entity SET availability='blocked' WHERE id=?").run(other.sourceEntityId);
  assert.equal((await app.inject({ url: candidates, headers: own })).json().items.length, 0);
  assert.equal((await app.inject({ url: `/api/catalog/albums/${other.albumId}`, headers: own })).statusCode, 404);
  await catalog.removeSource({ sourceEntityId: other.sourceEntityId, reason: "policy_change" });
  const all = await app.inject({ url: "/api/catalog/albums", headers: own }); assert.equal(all.json().items.length, 1); assert.equal(all.body.includes("별도 앨범"), false);
  assert.equal((await app.inject({ url: candidates, headers: own })).json().items.length, 0);
  await catalog.removeSource({ sourceEntityId: album.sourceEntityId, reason: "policy_change" });
  assert.equal((await app.inject({ url: `/api/catalog/albums/${album.id}`, headers: own })).statusCode, 404);
  assert.equal((await app.inject({ url: candidates, headers: own })).statusCode, 409);
  assert.equal((await app.inject({ url: "/api/catalog/albums", headers: own })).json().items.length, 0);
  assert.equal((await app.inject({ url: `/api/library/catalog/${root.id}`, headers: own })).statusCode, 200);
});

test("source candidates exclude own occupied sources, preserve independent saves, and recheck stale selections", async (t) => {
  const { app, catalog, album, other, own, foreign, create } = await fixture(t);
  const root = await create(album.id), savedOther = await create(other.albumId), theirs = await create(album.id, foreign);
  const candidates = `/api/library/catalog/${root.id}/source-candidates`, sources = `/api/library/catalog/${root.id}/sources`;
  const list = async () => (await app.inject({ url: candidates, headers: own })).json();
  let found = await list(); assert.equal(found.items[0].savedItemId, savedOther.id); assert.equal(found.version, root.version); assert.equal(found.target.id, root.id);
  await app.inject({ method: "POST", url: `/api/library/catalog/${theirs.id}/sources`, headers: foreign, payload: { version: theirs.version, sourceEntityId: other.sourceEntityId } });
  assert.equal((await list()).items.length, 1);
  await app.inject({ method: "PATCH", url: `/api/library/catalog/${root.id}`, headers: own, payload: { version: root.version, note: "Changed after discovery" } });
  assert.equal((await app.inject({ method: "POST", url: sources, headers: own, payload: { version: found.version, sourceEntityId: other.sourceEntityId } })).statusCode, 409);
  found = await list(); assert.equal(found.target.note, "Changed after discovery");
  const connected = await app.inject({ method: "POST", url: sources, headers: own, payload: { version: found.version, sourceEntityId: other.sourceEntityId } }); assert.equal(connected.statusCode, 200);
  assert.equal((await list()).items.length, 0); assert.equal((await list()).remainingSlots, 19);
  const [third] = await catalog.ingestSynthetic(otherAlbum(3)), thirdSaved = await create(third!.albumId);
  const thirdCandidates = (await app.inject({ url: `/api/library/catalog/${thirdSaved.id}/source-candidates`, headers: own })).json();
  assert.ok(thirdCandidates.items.every((row: { entity: { id: string } }) => row.entity.id !== other.albumId));
  assert.deepEqual((await app.inject({ url: `/api/library/catalog/${savedOther.id}`, headers: own })).json(), savedOther);
  found = await list(); await catalog.removeSource({ sourceEntityId: third!.sourceEntityId, reason: "policy_change" });
  assert.equal((await app.inject({ method: "POST", url: sources, headers: own, payload: { version: found.version, sourceEntityId: third!.sourceEntityId } })).statusCode, 409);
  const track = await create(album.tracks[0]!.id);
  assert.equal((await app.inject({ url: `/api/library/catalog/${track.id}/source-candidates`, headers: own })).statusCode, 400);
});
