import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { withDatabase } from "../src/database/access.ts";
import { CatalogStore } from "../src/catalog/store.ts";
import { CatalogLibraryStore } from "../src/library/catalog.ts";
import { CatalogBrowseStore } from "../src/catalog/browse.ts";
import { CatalogTransfer } from "../src/library/catalog-transfer.ts";
import { catalogArchiveV2, parseCatalogArchive } from "../src/library/catalog-archive.ts";
import { TransferError } from "../src/library/transfer.ts";
import { CatalogError } from "../src/catalog/input.ts";
import { createAccount } from "../src/auth/accounts.ts";
import { buildApp } from "../src/server/app.ts";
import type { CatalogArchiveV1, CatalogArchiveV2 } from "../src/shared/catalog-transfer.ts";
import { syntheticAlbum } from "../scripts/benchmarks/catalog-fixture.ts";
import { simulateLiveCatalog } from "./helpers/catalog-live.ts";

const config = { baseURL: "http://127.0.0.1:3000", secret: "catalog-kinds-only-test-secret-at-least-32-characters" };
const code = (value: TransferError["code"]) => (e: unknown) => e instanceof TransferError && e.code === value;
function fixture(t: TestContext, legacySchema = false) {
  const db = openDatabase(":memory:"); migrate(db, legacySchema ? loadMigrations().slice(0, 12) : loadMigrations()); t.after(() => db.close());
  const a = randomUUID(), b = randomUUID();
  for (const id of [a,b]) db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,\'Test\',?,0,\'now\',\'now\')').run(id, `${id}@example.test`);
  return { db, a, b, store: new CatalogStore(db), library: new CatalogLibraryStore(db), transfer: new CatalogTransfer(db, config.secret) };
}
function detached(kind: "synthetic" | "live-capture" = "live-capture"): CatalogArchiveV2 {
  const entityId = randomUUID(), sourceId = randomUUID(), now = new Date().toISOString();
  return { format: "loopshelf-catalog", schemaVersion: 2, exportedAt: now, items: [{ id: randomUUID(), reference: {
    entityId, kind: "album", albumId: entityId, source: { id: sourceId, sourceId: "zophar", externalKey: "nintendo-snes-spc/benchmark-00003", pageUrl: "https://www.zophar.net/music/nintendo-snes-spc/benchmark-00003.html" }, sampleKind: kind,
  }, titleOverride: null, note: "내 보관 기록", favorite: true, createdAt: now, updatedAt: now, sourceLinks: [] }] };
}
function legacy(file: CatalogArchiveV2): CatalogArchiveV1 {
  return { format: file.format, schemaVersion: 1, sampleKind: "synthetic", exportedAt: file.exportedAt, items: file.items.map((item) => {
    const { sampleKind: _kind, ...reference } = item.reference;
    return { ...item, reference, sourceLinks: item.sourceLinks.map((link) => { const { sampleKind: _kind, ...reference } = link.reference; return { ...link, reference }; }) };
  }) };
}
const restore = (f: ReturnType<typeof fixture>, archive: unknown) => f.transfer.import(f.a, archive, f.transfer.preview(f.a, archive).token!);

test("v2 exports mixed source kinds per reference with private data only; unknown live policy redacts album and track copies", async (t) => {
  const f = fixture(t), live = simulateLiveCatalog(f.db, f.a), [syn] = await f.store.ingestSynthetic(syntheticAlbum(1, 2));
  f.library.create(f.a, { entityId: syn!.albumId });
  const items = f.library.list(f.a).items, archive = f.transfer.export(f.a);
  assert.equal(items.length, 4); assert.equal(archive.schemaVersion, 2); assert.equal("sampleKind" in archive, false);
  assert.equal(archive.items.filter((item) => item.reference.sampleKind === "live-capture").length, 3);
  const track = items.find((item) => item.entity.id === live.trackIds[0])!;
  assert.equal(track.entity.sampleKind, "live-capture"); assert.equal(track.entity.presence, "expired"); assert.equal(track.entity.durationMs, null);
  assert.equal(track.note, "개인 메모"); assert.equal(track.entity.sourceEntityId, live.sourceId);
  for (const field of [live.title, "durationMs", "expiresAt", "policyRevision", "schema-simulation", "userId"]) assert.ok(!JSON.stringify(archive).includes(field));
  assert.deepEqual(parseCatalogArchive(archive), archive); assert.equal(new CatalogBrowseStore(f.db).list(f.a, {}).items.length, 1);
  await assert.rejects(f.store.getObservation(live.observationId), (e) => e instanceof CatalogError && e.code === "content_expired");
  assert.equal(f.library.list(f.b).items.length, 0); assert.throws(() => f.library.get(f.b, live.itemIds[0]!)); verifyDatabase(f.db);
});

test("live unresolved v2 references preserve IDs, kind and private fields without URL matching or shared writes", async (t) => {
  const f = fixture(t), [existing] = await f.store.ingestSynthetic(syntheticAlbum(3, 2)), file = detached();
  const before = f.db.prepare("SELECT count(*) AS n FROM entity").get();
  assert.equal(restore(f, file).unresolved, 1);
  const item = f.library.get(f.a, file.items[0]!.id);
  assert.equal(item.entity.sampleKind, "live-capture"); assert.equal(item.entity.contentState, "unresolved");
  assert.notEqual(item.entity.id, existing!.albumId); assert.equal(item.note, file.items[0]!.note);
  assert.deepEqual(f.transfer.export(f.a).items, file.items); assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM entity").get(), before);
  assert.equal(restore(f, file).skipped, 1);
  const edited = f.library.update(f.a, item.id, { version: item.version, note: "다시 편집" });
  assert.equal(edited.entity.sampleKind, "live-capture"); f.library.delete(f.a, item.id, { version: edited.version });
  assert.equal(restore(f, file).added, 1); assert.ok(f.library.get(f.a, item.id).version > edited.version);
});

test("v1 files and old immutable detached rows remain synthetic; v2 export preserves their contents and identity", (t) => {
  const f = fixture(t, true), file = legacy(detached("synthetic")), item = file.items[0]!;
  // Exact old row format, with no new kind field and no migration of private content/version.
  f.db.prepare(`INSERT INTO catalog_detached_item(id,user_id,entity_id,kind,reference_json,title_override,note,favorite,version,created_at,updated_at)
    VALUES (?,?,?,'album',?,NULL,?,1,17,?,?)`).run(item.id, f.a, item.reference.entityId, JSON.stringify(item.reference), item.note, item.createdAt, item.updatedAt);
  const before = f.db.prepare("SELECT * FROM catalog_detached_item").all();
  migrate(f.db); // 0013 keeps the old JSON and version intact, while fencing older readers.
  assert.equal(f.library.get(f.a, item.id).entity.sampleKind, "synthetic");
  assert.deepEqual(f.transfer.export(f.a).items, catalogArchiveV2(file).items);
  assert.equal(restore(f, file).skipped, 1); assert.deepEqual(f.db.prepare("SELECT * FROM catalog_detached_item").all(), before);
  const other = fixture(t); assert.equal(restore(other, file).added, 1); assert.deepEqual(other.transfer.export(other.a).items, catalogArchiveV2(file).items);
});

test("v2 requires every reference kind and cannot smuggle metadata, permission, inconsistent kinds or changed versions", (t) => {
  const f = fixture(t), file = detached();
  const mutations: ((value: any) => void)[] = [
    (v) => { delete v.items[0].reference.sampleKind; }, (v) => { v.items[0].reference.sampleKind = "real"; },
    (v) => { v.items[0].reference.policyRevision = "allowed"; }, (v) => { v.items[0].expiresAt = "2099"; },
    (v) => { v.sampleKind = "live-capture"; }, (v) => { v.schemaVersion = 3; },
    (v) => { const link = detached("synthetic").items[0]!.reference; v.items[0].sourceLinks.push({ reference: link, assertedAt: v.exportedAt }); },
  ];
  for (const mutate of mutations) { const invalid = structuredClone(file); mutate(invalid); assert.throws(() => f.transfer.preview(f.a, invalid), code("invalid_archive")); }
  const old: any = legacy(file); old.sampleKind = "live-capture"; assert.throws(() => parseCatalogArchive(old), code("invalid_archive"));
  old.sampleKind = "synthetic"; old.items[0].reference.sampleKind = "live-capture"; assert.throws(() => parseCatalogArchive(old), code("invalid_archive"));
  assert.equal(f.library.list(f.a).items.length, 0);
});

test("preview tokens bind the source file version and reference kinds, not only normalized private contents", (t) => {
  const f = fixture(t), old = legacy(detached("synthetic")), current = catalogArchiveV2(old), token = f.transfer.preview(f.a, old).token!;
  assert.throws(() => f.transfer.import(f.a, current, token), code("preview_stale"));
  const next = f.transfer.preview(f.a, current).token!; current.items[0]!.reference.sampleKind = "live-capture";
  assert.throws(() => f.transfer.import(f.a, current, next), code("preview_stale")); assert.equal(f.library.list(f.a).items.length, 0);
  f.transfer.import(f.a, old, token); assert.equal(f.library.get(f.a, old.items[0]!.id).entity.sampleKind, "synthetic");
});

test("existing source identity kind conflicts are rejected even if the referenced track is absent", async (t) => {
  const f = fixture(t), [seed] = await f.store.ingestSynthetic(syntheticAlbum(3, 2)), saved = f.library.create(f.a, { entityId: seed!.albumId }).item;
  const archive = f.transfer.export(f.a); f.library.delete(f.a, saved.id, { version: saved.version });
  archive.items[0]!.reference.sampleKind = "live-capture";
  assert.equal(f.transfer.preview(f.a, archive).conflicts[0]!.reason, "id_conflict");
  archive.items[0]!.reference.kind = "track"; archive.items[0]!.reference.entityId = randomUUID();
  assert.equal(f.transfer.preview(f.a, archive).conflicts[0]!.reason, "id_conflict");
  archive.items[0]!.reference.sampleKind = "synthetic"; assert.equal(restore(f, archive).unresolved, 1);
});

test("resolved live personal rows restore after removal without reviving source metadata or changing sample kind", async (t) => {
  const f = fixture(t), live = simulateLiveCatalog(f.db, f.a), archive = f.transfer.export(f.a);
  for (const item of f.library.list(f.a).items) f.library.delete(f.a, item.id, { version: item.version });
  await f.store.removeSource({ sourceEntityId: live.sourceId, reason: "rights_request" });
  assert.equal(restore(f, archive).unresolved, 0);
  assert.equal((await f.store.getAlbum(live.albumId)).sampleKind, "live-capture");
  for (const item of f.library.list(f.a).items) { assert.equal(item.entity.sampleKind, "live-capture"); assert.equal(item.entity.contentState, "removed"); assert.equal(item.note, "개인 메모"); }
  assert.equal(f.db.prepare("SELECT 1 FROM catalog_observation").get(), undefined);
  assert.deepEqual(f.transfer.export(f.a).items, archive.items); verifyDatabase(f.db);
});

test("mixed v2 restore is atomic, including detached links and revision allocation", (t) => {
  const f = fixture(t), file = detached(), synthetic = detached("synthetic"); file.items.push(...synthetic.items);
  const link = detached().items[0]!.reference; file.items[0]!.sourceLinks.push({ reference: link, assertedAt: file.exportedAt });
  const before = f.db.prepare("SELECT * FROM library_revision").all();
  f.db.exec("CREATE TRIGGER fail_kind_link BEFORE INSERT ON catalog_detached_link BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
  assert.throws(() => restore(f, file), /simulated failure/);
  assert.equal(f.library.list(f.a).items.length, 0); assert.deepEqual(f.db.prepare("SELECT * FROM library_revision").all(), before);
  f.db.exec("DROP TRIGGER fail_kind_link"); assert.equal(restore(f, file).added, 2);
});

test("backup/reopen preserves v1 and v2 private reference kinds and redacts previously active live simulations", async (t) => {
  const f = fixture(t), live = simulateLiveCatalog(f.db, f.a); restore(f, detached()); restore(f, legacy(detached("synthetic")));
  const dir = mkdtempSync(join(tmpdir(), "loopshelf-kinds-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backup = join(dir, "backup.sqlite"), copyPath = join(dir, "restored.sqlite");
  await backupDatabase(f.db, backup); await restoreDatabase(backup, copyPath);
  const copy = openDatabase(copyPath);
  try { const archive = new CatalogTransfer(copy, config.secret).export(f.a); assert.deepEqual(archive.items, f.transfer.export(f.a).items);
    assert.equal(new CatalogLibraryStore(copy).get(f.a, live.itemIds[1]!).entity.sampleKind, "live-capture"); verifyDatabase(copy);
  } finally { copy.close(); }
});

test("retained writer denies live permission injection before allocation and validates capture-based deadlines", async (t) => {
  const f = fixture(t), data = syntheticAlbum(1, 2), now = Date.now(); data.provenance.capturedAt = new Date(now - 1000).toISOString(); data.provenance.parsedAt = data.provenance.capturedAt;
  const lease = { policyRevision: "offline-test", expiresAt: new Date(now + 100000).toISOString() };
  const write = (value: unknown, grant: unknown) => withDatabase(f.db, async () => f.db.transaction(() => f.store.ingestRetainedAlbumInTransaction(value, grant)).immediate());
  const live = structuredClone(data); live.provenance.sampleKind = "live-capture";
  await assert.rejects(write(live, lease), (e) => e instanceof CatalogError && e.code === "policy_disabled");
  await assert.rejects(write(live, { ...lease, allowed: true }), (e) => e instanceof CatalogError && e.code === "invalid_input");
  await assert.rejects(write(data, { ...lease, expiresAt: new Date(now - 1).toISOString() }), (e) => e instanceof CatalogError && e.code === "content_expired");
  assert.equal(f.db.prepare("SELECT 1 FROM entity").get(), undefined);
  await assert.rejects(write(data, { ...lease, policyRevision: " padded " }), (e) => e instanceof CatalogError && e.code === "invalid_input");
  const [saved] = await write(data, lease); const before = f.db.prepare("SELECT * FROM catalog_observation").all();
  await assert.rejects(write(data, { ...lease, expiresAt: new Date(now + 110000).toISOString() }), (e) => e instanceof CatalogError && e.code === "retention_conflict");
  assert.deepEqual(f.db.prepare("SELECT * FROM catalog_observation").all(), before); assert.equal((await write(data, lease))[0]!.observationId, saved!.observationId);
});

test("real authenticated API exports v2 and preserves live reference identity without exposing revoked metadata", async (t) => {
  const f = fixture(t), password = "catalog-kind-password-123", user = await createAccount(f.db, config, { name: "Kinds", email: "kinds@example.test", password });
  const live = simulateLiveCatalog(f.db, user.id), app = await buildApp(f.db, config); t.after(() => app.close());
  const login = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin: config.baseURL, host: "127.0.0.1:3000" }, payload: { email: user.email, password } });
  assert.equal(login.statusCode, 200); const cookie = login.cookies.map((row) => `${row.name}=${row.value}`).join("; ");
  const headers = { cookie, host: "127.0.0.1:3000" };
  const response = await app.inject({ url: "/api/library/catalog/export", headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  const file = response.json() as CatalogArchiveV2; assert.equal(file.schemaVersion, 2); assert.ok(file.items.every((item) => item.reference.sampleKind === "live-capture"));
  assert.ok(!response.body.includes(live.title));
  const item = await app.inject({ url: `/api/library/catalog/${live.itemIds[0]}`, headers }); assert.equal(item.statusCode, 200);
  assert.equal(item.json().entity.contentState, "expired"); assert.equal(item.json().entity.sampleKind, "live-capture");
  const denied = await app.inject({ url: "/api/library/catalog/export", headers: { host: "127.0.0.1:3000" } }); assert.equal(denied.statusCode, 401);
});

test("0013 preserves legacy references on upgrade and rollback while enforcing explicit same-kind new links", (t) => {
  const f = fixture(t, true), file = legacy(detached("synthetic")), item = file.items[0]!;
  const insert = f.db.prepare(`INSERT INTO catalog_detached_item(id,user_id,entity_id,kind,reference_json,title_override,note,favorite,version,created_at,updated_at)
    VALUES (?,?,?,'album',?,NULL,'old',0,4,?,?)`);
  insert.run(item.id, f.a, item.reference.entityId, JSON.stringify(item.reference), item.createdAt, item.updatedAt);
  const before = f.db.prepare("SELECT * FROM catalog_detached_item").all(), migrations = loadMigrations(), last = migrations.at(-1)!;
  assert.throws(() => migrate(f.db, [...migrations.slice(0, -1), { ...last, sql: `${last.sql}\nSELECT missing_migration_function();` }]));
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='detached_reference_kind_insert'").get(), undefined);
  assert.deepEqual(f.db.prepare("SELECT * FROM catalog_detached_item").all(), before);
  migrate(f.db); assert.deepEqual(f.db.prepare("SELECT * FROM catalog_detached_item").all(), before);
  const missingId = randomUUID();
  for (const sampleKind of [undefined, null, 42, "unknown"]) {
    const invalid = { ...item.reference, entityId: missingId, albumId: missingId, sampleKind };
    assert.throws(() => insert.run(randomUUID(), f.a, missingId, JSON.stringify(invalid), item.createdAt, item.updatedAt), /explicit sample kind/);
  }
  assert.throws(() => f.db.prepare("UPDATE catalog_detached_item SET reference_json=? WHERE id=?").run(JSON.stringify({ ...item.reference, sampleKind: "live-capture" }), item.id), /immutable/);
  const live = detached(); restore(f, live); const root = live.items[0]!, ref = detached("synthetic").items[0]!.reference;
  assert.throws(() => f.db.prepare("INSERT INTO catalog_detached_link VALUES (?,?,?,?,?)").run(root.id, f.a, ref.source.id, JSON.stringify(ref), file.exportedAt), /same explicit sample kind/);
  assert.throws(() => migrate(f.db, migrations.slice(0, -1)), /Migration history mismatch/); verifyDatabase(f.db);
});

test("an actual previous-schema startup check refuses the upgraded DB rather than relabeling v2 live references", async (t) => {
  const f = fixture(t); restore(f, detached());
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-old-reader-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const migrationDir = join(directory, "migrations"), moduleDir = join(directory, "src", "database");
  mkdirSync(migrationDir); mkdirSync(moduleDir, { recursive: true });
  // Use the real startup checker with exactly the old migration catalog.
  for (const migration of loadMigrations().slice(0, 12)) writeFileSync(join(migrationDir, migration.name), migration.sql);
  const oldModule = join(moduleDir, "migrate.ts"); writeFileSync(oldModule, readFileSync(new URL("../src/database/migrate.ts", import.meta.url)));
  const file = join(directory, "database.sqlite"); await backupDatabase(f.db, file);
  const source = `import { assertMigrated } from ${JSON.stringify(pathToFileURL(oldModule).href)};\nimport { openDatabase } from ${JSON.stringify(new URL("../src/database/connection.ts", import.meta.url).href)};\nconst db=openDatabase(${JSON.stringify(file)});try { assertMigrated(db); } finally { db.close(); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Database migration mismatch/);
});
