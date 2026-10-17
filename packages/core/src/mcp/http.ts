import { lookup as systemLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";

export interface McpHttpAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface McpHttpOptions {
  readonly endpoint: string;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  /** A whole exchange deadline, including DNS and consumption of the response stream. */
  readonly timeoutMs: number;
  /** Fixtures only: also requires NODE_ENV=test and MCP_ALLOW_LOOPBACK_FOR_TESTS=1. */
  readonly allowLoopbackForTests?: boolean;
  /** Fixtures only, guarded by the same two environment conditions as loopback. */
  readonly lookup?: (hostname: string) => Promise<readonly McpHttpAddress[]>;
}

/** close() fences synchronously and settles every owned native socket before resolving. */
export type McpHttpFetch = typeof globalThis.fetch & { close(): Promise<void> };

export type McpHttpErrorCode =
  | "invalid_options" | "invalid_request" | "endpoint_mismatch" | "method_rejected"
  | "header_rejected" | "address_rejected" | "dns_failed" | "redirect_rejected"
  | "request_too_large" | "response_too_large" | "response_rejected"
  | "aborted" | "deadline_exceeded" | "transport_failed";

/** Never includes a remote URL, response body, credential, DNS answer, or underlying error. */
export class McpHttpError extends Error {
  constructor(readonly code: McpHttpErrorCode) {
    super(`MCP HTTP ${code}.`);
    this.name = "McpHttpError";
  }
}

function fail(code: McpHttpErrorCode): never { throw new McpHttpError(code); }

function fixturesEnabled(): boolean {
  return process.env.NODE_ENV === "test" && process.env.MCP_ALLOW_LOOPBACK_FOR_TESTS === "1";
}

function hostnameOf(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inV4(address: number, network: string, bits: number): boolean {
  const divisor = 2 ** (32 - bits);
  return Math.floor(address / divisor) === Math.floor(ipv4Number(network) / divisor);
}

function ipv6Number(address: string): bigint | undefined {
  // Mapped/translated IPv4, zone identifiers, and transition mechanisms are never needed here.
  if (address.includes(".") || address.includes("%")) return undefined;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const padding = halves.length === 2 ? 8 - left.length - right.length : 0;
  if ((halves.length === 2 && padding < 1) || left.length + right.length + padding !== 8) return undefined;
  const words = [...left, ...Array<string>(padding).fill("0"), ...right];
  if (words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function inV6(address: bigint, network: bigint, bits: number): boolean {
  return address >> BigInt(128 - bits) === network >> BigInt(128 - bits);
}

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || (isIP(address) === 6 && ipv6Number(address) === 1n);
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const numeric = ipv4Number(address);
    // Reject the full special-purpose blocks, including publicly reachable special anycast ranges.
    const excluded: readonly [string, number][] = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
      ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !excluded.some(([network, bits]) => inV4(numeric, network, bits));
  }
  if (isIP(address) !== 6) return false;
  const numeric = ipv6Number(address);
  if (numeric === undefined || !inV6(numeric, 0x20000000000000000000000000000000n, 3)) return false;
  const excluded: readonly [bigint, number][] = [
    [0x20010000000000000000000000000000n, 23], // IETF special-purpose space (incl. Teredo/ORCHID).
    [0x20010db8000000000000000000000000n, 32], // Documentation.
    [0x20020000000000000000000000000000n, 16], // 6to4 can encode a private IPv4 destination.
    [0x2620004f800000000000000000000000n, 48], // Special-purpose AS112 anycast.
    [0x3ffe0000000000000000000000000000n, 16], // Deprecated 6bone space.
    [0x3fff0000000000000000000000000000n, 20], // Documentation.
  ];
  return !excluded.some(([network, bits]) => inV6(numeric, network, bits));
}

function parseEndpoint(value: string, allowFixtureHttp: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { return fail("invalid_options"); }
  if (url.username || url.password || url.href.includes("?") || url.href.includes("#") || !url.hostname
    || (url.protocol !== "https:" && !(allowFixtureHttp && url.protocol === "http:"))) fail("invalid_options");
  const hostname = hostnameOf(url).toLowerCase();
  if (hostname === "localhost" || /\.(localhost|local|internal|onion)$/.test(hostname)) fail("invalid_options");
  return url;
}

function requestHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of headers) {
    if (value.length > 1_024) fail("header_rejected");
    if (name === "accept") {
      const accepted = value.toLowerCase().split(",").map((part) => part.trim());
      if (!accepted.length || accepted.some((part) => part !== "application/json" && part !== "text/event-stream")) fail("header_rejected");
    } else if (name === "content-type") {
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)) fail("header_rejected");
    } else if (name === "mcp-protocol-version") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("header_rejected");
    } else if (name === "mcp-method") {
      if (!/^[a-zA-Z][a-zA-Z0-9_./-]{0,127}$/.test(value)) fail("header_rejected");
    } else if (name === "mcp-name") {
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) fail("header_rejected");
    } else fail("header_rejected");
    result[name] = value;
  }
  if (!result["content-type"]) fail("header_rejected");
  // Native requests never consult proxy variables, cookie jars, or global fetch dispatchers.
  result["accept-encoding"] = "identity";
  return result;
}

/**
 * Anonymous, POST-only Streamable HTTP substrate. This deliberately has no OAuth, session,
 * redirects, GET subscription, DELETE, or automatic retry path. Credential support must use a
 * separately reviewed owner-scoped contract rather than widening this header allowlist.
 */
export function createMcpHttpFetch(options: McpHttpOptions): McpHttpFetch {
  const { maxRequestBytes, maxResponseBytes, timeoutMs } = options;
  if ([maxRequestBytes, maxResponseBytes, timeoutMs].some((number) => !Number.isSafeInteger(number) || number <= 0 || number > 2_147_483_647)) fail("invalid_options");
  const fixtureOption = options.allowLoopbackForTests === true;
  const injectedLookup = options.lookup;
  if ((fixtureOption || injectedLookup) && !fixturesEnabled()) fail("invalid_options");
  const endpoint = parseEndpoint(options.endpoint, fixtureOption && fixturesEnabled());
  const endpointHref = endpoint.href;
  const hostname = hostnameOf(endpoint);
  const lookup = injectedLookup ?? (async (host: string): Promise<readonly McpHttpAddress[]> => {
    const answers = await systemLookup(host, { all: true, verbatim: true });
    return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  });
  const exchanges = new Set<{ cancel(): void; drained: Promise<void> }>();
  let fenced = false;

  const fetch: typeof globalThis.fetch = async (input, init): Promise<Response> => {
    if (fenced) fail("aborted");
    if ((fixtureOption || injectedLookup) && !fixturesEnabled()) fail("invalid_options");
    if (init && ["agent", "dispatcher", "proxy"].some((key) => Object.hasOwn(init, key))) fail("invalid_request");
    let request: Request;
    try { request = new Request(input, init); } catch { return fail("invalid_request"); }
    if (request.url !== endpointHref) fail("endpoint_mismatch");
    if (request.method !== "POST") fail("method_rejected");
    if (request.credentials === "include" || request.integrity || request.keepalive) fail("invalid_request");
    const headers = requestHeaders(request.headers);
    const signal = request.signal;
    if (signal.aborted) fail("aborted");

    return new Promise<Response>((resolve, reject) => {
      let outgoing: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let responseExposed = false;
      let finished = false;
      let stopping = Promise.resolve();
      let ownedSocket: Socket | undefined;
      let socketClosed = Promise.resolve();
      let resolveDrained!: () => void;
      const drained = new Promise<void>((settled) => { resolveDrained = settled; });
      const exchange = { cancel: () => stop("aborted"), drained };
      exchanges.add(exchange);

      const waitForNativeClose = async () => {
        if (outgoing && !outgoing.closed) await new Promise<void>((settled) => outgoing!.once("close", settled));
        if (ownedSocket && !ownedSocket.closed) await socketClosed;
      };
      const markDrained = () => {
        exchanges.delete(exchange);
        resolveDrained();
      };

      const clean = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const stop = (code: McpHttpErrorCode) => {
        if (finished) return;
        finished = true;
        clean();
        stopping = waitForNativeClose();
        outgoing?.destroy();
        incoming?.destroy();
        void bodyReader?.cancel().catch(() => {});
        const error = new McpHttpError(code);
        void stopping.then(() => {
          markDrained();
          if (responseExposed) streamController?.error(error);
          else reject(error);
        });
      };
      const abort = () => stop("aborted");
      const timer = setTimeout(() => stop("deadline_exceeded"), timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      // Close the race between the initial check and event registration.
      if (signal.aborted) { stop("aborted"); return; }

      void (async () => {
        try {
          const chunks: Uint8Array[] = [];
          let bodyBytes = 0;
          if (request.body) {
            bodyReader = request.body.getReader();
            while (!finished) {
              const next = await bodyReader.read();
              if (next.done) break;
              if (!(next.value instanceof Uint8Array)) return stop("invalid_request");
              bodyBytes += next.value.byteLength;
              if (bodyBytes > maxRequestBytes) return stop("request_too_large");
              chunks.push(new Uint8Array(next.value));
            }
          }
          if (finished) return;
          let answers: readonly McpHttpAddress[];
          try {
            answers = isIP(hostname)
              ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
              : await lookup(hostname);
          } catch { return stop("dns_failed"); }
          if (finished) return;
          if (!answers.length || answers.length > 64 || answers.some(({ address, family }) =>
            isIP(address) !== family || (!isPublicAddress(address) && !(fixtureOption && isLoopback(address))))) return stop("address_rejected");
          // HTTP is possible only for an explicitly enabled, entirely loopback fixture.
          if (endpoint.protocol === "http:" && !answers.every(({ address }) => isLoopback(address))) return stop("address_rejected");
          const selected = answers[0]!;
          headers["content-length"] = String(bodyBytes);
          const nativeRequest = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
          outgoing = nativeRequest({
            protocol: endpoint.protocol,
            hostname,
            port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
            path: `${endpoint.pathname}${endpoint.search}`,
            method: "POST",
            headers,
            agent: false,
            // A fixed 4/6 family disables Node's automatic dual-stack selection; lookup also
            // returns exactly the selected, already validated address, including in all mode.
            family: selected.family,
            maxHeaderSize: 16_384,
            // Preserve the hostname for Host, SNI and certificate identity, pin only socket DNS.
            ...(endpoint.protocol === "https:" ? { rejectUnauthorized: true, servername: isIP(hostname) ? undefined : hostname } : {}),
            lookup: (requestedHostname, lookupOptions, callback) => {
              if (requestedHostname !== hostname) { callback(new McpHttpError("endpoint_mismatch"), "", 0); return; }
              if (lookupOptions.all) callback(null, [{ address: selected.address, family: selected.family }]);
              else callback(null, selected.address, selected.family);
            },
          }, (message) => {
            incoming = message;
            if (finished) { message.destroy(); return; }
            const status = message.statusCode ?? 0;
            if (status >= 300 && status < 400) return stop("redirect_rejected");
            if (status < 200 || status > 599 || (message.headers["content-encoding"] && message.headers["content-encoding"] !== "identity")) return stop("response_rejected");
            const declared = message.headers["content-length"];
            if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) return stop("response_too_large");
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(message.headers)) {
              if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
            message.pause();
            let receivedBytes = 0;
            const stream = new ReadableStream<Uint8Array>({
              start(controller) { streamController = controller; },
              pull() { if (!finished) message.resume(); },
              cancel() { stop("aborted"); return stopping; },
            });
            message.on("data", (chunk: Buffer) => {
              if (finished) return;
              receivedBytes += chunk.byteLength;
              if (receivedBytes > maxResponseBytes) { stop("response_too_large"); return; }
              streamController!.enqueue(new Uint8Array(chunk));
              if ((streamController!.desiredSize ?? 0) <= 0) message.pause();
            });
            message.once("aborted", () => stop("transport_failed"));
            message.once("error", () => stop("transport_failed"));
            message.once("end", () => {
              if (finished) return;
              finished = true;
              clean();
              streamController!.close();
              stopping = waitForNativeClose();
              outgoing?.destroy();
              void stopping.then(markDrained);
            });
            try {
              const noBody = status === 204 || status === 205;
              const response = new Response(noBody ? null : stream, { status, statusText: message.statusMessage ?? "", headers: responseHeaders });
              Object.defineProperties(response, { url: { value: endpointHref }, type: { value: "basic" } });
              responseExposed = true;
              resolve(response);
              if (noBody) message.resume();
            } catch { stop("response_rejected"); }
          });
          outgoing.once("socket", (socket) => {
            ownedSocket = socket;
            socketClosed = socket.closed ? Promise.resolve() : new Promise<void>((settled) => socket.once("close", settled));
          });
          outgoing.once("error", () => stop("transport_failed"));
          outgoing.once("upgrade", (_response, socket) => { socket.destroy(); stop("response_rejected"); });
          outgoing.end(Buffer.concat(chunks, bodyBytes));
        } catch { stop("transport_failed"); }
      })();
    });
  };
  return Object.assign(fetch, {
    async close(): Promise<void> {
      fenced = true;
      const pending = [...exchanges];
      for (const exchange of pending) exchange.cancel();
      await Promise.all(pending.map((exchange) => exchange.drained));
    },
  });
}
