import { createHmac, timingSafeEqual } from "node:crypto";
import type { TenantWebhookBodyScope, TenantWebhookPhase, TenantWebhookPromptSnapshot } from "@agent-service/store";
import { tenantWebhookCanonicalJson, tenantWebhookHash } from "./cipher.js";

export const TENANT_WEBHOOK_MAX_REQUEST_BYTES = 16_384;
export const TENANT_WEBHOOK_MAX_RESPONSE_BYTES = 8192;
export class TenantWebhookProjectionError extends Error {
  constructor() { super("Tenant webhook projection is unavailable."); this.name = "TenantWebhookProjectionError"; }
}
export interface TenantWebhookRequestV2 {
  readonly schema: "agent-service-tenant-tool-hook-request-v2";
  readonly webhookId: string; readonly configVersionId: string; readonly configSha256: string;
  readonly phase: TenantWebhookPhase; readonly invocationId: string;
  readonly refs: { readonly tenant: string; readonly user: string; readonly session: string; readonly turn: string; readonly callItem: string };
  readonly tool: { readonly name: string; readonly kind: string }; readonly isError: boolean | null;
  readonly bodyScopes: readonly TenantWebhookBodyScope[];
  readonly body?: Readonly<Record<string, unknown>>;
  readonly requestSha256: string; readonly macSha256: string;
}
export interface TenantWebhookResponseV2 {
  readonly schema: "agent-service-tenant-tool-hook-response-v2";
  readonly webhookId: string; readonly configVersionId: string; readonly phase: TenantWebhookPhase;
  readonly invocationId: string; readonly requestSha256: string; readonly decision: "ack"; readonly macSha256: string;
}
function fail(): never { throw new TenantWebhookProjectionError(); }
function mac(key: Uint8Array, domain: string, value: unknown): string {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) fail();
  return createHmac("sha256", key).update(domain).update("\0").update(tenantWebhookCanonicalJson(value)).digest("hex");
}
function equal(left: unknown, right: string): boolean {
  return typeof left === "string" && /^[0-9a-f]{64}$/.test(left) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  tenantWebhookCanonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail();
}
export function tenantWebhookOpaqueRef(key: Uint8Array, kind: string, value: readonly string[]): string {
  return mac(key, `tenant-webhook-ref-${kind}-v2`, value);
}
/** The compiler's only prompt input is the Store-issued current-turn original-text snapshot. */
export function tenantWebhookPromptBody(snapshot: TenantWebhookPromptSnapshot): unknown {
  if (snapshot.profile !== "current_turn_user_text_v1") fail();
  return { profile: snapshot.profile, textParts: snapshot.parts.map(part => part.text) };
}
export function signTenantWebhookRequest(
  input: Omit<TenantWebhookRequestV2, "requestSha256" | "macSha256">, key: Uint8Array,
): Readonly<TenantWebhookRequestV2> {
  try {
    const requestSha256 = tenantWebhookHash("tenant-webhook-request-digest-v2", input);
    const signed = { ...input, requestSha256 };
    const result = { ...signed, macSha256: mac(key, "tenant-webhook-request-mac-v2", signed) };
    if (Buffer.byteLength(tenantWebhookCanonicalJson(result)) > TENANT_WEBHOOK_MAX_REQUEST_BYTES) fail();
    return Object.freeze(result);
  } catch { return fail(); }
}
/** A receiver must reject duplicate wire keys before passing its parsed object to this helper. */
export function validateTenantWebhookRequest(value: unknown, key: Uint8Array): Readonly<TenantWebhookRequestV2> {
  const base = ["schema", "webhookId", "configVersionId", "configSha256", "phase", "invocationId", "refs", "tool", "isError", "bodyScopes", "requestSha256", "macSha256"];
  exact(value, value && typeof value === "object" && Object.hasOwn(value, "body") ? [...base, "body"] : base);
  if (value.schema !== "agent-service-tenant-tool-hook-request-v2" || !["preToolUse", "postToolUse"].includes(String(value.phase))
    || !Array.isArray(value.bodyScopes) || value.bodyScopes.length > 3 || new Set(value.bodyScopes).size !== value.bodyScopes.length
    || value.bodyScopes.some(scope => !["prompt", "tool_arguments", "tool_result"].includes(String(scope)))
    || value.phase === "preToolUse" && (value.isError !== null || value.bodyScopes.includes("tool_result"))
    || value.phase === "postToolUse" && typeof value.isError !== "boolean") fail();
  for (const field of ["webhookId", "configVersionId", "configSha256", "invocationId"]) if (!/^[a-f0-9]{64}$/.test(String(value[field]))) fail();
  exact(value.refs, ["tenant", "user", "session", "turn", "callItem"]);
  if (Object.values(value.refs).some(ref => typeof ref !== "string" || !/^[a-f0-9]{64}$/.test(ref))) fail();
  exact(value.tool, ["name", "kind"]);
  if (typeof value.tool.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.tool.name)
    || !["builtin", "mcp", "dynamic", "skill"].includes(String(value.tool.kind))) fail();
  if (value.bodyScopes.length) exact(value.body, value.bodyScopes as string[]);
  else if (Object.hasOwn(value, "body")) fail();
  if (Buffer.byteLength(tenantWebhookCanonicalJson(value)) > TENANT_WEBHOOK_MAX_REQUEST_BYTES) fail();
  const { macSha256: _mac, requestSha256: _digest, ...payload } = value;
  if (!equal(value.requestSha256, tenantWebhookHash("tenant-webhook-request-digest-v2", payload))
    || !equal(value.macSha256, mac(key, "tenant-webhook-request-mac-v2", { ...payload, requestSha256: value.requestSha256 }))) fail();
  return Object.freeze(structuredClone(value)) as unknown as Readonly<TenantWebhookRequestV2>;
}
export function createTenantWebhookResponse(request: unknown, key: Uint8Array): Readonly<TenantWebhookResponseV2> {
  const input = validateTenantWebhookRequest(request, key);
  const payload = { schema: "agent-service-tenant-tool-hook-response-v2", webhookId: input.webhookId,
    configVersionId: input.configVersionId, phase: input.phase, invocationId: input.invocationId,
    requestSha256: input.requestSha256, decision: "ack" } as const;
  return Object.freeze({ ...payload, macSha256: mac(key, "tenant-webhook-response-mac-v2", payload) });
}
/** Response profile is flat string-only JSON. Reject lexical duplicate/escaped duplicate names. */
export function verifyTenantWebhookResponse(raw: string, request: TenantWebhookRequestV2, key: Uint8Array): string {
  if (Buffer.byteLength(raw) > TENANT_WEBHOOK_MAX_RESPONSE_BYTES) fail();
  const value: unknown = JSON.parse(raw);
  exact(value, ["schema", "webhookId", "configVersionId", "phase", "invocationId", "requestSha256", "decision", "macSha256"]);
  const tokens = raw.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}:,]|[^\s{}:,]+/g);
  if (!tokens || tokens[0] !== "{" || tokens.at(-1) !== "}") fail();
  const seen = new Set<string>(); let i = 1;
  while (i < tokens.length - 1) {
    const keyToken = tokens[i++]; if (!keyToken?.startsWith('"') || tokens[i++] !== ":") fail();
    const name: unknown = JSON.parse(keyToken); if (typeof name !== "string" || seen.has(name)) fail(); seen.add(name);
    if (!tokens[i++]?.startsWith('"')) fail();
    if (i < tokens.length - 1 && tokens[i++] !== ",") fail();
  }
  if (i !== tokens.length - 1 || seen.size !== Object.keys(value).length) fail();
  if (value.schema !== "agent-service-tenant-tool-hook-response-v2" || value.webhookId !== request.webhookId
    || value.configVersionId !== request.configVersionId || value.phase !== request.phase || value.invocationId !== request.invocationId
    || value.requestSha256 !== request.requestSha256 || value.decision !== "ack") fail();
  const { macSha256: _mac, ...payload } = value;
  if (!equal(value.macSha256, mac(key, "tenant-webhook-response-mac-v2", payload))) fail();
  return tenantWebhookHash("tenant-webhook-response-receipt-v2", value);
}
