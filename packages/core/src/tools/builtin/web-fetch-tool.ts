import type { RunnerTool } from "../types.js";
import { PublicWebError, readPublicWeb, type PublicWebResponse, type PublicWebTestOptions } from "./public-web.js";

/** Internal factory, deliberately not re-exported from the product core API. */
export function createWebFetchTool(tests: PublicWebTestOptions = {}): RunnerTool { return {
  name: "web_fetch",
  description: "Fetch the content of a public http(s) URL and return it as text (max 64KB).",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
  kind: "builtin",
  readOnly: true,
  needsApproval: false,
  execute: async (args, ctx) => {
    const { url } = args as { url: string };
    let target: URL;
    try { target = new URL(url); }
    catch { return { content: [{ type: "text", text: "invalid url" }], isError: true }; }
    if (target.protocol !== "http:" && target.protocol !== "https:") return { content: [{ type: "text", text: "only http(s) urls are allowed" }], isError: true };
    if (target.username || target.password) return { content: [{ type: "text", text: "blocked: URL credentials are not allowed" }], isError: true };
    let result: PublicWebResponse;
    try { result = await readPublicWeb(target, ctx.signal, tests); }
    catch (error) {
      if (error instanceof PublicWebError && (error.code === "address_rejected" || error.code === "dns_failed")) {
        return { content: [{ type: "text", text: "blocked: host is not a public destination" }], isError: true };
      }
      throw error;
    }
    if (result.status >= 300 && result.status < 400) {
      // The native GET has already closed its body/socket without following Location.
      return { content: [{ type: "text", text: `redirect to ${result.location} not followed` }], isError: true };
    }
    const text = result.text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 64 * 1024);
    return { content: [{ type: "text", text: `HTTP ${result.status}\n${text}` }], isError: result.status < 200 || result.status >= 300 };
  },
}; }
