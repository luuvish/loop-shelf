import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { openDatabase } from "../src/database/connection.ts";
import { loadMigrations, migrate, assertMigrated } from "../src/database/migrate.ts";
import { backupDatabase, restoreDatabase, verifyDatabase } from "../src/database/backup.ts";
import { withDatabase } from "../src/database/access.ts";
import { getSourceCapture } from "../src/sources/transport.ts";
import { sourceAssessments } from "../src/sources/policies.ts";
import { createTransport } from "../src/sources/transport/engine.ts";
import { coordinationClock, createSqliteCoordinator, deferSourceRequests, recoverSourceRequest } from "../src/sources/transport/sqlite-coordinator.ts";
import { TransportFault, type SourcePermit, type TransportClock, type TransportDependencies } from "../src/sources/transport/contracts.ts";

class Clock implements TransportClock {
  time = Date.parse("2026-10-25T00:00:00Z");
  timers = new Set<{ at: number; fn: () => void }>();
  now = () => this.time;
  timer(ms: number, fn: () => void) { const entry = { at: this.time + ms, fn }; this.timers.add(entry); return () => { this.timers.delete(entry); }; }
  async advance(ms: number) {
    const end = this.time + ms; await tick();
    while (true) {
      const next = [...this.timers].sort((a, b) => a.at - b.at)[0]; if (!next || next.at > end) break;
      this.time = next.at; this.timers.delete(next); next.fn(); await tick();
    }
    this.time = end; await tick();
  }
}
const signal = () => new AbortController().signal;
const fault = (code: string) => (error: unknown) => error instanceof TransportFault && error.failure.code === code;
function fixture(t: TestContext, migrationCount?: number) {
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-source-coordination-")), filename = join(directory, "db.sqlite");
  const a = openDatabase(filename); migrate(a, migrationCount ? loadMigrations().slice(0, migrationCount) : loadMigrations());
  const b = openDatabase(filename), clock = new Clock();
  t.after(() => { a.close(); b.close(); rmSync(directory, { recursive: true, force: true }); });
  return { a, b, directory, filename, clock, one: createSqliteCoordinator(a, clock), two: createSqliteCoordinator(b, clock) };
}
function transport(db: ReturnType<typeof openDatabase>, clock: Clock, overrides: Partial<TransportDependencies> = {}) {
  const events: { kind: string; at: number }[] = [];
  const deps: TransportDependencies = {
    coordinator: createSqliteCoordinator(db, clock), clock, sampleKind: "synthetic", authorize: () => ({ allowed: true }),
    async resolve() { events.push({ kind: "dns", at: clock.now() }); return [{ address: "93.184.215.14", family: 4 }]; },
    async open() { events.push({ kind: "open", at: clock.now() }); return { status: 200, headers: { "content-type": "text/html" },
      body: { async *[Symbol.asyncIterator]() { yield Buffer.from("<html>synthetic</html>"); } }, close() { events.push({ kind: "close", at: clock.now() }); } }; },
    ...overrides,
  };
  return { capture: createTransport(deps), events, deps };
}
const request = { sourceId: "zophar", kind: "search", query: "synthetic" } as const;

test("0017 preserves prior contents, rolls back failed batches and carries interval/cooldown/running state through verified backup and fresh-path restore", async (t) => {
  const f = fixture(t, 16), history = f.a.prepare("SELECT * FROM schema_migration").all(), all = loadMigrations(), last = all.at(-1)!;
  assert.equal(last.name, "0017_source_request_coordination.sql");
  const user = randomUUID(); f.a.prepare(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'keep','keep@example.test',0,'now','now')`).run(user);
  assert.throws(() => migrate(f.a, [...all.slice(0, -1), { ...last, sql: `${last.sql}\nSELECT absent_function();` }]));
  assert.deepEqual(f.a.prepare("SELECT * FROM schema_migration").all(), history);
  assert.equal(f.a.prepare("SELECT 1 FROM sqlite_schema WHERE name='source_request_state'").get(), undefined);
  migrate(f.a); assertMigrated(f.a); assert.throws(() => migrate(f.a, all.slice(0, -1)), /history mismatch/);
  const permit = await f.one.acquire("zophar", signal(), 10000); await permit.beginAttempt(signal());
  const until = await permit.rateLimit("3600", signal());
  const before = f.a.prepare("SELECT * FROM source_request_ticket").all();
  const backup = join(f.directory, "backup.sqlite"), restored = join(f.directory, "restored.sqlite");
  await backupDatabase(f.a, backup); const hash = createHash("sha256").update(readFileSync(backup)).digest("hex");
  await restoreDatabase(backup, restored); const copy = openDatabase(restored);
  try {
    verifyDatabase(copy); assertMigrated(copy);
    assert.deepEqual(copy.prepare("SELECT * FROM source_request_ticket").all(), before);
    assert.equal((copy.prepare("SELECT cooldown_until FROM source_request_state WHERE source_id='zophar'").get() as { cooldown_until: number }).cooldown_until, until);
    assert.equal((copy.prepare('SELECT name FROM "user" WHERE id=?').get(user) as { name: string }).name, "keep");
    await assert.rejects(createSqliteCoordinator(copy, f.clock).acquire("zophar", signal(), 10000), fault("rate_limited"));
  } finally { copy.close(); }
  assert.equal(createHash("sha256").update(readFileSync(backup)).digest("hex"), hash);
  assert.deepEqual(f.a.prepare("SELECT * FROM source_request_ticket").all(), before);
});

test("two connections share the eight-waiter bound, FIFO reservation, cancellation and independent source", async (t) => {
  const f = fixture(t), first = await f.one.acquire("zophar", signal(), 10000); await first.beginAttempt(signal());
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const order: number[] = [], permits: SourcePermit[] = [];
  const queued = controllers.map((c, i) => f.two.acquire("zophar", c.signal, 10000).then((p) => { order.push(i); permits.push(p); return p; }, (error: unknown) => error));
  await tick(); await assert.rejects(f.one.acquire("zophar", signal(), 10000), fault("queue_full"));
  const other = await f.two.acquire("khinsider", signal(), 10000); await other.beginAttempt(signal()); await other.endAttempt(signal()); await other.release(signal());
  controllers[3]!.abort(new TransportFault("cancelled")); await tick();
  const extra = new AbortController(), replacement = f.one.acquire("zophar", extra.signal, 10000).catch((error: unknown) => error); await tick();
  await first.endAttempt(signal()); await first.release(signal()); await f.clock.advance(100);
  assert.deepEqual(order, [0]); await permits[0]!.release(signal()); await f.clock.advance(100); assert.deepEqual(order, [0, 1]);
  for (const controller of controllers) controller.abort(new TransportFault("cancelled")); extra.abort(new TransportFault("cancelled"));
  await Promise.all([...queued, replacement]); for (const p of permits) await p.release(signal());
  assert.equal((f.a.prepare("SELECT count(*) AS n FROM source_request_ticket").get() as { n: number }).n, 0);
});

test("reserved tickets can expire without traffic; expired running tickets never automatically admit a successor", async (t) => {
  const f = fixture(t), abandoned = await f.one.acquire("zophar", signal(), 1000);
  await f.clock.advance(1001); const successor = await f.two.acquire("zophar", signal(), 10000);
  await assert.rejects(abandoned.beginAttempt(signal()), fault("timeout")); await abandoned.release(signal());
  await successor.beginAttempt(signal()); await f.clock.advance(10001);
  await assert.rejects(f.one.acquire("zophar", signal(), 10000), fault("network_error"));
  await assert.rejects(successor.assertRunning(signal()), fault("timeout"));
  await successor.release(signal()); // A generic release cannot erase an uncertain running attempt.
  assert.equal((f.a.prepare("SELECT phase FROM source_request_ticket").get() as { phase: string }).phase, "running");
  await successor.endAttempt(signal()); await successor.release(signal());
  const next = await f.one.acquire("zophar", signal(), 10000), begin = next.beginAttempt(signal());
  await f.clock.advance(2999); assert.equal((f.a.prepare("SELECT phase FROM source_request_ticket").get() as { phase: string }).phase, "reserved");
  await f.clock.advance(1); await begin; await next.endAttempt(signal()); await next.release(signal());
});

test("429 values survive new coordinators without shortening, remain source-local and include oversized/fallback dates", async (t) => {
  const f = fixture(t), permit = await f.one.acquire("zophar", signal(), 10000); await permit.beginAttempt(signal());
  const end = f.clock.now() + 120000;
  assert.equal(await permit.rateLimit("120", signal()), end);
  assert.equal(await permit.rateLimit("1", signal()), end);
  assert.equal(await permit.rateLimit("nonsense", signal()), end);
  await permit.endAttempt(signal()); await permit.release(signal());
  const restarted = createSqliteCoordinator(f.b, f.clock);
  await assert.rejects(restarted.acquire("zophar", signal(), 10000), (error) => fault("rate_limited")(error) && (error as TransportFault).failure.retryAt === end);
  const other = await restarted.acquire("khinsider", signal(), 10000); await other.beginAttempt(signal());
  assert.equal(await other.rateLimit("99999999999999999999999", signal()), Number.MAX_SAFE_INTEGER);
  await other.endAttempt(signal()); await other.release(signal());
  await f.clock.advance(120001);
  const next = await restarted.acquire("zophar", signal(), 10000); await next.beginAttempt(signal());
  assert.equal(await next.rateLimit(new Date(f.clock.now() + 90000).toUTCString(), signal()), Math.floor((f.clock.now() + 90000) / 1000) * 1000);
  await next.endAttempt(signal()); await next.release(signal());
});

test("database turn wait cancellation cannot insert late tickets, and SQLite contention fails without a synchronous busy wait", async (t) => {
  const f = fixture(t); let unlock!: () => void;
  const blocker = withDatabase(f.a, async () => { await new Promise<void>((resolve) => { unlock = resolve; }); }); await tick();
  const controller = new AbortController(), pending = f.one.acquire("zophar", controller.signal, 10000); controller.abort(new TransportFault("cancelled"));
  await assert.rejects(pending, fault("cancelled")); unlock(); await blocker; await tick();
  assert.equal((f.a.prepare("SELECT count(*) AS n FROM source_request_ticket").get() as { n: number }).n, 0);
  f.a.exec("BEGIN IMMEDIATE"); const start = performance.now();
  try { await assert.rejects(f.two.acquire("zophar", signal(), 10000), /locked/); assert.ok(performance.now() - start < 1000); }
  finally { f.a.exec("ROLLBACK"); }
  assert.equal(f.b.pragma("busy_timeout", { simple: true }), 5000);
});

test("persisted clock rollback and in-process wall jumps fail closed", async (t) => {
  const f = fixture(t), permit = await f.one.acquire("zophar", signal(), 10000); await permit.release(signal());
  f.clock.time -= 1; await assert.rejects(f.two.acquire("zophar", signal(), 10000), fault("network_error"));
  const before = Date.now(), clock = coordinationClock();
  t.mock.method(Date, "now", () => before + 10000); assert.throws(() => clock.now(), fault("network_error"));
});

test("persistent transport spaces failures and redirects, keeps source lanes independent and holds no DB during bodies", async (t) => {
  const f = fixture(t), one = transport(f.a, f.clock), two = transport(f.b, f.clock);
  assert.equal((await one.capture(request)).ok, true);
  const second = two.capture(request); await f.clock.advance(2999); assert.equal(two.events.length, 0);
  await f.clock.advance(1); assert.equal((await second).ok, true);
  let complete!: () => void;
  const holding = transport(f.a, f.clock, { async open() { return { status: 200, headers: { "content-type": "text/html" }, close() {},
    body: { async *[Symbol.asyncIterator]() { await new Promise<void>((resolve) => { complete = resolve; }); yield Buffer.from("synthetic"); } } }; } });
  const pending = holding.capture({ ...request, sourceId: "khinsider" }); await tick();
  await withDatabase(f.a, async () => { f.a.prepare("UPDATE source_request_state SET ready_at=ready_at WHERE source_id='zophar'").run(); });
  complete(); assert.equal((await pending).ok, true);
  await f.clock.advance(3000); let calls = 0;
  const redirected = transport(f.a, f.clock, { async open() { calls++; return { status: calls === 1 ? 302 : 200,
    headers: calls === 1 ? { location: "/search?search=synthetic" } : { "content-type": "text/html" },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.from("synthetic"); } }, close() {} }; } });
  // A same-spelling loop is rejected but still consumes the shared attempt interval.
  assert.deepEqual(await redirected.capture(request), { ok: false, code: "redirect_rejected", httpStatus: 302 });
  const failedDns = transport(f.b, f.clock, { async resolve() { throw new Error("synthetic failure"); } });
  const fail = failedDns.capture(request); await f.clock.advance(3000); assert.deepEqual(await fail, { ok: false, code: "network_error" });
  assert.ok((f.a.prepare("SELECT ready_at FROM source_request_state WHERE source_id='zophar'").get() as { ready_at: number }).ready_at >= f.clock.now() + 3000);
});

test("policy changes and cancellation while waiting prevent DNS; timeout cleanup can wait for DB without delaying caller", async (t) => {
  const f = fixture(t), first = transport(f.a, f.clock); await first.capture(request);
  let allowed = true;
  const waiting = transport(f.b, f.clock, { authorize: () => allowed ? { allowed: true } : { allowed: false, code: "policy_disabled" } });
  const pending = waiting.capture(request); await tick(); allowed = false; await f.clock.advance(3000);
  assert.deepEqual(await pending, { ok: false, code: "policy_disabled" }); assert.equal(waiting.events.length, 0);
  await f.clock.advance(3000);
  let opened!: () => void; const didOpen = new Promise<void>((resolve) => { opened = resolve; });
  const stuck = transport(f.a, f.clock, { async open() { opened(); return { status: 200, headers: { "content-type": "text/html" }, close() {},
    body: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } } }; } });
  const timed = stuck.capture(request); await didOpen; let unlock!: () => void;
  const blocker = withDatabase(f.a, async () => { await new Promise<void>((resolve) => { unlock = resolve; }); }); await tick();
  await f.clock.advance(10000); assert.deepEqual(await timed, { ok: false, code: "timeout" });
  assert.equal((f.b.prepare("SELECT phase FROM source_request_ticket").get() as { phase: string }).phase, "running");
  unlock(); await blocker; await tick();
  assert.equal((f.a.prepare("SELECT count(*) AS n FROM source_request_ticket").get() as { n: number }).n, 0);
});

test("persistent redirect keeps its reservation and interval across hops; final policy checks include database cleanup waits", async (t) => {
  const f = fixture(t); let opened = 0, allowed = true, unlock!: () => void, blocker: Promise<void> | undefined;
  const h = transport(f.a, f.clock, {
    authorize: () => allowed ? { allowed: true } : { allowed: false, code: "policy_disabled" },
    async open() {
      opened++;
      return { status: opened === 1 ? 302 : 200,
        headers: opened === 1 ? { location: "/search?%73earch=synthetic" } : { "content-type": "text/html" },
        body: { async *[Symbol.asyncIterator]() { yield Buffer.from("synthetic"); } },
        close() {
          if (opened !== 2) return;
          blocker = withDatabase(f.a, async () => { await new Promise<void>((resolve) => { unlock = resolve; }); allowed = false; });
        },
      };
    },
  });
  const pending = h.capture(request); await f.clock.advance(2999); assert.equal(opened, 1);
  await f.clock.advance(1); assert.equal(opened, 2); assert.ok(blocker);
  unlock(); await blocker;
  assert.deepEqual(await pending, { ok: false, code: "policy_disabled" });
  assert.equal(h.events.filter((e) => e.kind === "dns").length, 2);
  assert.equal((f.a.prepare("SELECT count(*) AS n FROM source_request_ticket").get() as { n: number }).n, 0);
});

test("failed 429 persistence or completion writes never release uncertain running ownership or expose success", async (t) => {
  for (const operation of ["cooldown_until", "ready_at"]) {
    const f = fixture(t); f.a.exec(`CREATE TRIGGER fail_coordination BEFORE UPDATE OF ${operation} ON source_request_state BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    const run = transport(f.a, f.clock, operation === "cooldown_until" ? { async open() { return { status: 429, headers: { "retry-after": "3600" }, body: { async *[Symbol.asyncIterator]() {} }, close() {} }; } } : {});
    assert.deepEqual(await run.capture(request), { ok: false, code: "network_error" });
    assert.equal((f.a.prepare("SELECT phase FROM source_request_ticket").get() as { phase: string }).phase, "running");
    await f.clock.advance(10001); const other = transport(f.b, f.clock);
    assert.deepEqual(await other.capture(request), { ok: false, code: "network_error" }); assert.equal(other.events.length, 0);
  }
});

test("operator recovery requires the exact expired running token, preserves longer cooldown and rejects stale owner cleanup", async (t) => {
  const f = fixture(t), permit = await f.one.acquire("zophar", signal(), 10000); await permit.beginAttempt(signal());
  const until = await permit.rateLimit("3600", signal()), token = (f.a.prepare("SELECT token FROM source_request_ticket").get() as { token: string }).token;
  await assert.rejects(recoverSourceRequest(f.a, { sourceId: "zophar", token, retryAt: f.clock.now() + 120000 }, f.clock), /expired running/);
  await f.clock.advance(10001);
  await assert.rejects(recoverSourceRequest(f.a, { sourceId: "zophar", token: randomUUID(), retryAt: f.clock.now() + 120000 }, f.clock), /matching/);
  await assert.rejects(recoverSourceRequest(f.a, { sourceId: "zophar", token, retryAt: f.clock.now() + 59000 }, f.clock), /60 seconds/);
  assert.equal((await recoverSourceRequest(f.a, { sourceId: "zophar", token, retryAt: f.clock.now() + 120000 }, f.clock)).retryAt, until);
  await f.clock.advance(3600000);
  const next = await f.two.acquire("zophar", signal(), 10000); await next.beginAttempt(signal());
  await assert.rejects(permit.endAttempt(signal()), fault("timeout")); await permit.release(signal());
  await next.assertRunning(signal()); await next.endAttempt(signal()); await next.release(signal());
});

test("product database-bound/unbound-live paths remain closed before reservation, DNS or policy mutation", async (t) => {
  const f = fixture(t), before = JSON.stringify(sourceAssessments), capture = getSourceCapture(f.a);
  assert.equal(getSourceCapture(f.a), capture);
  for (const sourceId of ["khinsider", "zophar"] as const) assert.deepEqual(await capture({ ...request, sourceId }), { ok: false, code: "policy_disabled" });
  const h = transport(f.a, f.clock), { coordinator: _coordinator, ...unbound } = h.deps;
  assert.deepEqual(await createTransport({ ...unbound, sampleKind: "live-capture" })(request), { ok: false, code: "policy_disabled" });
  assert.equal(h.events.length, 0); assert.equal(JSON.stringify(sourceAssessments), before);
  assert.equal((f.a.prepare("SELECT count(*) AS n FROM source_request_ticket").get() as { n: number }).n, 0);
  assert.deepEqual(f.a.prepare("SELECT observed_at FROM source_request_state").all(), [{ observed_at: 0 }, { observed_at: 0 }]);
});

test("restored-installation deferral can only extend waiting, preserves running ownership and is available through the strict operator CLI", async (t) => {
  const f = fixture(t), p = await f.one.acquire("zophar", signal(), 10000); await p.beginAttempt(signal());
  const before = f.a.prepare("SELECT * FROM source_request_ticket").all(), until = f.clock.now() + 3600000;
  assert.equal((await deferSourceRequests(f.a, { sourceId: "zophar", retryAt: until }, f.clock)).retryAt, until);
  assert.equal((await deferSourceRequests(f.a, { sourceId: "zophar", retryAt: f.clock.now() + 60000 }, f.clock)).retryAt, until);
  assert.deepEqual(f.a.prepare("SELECT * FROM source_request_ticket").all(), before);
  await assert.rejects(deferSourceRequests(f.a, { sourceId: "zophar", retryAt: f.clock.now() }, f.clock), /60 seconds/);
  const env = { ...process.env, DATABASE_PATH: f.filename }, args = ["scripts/source-requests.ts", "defer", "--source", "khinsider", "--reviewed-retry-at", new Date(Date.now() + 120000).toISOString()];
  assert.notEqual(spawnSync(process.execPath, args, { env }).status, 0);
  const done = spawnSync(process.execPath, [...args, "--confirm-workers-stopped"], { env, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr); assert.ok(JSON.parse(done.stdout).retryAt > Date.now() + 60000);
  assert.notEqual(spawnSync(process.execPath, [...args, "--confirm-workers-stopped", "--token", randomUUID()], { env }).status, 0);
  assert.deepEqual(f.a.prepare("SELECT * FROM source_request_ticket").all(), before);
});

interface Message { event: string; id?: string; source?: string; at?: number; result?: { ok: boolean; code?: string; retryAt?: number } }
async function worker(t: TestContext, filename: string) {
  const child = fork(new URL("./helpers/source-coordination-worker.ts", import.meta.url), [filename], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages: Message[] = []; let stderr = "";
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); }); child.on("message", (m: Message) => messages.push(m));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>((resolve) => child.once("exit", () => resolve())); child.kill(); await exited; } });
  const wait = async (predicate: (m: Message) => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const found = messages.find(predicate); if (found) return found; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited: ${stderr}`); await sleep(10); }
    throw new Error(`Worker timeout: ${stderr}; ${JSON.stringify(messages)}`);
  };
  await wait((m) => m.event === "ready");
  return { child, messages, wait, start(id: string, source = "zophar", extras = {}) { child.send({ kind: "start", id, source, ...extras }); } };
}

test("separate real processes serialize one source with a three-second completion gap while the other source progresses", { timeout: 25000 }, async (t) => {
  const f = fixture(t), a = await worker(t, f.filename), b = await worker(t, f.filename);
  a.start("first", "zophar", { hold: true }); await a.wait((m) => m.event === "open");
  b.start("second"); b.start("other", "khinsider"); await b.wait((m) => m.id === "other" && m.event === "result");
  assert.equal(b.messages.filter((m) => m.event === "dns" && m.source === "zophar").length, 0);
  a.child.send({ kind: "release", id: "first" }); const closed = await a.wait((m) => m.event === "close" && m.id === "first");
  const done = await b.wait((m) => m.event === "result" && m.id === "second"); assert.equal(done.result?.ok, true);
  const dns = b.messages.find((m) => m.event === "dns" && m.source === "zophar")!;
  assert.ok(dns.at! - closed.at! >= 3000, `${dns.at} vs ${closed.at}`);
});

test("429 persists across an actual process exit and replacement without any new synthetic DNS", { timeout: 20000 }, async (t) => {
  const f = fixture(t), a = await worker(t, f.filename); a.start("limited", "zophar", { status: 429, retryAfter: "3600" });
  const limited = await a.wait((m) => m.event === "result"); assert.equal(limited.result?.code, "rate_limited");
  const exited = new Promise<void>((resolve) => a.child.once("exit", () => resolve())); a.child.kill(); await exited;
  const b = await worker(t, f.filename); b.start("restarted"); const next = await b.wait((m) => m.event === "result");
  assert.equal(next.result?.code, "rate_limited"); assert.equal(next.result?.retryAt, limited.result?.retryAt);
  assert.equal(b.messages.filter((m) => m.event === "dns").length, 0);
});

test("normal completion interval survives an actual process exit before the next DNS attempt", { timeout: 15000 }, async (t) => {
  const f = fixture(t), a = await worker(t, f.filename); a.start("finished");
  assert.equal((await a.wait((m) => m.event === "result")).result?.ok, true);
  const ready = (f.a.prepare("SELECT ready_at FROM source_request_state WHERE source_id='zophar'").get() as { ready_at: number }).ready_at;
  const exited = new Promise<void>((resolve) => a.child.once("exit", () => resolve())); a.child.kill(); await exited;
  const b = await worker(t, f.filename); b.start("after-restart");
  assert.equal((await b.wait((m) => m.event === "result")).result?.ok, true);
  assert.ok(b.messages.find((m) => m.event === "dns")!.at! >= ready);
});

test("SIGKILL leaves running ownership closed beyond expiry; inspected CLI recovery needs attestation and reviewed waiting time", { timeout: 30000 }, async (t) => {
  const f = fixture(t), a = await worker(t, f.filename); a.start("crashed", "zophar", { hold: true }); await a.wait((m) => m.event === "open");
  const exited = new Promise<void>((resolve) => a.child.once("exit", () => resolve())); a.child.kill("SIGKILL"); await exited;
  const token = (f.a.prepare("SELECT token FROM source_request_ticket").get() as { token: string }).token;
  await sleep(10100);
  const b = await worker(t, f.filename); b.start("replacement"); const result = await b.wait((m) => m.event === "result");
  assert.equal(result.result?.code, "network_error"); assert.equal(b.messages.filter((m) => m.event === "dns").length, 0);
  const env = { ...process.env, DATABASE_PATH: f.filename }, args = ["scripts/source-requests.ts", "recover", "--source", "zophar", "--token", token, "--reviewed-retry-at", new Date(Date.now() + 120000).toISOString()];
  const missing = spawnSync(process.execPath, args, { env, encoding: "utf8" }); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /Stop ALL workers/);
  const bExited = new Promise<void>((resolve) => b.child.once("exit", () => resolve())); b.child.kill(); await bExited;
  const inspection = spawnSync(process.execPath, ["scripts/source-requests.ts", "inspect", "--source", "zophar"], { env, encoding: "utf8" });
  assert.equal(inspection.status, 0, inspection.stderr); assert.equal(JSON.parse(inspection.stdout).tickets[0].token, token);
  const recovery = spawnSync(process.execPath, [...args, "--confirm-workers-stopped"], { env, encoding: "utf8" });
  assert.equal(recovery.status, 0, recovery.stderr); assert.ok(JSON.parse(recovery.stdout).retryAt >= Date.now() + 60000);
  assert.equal((f.a.prepare("SELECT count(*) AS n FROM source_request_ticket").get() as { n: number }).n, 0);
  const badPath = join(f.directory, "absent.sqlite");
  assert.notEqual(spawnSync(process.execPath, ["scripts/source-requests.ts", "inspect", "--source", "zophar"], { env: { ...env, DATABASE_PATH: badPath } }).status, 0);
  assert.equal(existsSync(badPath), false);
});
