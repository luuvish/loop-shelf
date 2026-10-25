import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { withDatabase } from "../../database/access.ts";
import type { SourceId } from "../types.ts";
import { cooldownUntil } from "./cooldown.ts";
import { abortable, TRANSPORT_LIMITS as limits, TransportFault,
  type SourceCoordinator, type SourcePermit, type TransportClock } from "./contracts.ts";

interface State { ready_at: number; cooldown_until: number; observed_at: number }
interface Ticket { token: string; phase: "waiting" | "reserved" | "running"; expires_at: number }
const failed = () => new TransportFault("network_error");
const boundedAdd = (now: number, ms: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(now + ms));

/** Same-host wall time for persisted dates. In-process jumps fail closed, never reset deadlines. */
export function coordinationClock(): TransportClock {
  const wall = Date.now(), monotonic = performance.now();
  return {
    now() {
      const now = Date.now();
      if (Math.abs(now - wall - (performance.now() - monotonic)) > 1000) throw failed();
      return now;
    },
    timer(ms, callback) { const id = setTimeout(callback, ms); return () => clearTimeout(id); },
  };
}

/** No synchronous busy wait, network or timers inside the shared connection boundary. */
async function turn<T>(db: Database.Database, action: () => T): Promise<T> {
  return withDatabase(db, async () => {
    const timeout = db.pragma("busy_timeout", { simple: true }) as number;
    db.pragma("busy_timeout = 0");
    try { return db.transaction(action).immediate(); }
    finally { db.pragma(`busy_timeout = ${timeout}`); }
  });
}
function stateAt(db: Database.Database, source: SourceId, clock: TransportClock): { state: State; now: number } {
  const now = Math.floor(clock.now());
  if (!Number.isSafeInteger(now) || now < 0) throw failed();
  const state = db.prepare("SELECT * FROM source_request_state WHERE source_id=?").get(source) as State | undefined;
  if (!state || now < state.observed_at) throw failed();
  db.prepare("UPDATE source_request_state SET observed_at=? WHERE source_id=?").run(now, source);
  return { state, now };
}
function checkCooldown(state: State, now: number) {
  if (state.cooldown_until > now) throw new TransportFault("rate_limited", { retryAt: state.cooldown_until });
}
function advanceQueue(db: Database.Database, source: SourceId, now: number) {
  // Only a reservation that has never entered DNS/HTTP can expire automatically.
  db.prepare("DELETE FROM source_request_ticket WHERE source_id=? AND phase<>'running' AND expires_at<=?").run(source, now);
  const holder = db.prepare("SELECT token,phase,expires_at FROM source_request_ticket WHERE source_id=? AND phase<>'waiting'").get(source) as Ticket | undefined;
  if (holder?.phase === "running" && holder.expires_at <= now) throw failed();
  if (!holder) db.prepare(`UPDATE source_request_ticket SET phase='reserved' WHERE sequence=(
    SELECT sequence FROM source_request_ticket WHERE source_id=? AND phase='waiting' ORDER BY sequence LIMIT 1)`).run(source);
}
function delay(clock: TransportClock, signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = clock.timer(ms, () => { signal.removeEventListener("abort", abort); resolve(); });
    const abort = () => { cancel(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Internal dependency only. All processes must use the SAME local DB; no HTTP/env overrides. */
export function createSqliteCoordinator(db: Database.Database, clock: TransportClock = coordinationClock()): SourceCoordinator {
  const owner = randomUUID();
  return {
    async acquire(source, signal, remainingMs) {
      const token = randomUUID(), started = clock.now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new TransportFault("timeout");
      const expires = boundedAdd(started, Math.min(remainingMs, limits.timeoutMs));
      const query = <T>(action: () => T) => abortable(turn(db, () => { signal.throwIfAborted(); return action(); }), signal);
      // Cleanup is queued even after cancellation, but cannot prolong the caller's deadline.
      const release = (abort: AbortSignal) => abortable(turn(db, () => {
        db.prepare("DELETE FROM source_request_ticket WHERE token=? AND owner_id=? AND phase<>'running'").run(token, owner);
      }), abort);
      const owned = (): Ticket => {
        const row = db.prepare("SELECT token,phase,expires_at FROM source_request_ticket WHERE token=? AND owner_id=?").get(token, owner) as Ticket | undefined;
        if (!row) throw new TransportFault("timeout");
        return row;
      };
      try {
        await query(() => {
          const { state, now } = stateAt(db, source, clock); checkCooldown(state, now);
          if (now >= expires) throw new TransportFault("timeout");
          advanceQueue(db, source, now);
          const holder = db.prepare("SELECT 1 FROM source_request_ticket WHERE source_id=? AND phase<>'waiting'").get(source);
          const waiting = (db.prepare("SELECT count(*) AS n FROM source_request_ticket WHERE source_id=? AND phase='waiting'").get(source) as { n: number }).n;
          if (waiting >= limits.maxWaiting + (holder ? 0 : 1)) throw new TransportFault("queue_full");
          db.prepare("INSERT INTO source_request_ticket(token,source_id,owner_id,expires_at,phase) VALUES (?,?,?,?,'waiting')").run(token, source, owner, expires);
          advanceQueue(db, source, now);
        });
        while (true) {
          const reserved = await query(() => {
            const { state, now } = stateAt(db, source, clock); checkCooldown(state, now); advanceQueue(db, source, now);
            return owned().phase === "reserved";
          });
          if (reserved) break;
          await delay(clock, signal, 100);
        }
        const permit: SourcePermit = {
          async beginAttempt(abort) {
            while (true) {
              const wait = await abortable(turn(db, () => {
                abort.throwIfAborted();
                const { state, now } = stateAt(db, source, clock); checkCooldown(state, now);
                const ticket = owned();
                if (ticket.expires_at <= now) throw new TransportFault("timeout");
                if (ticket.phase !== "reserved") throw failed();
                if (state.ready_at > now) return Math.min(100, state.ready_at - now);
                db.prepare("UPDATE source_request_ticket SET phase='running' WHERE token=?").run(token);
                return 0;
              }), abort);
              if (!wait) return;
              await delay(clock, abort, wait);
            }
          },
          async assertRunning(abort) {
            await abortable(turn(db, () => {
              abort.throwIfAborted();
              const { now } = stateAt(db, source, clock), row = owned();
              if (row.expires_at <= now) throw new TransportFault("timeout");
              if (row.phase !== "running") throw failed();
            }), abort);
          },
          async rateLimit(header, abort) {
            // Persist an observed 429 even if the caller cancels while queued for this DB turn.
            return abortable(turn(db, () => {
              const { state, now } = stateAt(db, source, clock), row = owned();
              if (row.phase !== "running") throw failed();
              const until = Math.max(state.cooldown_until, cooldownUntil(header, now));
              db.prepare("UPDATE source_request_state SET cooldown_until=? WHERE source_id=?").run(until, source);
              return until;
            }), abort);
          },
          async endAttempt(abort) {
            await abortable(turn(db, () => {
              const { now } = stateAt(db, source, clock), row = owned();
              if (row.phase !== "running") throw failed();
              db.prepare("UPDATE source_request_state SET ready_at=max(ready_at,?) WHERE source_id=?").run(boundedAdd(now, limits.intervalMs), source);
              db.prepare("UPDATE source_request_ticket SET phase='reserved' WHERE token=?").run(token);
            }), abort);
          },
          release,
        };
        return permit;
      } catch (error) { await release(signal).catch(() => {}); throw error; }
    },
  };
}

/** Operator attests all workers stopped and reviews uncertain upstream cooldown before calling. */
export async function deferSourceRequests(db: Database.Database, input: { sourceId: SourceId; retryAt: number }, clock: TransportClock = coordinationClock()) {
  if (!["khinsider", "zophar"].includes(input.sourceId) || !Number.isSafeInteger(input.retryAt)) throw new Error("Invalid deferral input");
  return turn(db, () => {
    const { state, now } = stateAt(db, input.sourceId, clock);
    if (input.retryAt < boundedAdd(now, limits.fallbackCooldownMs)) throw new Error("Reviewed retry time must be at least 60 seconds in the future");
    const until = Math.max(state.cooldown_until, input.retryAt);
    db.prepare("UPDATE source_request_state SET cooldown_until=?,ready_at=max(ready_at,?) WHERE source_id=?").run(until, until, input.sourceId);
    return { sourceId: input.sourceId, retryAt: until };
  });
}

/** Exact expired running ownership only; never a blanket queue reset. */
export async function recoverSourceRequest(db: Database.Database, input: { sourceId: SourceId; token: string; retryAt: number }, clock: TransportClock = coordinationClock()) {
  if (!["khinsider", "zophar"].includes(input.sourceId) || !/^[0-9a-f-]{36}$/.test(input.token) || !Number.isSafeInteger(input.retryAt)) throw new Error("Invalid recovery input");
  return turn(db, () => {
    const { state, now } = stateAt(db, input.sourceId, clock);
    const row = db.prepare("SELECT token,phase,expires_at FROM source_request_ticket WHERE source_id=? AND token=?").get(input.sourceId, input.token) as Ticket | undefined;
    if (!row || row.phase !== "running" || row.expires_at > now) throw new Error("No matching expired running request; inspect current state");
    if (input.retryAt < boundedAdd(now, limits.fallbackCooldownMs)) throw new Error("Reviewed retry time must be at least 60 seconds in the future");
    const until = Math.max(state.cooldown_until, input.retryAt);
    db.prepare("UPDATE source_request_state SET cooldown_until=?,ready_at=max(ready_at,?) WHERE source_id=?").run(until, until, input.sourceId);
    db.prepare("DELETE FROM source_request_ticket WHERE token=?").run(row.token);
    return { sourceId: input.sourceId, releasedToken: row.token, retryAt: until };
  });
}
