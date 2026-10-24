import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { captureSourcePage } from "../src/sources/transport.ts";
import { sourceAssessments } from "../src/sources/policies.ts";
import { inspectCapturedPage } from "../src/sources/parsers.ts";
import { createTransport } from "../src/sources/transport/engine.ts";
import { isPublicAddress, selectAddress } from "../src/sources/transport/addresses.ts";
import { redirectUrl, requestUrl } from "../src/sources/transport/requests.ts";
import { TRANSPORT_LIMITS as limits, TransportFault, type Address, type SourceRequest,
  type TransportClock, type TransportDependencies, type TransportResult, type WireResponse } from "../src/sources/transport/contracts.ts";

const search: SourceRequest = { sourceId: "zophar", kind: "search", query: "sample" };
const publicIp: Address = { address: "93.184.215.14", family: 4 };
const tick = () => setImmediate();
class Clock implements TransportClock {
  time = Date.parse("2026-10-24T00:00:00Z");
  timers = new Set<{ at: number; callback: () => void }>();
  now = () => this.time;
  timer(ms: number, callback: () => void) {
    const timer = { at: this.time + ms, callback };
    this.timers.add(timer);
    return () => { this.timers.delete(timer); };
  }
  async advance(ms: number) {
    const end = this.time + ms;
    await tick();
    while (true) {
      const next = [...this.timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      this.time = next.at;
      this.timers.delete(next);
      next.callback();
      await tick();
    }
    this.time = end;
    await tick();
  }
}
function response(status = 200, headers: Record<string, string> = {}, chunks = [Buffer.from("<html>sample</html>")]) {
  const state = { closed: 0, read: 0 };
  const value: WireResponse = { status, headers: { "content-type": "text/html; charset=UTF-8", ...headers },
    body: { async *[Symbol.asyncIterator]() { for (const chunk of chunks) { state.read++; yield chunk; } } },
    close() { state.closed++; } };
  return { value, state };
}
function harness(overrides: Partial<TransportDependencies> = {}) {
  const clock = new Clock();
  const calls: { url: string; address: Address; at: number; signal: AbortSignal }[] = [];
  const resolved: string[] = [];
  const replies: ReturnType<typeof response>[] = [];
  const deps: TransportDependencies = {
    clock, sampleKind: "synthetic", authorize: () => ({ allowed: true }),
    async resolve(host) { resolved.push(host); return [publicIp]; },
    async open(url, address, signal) {
      calls.push({ url: url.href, address, at: clock.now(), signal });
      const reply = response(); replies.push(reply); return reply.value;
    }, ...overrides,
  };
  return { clock, calls, resolved, replies, deps, run: createTransport(deps) };
}
function failed(result: TransportResult, code: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected failure");
  assert.equal(result.code, code);
  return result;
}

test("product transport remains policy_disabled for both sources and operations", async (t) => {
  const dns = t.mock.method(Resolver.prototype, "resolve4", () => { throw new Error("Unexpected network access"); });
  const before = JSON.stringify(sourceAssessments);
  for (const sourceId of ["khinsider", "zophar"] as const) {
    failed(await captureSourcePage({ sourceId, kind: "search", query: "sample" }), "policy_disabled");
    failed(await captureSourcePage({ sourceId, kind: "album", externalKey: sourceId === "zophar" ? "snes/sample" : "sample" }), "policy_disabled");
  }
  assert.equal(JSON.stringify(sourceAssessments), before);
  assert.equal(dns.mock.callCount(), 0);
});

test("denied policy stops before DNS and wire, with no leftover timer", async () => {
  for (const code of ["policy_disabled", "blocked"] as const) {
    const h = harness({ authorize: () => ({ allowed: false, code }) });
    failed(await h.run(search), code);
    assert.equal(h.resolved.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.clock.timers.size, 0);
  }
});

test("request builders accept only source search text and canonical album keys", () => {
  assert.equal(requestUrl({ sourceId: "khinsider", kind: "search", query: "  星の庭 / &😀  " }).href,
    "https://downloads.khinsider.com/search?search=%E6%98%9F%E3%81%AE%E5%BA%AD+%2F+%26%F0%9F%98%80&type=album");
  assert.equal(requestUrl({ sourceId: "zophar", kind: "album", externalKey: "snes/星の庭" }).pathname,
    "/music/snes/%E6%98%9F%E3%81%AE%E5%BA%AD.html");
  for (const query of ["", " ", "x".repeat(201), "bad\nquery", "\ud800"])
    assert.throws(() => requestUrl({ ...search, kind: "search", query }), /invalid_input/);
  for (const externalKey of ["http://localhost/a", "snes/../a", "snes/%2e", "snes/a?x", "snes/a\\b", "snes/..", "year/a"])
    assert.throws(() => requestUrl({ sourceId: "zophar", kind: "album", externalKey }), /invalid_input/);
  assert.throws(() => requestUrl({ ...search, sourceId: "invalid" } as unknown as SourceRequest), /invalid_input/);
});

test("redirect accepts only same resource spelling and rejects URL/path/query escapes", () => {
  const request: SourceRequest = { sourceId: "khinsider", kind: "album", externalKey: "sample" };
  const current = requestUrl(request);
  assert.equal(redirectUrl(request, current, "/game-soundtracks/album/sample/").pathname, "/game-soundtracks/album/sample/");
  for (const location of ["http://downloads.khinsider.com/game-soundtracks/album/sample", "//127.0.0.1/a",
    "https://downloads.khinsider.com:444/game-soundtracks/album/sample", "https://evil.example/a", "/login",
    "/game-soundtracks/album/other", "/game-soundtracks/album/sample?token=x", "/game-soundtracks/album/sample#x",
    "https://u:p@downloads.khinsider.com/game-soundtracks/album/sample", "/x/../game-soundtracks/album/sample",
    "/%2e%2e/game-soundtracks/album/sample", "\\evil.example\\x", " /game-soundtracks/album/sample"])
    assert.throws(() => redirectUrl(request, current, location), /redirect_rejected/, location);
  for (const location of ["/search?search=other", "/search?search=sample&page=2", "/search?search=sample&search=sample"])
    assert.throws(() => redirectUrl(search, requestUrl(search), location), /redirect_rejected/);
});

test("IP guard rejects non-public IPv4/IPv6, unusual encodings and mixed DNS answers", () => {
  for (const address of ["0.1.2.3", "10.0.0.1", "100.64.0.1", "127.1.2.3", "169.254.169.254", "172.16.1.2",
    "192.0.0.9", "192.0.2.1", "192.88.99.2", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "224.0.0.1", "255.255.255.255", "2130706433", "0177.0.0.1", "0x7f000001"])
    assert.equal(isPublicAddress({ address, family: 4 }), false, address);
  for (const address of ["::", "::1", "::ffff:127.0.0.1", "::ffff:93.184.215.14", "64:ff9b::7f00:1", "100::1",
    "2001::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1", "5f00::1", "fc00::1", "fe80::1", "ff02::1", "2606:4700::1%eth0"])
    assert.equal(isPublicAddress({ address, family: 6 }), false, address);
  assert.ok(isPublicAddress(publicIp)); assert.ok(isPublicAddress({ address: "2606:4700:4700::1111", family: 6 }));
  assert.equal(isPublicAddress({ ...publicIp, family: 6 }), false);
  assert.throws(() => selectAddress([]), /unsafe_address/);
  assert.throws(() => selectAddress([publicIp, { address: "127.0.0.1", family: 4 }]), /unsafe_address/);
});

test("unsafe DNS and lookup failure produce errors without opening HTTP", async () => {
  for (const addresses of [[], [{ address: "127.0.0.1", family: 4 }], [publicIp, { address: "::1", family: 6 }]] as Address[][]) {
    const h = harness({ resolve: async () => addresses });
    failed(await h.run(search), "unsafe_address"); assert.equal(h.calls.length, 0);
  }
  const h = harness({ resolve: async () => { throw new Error("secret upstream detail"); } });
  assert.deepEqual(await h.run(search), { ok: false, code: "network_error" });
});

test("successful capture keeps synthetic provenance and no cookies/irrelevant headers", async () => {
  const reply = response(200, { "set-cookie": "secret", authorization: "secret", location: "secret", "cache-control": "no-store", vary: "*" },
    [readFileSync(new URL("./fixtures/zophar-search.html", import.meta.url))]);
  const h = harness({ open: async () => reply.value });
  const result = await h.run(search);
  assert.ok(result.ok);
  assert.equal(result.page.sampleKind, "synthetic"); assert.equal(result.page.capturedAt, "2026-10-24T00:00:00.000Z");
  assert.deepEqual(Object.keys(result.page.headers), ["content-type", "cache-control", "vary"]);
  assert.equal(result.page.headers["cache-control"], "no-store"); assert.equal(result.page.headers.vary, "*");
  const parsed = inspectCapturedPage(result.page);
  assert.ok(parsed.ok && parsed.data.kind === "search");
  assert.equal(parsed.data.albums.length, 2); assert.equal(reply.state.closed, 1);
});

test("capture success still requires parser validation; challenge and changed HTML are not zero results", async () => {
  for (const [html, code] of [["<title>Just a moment...</title>", "blocked"], ["<h1>New layout</h1>", "parse_changed"]]) {
    const h = harness({ open: async () => response(200, {}, [Buffer.from(html!)]).value });
    const result = await h.run(search); assert.ok(result.ok);
    const parsed = inspectCapturedPage(result.page); assert.ok(!parsed.ok); assert.equal(parsed.code, code);
  }
});

test("HTTP failures close without consuming a body or automatic retries", async () => {
  for (const [status, code] of [[401, "blocked"], [403, "blocked"], [407, "blocked"], [451, "blocked"],
    [404, "not_found"], [410, "not_found"], [500, "http_error"], [503, "http_error"], [204, "http_error"], [304, "http_error"]] as const) {
    const reply = response(status); let count = 0;
    const h = harness({ open: async () => { count++; return reply.value; } });
    const result = failed(await h.run(search), code);
    assert.equal(result.httpStatus, status); assert.equal(count, 1);
    assert.equal(reply.state.read, 0); assert.equal(reply.state.closed, 1);
  }
});

test("response type, compression, charset and content length are validated before reading", async () => {
  for (const headers of [{ "content-type": "audio/mpeg" }, { "content-type": "application/json" },
    { "content-type": "text/html; charset=shift_jis" }, { "content-encoding": "gzip" },
    { "content-length": "-1" }, { "content-length": "3, 3" }, { "content-length": String(limits.maxBodyBytes + 1) }]) {
    const reply = response(200, headers);
    const h = harness({ open: async () => reply.value });
    failed(await h.run(search), headers["content-length"] === String(limits.maxBodyBytes + 1) ? "response_too_large" : "invalid_response");
    assert.equal(reply.state.read, 0); assert.equal(reply.state.closed, 1);
  }
});

test("stream byte limit applies without Content-Length; exact limit succeeds and oversized stream stops early", async () => {
  const chunk = Buffer.alloc(limits.maxBodyBytes, 32);
  for (const extra of [false, true]) {
    const reply = response(200, {}, extra ? [chunk, Buffer.from("x"), Buffer.from("unread")] : [chunk]);
    const h = harness({ open: async () => reply.value }); const result = await h.run(search);
    if (extra) { failed(result, "response_too_large"); assert.equal(reply.state.read, 2); }
    else assert.ok(result.ok);
    assert.equal(reply.state.closed, 1);
  }
});

test("truncated lengths, invalid UTF-8 and interrupted body are failures", async () => {
  for (const reply of [response(200, { "content-length": "999" }), response(200, {}, [Buffer.from([0xff])])]) {
    failed(await harness({ open: async () => reply.value }).run(search), "invalid_response");
    assert.equal(reply.state.closed, 1);
  }
  const reply = response();
  reply.value.body = { async *[Symbol.asyncIterator]() { yield Buffer.from("x"); throw new Error("reset"); } };
  failed(await harness({ open: async () => reply.value }).run(search), "network_error");
  assert.equal(reply.state.closed, 1);
});

test("per-source queue is serial and waits three seconds after the previous response completes", async () => {
  const h = harness();
  const one = h.run(search); const two = h.run(search); const three = h.run(search);
  await tick(); assert.equal(h.calls.length, 1); assert.ok((await one).ok);
  await h.clock.advance(2999); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); assert.ok((await two).ok); assert.equal(h.calls.length, 2);
  await h.clock.advance(3000); assert.ok((await three).ok);
  assert.deepEqual(h.calls.map((call) => call.at - h.calls[0]!.at), [0, 3000, 6000]);
  assert.equal(h.clock.timers.size, 0);
});

test("another source is not blocked by a stalled source, and active concurrency is one", async () => {
  let finish!: (value: WireResponse) => void; let opened = 0;
  const h = harness({ open: async (url) => {
    opened++;
    return url.hostname === "www.zophar.net" ? new Promise((resolve) => { finish = resolve; }) : response().value;
  } });
  const first = h.run(search); const secondController = new AbortController();
  const second = h.run(search, secondController.signal);
  assert.ok((await h.run({ sourceId: "khinsider", kind: "search", query: "sample" })).ok);
  assert.equal(opened, 2); secondController.abort(); failed(await second, "cancelled");
  finish(response().value); assert.ok((await first).ok);
});

test("queue capacity is bounded and a queued cancellation frees capacity immediately", async () => {
  const h = harness({ resolve: () => new Promise(() => {}) });
  const controller = new AbortController();
  const active = h.run(search, controller.signal);
  const waiters = Array.from({ length: limits.maxWaiting }, () => new AbortController());
  const pending = waiters.map((c) => h.run(search, c.signal));
  failed(await h.run(search), "queue_full");
  waiters[0]!.abort(); failed(await pending[0]!, "cancelled");
  const replacement = h.run(search, controller.signal);
  controller.abort(); waiters.forEach((c) => c.abort());
  for (const result of await Promise.all([active, ...pending, replacement])) failed(result, "cancelled");
  assert.equal(h.clock.timers.size, 0);
});

test("queue time is part of the total deadline and expiry frees the lane", async () => {
  const h = harness({ resolve: () => new Promise(() => {}) });
  const first = h.run(search); const second = h.run(search);
  await h.clock.advance(limits.timeoutMs);
  failed(await first, "timeout"); failed(await second, "timeout");
  h.deps.resolve = async () => [publicIp];
  const next = h.run(search); await h.clock.advance(3000);
  assert.ok((await next).ok); assert.equal(h.clock.timers.size, 0);
});

test("pre-cancellation and cancellation during DNS prevent HTTP, including late resolution", async () => {
  let resolve!: (addresses: Address[]) => void;
  const h = harness({ resolve: () => new Promise((done) => { resolve = done; }) });
  const cancelled = new AbortController(); cancelled.abort();
  failed(await h.run(search, cancelled.signal), "cancelled"); assert.equal(h.calls.length, 0);
  const controller = new AbortController(); const pending = h.run(search, controller.signal);
  await tick(); controller.abort(); failed(await pending, "cancelled");
  resolve([publicIp]); await tick(); assert.equal(h.calls.length, 0); assert.equal(h.clock.timers.size, 0);
});

test("deadline covers DNS, headers and stalled body; late headers are closed", async () => {
  for (const stage of ["dns", "headers", "body"] as const) {
    let finish!: (reply: WireResponse) => void;
    const reply = response(); let signal!: AbortSignal;
    if (stage === "body") reply.value.body = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    const h = harness({
      resolve: async (_host, current) => { signal = current; return stage === "dns" ? new Promise(() => {}) : [publicIp]; },
      open: async () => stage === "headers" ? new Promise((resolve) => { finish = resolve; }) : reply.value,
    });
    const pending = h.run(search); await h.clock.advance(limits.timeoutMs);
    failed(await pending, "timeout"); assert.ok(signal.aborted);
    if (stage === "headers") { finish(reply.value); await tick(); }
    assert.equal(reply.state.closed, stage === "dns" ? 0 : 1); assert.equal(h.clock.timers.size, 0);
  }
});

test("cancellation during interval or body releases work without retry", async () => {
  const h = harness(); await h.run(search);
  const c = new AbortController(); const pending = h.run(search, c.signal);
  await tick(); c.abort(); failed(await pending, "cancelled"); assert.equal(h.calls.length, 1);
  const reply = response();
  reply.value.body = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  const slow = harness({ open: async () => reply.value });
  const c2 = new AbortController(); const body = slow.run(search, c2.signal);
  await tick(); c2.abort(); failed(await body, "cancelled"); assert.equal(reply.state.closed, 1);
});

test("policy is checked again after queue wait, DNS and before returning the body", async () => {
  let allowed = true;
  const h = harness({ authorize: () => allowed ? { allowed: true } : { allowed: false, code: "policy_disabled" } });
  await h.run(search);
  const waiting = h.run(search); await tick(); allowed = false;
  await h.clock.advance(3000); failed(await waiting, "policy_disabled"); assert.equal(h.calls.length, 1);
  allowed = true;
  const dns = harness({ authorize: h.deps.authorize, resolve: async () => { allowed = false; return [publicIp]; } });
  failed(await dns.run(search), "policy_disabled"); assert.equal(dns.calls.length, 0);
  allowed = true;
  const reply = response();
  reply.value.body = { async *[Symbol.asyncIterator]() { yield Buffer.from("x"); allowed = false; } };
  failed(await harness({ authorize: h.deps.authorize, open: async () => reply.value }).run(search), "policy_disabled");
  assert.equal(reply.state.closed, 1);
});

test("caller mutation during a request cannot change its source/query", async () => {
  const h = harness(); const input: SourceRequest = { ...search };
  const pending = h.run(input);
  input.sourceId = "khinsider";
  assert.ok((await pending).ok); assert.equal(h.calls[0]?.url, requestUrl(search).href);
});

test("429 delta/date/fallback cooldown blocks DNS, survives failed calls and isolates sources", async () => {
  for (const header of ["120", "Sat, 24 Oct 2026 00:02:00 GMT", "invalid", "-1", "1.5"]) {
    const reply = response(429, { "retry-after": header }); let count = 0;
    const h = harness({ open: async () => { count++; return count === 1 ? reply.value : response().value; } });
    const now = h.clock.now(); const failure = failed(await h.run(search), "rate_limited");
    assert.equal(failure.retryAt, now + (["120", "Sat, 24 Oct 2026 00:02:00 GMT"].includes(header) ? 120_000 : 60_000));
    failed(await h.run(search), "rate_limited"); assert.equal(h.resolved.length, 1);
    assert.ok((await h.run({ sourceId: "khinsider", kind: "search", query: "sample" })).ok);
    await h.clock.advance(failure.retryAt! - h.clock.now());
    assert.ok((await h.run(search)).ok); assert.equal(reply.state.read, 0); assert.equal(reply.state.closed, 1);
  }
});

test("huge Retry-After is not shortened and queued requests see the new cooldown", async () => {
  const h = harness({ open: async () => response(429, { "retry-after": "99999999999999999999999999" }).value });
  const one = h.run(search); const two = h.run(search);
  assert.equal(failed(await one, "rate_limited").retryAt, Number.MAX_SAFE_INTEGER);
  failed(await two, "rate_limited"); assert.equal(h.resolved.length, 1);
});

test("redirect hop rechecks DNS, rate spacing and policy; private rebinding is rejected", async () => {
  let dnsCount = 0; const reply = response(302, { location: "/game-soundtracks/album/sample/" });
  const h = harness({ resolve: async () => ++dnsCount === 1 ? [publicIp] : [{ address: "127.0.0.1", family: 4 }],
    open: async () => reply.value });
  const pending = h.run({ sourceId: "khinsider", kind: "album", externalKey: "sample" });
  await tick(); assert.equal(dnsCount, 1); assert.equal(reply.state.closed, 1); assert.equal(reply.state.read, 0);
  await h.clock.advance(3000); failed(await pending, "unsafe_address"); assert.equal(dnsCount, 2);
  let allowed = true;
  const policy = harness({ authorize: () => allowed ? { allowed: true } : { allowed: false, code: "blocked" },
    open: async () => { allowed = false; return reply.value; } });
  failed(await policy.run({ sourceId: "khinsider", kind: "album", externalKey: "sample" }), "blocked");
  assert.equal(policy.resolved.length, 1);
});

test("redirect success preserves final URL; loops, login and third hop fail", async () => {
  const request: SourceRequest = { sourceId: "khinsider", kind: "album", externalKey: "sample" };
  let count = 0;
  const h = harness({ open: async () => ++count === 1 ? response(302, { location: "/game-soundtracks/album/sample/" }).value : response().value });
  const pending = h.run(request); await h.clock.advance(3000); const result = await pending;
  assert.ok(result.ok); assert.equal(result.page.url, requestUrl(request).href + "/"); assert.equal(count, 2);
  for (const location of [requestUrl(request).href, "/login", "https://evil.example/"])
    failed(await harness({ open: async () => response(302, { location }).value }).run(request), "redirect_rejected");
  let hop = 0;
  const paths = ["/game-soundtracks/album/%73ample", "/game-soundtracks/album/%73ample/", "/game-soundtracks/album/s%61mple"];
  const many = harness({ open: async () => response(302, { location: paths[hop++]! }).value });
  const loop = many.run(request); await many.clock.advance(6000); failed(await loop, "redirect_rejected"); assert.equal(hop, 3);
});

test("transport faults are preserved while internal exception messages are not exposed", async () => {
  const h = harness({ open: async () => { throw new TransportFault("invalid_response"); } });
  failed(await h.run(search), "invalid_response");
  const other = harness({ open: async () => { throw new Error("credential / private path"); } });
  assert.deepEqual(await other.run(search), { ok: false, code: "network_error" });
});

test("failed DNS and HTTP attempts also enforce the source interval before a new lookup", async () => {
  for (const failure of ["dns", "http"]) {
    let count = 0;
    const h = harness({ resolve: async () => {
      count++;
      if (failure === "dns") throw new Error("DNS failure");
      return [publicIp];
    }, open: async () => response(503).value });
    failed(await h.run(search), failure === "dns" ? "network_error" : "http_error");
    const next = h.run(search); await h.clock.advance(2999); assert.equal(count, 1);
    await h.clock.advance(1); failed(await next, failure === "dns" ? "network_error" : "http_error");
    assert.equal(count, 2);
  }
});

test("Retry-After accepts HTTP date variants and defaults conservatively for absent or past dates", async () => {
  for (const header of [undefined, "Fri, 23 Oct 2026 00:00:00 GMT", "Saturday, 24-Oct-26 00:02:00 GMT", "Sat Oct 24 00:02:00 2026"]) {
    const h = harness({ open: async () => response(429, header ? { "retry-after": header } : {}).value });
    const result = failed(await h.run(search), "rate_limited");
    assert.equal(result.retryAt, h.clock.now() + (header?.includes("00:02:00") ? 120_000 : 60_000));
  }
});
