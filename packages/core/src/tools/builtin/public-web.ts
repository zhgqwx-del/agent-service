import { lookup as systemLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Transform } from "node:stream";

interface Address { readonly address: string; readonly family: 4 | 6 }
/** Internal fixture inputs. The product tool never supplies these or reads a bypass switch. */
export interface PublicWebTestOptions {
  readonly lookup?: (hostname: string) => Promise<readonly Address[]>;
  readonly allowLoopback?: boolean;
  readonly ca?: string;
  /** Tests may tighten, never extend the product's limits. */
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}
export interface PublicWebResponse {
  readonly status: number;
  readonly location: string | null;
  readonly text: string;
}
type ErrorCode = "invalid_options" | "invalid_url" | "address_rejected" | "dns_failed"
  | "aborted" | "deadline_exceeded" | "unsupported_encoding" | "transport_failed";
/** Remote URLs, resolved addresses, TLS errors and response bodies never enter error text. */
export class PublicWebError extends Error {
  constructor(readonly code: ErrorCode) { super(`Web fetch ${code}.`); this.name = "PublicWebError"; }
}
const fail = (code: ErrorCode): never => { throw new PublicWebError(code); };
function fixturesEnabled(): boolean {
  return process.env.NODE_ENV === "test" && process.env.WEB_FETCH_ALLOW_LOOPBACK_FOR_TESTS === "1";
}
function hostOf(url: URL): string { return url.hostname.replace(/^\[|\]$/g, ""); }
function v4Number(address: string): number { return address.split(".").reduce((n, part) => n * 256 + Number(part), 0); }
function v6Number(address: string): bigint | undefined {
  // Mapped IPv4, scoped literals and transition encodings are not public-web destinations.
  if (address.includes(".") || address.includes("%")) return undefined;
  const halves = address.toLowerCase().split("::"); if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [], right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const padding = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (padding < 0 || halves.length === 2 && padding < 1 || left.length + right.length + padding !== 8) return undefined;
  const words = [...left, ...Array<string>(padding).fill("0"), ...right];
  if (words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;
  return words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n);
}
function isPublic(address: string): boolean {
  if (isIP(address) === 4) {
    const value = v4Number(address);
    const blocks: readonly [string, number][] = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
      ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15],
      ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !blocks.some(([base, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)));
  }
  if (isIP(address) !== 6) return false;
  const value = v6Number(address); if (value === undefined || value >> 125n !== 1n) return false; // 2000::/3 only.
  const blocks: readonly [bigint, number][] = [
    [0x20010000000000000000000000000000n, 23], [0x20010db8000000000000000000000000n, 32],
    [0x20020000000000000000000000000000n, 16], [0x2620004f800000000000000000000000n, 48],
    [0x3ffe0000000000000000000000000000n, 16], [0x3fff0000000000000000000000000000n, 20],
  ];
  return !blocks.some(([base, bits]) => value >> BigInt(128 - bits) === base >> BigInt(128 - bits));
}
function loopback(address: string): boolean { return address === "127.0.0.1" || isIP(address) === 6 && v6Number(address) === 1n; }

/**
 * Anonymous GET, independent of MCP credential purposes and global fetch/proxy state.
 * The 15s exchange budget includes DNS and decoded body consumption. Cancellation is
 * cooperative for DNS: the promise retains ownership until DNS and native close settle.
 */
export async function readPublicWeb(url: URL, signal: AbortSignal, tests: PublicWebTestOptions = {}): Promise<PublicWebResponse> {
  const fixtureInputs = tests.lookup !== undefined || tests.allowLoopback !== undefined || tests.ca !== undefined;
  if (fixtureInputs && !fixturesEnabled()) fail("invalid_options");
  const timeoutMs = tests.timeoutMs ?? 15_000, maxBytes = tests.maxBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024) fail("invalid_options");
  // Copy the caller's mutable URL before awaiting DNS. Userinfo must never become native auth.
  const target = new URL(url.href), hostname = hostOf(target), lower = hostname.toLowerCase();
  if (!hostname || target.protocol !== "http:" && target.protocol !== "https:" || target.username || target.password) fail("invalid_url");
  if (lower === "localhost" || /\.(localhost|local|internal|onion)$/.test(lower)) fail("address_rejected");
  if (signal.aborted) fail("aborted");
  const lookup = tests.lookup ?? (async (host: string): Promise<readonly Address[]> => {
    const addresses = await systemLookup(host, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  });
  return new Promise<PublicWebResponse>((resolve, reject) => {
    let outgoing: ClientRequest | undefined, incoming: IncomingMessage | undefined, decoder: Transform | undefined, socket: Socket | undefined;
    let finished = false, status = 0, location: string | null = null, received = 0;
    const chunks: Buffer[] = [];
    let settleWork!: () => void;
    const workSettled = new Promise<void>(done => { settleWork = done; });
    const closed = async (resource: ClientRequest | IncomingMessage | Socket | Transform | undefined) => {
      if (resource && !resource.closed) await new Promise<void>(done => resource.once("close", done));
    };
    const finish = (error?: PublicWebError) => {
      if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      // Install the close listeners before destroying. DNS may still be pending;
      // no result escapes until that task and any late-assigned socket settle.
      const decoderClosed = closed(decoder), bodyClosed = closed(incoming), requestClosed = closed(outgoing);
      decoder?.destroy(); incoming?.destroy(); outgoing?.destroy();
      void (async () => {
        await workSettled; await Promise.all([decoderClosed, bodyClosed, requestClosed]); await closed(socket);
        if (error) reject(error);
        else resolve({ status, location, text: new TextDecoder().decode(Buffer.concat(chunks, received)) });
      })();
    };
    const abort = () => finish(new PublicWebError("aborted"));
    const timer = setTimeout(() => finish(new PublicWebError("deadline_exceeded")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { settleWork(); abort(); return; }
    void (async () => {
      try {
        let addresses: readonly Address[];
        try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }] : await lookup(hostname); }
        catch { finish(new PublicWebError("dns_failed")); return; }
        if (finished) return;
        if (fixtureInputs && !fixturesEnabled()) { finish(new PublicWebError("invalid_options")); return; }
        if (!addresses.length || addresses.length > 64 || addresses.some(({ address, family }) => isIP(address) !== family
          || !isPublic(address) && !(tests.allowLoopback === true && loopback(address)))) {
          finish(new PublicWebError("address_rejected")); return;
        }
        const selected = addresses[0]!, request = target.protocol === "https:" ? httpsRequest : httpRequest;
        outgoing = request({
          protocol: target.protocol, hostname, port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: `${target.pathname}${target.search}`, method: "GET", agent: false, family: selected.family, maxHeaderSize: 16_384,
          headers: { "user-agent": "agent-runner/0.1", accept: "*/*", "accept-encoding": "gzip, deflate, br" },
          ...(target.protocol === "https:" ? { rejectUnauthorized: true, servername: isIP(hostname) ? undefined : hostname,
            ...(tests.ca === undefined ? {} : { ca: tests.ca }) } : {}),
          // Keep hostname for Host/SNI/certificate identity. Native lookup can only
          // use this exact prevalidated address, never a second DNS resolution.
          lookup: (host, options, callback) => {
            if (host !== hostname) { callback(new PublicWebError("address_rejected"), "", 0); return; }
            if (options.all) callback(null, [{ address: selected.address, family: selected.family }]);
            else callback(null, selected.address, selected.family);
          },
        }, message => {
          incoming = message;
          const broken = () => finish(new PublicWebError("transport_failed"));
          message.once("aborted", broken); message.once("error", broken);
          if (finished) { message.destroy(); return; }
          status = message.statusCode ?? 0;
          if (status < 200 || status > 599) { finish(new PublicWebError("transport_failed")); return; }
          if (status >= 300 && status < 400) { location = message.headers.location ?? null; finish(); return; }
          const encoding = message.headers["content-encoding"]?.toLowerCase().trim();
          if (encoding && encoding !== "identity") {
            if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
            else if (encoding === "deflate") decoder = createInflate();
            else if (encoding === "br") decoder = createBrotliDecompress();
            else { finish(new PublicWebError("unsupported_encoding")); return; }
          }
          const body = decoder ?? message;
          decoder?.once("error", broken);
          body.on("data", (chunk: Buffer) => {
            if (finished) return;
            const part = chunk.subarray(0, maxBytes - received); chunks.push(Buffer.from(part)); received += part.byteLength;
            if (received >= maxBytes) finish();
          });
          body.once("end", () => finish());
          if (decoder) message.pipe(decoder);
        });
        outgoing.once("socket", owned => { socket = owned; });
        outgoing.once("error", () => finish(new PublicWebError("transport_failed")));
        outgoing.once("upgrade", (_response, owned) => { owned.destroy(); finish(new PublicWebError("transport_failed")); });
        outgoing.end();
      } catch { finish(new PublicWebError("transport_failed")); }
      finally { settleWork(); }
    })();
  });
}
