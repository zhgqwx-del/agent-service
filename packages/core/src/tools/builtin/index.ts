import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { RunnerTool } from "../types.js";
import { createWebFetchTool } from "./web-fetch-tool.js";

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
 * name resolves to must be public. This exported helper is a preflight only, not a socket
 * capability. web_fetch uses its separate pinned native GET below; other callers must likewise
 * bind their own actual requests instead of treating this check as DNS-rebinding protection.
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
export const webFetchTool: RunnerTool = createWebFetchTool();

export const builtinTools: RunnerTool[] = [currentTimeTool, webFetchTool];
