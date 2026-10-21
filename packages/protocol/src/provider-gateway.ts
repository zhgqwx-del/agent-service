import { createHash } from "node:crypto";
import { z } from "zod";

/** Operator namespace declaration, not proof that URLs reach the same physical Redis service. */
export function providerQuotaNamespaceSha256(input: { prefix: string; namespaceId: string }): string {
  if (!input || Reflect.ownKeys(input).length !== 2 || typeof input.prefix !== "string" || typeof input.namespaceId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(input.prefix) || /[\u0000-\u0020\u007f]/.test(input.prefix)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.namespaceId) || /[\u0000-\u0020\u007f]/.test(input.namespaceId)) throw new Error("Provider admission is unavailable.");
  return createHash("sha256").update("provider-quota-namespace-v1\0")
    .update(JSON.stringify({ prefix: input.prefix, namespaceId: input.namespaceId })).digest("hex");
}

export const PROVIDER_GATEWAY_QUOTA_V1 = "provider-gateway-quota-v1" as const;
export const INTERNAL_PROVIDER_GATEWAY_READY_PATH = "/_internal/provider-gateway-quota-v1/ready" as const;
export const INTERNAL_PROVIDER_GATEWAY_ACK_HEADER = "x-agent-service-provider-gateway" as const;
export const INTERNAL_PROVIDER_GATEWAY_ACK_VALUE = "provider-quota-ready-v1" as const;
export const ProviderGatewayIdentity = z.object({
  namespaceSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  policySha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
}).strict();
export type ProviderGatewayIdentity = z.infer<typeof ProviderGatewayIdentity>;
export const ProviderGatewayFleetRequest = z.object({
  nonce: z.string().length(64).regex(/^[a-f0-9]{64}$/), identity: ProviderGatewayIdentity,
}).strict();
export const ProviderGatewayFleetResponse = ProviderGatewayFleetRequest;
export function providerGatewayIdentitiesEqual(a: ProviderGatewayIdentity, b: ProviderGatewayIdentity): boolean {
  return a.namespaceSha256 === b.namespaceSha256 && a.policySha256 === b.policySha256;
}

/** Bounded private JSON; cancellation retains ownership until the real reader settles. */
export async function readProviderGatewayJson(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<unknown> {
  if (!body) throw new Error("Provider gateway fleet is unavailable.");
  const reader = body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 2048) throw new Error("Provider gateway fleet is unavailable.");
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener("abort", cancel); cancel();
    try { await cancellation; } finally { reader.releaseLock(); }
  }
}
