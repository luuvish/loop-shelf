import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { request as httpsRequest, RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createNodeOpener, pinnedOptions, resolveSourceHost, SOURCE_USER_AGENT } from "../src/sources/transport/node-driver.ts";
import { TRANSPORT_LIMITS } from "../src/sources/transport/contracts.ts";

const url = new URL("https://www.zophar.net/search?search=sample");
const address = { address: "93.184.215.14", family: 4 as const };
function mockWire() {
  const incoming = new PassThrough() as PassThrough & { statusCode: number; headersDistinct: Record<string, string[]> };
  incoming.statusCode = 200;
  incoming.headersDistinct = { "content-type": ["text/html"], "set-cookie": ["private-session=value"] };
  const req = Object.assign(new EventEmitter(), { destroyed: false, end() {}, destroy() { this.destroyed = true; } });
  let options!: RequestOptions;
  let deliver!: () => void;
  const request = ((opts: RequestOptions, callback: (value: IncomingMessage) => void) => {
    options = opts;
    deliver = () => callback(incoming as unknown as IncomingMessage);
    return req;
  }) as unknown as typeof httpsRequest;
  return { incoming, req, request, options: () => options, deliver: () => deliver() };
}

test("native HTTPS options pin IP in both lookup modes while retaining hostname TLS and restrictive headers", () => {
  const controller = new AbortController();
  for (const ip of [address, { address: "2606:4700:4700::1111", family: 6 as const }]) {
    const options = pinnedOptions(url, ip, controller.signal);
    assert.equal(options.hostname, url.hostname); assert.equal(options.servername, url.hostname);
    assert.equal(options.port, 443); assert.equal(options.protocol, "https:"); assert.equal(options.method, "GET");
    assert.equal(options.path, "/search?search=sample"); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false); assert.equal(options.autoSelectFamily, false); assert.equal(options.family, ip.family);
    assert.equal(options.signal, controller.signal); assert.equal(options.maxHeaderSize, TRANSPORT_LIMITS.maxHeaderBytes);
    assert.equal(options.checkServerIdentity, undefined);
    assert.deepEqual(options.headers, { "User-Agent": SOURCE_USER_AGENT, Accept: "text/html, application/xhtml+xml",
      "Accept-Encoding": "identity", Connection: "close" });
    let called = 0;
    options.lookup!(url.hostname, { all: true }, (error, answer) => {
      called++; assert.equal(error, null); assert.deepEqual(answer, [ip]);
    });
    options.lookup!(url.hostname, {}, (error, answer, family) => {
      called++; assert.equal(error, null); assert.equal(answer, ip.address); assert.equal(family, ip.family);
    });
    assert.equal(called, 2);
  }
});

test("native opener passes the abort signal, exposes only relevant headers and closes both streams", async () => {
  const wire = mockWire(); const controller = new AbortController();
  wire.incoming.headersDistinct["cache-control"] = ["max-age=60"];
  const pending = createNodeOpener(wire.request)(url, address, controller.signal);
  assert.equal(wire.options().signal, controller.signal);
  wire.deliver(); const response = await pending;
  assert.deepEqual(response.headers, { "content-type": "text/html", "cache-control": "max-age=60" });
  const body = (async () => { let text = ""; for await (const chunk of response.body) text += Buffer.from(chunk).toString(); return text; })();
  wire.incoming.end("<html>sample</html>"); assert.equal(await body, "<html>sample</html>");
  response.close(); assert.ok(wire.req.destroyed); assert.ok(wire.incoming.destroyed);
});

test("native opener rejects duplicate control headers before body exposure", async () => {
  for (const name of ["content-type", "location", "retry-after", "content-length", "content-encoding", "cache-control", "vary"]) {
    const wire = mockWire(); wire.incoming.headersDistinct[name] = ["a", "b"];
    const pending = createNodeOpener(wire.request)(url, address, new AbortController().signal);
    wire.deliver(); await assert.rejects(pending, /invalid_response/);
    assert.ok(wire.req.destroyed); assert.ok(wire.incoming.destroyed);
  }
});

test("native errors reject, pre-aborted signals do not create requests, and late response is destroyed", async () => {
  const wire = mockWire(); const controller = new AbortController();
  const pending = createNodeOpener(wire.request)(url, address, controller.signal);
  controller.abort(); wire.req.emit("error", new Error("aborted"));
  await assert.rejects(pending, /aborted/); wire.deliver(); assert.ok(wire.incoming.destroyed);
  const unused = mockWire();
  await assert.rejects(createNodeOpener(unused.request)(url, address, controller.signal));
  assert.equal(unused.options(), undefined);
});

test("DNS resolver gathers both families and cleans up its dedicated resolver", async (t) => {
  const queries: string[] = []; const owners = new Set<Resolver>(); let cancelled = 0;
  t.mock.method(Resolver.prototype, "resolve4", async function(this: Resolver, host: string) {
    owners.add(this); queries.push(host); return [address.address];
  });
  t.mock.method(Resolver.prototype, "resolve6", async function(this: Resolver, host: string) {
    owners.add(this); queries.push(host); return ["2606:4700:4700::1111"];
  });
  t.mock.method(Resolver.prototype, "cancel", () => { cancelled++; });
  const result = await resolveSourceHost(url.hostname, new AbortController().signal);
  assert.deepEqual(result, [address, { address: "2606:4700:4700::1111", family: 6 }]);
  assert.deepEqual(queries, [url.hostname, url.hostname]); assert.equal(owners.size, 1); assert.equal(cancelled, 1);
});

test("DNS absent family is accepted but resolver/network failure cannot become an empty successful lookup", async (t) => {
  t.mock.method(Resolver.prototype, "resolve4", async () => [address.address]);
  const ipv6 = t.mock.method(Resolver.prototype, "resolve6", async () => { throw Object.assign(new Error(), { code: "ENODATA" }); });
  let cancelled = 0; t.mock.method(Resolver.prototype, "cancel", () => { cancelled++; });
  assert.deepEqual(await resolveSourceHost(url.hostname, new AbortController().signal), [address]);
  ipv6.mock.mockImplementation(async () => { throw Object.assign(new Error("DNS failed"), { code: "ESERVFAIL" }); });
  await assert.rejects(resolveSourceHost(url.hostname, new AbortController().signal), /DNS failed/);
  assert.equal(cancelled, 2);
});

test("DNS cancellation calls cancel on its own resolver and discards the result", async (t) => {
  let reject4!: (error: Error) => void; let reject6!: (error: Error) => void; let cancelled = 0;
  t.mock.method(Resolver.prototype, "resolve4", () => new Promise((_resolve, reject) => { reject4 = reject; }));
  t.mock.method(Resolver.prototype, "resolve6", () => new Promise((_resolve, reject) => { reject6 = reject; }));
  t.mock.method(Resolver.prototype, "cancel", () => {
    cancelled++; reject4(new Error("DNS cancelled")); reject6(new Error("DNS cancelled"));
  });
  const controller = new AbortController(); const pending = resolveSourceHost(url.hostname, controller.signal);
  controller.abort(); await assert.rejects(pending, /DNS cancelled/); assert.equal(cancelled, 2);
});
