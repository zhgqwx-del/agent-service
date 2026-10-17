import { createMcpPurposeHttpFetch, McpHttpError, type McpHttpFetch, type McpHttpOptions } from "./http.js";

export type McpNetworkPurpose = "metadata" | "token" | "registration" | "resource";
export type McpProtocolVersion = "2026-07-28" | "2025-11-25";
export interface McpAsAuthentication {
  /** A server-owned value, never an incoming request header or MCP access token. */
  readonly basicCredential: () => Promise<string | undefined>;
}

function rejected(): never { throw new McpHttpError("header_rejected"); }
function headersFor(purpose: McpNetworkPurpose, headers: Headers, method: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of headers) {
    if (value.length > 1024) rejected();
    if (name === "accept") {
      const types = value.toLowerCase().split(",").map(value => value.trim());
      if (!types.length || types.some(value => value !== "application/json" && !(purpose === "resource" && value === "text/event-stream"))) rejected();
    } else if (name === "content-type") {
      const expected = purpose === "token" ? /^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i : /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
      if (method !== "POST" || !expected.test(value)) rejected();
    } else if (name === "mcp-protocol-version") {
      if ((purpose !== "resource" && purpose !== "metadata") || !/^\d{4}-\d{2}-\d{2}$/.test(value)) rejected();
    } else if (purpose === "resource" && name === "mcp-method") {
      if (!/^[A-Za-z][A-Za-z0-9_./-]{0,127}$/.test(value)) rejected();
    } else if (purpose === "resource" && name === "mcp-name") {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(value)) rejected();
    } else if (purpose === "resource" && name === "mcp-session-id") {
      if (!/^[\x21-\x7e]{1,256}$/.test(value)) rejected();
    } else rejected();
    // Authorization, Cookie, inbound tracing and internal/operator tokens are
    // rejected here, even when their value would happen to match a saved token.
    result[name] = value;
  }
  if (method === "POST" && !result["content-type"]) rejected();
  result["accept-encoding"] = "identity";
  return result;
}

/** Each constructor fixes one exact URL. Metadata never has a credential callback. */
export function createMcpMetadataFetch(options: McpHttpOptions): McpHttpFetch {
  return createMcpPurposeHttpFetch(options, {
    methods: ["GET"], allowQuery: true, headers: (headers, method) => headersFor("metadata", headers, method),
  });
}
export function createMcpTokenFetch(options: McpHttpOptions, authentication?: McpAsAuthentication): McpHttpFetch {
  return createMcpPurposeHttpFetch(options, {
    methods: ["POST"], allowQuery: true, headers: (headers, method) => headersFor("token", headers, method),
    ...(authentication ? { authorization: { scheme: "Basic" as const, token: authentication.basicCredential } } : {}),
  });
}
export function createMcpRegistrationFetch(options: McpHttpOptions): McpHttpFetch {
  // Dynamic registration's initial request is anonymous. Registration-management
  // credentials, if later supported, need their own exact destination capability.
  return createMcpPurposeHttpFetch(options, {
    methods: ["POST"], allowQuery: true, headers: (headers, method) => headersFor("registration", headers, method),
  });
}
export function createMcpResourceFetch(options: McpHttpOptions, binding: {
  readonly protocolVersion: McpProtocolVersion;
  readonly accessToken?: () => Promise<string | undefined>;
}): McpHttpFetch {
  if (binding.protocolVersion !== "2026-07-28" && binding.protocolVersion !== "2025-11-25") throw new McpHttpError("invalid_options");
  return createMcpPurposeHttpFetch(options, {
    // Legacy GET is only the fixed MCP endpoint's notification stream, never a
    // resource-link URL. Modern requests have no session/GET/DELETE fallback.
    methods: binding.protocolVersion === "2025-11-25" ? ["GET", "POST", "DELETE"] : ["POST"],
    headers: (headers, method) => {
      if (binding.protocolVersion === "2026-07-28" && headers.has("mcp-session-id")) rejected();
      if (headers.has("mcp-protocol-version") && headers.get("mcp-protocol-version") !== binding.protocolVersion) rejected();
      return headersFor("resource", headers, method);
    },
    ...(binding.accessToken ? { authorization: { scheme: "Bearer" as const, token: binding.accessToken } } : {}),
  });
}
