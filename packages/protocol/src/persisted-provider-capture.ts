import { createHash } from "node:crypto";
import { z } from "zod";
import { PROTOCOL_VERSION } from "./capabilities.js";

export const PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL = "persisted-provider-capture-fleet-v2" as const;
export const INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH = "/_internal/telemetry/persisted-provider-capture/ready";
export const INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH = "/_internal/telemetry/persisted-provider-capture/fleet";
export const INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER = "x-agent-persisted-provider-capture-ack";
export const INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE = "persisted-provider-capture-v2";
export const INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER = "x-agent-persisted-provider-capture-nonce";
export const PERSISTED_PROVIDER_CAPTURE_MAX_RESPONSE_BYTES = 32_768;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const nonce = z.string().regex(/^[0-9a-f]{64}$/);

/** Only public digests cross the router boundary; never ref keys, source IDs or sink config. */
export const PersistedProviderCaptureBinding = z.object({
  captureControlEvidenceSha256: digest,
  refKeyIdSha256: digest,
  logsTargetSha256: digest,
  logsTargetReceiptSha256: digest,
  runtimeEpochSha256: digest,
  runtimeBindingSha256: digest,
}).strict();
export type PersistedProviderCaptureBinding = z.infer<typeof PersistedProviderCaptureBinding>;
export const PersistedProviderCaptureFleetProof = PersistedProviderCaptureBinding.extend({
  protocol: z.literal(PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL),
  configuredFleetRootSha256: digest,
}).strict();
export type PersistedProviderCaptureFleetProof = z.infer<typeof PersistedProviderCaptureFleetProof>;
export const PersistedProviderCaptureRunnerReady = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  service: z.literal("agent-runner"),
  capability: z.literal(PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL),
  runnerId: identity,
  bootId: z.string().uuid(),
  localEnabled: z.literal(true),
  writerEnabled: z.literal(true),
  nonce,
  configuredFleetRootSha256: digest,
  binding: PersistedProviderCaptureBinding,
}).strict();
export type PersistedProviderCaptureRunnerReady = z.infer<typeof PersistedProviderCaptureRunnerReady>;
export const PersistedProviderCaptureFleetRequest = z.object({
  runnerId: identity,
  bootId: z.string().uuid(),
  nonce,
  boundary: z.enum(["capture", "claim", "reserve", "create", "ack"]),
  configuredFleetRootSha256: digest,
  binding: PersistedProviderCaptureBinding,
}).strict();
export type PersistedProviderCaptureFleetRequest = z.infer<typeof PersistedProviderCaptureFleetRequest>;
export const PersistedProviderCaptureFleetResponse = z.object({
  nonce,
  runnerId: identity,
  bootId: z.string().uuid(),
  boundary: PersistedProviderCaptureFleetRequest.shape.boundary,
  proof: PersistedProviderCaptureFleetProof,
  fleetObservationSha256: digest,
}).strict();
export type PersistedProviderCaptureFleetResponse = z.infer<typeof PersistedProviderCaptureFleetResponse>;

export function persistedProviderCaptureBindingsEqual(left: PersistedProviderCaptureBinding, right: PersistedProviderCaptureBinding): boolean {
  return Object.keys(PersistedProviderCaptureBinding.shape).every((key) => (
    left[key as keyof PersistedProviderCaptureBinding] === right[key as keyof PersistedProviderCaptureBinding]
  ));
}

export function persistedProviderCaptureConfiguredFleetRootSha256(targets: readonly { url: string; runnerId: string }[]): string {
  const sorted = [...targets].sort((a, b) => a.url.localeCompare(b.url));
  return createHash("sha256").update(JSON.stringify([
    "agent-service/persisted-provider-capture-configured-fleet/v2", sorted.map((target) => [target.url, target.runnerId]),
  ])).digest("hex");
}

export function persistedProviderCaptureFleetObservationSha256(targets: readonly { url: string; runnerId: string; bootId: string }[]): string {
  const sorted = [...targets].sort((a, b) => a.url.localeCompare(b.url));
  return createHash("sha256").update(JSON.stringify([
    "agent-service/persisted-provider-capture-fresh-observation/v2", sorted.map((target) => [target.url, target.runnerId, target.bootId]),
  ])).digest("hex");
}

/** Bound both headers and body, including injected transports that do not honor AbortSignal. */
export async function awaitPersistedProviderCaptureBoundary<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller may already have started a noncooperative operation before noticing cancellation.
    // Its later rejection must remain observed even though this boundary returns immediately.
    void work.catch(() => {});
    signal.throwIfAborted();
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function readPersistedProviderCaptureJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("capture response has no body");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > PERSISTED_PROVIDER_CAPTURE_MAX_RESPONSE_BYTES)) {
    void response.body.cancel().catch(() => {});
    throw new Error("capture response exceeds its bound");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await awaitPersistedProviderCaptureBoundary(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > PERSISTED_PROVIDER_CAPTURE_MAX_RESPONSE_BYTES) throw new Error("capture response exceeds its bound");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A transport abort may already have detached it. */ }
  }
}

export async function awaitPersistedProviderCaptureResponse(work: Promise<Response>, signal: AbortSignal): Promise<Response> {
  try {
    return await awaitPersistedProviderCaptureBoundary(work, signal);
  } catch (error) {
    // Observe and close a late headers result from a transport that ignored the same deadline.
    void work.then((response) => response.body?.cancel().catch(() => {}), () => {});
    throw error;
  }
}
