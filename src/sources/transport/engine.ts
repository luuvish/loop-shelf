import type { SourceId } from "../types.ts";
import { cooldownUntil } from "./cooldown.ts";
import { selectAddress } from "./addresses.ts";
import { redirectUrl, requestUrl } from "./requests.ts";
import { abortable, TRANSPORT_LIMITS as limits, TransportFault,
  type SourcePermit, type SourceRequest, type TransportDependencies, type TransportResult, type WireResponse } from "./contracts.ts";

class Lane {
  busy = false;
  readyAt = 0;
  cooldownUntil = 0;
  waiting: (() => void)[] = [];
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.busy) {
      if (this.waiting.length >= limits.maxWaiting) throw new TransportFault("queue_full");
      await new Promise<void>((resolve, reject) => {
        const enter = () => { signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.waiting.splice(this.waiting.indexOf(enter), 1); reject(signal.reason); };
        this.waiting.push(enter);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else this.busy = true;
    return () => {
      const next = this.waiting.shift();
      if (next) next(); else this.busy = false;
    };
  }
}

async function readHtml(response: WireResponse, signal: AbortSignal): Promise<string> {
  const type = response.headers["content-type"] ?? "";
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(type))
    throw new TransportFault("invalid_response");
  const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1];
  if (charset && !/^(utf-8|utf8|us-ascii)$/i.test(charset)) throw new TransportFault("invalid_response");
  if (response.headers["content-encoding"] && response.headers["content-encoding"]?.toLowerCase() !== "identity")
    throw new TransportFault("invalid_response");
  const length = response.headers["content-length"];
  if (length !== undefined && !/^\d+$/.test(length)) throw new TransportFault("invalid_response");
  if (length !== undefined && Number(length) > limits.maxBodyBytes) throw new TransportFault("response_too_large");
  // Fixed storage also bounds overhead from arbitrarily many tiny chunks.
  const buffer = Buffer.allocUnsafe(limits.maxBodyBytes);
  let bytes = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  while (true) {
    signal.throwIfAborted();
    const chunk = await abortable(iterator.next(), signal);
    if (chunk.done) break;
    if (bytes + chunk.value.byteLength > limits.maxBodyBytes) throw new TransportFault("response_too_large");
    buffer.set(chunk.value, bytes);
    bytes += chunk.value.byteLength;
  }
  if (length !== undefined && bytes !== Number(length)) throw new TransportFault("invalid_response");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)); }
  catch { throw new TransportFault("invalid_response"); }
}

/** Internal test seam. Product callers use captureSourcePage, which owns its policy and drivers. */
export function createTransport(deps: TransportDependencies) {
  const lanes: Record<SourceId, Lane> = { khinsider: new Lane(), zophar: new Lane() };
  const check = (request: SourceRequest, url: URL) => {
    const decision = deps.authorize(request, url);
    if (!decision.allowed) throw new TransportFault(decision.code);
    return decision.revision;
  };
  const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = deps.clock.timer(ms, () => { signal.removeEventListener("abort", abort); resolve(); });
    const abort = () => { cancel(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
  return async (input: SourceRequest, caller?: AbortSignal): Promise<TransportResult> => {
    const started = deps.clock.now();
    const controller = new AbortController();
    const signal = controller.signal;
    const abort = () => controller.abort(new TransportFault("cancelled"));
    const cancelTimer = deps.clock.timer(limits.timeoutMs, () => controller.abort(new TransportFault("timeout")));
    if (caller?.aborted) abort(); else caller?.addEventListener("abort", abort, { once: true });
    let release: (() => void) | undefined;
    let permit: SourcePermit | undefined;
    let result: TransportResult;
    let checked = false;
    let policyRevision: string | undefined;
    const checkPolicy = (request: SourceRequest, url: URL) => {
      const current = check(request, url);
      if (checked && current !== policyRevision) throw new TransportFault("policy_disabled");
      policyRevision = current;
      checked = true;
    };
    const active = () => {
      if (deps.clock.now() - started >= limits.timeoutMs) controller.abort(new TransportFault("timeout"));
      signal.throwIfAborted();
    };
    try {
      // Snapshot caller-owned fields before the first await.
      const request = { ...input };
      let url = requestUrl(request);
      active();
      checkPolicy(request, url);
      if (deps.sampleKind === "live-capture" && !deps.coordinator) throw new TransportFault("policy_disabled");
      const lane = lanes[request.sourceId];
      const checkCooldown = () => {
        if (lane.cooldownUntil > deps.clock.now())
          throw new TransportFault("rate_limited", { retryAt: lane.cooldownUntil });
      };
      checkCooldown();
      if (deps.coordinator) permit = await deps.coordinator.acquire(request.sourceId, signal, limits.timeoutMs - (deps.clock.now() - started));
      else release = await lane.acquire(signal);
      const visited = new Set([url.href]);
      let page: Extract<TransportResult, { ok: true }>["page"];
      for (let hop = 0; ; hop++) {
        active();
        checkPolicy(request, url);
        checkCooldown();
        if (permit) await permit.beginAttempt(signal);
        else if (lane.readyAt > deps.clock.now()) await wait(lane.readyAt - deps.clock.now(), signal);
        let response: WireResponse | undefined;
        let completionKnown = true;
        try {
          active(); checkPolicy(request, url); checkCooldown();
          const addresses = await abortable(deps.resolve(url.hostname, signal), signal);
          const address = selectAddress(addresses);
          if (permit) await permit.assertRunning(signal);
          active();
          checkPolicy(request, url);
          response = await abortable(deps.open(url, address, signal), signal, (late) => late.close());
          const status = response.status;
          if (status === 429) {
            // If persistence fails, leave the running reservation closed to new requests.
            completionKnown = false;
            lane.cooldownUntil = permit ? await permit.rateLimit(response.headers["retry-after"], signal)
              : Math.max(lane.cooldownUntil, cooldownUntil(response.headers["retry-after"], deps.clock.now()));
            completionKnown = true;
            throw new TransportFault("rate_limited", { httpStatus: status, retryAt: lane.cooldownUntil });
          }
          active();
          if ([401, 403, 407, 451].includes(status)) throw new TransportFault("blocked", { httpStatus: status });
          if ([404, 410].includes(status)) throw new TransportFault("not_found", { httpStatus: status });
          if ([301, 302, 303, 307, 308].includes(status)) {
            if (hop >= limits.maxRedirects) throw new TransportFault("redirect_rejected", { httpStatus: status });
            const next = redirectUrl(request, url, response.headers.location ?? "");
            if (visited.has(next.href)) throw new TransportFault("redirect_rejected", { httpStatus: status });
            visited.add(next.href);
            url = next;
            continue;
          }
          if (status !== 200) throw new TransportFault("http_error", { httpStatus: status });
          const html = await readHtml(response, signal);
          if (permit) await permit.assertRunning(signal);
          active();
          checkPolicy(request, url);
          const headers: Record<string, string> = { "content-type": response.headers["content-type"]! };
          for (const name of ["cache-control", "expires", "date", "age", "vary"])
            if (response.headers[name] !== undefined) headers[name] = response.headers[name];
          page = { sourceId: request.sourceId, kind: request.kind, url: url.href,
            status, headers, html,
            capturedAt: new Date(deps.clock.now()).toISOString(), sampleKind: deps.sampleKind };
          break;
        } finally {
          response?.close();
          if (permit) { if (completionKnown) await permit.endAttempt(signal); }
          else lane.readyAt = deps.clock.now() + limits.intervalMs;
        }
      }
      if (permit) { await permit.release(signal); permit = undefined; }
      active(); checkPolicy(request, url);
      result = { ok: true, page };
    } catch (error) {
      const failure: unknown = signal.aborted ? signal.reason : error;
      result = failure instanceof TransportFault ? failure.failure : { ok: false, code: "network_error" };
    } finally {
      // Aborted callers return promptly; queued cleanup can only remove this owner's non-running row.
      if (permit) await permit.release(signal).catch(() => {});
      release?.();
      cancelTimer();
      caller?.removeEventListener("abort", abort);
    }
    return result;
  };
}
