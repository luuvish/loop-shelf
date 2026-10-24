import type { FastifyInstance, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { withDatabase } from "../database/access.ts";
import { abortable } from "../sources/transport/contracts.ts";

export interface SessionIdentity { userId: string; sessionId: string }
export type ReadSession = (request: FastifyRequest) => Promise<SessionIdentity | null>;
export const SOURCE_READ_HTTP_LIMITS = Object.freeze({ deadlineMs: 12_000, maxActive: 16, perMinute: 30, bodyBytes: 4096 });

interface ControlFailure { ok: false; code: "invalid_input" | "queue_full" | "cancelled" }
interface ReadOperation<Input, Result extends { ok: true } | ControlFailure> {
  path: string;
  timeoutCode: string;
  parse(input: unknown): Input;
  read(input: Input, signal: AbortSignal): Promise<Result>;
  /** Synchronous; called after final authentication while owning withDatabase. */
  recheck(input: Input, result: Result): Result;
}

interface WriteOperation<Input> {
  path: string; timeoutCode: string; bodyBytes: number;
  parse(input: unknown): Input;
  /** Must authenticate and commit in the same DB turn. No asynchronous work after the commit. */
  write(input: Input, request: FastifyRequest, signal: AbortSignal): Promise<{
    status: number; value: unknown; authenticated?: SessionIdentity;
  }>;
}

/** One admission/rate budget for search, source detail and source saves, separate from authentication and private CRUD. */
export function createSourceRoutes(app: FastifyInstance, db: Database.Database, readSession: ReadSession) {
  const active = new Set<AbortController>();
  const limiter = app.rateLimit({ max: SOURCE_READ_HTTP_LIMITS.perMinute, timeWindow: "1 minute" });
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
    for (const controller of active) controller.abort("closing");
  });
  function register<Input, Result extends { ok: true } | ControlFailure>(operation: ReadOperation<Input, Result> | WriteOperation<Input>) {
    app.post(operation.path, { bodyLimit: "write" in operation ? operation.bodyBytes : SOURCE_READ_HTTP_LIMITS.bodyBytes, onRequest: limiter, config: { rateLimit: false },
    }, async (request, reply) => {
      // Host, exact Origin and no-store are enforced by the application's onRequest hook.
      reply.header("Vary", "Cookie, X-LoopShelf-Session");
      if (closing) return reply.code(503).send({ code: "server_closing" });
      if (active.size >= SOURCE_READ_HTTP_LIMITS.maxActive) return reply.code(429).send({ code: "queue_full" });
      const controller = new AbortController(), { signal } = controller, started = performance.now();
      active.add(controller);
      const disconnected = () => { if (!reply.raw.writableFinished) controller.abort("disconnected"); };
      request.raw.once("aborted", disconnected);
      // IncomingMessage.close can mean a successfully received POST body. Observe the response/socket instead.
      reply.raw.once("close", disconnected);
      if (request.raw.aborted || reply.raw.destroyed) disconnected();
      const timer = setTimeout(() => controller.abort("timeout"), SOURCE_READ_HTTP_LIMITS.deadlineMs);
      function check() {
        if (performance.now() - started >= SOURCE_READ_HTTP_LIMITS.deadlineMs) controller.abort("timeout");
        signal.throwIfAborted();
      }
      try {
        const initial = await abortable(withDatabase(db, async () => { check(); const session = await readSession(request); check(); return session; }), signal);
        if (!initial) return reply.code(401).send({ code: "unauthorized" });
        const expected = request.headers["x-loopshelf-session"];
        if (expected === undefined) return reply.code(428).send({ code: "session_required" });
        if (expected !== initial.sessionId) return reply.code(401).send({ code: "session_changed" });
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
          return reply.code(415).send({ code: "invalid_content_type" });
        let input;
        try {
          if (!request.query || typeof request.query !== "object" || Object.keys(request.query).length) throw new Error("Unexpected query");
          input = operation.parse(request.body);
        } catch { return reply.code(400).send({ code: "invalid_input" }); }
        check();
        if ("write" in operation) {
          const outcome = await abortable(Promise.resolve().then(() => { check(); return operation.write(input, request, signal); }), signal);
          check();
          if (outcome.status >= 200 && outcome.status < 300) {
            if (outcome.authenticated?.userId !== initial.userId || outcome.authenticated.sessionId !== initial.sessionId)
              throw new Error("Save result session changed");
            reply.header("X-LoopShelf-User", initial.userId).header("X-LoopShelf-Session", initial.sessionId);
          }
          // The writer reauthenticated immediately before commit. A second asynchronous lookup here
          // could discard a committed result; send immediately and let the UI recheck its current cookie.
          return reply.code(outcome.status).send(outcome.value);
        }
        const result = await abortable(Promise.resolve().then(() => { check(); return operation.read(input, signal); }), signal);
        // Reauthenticate after waiting. Do not keep the DB locked during source work or wait for network sends in this callback.
        await abortable(withDatabase(db, async () => {
          check(); const current = await readSession(request); check();
          if (!current) { reply.code(401).send({ code: "unauthorized" }); return; }
          if (current.userId !== initial.userId || current.sessionId !== initial.sessionId) {
            reply.code(401).send({ code: "session_changed" }); return;
          }
          // Authentication may have queued behind a removal, expiry or policy update after the source read completed.
          const checked = operation.recheck(input, result); check();
          reply.header("X-LoopShelf-User", current.userId).header("X-LoopShelf-Session", current.sessionId);
          if (!checked.ok) reply.code(checked.code === "invalid_input" ? 400 : checked.code === "queue_full" ? 429 : 408);
          reply.send(checked);
          // Returning FastifyReply here would await transmission while owning the database boundary.
        }), signal);
        return reply;
      } catch (error) {
        if (!signal.aborted) throw error;
        if (signal.reason === "disconnected") { reply.hijack(); return; }
        return reply.code(signal.reason === "closing" ? 503 : 504).send({ code: signal.reason === "closing" ? "server_closing" : operation.timeoutCode });
      } finally {
        clearTimeout(timer); request.raw.removeListener("aborted", disconnected); reply.raw.removeListener("close", disconnected);
        active.delete(controller); controller.abort("finished");
      }
    });
  }
  return {
    read: <Input, Result extends { ok: true } | ControlFailure>(operation: ReadOperation<Input, Result>) => register(operation),
    write: <Input>(operation: WriteOperation<Input>) => register(operation),
  };
}
