import type { SourceId } from "../types.ts";
import { parseHttpDate } from "../http-date.ts";
import { selectAddress } from "./addresses.ts";
import { redirectUrl, requestUrl } from "./requests.ts";
import { abortable, TRANSPORT_LIMITS as limits, TransportFault,
  type SourceRequest, type TransportDependencies, type TransportResult, type WireResponse } from "./contracts.ts";

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

function cooldown(header: string | undefined, now: number): number {
  if (header && /^\d+$/.test(header.trim())) {
    // Oversized valid delta-seconds never shorten the upstream waiting period.
    return Math.min(Number.MAX_SAFE_INTEGER, now + Number(header.trim()) * 1000);
  }
  // Avoid Date.parse interpreting malformed numeric values (e.g. "1.5") as dates.
  const date = header ? parseHttpDate(header) : NaN;
  return Number.isFinite(date) && date > now ? date : now + limits.fallbackCooldownMs;
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
  };
  const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = deps.clock.timer(ms, () => { signal.removeEventListener("abort", abort); resolve(); });
    const abort = () => { cancel(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
  return async (input: SourceRequest, caller?: AbortSignal): Promise<TransportResult> => {
    const controller = new AbortController();
    const signal = controller.signal;
    const abort = () => controller.abort(new TransportFault("cancelled"));
    const cancelTimer = deps.clock.timer(limits.timeoutMs, () => controller.abort(new TransportFault("timeout")));
    if (caller?.aborted) abort(); else caller?.addEventListener("abort", abort, { once: true });
    let release: (() => void) | undefined;
    try {
      // Snapshot caller-owned fields before the first await.
      const request = { ...input };
      let url = requestUrl(request);
      signal.throwIfAborted();
      check(request, url);
      const lane = lanes[request.sourceId];
      const checkCooldown = () => {
        if (lane.cooldownUntil > deps.clock.now())
          throw new TransportFault("rate_limited", { retryAt: lane.cooldownUntil });
      };
      checkCooldown();
      release = await lane.acquire(signal);
      const visited = new Set([url.href]);
      for (let hop = 0; ; hop++) {
        signal.throwIfAborted();
        check(request, url);
        checkCooldown();
        if (lane.readyAt > deps.clock.now()) await wait(lane.readyAt - deps.clock.now(), signal);
        signal.throwIfAborted();
        check(request, url);
        checkCooldown();
        let response: WireResponse | undefined;
        try {
          const addresses = await abortable(deps.resolve(url.hostname, signal), signal);
          const address = selectAddress(addresses);
          signal.throwIfAborted();
          check(request, url);
          response = await abortable(deps.open(url, address, signal), signal, (late) => late.close());
          signal.throwIfAborted();
          const status = response.status;
          if (status === 429) {
            lane.cooldownUntil = Math.max(lane.cooldownUntil, cooldown(response.headers["retry-after"], deps.clock.now()));
            throw new TransportFault("rate_limited", { httpStatus: status, retryAt: lane.cooldownUntil });
          }
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
          signal.throwIfAborted();
          check(request, url);
          const headers: Record<string, string> = { "content-type": response.headers["content-type"]! };
          for (const name of ["cache-control", "expires", "date", "age", "vary"])
            if (response.headers[name] !== undefined) headers[name] = response.headers[name];
          return { ok: true, page: { sourceId: request.sourceId, kind: request.kind, url: url.href,
            status, headers, html,
            capturedAt: new Date(deps.clock.now()).toISOString(), sampleKind: deps.sampleKind } };
        } finally {
          response?.close();
          lane.readyAt = deps.clock.now() + limits.intervalMs;
        }
      }
    } catch (error) {
      const failure: unknown = signal.aborted ? signal.reason : error;
      return failure instanceof TransportFault ? failure.failure : { ok: false, code: "network_error" };
    } finally {
      release?.();
      cancelTimer();
      caller?.removeEventListener("abort", abort);
    }
  };
}
