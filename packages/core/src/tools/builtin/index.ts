import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { RunnerTool } from "../types.js";

export const currentTimeTool: RunnerTool = {
  name: "current_time",
  description: "Get the current date and time. Optional IANA time zone (default Asia/Shanghai).",
  parameters: { type: "object", properties: { timeZone: { type: "string" } }, additionalProperties: false },
  kind: "builtin",
  readOnly: true,
  execute: async (args) => {
    const tz = (args as { timeZone?: string })?.timeZone ?? "Asia/Shanghai";
    const now = new Date();
    let text: string;
    try {
      text = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeStyle: "long", timeZone: tz }).format(now);
    } catch {
      return { content: [{ type: "text", text: `unknown time zone: ${tz}` }], isError: true };
    }
    return { content: [{ type: "text", text: `${text} (${tz}, epoch ${now.toISOString()})` }] };
  },
};

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/**
 * Reject hosts that resolve to anything non-public.
 *
 * `URL.hostname` keeps IPv6 literals wrapped in brackets (`[::1]`), which `isIP` rejects and DNS
 * would happily "resolve" via a wildcard, so brackets are stripped before any check. Every address a
 * name resolves to must be public, which closes the multi-A-record case but NOT rebinding between
 * this check and the socket connect — that needs a pinned-IP agent (tracked as a follow-up).
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const check = (ip: string) => {
    const v = isIP(ip);
    if (v === 0) throw new Error(`not an ip: ${ip}`);
    if (v === 4 && PRIVATE_V4.some((re) => re.test(ip))) throw new Error(`blocked private address ${ip}`);
    if (v === 6) {
      const low = ip.toLowerCase();
      // ::1 loopback, fc00::/7 ULA, fe80::/10 link-local, and any v4-mapped form
      if (low === "::1" || low === "::" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low)) throw new Error(`blocked private address ${ip}`);
      const mapped = /^::ffff:(.+)$/.exec(low)?.[1];
      if (mapped) {
        if (isIP(mapped) === 4) return check(mapped);
        throw new Error(`blocked v4-mapped address ${ip}`);
      }
    }
  };
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal") || lower.endsWith(".local")) throw new Error("blocked host");
  if (isIP(host)) return check(host);
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new Error("host does not resolve");
  for (const a of addrs) check(a.address);
}

/** Fetch a public HTTP(S) URL and return its text (HTML tags stripped). SSRF-guarded. */
export const webFetchTool: RunnerTool = {
  name: "web_fetch",
  description: "Fetch the content of a public http(s) URL and return it as text (max 64KB).",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  kind: "builtin",
  readOnly: true,
  needsApproval: false,
  execute: async (args, ctx) => {
    const { url } = args as { url: string };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { content: [{ type: "text", text: "invalid url" }], isError: true };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { content: [{ type: "text", text: "only http(s) urls are allowed" }], isError: true };
    try {
      await assertPublicHost(u.hostname);
    } catch (err) {
      return { content: [{ type: "text", text: `blocked: ${(err as Error).message}` }], isError: true };
    }
    const res = await fetch(u, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]), redirect: "manual", headers: { "user-agent": "agent-runner/0.1" } });
    if (res.status >= 300 && res.status < 400) {
      // Even a manual redirect may carry a response body/socket. Settle it before the tool (and
      // therefore the tenant turn lease) completes so runtime quiescence cannot miss live I/O.
      await res.body?.cancel().catch(() => {});
      return { content: [{ type: "text", text: `redirect to ${res.headers.get("location")} not followed` }], isError: true };
    }
    const raw = await readCapped(res, 256 * 1024);
    const text = raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 64 * 1024);
    return { content: [{ type: "text", text: `HTTP ${res.status}\n${text}` }], isError: !res.ok };
  },
};

/** Read at most `maxBytes`, abandoning the rest: a hostile endpoint must not be able to stream us to death. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      chunks.push(total > maxBytes ? value.subarray(0, value.byteLength - (total - maxBytes)) : value);
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

export const builtinTools: RunnerTool[] = [currentTimeTool, webFetchTool];
