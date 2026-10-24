import { Resolver } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { TRANSPORT_LIMITS, TransportFault, type Address, type WireResponse } from "./contracts.ts";

export const SOURCE_USER_AGENT = "LoopShelf/0.1 (+https://github.com/luuvish/loop-shelf)";

/** A dedicated resolver lets cancellation stop both A and AAAA queries for this operation. */
export async function resolveSourceHost(host: string, signal: AbortSignal): Promise<readonly Address[]> {
  signal.throwIfAborted();
  const resolver = new Resolver();
  const abort = () => resolver.cancel();
  signal.addEventListener("abort", abort, { once: true });
  const optional = async (query: Promise<string[]>): Promise<string[]> => {
    try { return await query; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENODATA" || code === "ENOTFOUND") return [];
      throw error;
    }
  };
  try {
    const [v4, v6] = await Promise.all([optional(resolver.resolve4(host)), optional(resolver.resolve6(host))]);
    signal.throwIfAborted();
    return [...v4.map((address): Address => ({ address, family: 4 })),
      ...v6.map((address): Address => ({ address, family: 6 }))];
  } finally {
    resolver.cancel();
    signal.removeEventListener("abort", abort);
  }
}

/** Keep Host/SNI/certificate checking on the source hostname; connect ONLY to the checked IP. */
export function pinnedOptions(url: URL, address: Address, signal: AbortSignal): RequestOptions & { autoSelectFamily: false } {
  return {
    method: "GET", protocol: "https:", hostname: url.hostname, port: 443,
    path: url.pathname + url.search, servername: url.hostname, rejectUnauthorized: true,
    agent: false, family: address.family, autoSelectFamily: false, signal,
    maxHeaderSize: TRANSPORT_LIMITS.maxHeaderBytes,
    lookup: (_host, options, callback) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    },
    headers: { "User-Agent": SOURCE_USER_AGENT, Accept: "text/html, application/xhtml+xml",
      "Accept-Encoding": "identity", Connection: "close" },
  };
}

/** Injectable native request only for offline driver tests. Not an application extension point. */
export function createNodeOpener(request: typeof httpsRequest = httpsRequest) {
  return (url: URL, address: Address, signal: AbortSignal): Promise<WireResponse> => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const req = request(pinnedOptions(url, address, signal), (response) => {
      if (signal.aborted) { response.destroy(); return; }
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "content-length", "content-encoding", "location", "retry-after", "cache-control", "expires", "date", "age", "vary"]) {
        const values = response.headersDistinct[name];
        if (values && values.length !== 1) {
          response.destroy(); req.destroy(); reject(new TransportFault("invalid_response")); return;
        }
        if (values?.[0] !== undefined) headers[name] = values[0];
      }
      // Body may error after headers but before its async iterator is attached.
      response.on("error", () => {});
      resolve({ status: response.statusCode ?? 0, headers, body: response,
        close: () => { response.destroy(); req.destroy(); } });
    });
    req.on("error", reject);
    req.end();
  });
}
