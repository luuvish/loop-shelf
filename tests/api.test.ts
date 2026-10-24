import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { getMigrations } from "better-auth/db/migration";
import { openDatabase } from "../src/database/connection.ts";
import { migrate } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase } from "../src/database/backup.ts";
import { authOptions } from "../src/auth/options.ts";
import { createAccount, resetAccountPassword } from "../src/auth/accounts.ts";
import { buildApp } from "../src/server/app.ts";
import type { Bookmark } from "../src/library/bookmarks.ts";
import { ARCHIVE_MAX_BYTES, type BookmarkArchive } from "../src/shared/transfer.ts";

const config = { baseURL: "http://127.0.0.1:3000", secret: "test-only-auth-secret-at-least-32-characters-long" };
const headers = { host: "127.0.0.1:3000", origin: config.baseURL };
const password = "test-only-password-123";
const bookmark = { title: "My soundtrack", url: "https://downloads.khinsider.com/game-soundtracks/album/example", note: "Private" };

async function fixture(t: TestContext, origin = config.baseURL) {
  const db = openDatabase(":memory:"); migrate(db);
  const settings = { ...config, baseURL: origin };
  const a = await createAccount(db, settings, { name: "Alice", email: "alice@example.test", password });
  const b = await createAccount(db, settings, { name: "Bob", email: "bob@example.test", password });
  const app = await buildApp(db, settings);
  t.after(async () => { await app.close(); db.close(); });
  async function login(email = "alice@example.test") {
    const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email",
      headers: { host: new URL(origin).host, origin }, payload: { email, password } });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = response.cookies.map((value) => `${value.name}=${value.value}`).join("; ");
    assert.ok(cookie);
    return { cookie, response };
  }
  return { db, app, a, b, login };
}

test("generated auth migration matches pinned library options", async (t) => {
  const { db } = await fixture(t);
  const plan = await getMigrations(authOptions(db, config));
  assert.deepEqual(plan.toBeCreated, []); assert.deepEqual(plan.toBeAdded, []);
  assert.deepEqual(plan.toBeAddedIndexes, []); assert.deepEqual(plan.schemaProblems, []);
});

test("export and import use real sessions, same-origin and no-store; archives contain only the owner's originals", async (t) => {
  const { app, login, b } = await fixture(t);
  const alice = await login(), bob = await login("bob@example.test");
  const own = { ...headers, cookie: alice.cookie }, other = { ...headers, cookie: bob.cookie };
  await app.inject({ method: "POST", url: "/api/bookmarks", headers: own, payload: bookmark });
  const exported = await app.inject({ url: "/api/library/export", headers: own });
  assert.equal(exported.statusCode, 200); assert.equal(exported.headers["cache-control"], "no-store");
  assert.match(String(exported.headers["content-disposition"]), /^attachment; filename="loopshelf-\d{4}-\d{2}-\d{2}\.json"$/);
  const archive = exported.json() as BookmarkArchive;
  assert.equal(archive.bookmarks.length, 1);
  assert.deepEqual((await app.inject({ url: "/api/library/export", headers: other })).json().bookmarks, []);
  assert.equal((await app.inject({ url: "/api/library/export", headers })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/library/export?userId=${b.id}`, headers: own })).statusCode, 400);
  const checked = await app.inject({ method: "POST", url: "/api/library/import/preview", headers: own, payload: { archive } });
  assert.equal(checked.statusCode, 200); assert.equal(checked.json().skipCount, 1); assert.ok(checked.json().token);
  const session = (await app.inject({ url: "/api/auth/get-session", headers: own })).json();
  for (const path of ["/api/library/import/preview", "/api/library/import"]) {
    const payload = path.endsWith("preview") ? { archive } : { archive, token: checked.json().token };
    assert.equal((await app.inject({ method: "POST", url: path, headers, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: path, headers: { ...own, origin: "https://evil.example" }, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: path, headers: own, payload: { ...payload, userId: b.id } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: path, headers: { ...other, "x-loopshelf-session": session.session.id }, payload })).statusCode, 401);
  }
  const foreign = await app.inject({ method: "POST", url: "/api/library/import/preview", headers: other, payload: { archive } });
  assert.equal(foreign.json().conflictCount, 1); assert.equal(foreign.json().token, null);
  assert.equal((await app.inject({ method: "POST", url: "/api/library/import", headers: other, payload: { archive, token: checked.json().token } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/library/import", headers: own, payload: { archive, token: checked.json().token } })).json().skipped, 1);
});

test("concurrent restores have one winner and recheck global ID collisions without changing another account", async (t) => {
  const { app, login } = await fixture(t);
  const alice = await login(), bob = await login("bob@example.test");
  const own = { ...headers, cookie: alice.cookie }, other = { ...headers, cookie: bob.cookie };
  const item = (await app.inject({ method: "POST", url: "/api/bookmarks", headers: own, payload: bookmark })).json().item;
  const archive = (await app.inject({ url: "/api/library/export", headers: own })).json();
  assert.equal((await app.inject({ method: "DELETE", url: `/api/bookmarks/${item.id}`, headers: own, payload: { version: item.version } })).statusCode, 204);
  const preview = async (requestHeaders: typeof own) => (await app.inject({ method: "POST", url: "/api/library/import/preview", headers: requestHeaders, payload: { archive } })).json();
  const checked = await preview(own), otherChecked = await preview(other);
  assert.equal(otherChecked.addCount, 1);
  const results = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/library/import", headers: own, payload: { archive, token: checked.token } })));
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
  const foreign = await app.inject({ method: "POST", url: "/api/library/import", headers: other, payload: { archive, token: otherChecked.token } });
  assert.equal(foreign.statusCode, 409); assert.equal(foreign.json().code, "import_conflict");
  assert.deepEqual((await app.inject({ url: "/api/library/export", headers: own })).json().bookmarks, archive.bookmarks);
  assert.deepEqual((await app.inject({ url: "/api/library/export", headers: other })).json().bookmarks, []);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/bookmarks/${item.id}`, headers: own, payload: { version: item.version, note: "old editor" } })).statusCode, 409);
});

test("archive endpoints reject malformed files and enforce byte limits without raising the CRUD body limit", async (t) => {
  const { app, login } = await fixture(t);
  const { cookie } = await login(); const own = { ...headers, cookie };
  for (const archive of [null, { format: "loopshelf-bookmarks", schemaVersion: 99 }, { url: "https://evil.example/file.json" }]) {
    const result = await app.inject({ method: "POST", url: "/api/library/import/preview", headers: own, payload: { archive } });
    assert.equal(result.statusCode, 400); assert.equal(result.json().code, "invalid_archive");
  }
  const malformed = await app.inject({ method: "POST", url: "/api/library/import/preview", headers: { ...own, "content-type": "application/json" }, payload: '{"archive":' });
  assert.equal(malformed.statusCode, 400);
  const oversized = await app.inject({ method: "POST", url: "/api/library/import/preview", headers: own, payload: { archive: "x".repeat(ARCHIVE_MAX_BYTES + 5000) } });
  assert.equal(oversized.statusCode, 413); assert.equal(oversized.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ method: "POST", url: "/api/bookmarks", headers: own, payload: { ...bookmark, note: "x".repeat(40000) } })).statusCode, 413);
});

test("real sessions own both sides of a connection and its reversible changes", async (t) => {
  const { app, login } = await fixture(t);
  const alice = await login(), bob = await login("bob@example.test");
  const ownHeaders = { ...headers, cookie: alice.cookie }, otherHeaders = { ...headers, cookie: bob.cookie };
  const create = async (url: string, requestHeaders = ownHeaders) => (await app.inject({ method: "POST", url: "/api/bookmarks", headers: requestHeaders, payload: { ...bookmark, url } })).json().item as Bookmark;
  const root = await create(bookmark.url), member = await create("https://www.zophar.net/music/snes/member.html"), alien = await create("https://www.zophar.net/music/snes/member.html", otherHeaders);
  const path = `/api/bookmarks/${root.id}/connections`;
  const input = { version: root.version, memberId: member.id, memberVersion: member.version };
  assert.equal((await app.inject({ method: "POST", url: path, headers: ownHeaders, payload: { ...input, memberId: alien.id } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: path, headers: otherHeaders, payload: input })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: path, headers: { ...ownHeaders, origin: "https://evil.example" }, payload: input })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: path, headers: ownHeaders, payload: { ...input, userId: "forged" } })).statusCode, 400);
  const connected = await app.inject({ method: "POST", url: path, headers: ownHeaders, payload: input });
  assert.equal(connected.statusCode, 200); const group = connected.json();
  const linkedInput = { version: group.root.version, memberId: member.id, memberVersion: group.members[0].version };
  assert.equal((await app.inject({ url: path, headers: otherHeaders })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: path, headers: otherHeaders, payload: linkedInput })).statusCode, 404);
  assert.equal((await app.inject({ url: path, headers })).statusCode, 401);
  const view = await app.inject({ url: path, headers: ownHeaders });
  assert.equal(view.headers["cache-control"], "no-store"); assert.equal(view.json().members[0].id, member.id);
  assert.equal((await app.inject({ url: "/api/bookmarks", headers: ownHeaders })).json().items.length, 1);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/bookmarks/${root.id}`, headers: ownHeaders, payload: { version: group.root.version } })).statusCode, 409);
  const disconnected = await app.inject({ method: "DELETE", url: path, headers: ownHeaders, payload: linkedInput });
  assert.equal(disconnected.statusCode, 200); assert.equal(disconnected.json().detached.id, member.id);
  assert.equal((await app.inject({ url: "/api/bookmarks", headers: ownHeaders })).json().items.length, 2);
  assert.equal((await app.inject({ url: "/api/bookmarks", headers: otherHeaders })).json().items[0].id, alien.id);
});

test("concurrent connection requests with the same version have one winner", async (t) => {
  const { app, login } = await fixture(t);
  const { cookie } = await login(); const requestHeaders = { ...headers, cookie };
  const items: Bookmark[] = [];
  for (const slug of ["root", "one", "two"]) items.push((await app.inject({ method: "POST", url: "/api/bookmarks", headers: requestHeaders,
    payload: { ...bookmark, url: `https://www.zophar.net/music/snes/${slug}.html` } })).json().item);
  const root = items[0]!;
  const results = await Promise.all(items.slice(1).map((member) => app.inject({ method: "POST", url: `/api/bookmarks/${root.id}/connections`, headers: requestHeaders,
    payload: { version: root.version, memberId: member.id, memberVersion: member.version } })));
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
  const group = (await app.inject({ url: `/api/bookmarks/${root.id}/connections`, headers: requestHeaders })).json();
  assert.equal(group.members.length, 1); assert.equal(group.root.version, root.version + 1);
});

test("a stale UI session cannot save its draft under a different logged-in account", async (t) => {
  const { app, login } = await fixture(t);
  const alice = await login(), bob = await login("bob@example.test");
  const session = (await app.inject({ url: "/api/auth/get-session", headers: { ...headers, cookie: alice.cookie } })).json();
  const stale = await app.inject({ method: "POST", url: "/api/bookmarks",
    headers: { ...headers, cookie: bob.cookie, "x-loopshelf-session": session.session.id }, payload: bookmark });
  assert.equal(stale.statusCode, 401); assert.equal(stale.json().code, "session_changed");
  const bobList = await app.inject({ url: "/api/bookmarks", headers: { ...headers, cookie: bob.cookie } });
  assert.deepEqual(bobList.json().items, []);
  const noCookie = await app.inject({ method: "POST", url: "/api/bookmarks",
    headers: { ...headers, "x-loopshelf-session": session.session.id }, payload: bookmark });
  assert.equal(noCookie.statusCode, 401);
  const correct = await app.inject({ method: "POST", url: "/api/bookmarks",
    headers: { ...headers, cookie: alice.cookie, "x-loopshelf-session": session.session.id }, payload: bookmark });
  assert.equal(correct.statusCode, 201);
});

test("authenticated bookmark lifecycle uses server session and rejects other users", async (t) => {
  const { app, a, b, login } = await fixture(t);
  const alice = await login(), bob = await login("bob@example.test");
  const created = await app.inject({ method: "POST", url: "/api/bookmarks", headers: { ...headers, cookie: alice.cookie }, payload: bookmark });
  assert.equal(created.statusCode, 201, created.body);
  const item = created.json().item as Bookmark;
  assert.equal(item.provenance, "user-entered");
  const me = await app.inject({ url: "/api/me", headers: { ...headers, cookie: alice.cookie } });
  assert.equal(me.json().userId, a.id);
  assert.notEqual(a.id, b.id);
  for (const [method, payload] of [["GET", undefined], ["PATCH", { version: 1, note: "stolen" }], ["DELETE", { version: 1 }]] as const) {
    const response = await app.inject({ method, url: `/api/bookmarks/${item.id}`, headers: { ...headers, cookie: bob.cookie }, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 404, response.body);
  }
  const otherSearch = await app.inject({ url: "/api/bookmarks?q=Private", headers: { ...headers, cookie: bob.cookie } });
  assert.deepEqual(otherSearch.json().items, []);
  const edit = await app.inject({ method: "PATCH", url: `/api/bookmarks/${item.id}`, headers: { ...headers, cookie: alice.cookie }, payload: { version: 1, favorite: true, note: "Updated" } });
  assert.equal(edit.statusCode, 200); assert.equal(edit.json().version, 2);
  const stale = await app.inject({ method: "DELETE", url: `/api/bookmarks/${item.id}`, headers: { ...headers, cookie: alice.cookie }, payload: { version: 1 } });
  assert.equal(stale.statusCode, 409);
  const deleted = await app.inject({ method: "DELETE", url: `/api/bookmarks/${item.id}`, headers: { ...headers, cookie: alice.cookie }, payload: { version: 2 } });
  assert.equal(deleted.statusCode, 204);
  assert.equal((await app.inject({ url: `/api/bookmarks/${item.id}`, headers: { ...headers, cookie: alice.cookie } })).statusCode, 404);
});

test("unauthenticated, invalid and expired sessions cannot access bookmarks", async (t) => {
  const { app, db, login } = await fixture(t);
  for (const cookie of ["", "better-auth.session_token=forged"])
    assert.equal((await app.inject({ url: "/api/bookmarks", headers: { ...headers, cookie } })).statusCode, 401);
  const { cookie } = await login();
  db.prepare('UPDATE session SET "expiresAt" = ?').run(new Date(0).getTime());
  assert.equal((await app.inject({ url: "/api/bookmarks", headers: { ...headers, cookie } })).statusCode, 401);
});

test("mutations require exact Origin and all responses disable caching", async (t) => {
  const { app, login } = await fixture(t);
  const { cookie } = await login();
  for (const origin of [undefined, "https://attacker.test", "null"]) {
    const response = await app.inject({ method: "POST", url: "/api/bookmarks",
      headers: { host: headers.host, cookie, ...(origin ? { origin } : {}) }, payload: bookmark });
    assert.equal(response.statusCode, 403); assert.equal(response.headers["cache-control"], "no-store");
  }
  const valid = await app.inject({ url: "/api/bookmarks", headers: { ...headers, cookie } });
  assert.equal(valid.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ url: "/api/bookmarks", headers: { host: "attacker.test", cookie } })).statusCode, 400);
});

test("public signup/reset are unavailable, logout invalidates the previous cookie", async (t) => {
  const { app, login } = await fixture(t);
  for (const path of ["sign-up/email", "request-password-reset", "reset-password", "delete-user"]) {
    const response = await app.inject({ method: "POST", url: `/api/auth/${path}`, headers, payload: {} });
    assert.equal(response.statusCode, 404);
  }
  const { cookie } = await login();
  const response = await app.inject({ method: "POST", url: "/api/auth/sign-out", headers: { ...headers, cookie }, payload: {} });
  assert.equal(response.statusCode, 200);
  assert.equal((await app.inject({ url: "/api/bookmarks", headers: { ...headers, cookie } })).statusCode, 401);
});

test("strict input blocks owner injection, unsafe URLs, oversized bodies and invalid versions", async (t) => {
  const { app, login, b } = await fixture(t);
  const { cookie } = await login();
  for (const payload of [{ ...bookmark, userId: b.id }, { ...bookmark, url: "javascript:alert(1)" },
    { ...bookmark, title: " " }, { ...bookmark, favorite: "true" }]) {
    const response = await app.inject({ method: "POST", url: "/api/bookmarks", headers: { ...headers, cookie }, payload });
    assert.equal(response.statusCode, 400, response.body);
  }
  const oversized = await app.inject({ method: "POST", url: "/api/bookmarks", headers: { ...headers, cookie }, payload: { ...bookmark, note: "x".repeat(40000) } });
  assert.equal(oversized.statusCode, 413);
  const created = await app.inject({ method: "POST", url: "/api/bookmarks", headers: { ...headers, cookie }, payload: bookmark });
  const item = created.json().item;
  const missingVersion = await app.inject({ method: "PATCH", url: `/api/bookmarks/${item.id}`, headers: { ...headers, cookie }, payload: { note: "changed" } });
  assert.equal(missingVersion.statusCode, 400);
  const repeated = await app.inject({ method: "POST", url: "/api/bookmarks", headers: { ...headers, cookie }, payload: { ...bookmark, note: "overwrite" } });
  assert.equal(repeated.statusCode, 200); assert.equal(repeated.json().item.note, "Private");
});

test("login rate limiting uses socket IP, not forged forwarded headers", async (t) => {
  const { app } = await fixture(t);
  for (let i = 0; i < 6; i++) {
    const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email",
      headers: { ...headers, "x-forwarded-for": `203.0.113.${i}`, "x-loopshelf-client-ip": `203.0.113.${i}` },
      payload: { email: "alice@example.test", password: "incorrect-password" } });
    assert.equal(response.statusCode, i < 5 ? 401 : 429, response.body);
    if (i === 5) assert.ok(response.headers["retry-after"]);
  }
});

test("operator password reset revokes sessions and retains the user's bookmark", async (t) => {
  const { app, db, login } = await fixture(t);
  const { cookie } = await login();
  const created = await app.inject({ method: "POST", url: "/api/bookmarks", headers: { ...headers, cookie }, payload: bookmark });
  const item = created.json().item;
  await resetAccountPassword(db, config, { email: "alice@example.test", password: "replacement-password-123" });
  assert.equal((await app.inject({ url: "/api/bookmarks", headers: { ...headers, cookie } })).statusCode, 401);
  const response = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers,
    payload: { email: "alice@example.test", password: "replacement-password-123" } });
  assert.equal(response.statusCode, 200, response.body);
  const nextCookie = response.cookies.map((value) => `${value.name}=${value.value}`).join("; ");
  const recovered = await app.inject({ url: `/api/bookmarks/${item.id}`, headers: { ...headers, cookie: nextCookie } });
  assert.equal(recovered.json().id, item.id);
});

test("HTTPS origin issues Secure, HttpOnly and SameSite session cookies", async (t) => {
  const { login } = await fixture(t, "https://loopshelf.example.test");
  const { response } = await login();
  const cookies = String(response.headers["set-cookie"]);
  assert.match(cookies, /Secure/i); assert.match(cookies, /HttpOnly/i); assert.match(cookies, /SameSite=Lax/i);
});

test("concurrent authentication and bookmark writes do not interleave SQLite transactions", async (t) => {
  const { app, login } = await fixture(t);
  const { cookie } = await login();
  const responses = await Promise.all([
    ...Array.from({ length: 12 }, (_, index) => app.inject({ method: "POST", url: "/api/bookmarks", headers: { ...headers, cookie },
      payload: { ...bookmark, url: bookmark.url + `-${index}` } })),
    ...Array.from({ length: 2 }, () => app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers,
      payload: { email: "alice@example.test", password } })),
  ]);
  assert.ok(responses.every((response) => [200, 201].includes(response.statusCode)), responses.map((response) => response.body).join("\n"));
  const list = await app.inject({ url: "/api/bookmarks", headers: { ...headers, cookie } });
  assert.equal(list.json().items.length, 12);
});

test("restart preserves sessions; snapshot recovery revokes past sessions and tokens while preserving private libraries", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "main.sqlite"), snapshot = join(directory, "snapshot.sqlite"), restored = join(directory, "restored.sqlite");
  let db = openDatabase(path); migrate(db);
  await createAccount(db, config, { name: "Alice", email: "alice@example.test", password });
  await createAccount(db, config, { name: "Bob", email: "bob@example.test", password });
  let app = await buildApp(db, config);
  try {
    const cookies: string[] = [];
    for (const email of ["alice@example.test", "bob@example.test"]) {
      const login = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers, payload: { email, password } });
      assert.equal(login.statusCode, 200);
      cookies.push(login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "));
    }
    const created = await app.inject({ method: "POST", url: "/api/bookmarks", headers: { ...headers, cookie: cookies[0]! },
      payload: { ...bookmark, favorite: true } });
    const item = created.json().item;
    const disposable = (await app.inject({ method: "POST", url: "/api/bookmarks", headers: { ...headers, cookie: cookies[0]! },
      payload: { ...bookmark, url: bookmark.url + "-deleted" } })).json().item;
    assert.equal((await app.inject({ method: "POST", url: `/api/bookmarks/${disposable.id}/deletion`, headers: { ...headers, cookie: cookies[0]! },
      payload: { version: disposable.version, operationId: randomUUID() } })).statusCode, 200);
    db.prepare('INSERT INTO verification (id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), "recovery-test", "test-only-token", Date.now() + 60000, Date.now(), Date.now());
    await backupDatabase(db, snapshot);
    // Replaying a snapshot must not revive this explicitly revoked session.
    await app.inject({ method: "POST", url: "/api/auth/sign-out", headers: { ...headers, cookie: cookies[0]! }, payload: {} });
    await app.close(); db.close();
    await restoreDatabase(snapshot, restored);
    for (const filename of [path, restored]) {
      db = openDatabase(filename); app = await buildApp(db, config);
      assert.equal((await app.inject({ url: `/api/bookmarks/${item.id}`, headers: { ...headers, cookie: cookies[0]! } })).statusCode, 401);
      const bob = await app.inject({ url: "/api/bookmarks?q=Private", headers: { ...headers, cookie: cookies[1]! } });
      assert.equal(bob.statusCode, filename === path ? 200 : 401);
      if (filename === restored) {
        for (const table of ["session", "verification", "bookmark_deletion"])
          assert.equal((db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n, 0);
        for (const email of ["alice@example.test", "bob@example.test"]) {
          const login = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers, payload: { email, password } });
          assert.equal(login.statusCode, 200);
          const cookie = login.cookies.map((value) => `${value.name}=${value.value}`).join("; ");
          const list = await app.inject({ url: "/api/bookmarks", headers: { ...headers, cookie } });
          assert.equal(list.statusCode, 200); assert.deepEqual(list.json().items, email.startsWith("alice") ? [item] : []);
        }
      } else assert.deepEqual(bob.json().items, []);
      await app.close(); db.close();
    }
    db = openDatabase(snapshot);
    for (const table of ["session", "verification", "bookmark_deletion"])
      assert.ok((db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n > 0);
  } finally { await app.close(); if (db.open) db.close(); }
});


test("deletion undo requires the original real session, ownership, origin and strict inputs", async (t) => {
  const { db, app, login } = await fixture(t);
  const alice = await login(), alice2 = await login(), bob = await login("bob@example.test");
  const own = { ...headers, cookie: alice.cookie }, anotherSession = { ...headers, cookie: alice2.cookie }, other = { ...headers, cookie: bob.cookie };
  const item = (await app.inject({ method: "POST", url: "/api/bookmarks", headers: own, payload: bookmark })).json().item;
  const path = `/api/bookmarks/${item.id}/deletion`, input = { version: item.version, operationId: randomUUID() };
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: input })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: path, headers: other, payload: input })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: path, headers: { ...own, origin: "https://evil.test" }, payload: input })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: path, headers: own, payload: { ...input, userId: "forged" } })).statusCode, 400);
  const deleted = await app.inject({ method: "POST", url: path, headers: own, payload: input });
  assert.equal(deleted.statusCode, 200); assert.equal(deleted.headers["cache-control"], "no-store");
  assert.ok(!deleted.body.includes(bookmark.note));
  const restore = `/api/bookmark-deletions/${input.operationId}/restore`;
  for (const requestHeaders of [anotherSession, other]) assert.equal((await app.inject({ method: "POST", url: restore, headers: requestHeaders, payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: restore, headers, payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: restore, headers: { ...own, origin: "https://evil.test" }, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: restore, headers: own, payload: { title: "injection" } })).statusCode, 400);
  const session = (await app.inject({ url: "/api/auth/get-session", headers: own })).json().session.id;
  assert.equal((await app.inject({ method: "POST", url: restore, headers: { ...anotherSession, "x-loopshelf-session": session }, payload: {} })).statusCode, 401);
  const results = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: restore, headers: own, payload: {} })));
  assert.deepEqual(results.map((result) => result.statusCode), [200, 200]);
  assert.deepEqual(results.map((result) => result.json().restored).sort(), [false, true]);
  const fresh = (await app.inject({ url: `/api/bookmarks/${item.id}`, headers: own })).json();
  assert.equal(fresh.id, item.id); assert.equal(fresh.note, item.note); assert.ok(fresh.version > item.version);
  await app.inject({ method: "POST", url: path, headers: own, payload: { operationId: randomUUID(), version: fresh.version } });
  assert.equal((db.prepare("SELECT count(*) AS n FROM bookmark_deletion").get() as { n: number }).n, 2);
  await app.inject({ method: "POST", url: "/api/auth/sign-out", headers: own, payload: {} });
  assert.equal((db.prepare("SELECT count(*) AS n FROM bookmark_deletion").get() as { n: number }).n, 0);
});


test("pending undo survives server restart; startup purges expired recovery content", async (t) => {
  const { db, app, login } = await fixture(t);
  const { cookie } = await login(), own = { ...headers, cookie };
  const item = (await app.inject({ method: "POST", url: "/api/bookmarks", headers: own, payload: bookmark })).json().item;
  const operationId = randomUUID();
  await app.inject({ method: "POST", url: `/api/bookmarks/${item.id}/deletion`, headers: own, payload: { operationId, version: item.version } });
  await app.close();
  const restarted = await buildApp(db, config);
  try {
    assert.equal((await restarted.inject({ method: "POST", url: `/api/bookmark-deletions/${operationId}/restore`, headers: own, payload: {} })).json().restored, true);
    const restored = (await restarted.inject({ url: `/api/bookmarks/${item.id}`, headers: own })).json();
    assert.equal(restored.note, item.note);
    await restarted.inject({ method: "POST", url: `/api/bookmarks/${item.id}/deletion`, headers: own, payload: { operationId: randomUUID(), version: restored.version } });
  } finally { await restarted.close(); }
  db.prepare("UPDATE bookmark_deletion SET expires_at = ?").run(Date.now() - 1);
  const expired = await buildApp(db, config);
  try {
    assert.equal((db.prepare("SELECT count(*) AS n FROM bookmark_deletion").get() as { n: number }).n, 0);
    assert.deepEqual((await expired.inject({ url: "/api/bookmarks", headers: own })).json().items, []);
    assert.equal((await expired.inject({ method: "POST", url: `/api/bookmark-deletions/${operationId}/restore`, headers: own, payload: {} })).statusCode, 404);
  } finally { await expired.close(); }
});
