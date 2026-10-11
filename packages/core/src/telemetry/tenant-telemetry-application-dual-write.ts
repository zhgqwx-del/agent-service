import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
  createStructuredTelemetry,
  type StructuredTelemetry,
  type StructuredTelemetryComponent,
  type StructuredTelemetryEventCode,
  type StructuredTelemetryFields,
  type StructuredTelemetryLevel,
  type StructuredTelemetryRecord,
  type StructuredTelemetrySink,
} from "@agent-service/protocol";
import {
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  type EnqueueTenantTelemetryArtifactInput,
  type TenantTelemetryOwnerKind,
  type TenantTelemetryWriterStore,
} from "@agent-service/store";

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_SCHEMA = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

/**
 * Exact producer surface implemented by this module today.  The digest is persisted by the 0035
 * per-domain cutover, so adding another event/owner/source boundary requires a new protocol and an
 * explicit activation instead of silently broadening an already-certified contract.
 */
export const TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL =
  "agent-service-provider-owner-log-v1" as const;
export const TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT = Object.freeze({
  protocol: TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
  domain: "logs" as const,
  component: "provider" as const,
  eventCodes: Object.freeze(["provider.upstream_request_failed"] as const),
  ownerKinds: Object.freeze(["tenant"] as const),
  sourceSchema: "agent-service.telemetry.v1" as const,
  sourceGeneration: 1 as const,
  activeOwnerOutput: "durable-only" as const,
  inactiveOwnerOutput: "content-free-process-only" as const,
});
export const TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256 = createHash("sha256")
  .update(JSON.stringify([
    "tenant-telemetry-application-producer-contract-v1",
    TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT,
  ]))
  .digest("hex");

export type TenantTelemetryDurableFailureReason =
  | "enqueue_failed"
  | "writer_closed"
  | "writer_gate_failed";

/**
 * Raw ownership is used only for the transactional store admission check. It is never copied into
 * a structured record, artifact identity, callback, or process-log message.
 */
export interface TenantTelemetryApplicationOwnerBinding {
  tenantId: string;
  ownerKind: TenantTelemetryOwnerKind;
  ownerId: string;
  ownerUserId: string | null;
}

export interface TenantTelemetryApplicationDualWriteOptions {
  component: StructuredTelemetryComponent;
  /** Exact 0035 producer identity; both values are copied into every post-cutover admission. */
  producerProtocol: string;
  producerContractSha256: string;
  /** Must be the exact 32-byte key configured for the active 0033 lifecycle control. */
  opaqueRefKey: Uint8Array;
  /** Pre-cutover and explicitly process-only output. Active owner capture never mirrors to it. */
  processSink: StructuredTelemetrySink;
  store: Pick<TenantTelemetryWriterStore, "enqueueTenantTelemetryArtifact">;
  /** Default false. A throwing gate fails closed for durable admission without breaking runtime. */
  durableEnabled?: () => boolean;
  /** Content-free callback. The underlying error and raw owner identity are deliberately omitted. */
  onDurableFailure?: (reason: TenantTelemetryDurableFailureReason) => void;
  /** Content-free notification only; process output failure never escapes into application work. */
  onProcessSinkFailure?: () => void;
  sourceSchema?: string;
  sourceGeneration?: number;
  now?: () => number;
  /** Test seam for deterministic, content-free artifact identities. */
  artifactIdentitySeed?: Uint8Array;
}

export interface TenantTelemetryApplicationDualWrite {
  /** Process-only logger. Calls made directly through this property never gain durable authority. */
  readonly telemetry: StructuredTelemetry;
  info(
    owner: TenantTelemetryApplicationOwnerBinding,
    code: StructuredTelemetryEventCode,
    fields?: StructuredTelemetryFields,
  ): Promise<void>;
  warn(
    owner: TenantTelemetryApplicationOwnerBinding,
    code: StructuredTelemetryEventCode,
    fields?: StructuredTelemetryFields,
  ): Promise<void>;
  error(
    owner: TenantTelemetryApplicationOwnerBinding,
    code: StructuredTelemetryEventCode,
    fields?: StructuredTelemetryFields,
  ): Promise<void>;
  /** Wait for all enqueue attempts already admitted by this process. Never rejects. */
  drain(): Promise<void>;
  /** Retry the exact in-memory admissions whose spool write failed or returned ambiguously. */
  retryFailed(): Promise<void>;
  /** Permanently deny new durable admissions, then drain the attempts already admitted. */
  close(): Promise<void>;
  readonly pendingCount: number;
  readonly failedCount: number;
  /** False after any unresolved enqueue/gate failure, so application readiness can fail closed. */
  readonly durableReady: boolean;
}

interface RecordCaptureScope {
  record?: Readonly<StructuredTelemetryRecord>;
}

function validateId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new TypeError(`${name} is invalid`);
  }
}

function captureOwnerBinding(
  owner: TenantTelemetryApplicationOwnerBinding,
): Readonly<TenantTelemetryApplicationOwnerBinding> {
  if (typeof owner !== "object" || owner === null || Array.isArray(owner)) {
    throw new TypeError("tenant telemetry owner binding must be an object");
  }
  const keys = Object.keys(owner).sort();
  const expected = ["ownerId", "ownerKind", "ownerUserId", "tenantId"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("tenant telemetry owner binding has unknown or missing fields");
  }
  const tenantId = owner.tenantId;
  const ownerKind = owner.ownerKind;
  const ownerId = owner.ownerId;
  const ownerUserId = owner.ownerUserId;
  validateId(tenantId, "tenant telemetry tenant id");
  validateId(ownerId, "tenant telemetry owner id");
  if (ownerKind !== "tenant" && ownerKind !== "user" && ownerKind !== "session") {
    throw new TypeError("tenant telemetry owner kind is invalid");
  }
  if (ownerKind === "tenant") {
    if (ownerId !== tenantId || ownerUserId !== null) {
      throw new TypeError("tenant telemetry tenant owner must match the tenant id");
    }
  } else {
    validateId(ownerUserId, "tenant telemetry owner user id");
    if (ownerKind === "user" && ownerId !== ownerUserId) {
      throw new TypeError("tenant telemetry user owner must match the owner user id");
    }
  }
  return Object.freeze({ tenantId, ownerKind, ownerId, ownerUserId });
}

function sourceGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("tenant telemetry source generation must be a non-negative safe integer");
  }
  return value;
}

function failureWithoutThrow(
  callback: ((reason: TenantTelemetryDurableFailureReason) => void) | undefined,
  reason: TenantTelemetryDurableFailureReason,
): void {
  try {
    callback?.(reason);
  } catch {
    // A monitoring callback must not alter application behavior or the enqueue state machine.
  }
}

/**
 * Create the application boundary that preserves process logging and, only for explicit
 * owner-scoped emissions while the gate is open, writes the exact producer-authenticated record to
 * the 0034 durable spool without also creating an unmanaged process-log copy. A failed enqueue is
 * content-free-signalled and withheld from process output, so an untracked log copy cannot be
 * mistaken for lifecycle coverage. One record per artifact intentionally prevents
 * cross-owner batching and gives every exact retry an immutable identity.
 *
 * The unhealthy latch and exact in-memory retry make async DB failures visible and recoverable
 * while this process remains alive. They do not make an arbitrary business mutation and its log
 * one database transaction, so this helper alone is not proof of crash-safe complete-since-creation
 * coverage. Activation must stay unavailable until each authoritative producer either awaits an
 * atomic application outbox boundary or has an equivalent durable source/replay contract.
 */
export function createTenantTelemetryApplicationDualWrite(
  options: TenantTelemetryApplicationDualWriteOptions,
): TenantTelemetryApplicationDualWrite {
  const key = Buffer.from(options.opaqueRefKey);
  if (key.byteLength !== 32) {
    throw new TypeError("tenant telemetry opaque ref key must contain exactly 32 bytes");
  }
  const schema = options.sourceSchema ?? "agent-service.telemetry.v1";
  if (!SOURCE_SCHEMA.test(schema)) {
    throw new TypeError("tenant telemetry source schema is invalid");
  }
  const generation = sourceGeneration(options.sourceGeneration ?? 1);
  if (!SOURCE_SCHEMA.test(options.producerProtocol)) {
    throw new TypeError("tenant telemetry producer protocol is invalid");
  }
  if (!SHA256.test(options.producerContractSha256)) {
    throw new TypeError("tenant telemetry producer contract must be a lowercase SHA-256 digest");
  }
  const providerContract = options.producerProtocol
      === TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL
    || options.producerContractSha256
      === TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256;
  if (providerContract && (
    options.producerProtocol !== TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL
      || options.producerContractSha256
        !== TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256
      || options.component !== "provider"
      || schema !== TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT.sourceSchema
      || generation !== TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT.sourceGeneration
  )) {
    throw new TypeError("tenant telemetry provider producer contract is inconsistent");
  }
  const seed = Buffer.from(options.artifactIdentitySeed ?? randomBytes(32));
  if (seed.byteLength !== 32) {
    throw new TypeError("tenant telemetry artifact identity seed must contain exactly 32 bytes");
  }

  const recordCapture = new AsyncLocalStorage<RecordCaptureScope>();
  const pending = new Set<Promise<void>>();
  const inFlight = new Map<string, Promise<void>>();
  const failed = new Map<string, EnqueueTenantTelemetryArtifactInput>();
  let artifactSequence = 0;
  let closed = false;
  // Failures before an exact enqueue input exists cannot be replayed.  Keep the process unhealthy
  // and deny later durable admissions instead of letting a later successful record hide the gap.
  let admissionFailed = false;

  const artifactId = (): string => {
    artifactSequence += 1;
    if (!Number.isSafeInteger(artifactSequence)) {
      throw new Error("tenant telemetry artifact sequence is exhausted");
    }
    const digest = createHash("sha256")
      .update("agent-service/tenant-telemetry-application-artifact/v1\0", "utf8")
      .update(seed)
      .update("\0", "utf8")
      .update(String(artifactSequence), "utf8")
      .digest("hex");
    if (!SHA256.test(digest)) throw new Error("tenant telemetry artifact identity is invalid");
    return digest;
  };

  const writeProcess = (record: Readonly<StructuredTelemetryRecord>): void => {
    try {
      options.processSink.write(record);
    } catch {
      try {
        options.onProcessSinkFailure?.();
      } catch {
        // Monitoring a process-output failure is also best effort.
      }
    }
  };

  const enqueueInput = (input: EnqueueTenantTelemetryArtifactInput): Promise<void> => {
    const identity = input.artifactIdSha256;
    const existing = inFlight.get(identity);
    if (existing) return existing;

    let tracked: Promise<void>;
    tracked = (async () => {
      try {
        // This call is made with the exact frozen record emitted by createStructuredTelemetry.
        // Memory/MySQL capture and verify its process-local producer mark before their first await.
        await options.store.enqueueTenantTelemetryArtifact(input);
        failed.delete(identity);
      } catch {
        // Retain the exact original input, including the still trusted in-process record object.
        // retryFailed can therefore close an ambiguous DB response through the store's exact replay.
        failed.set(identity, input);
        failureWithoutThrow(options.onDurableFailure, "enqueue_failed");
      }
    })().finally(() => {
      pending.delete(tracked);
      if (inFlight.get(identity) === tracked) inFlight.delete(identity);
    });
    inFlight.set(identity, tracked);
    pending.add(tracked);
    return tracked;
  };

  const sink: StructuredTelemetrySink = Object.freeze({
    write(record: Readonly<StructuredTelemetryRecord>) {
      const capture = recordCapture.getStore();
      if (capture) {
        if (capture.record !== undefined) {
          throw new Error("tenant telemetry scoped emission produced more than one record");
        }
        capture.record = record;
        return;
      }
      writeProcess(record);
    },
  });
  const telemetry = createStructuredTelemetry({
    component: options.component,
    opaqueRefKey: key,
    sink,
    ...(options.now ? { now: options.now } : {}),
  });

  const emit = async (
    level: StructuredTelemetryLevel,
    ownerInput: TenantTelemetryApplicationOwnerBinding,
    code: StructuredTelemetryEventCode,
    fields: StructuredTelemetryFields = {},
  ): Promise<void> => {
    const owner = captureOwnerBinding(ownerInput);
    if (closed) {
      failureWithoutThrow(options.onDurableFailure, "writer_closed");
      return;
    }
    if (admissionFailed) return;
    let enabled = false;
    try {
      enabled = options.durableEnabled?.() === true;
    } catch {
      admissionFailed = true;
      failureWithoutThrow(options.onDurableFailure, "writer_gate_failed");
      return;
    }

    const copiedFields: StructuredTelemetryFields = { ...fields };
    if (!enabled) {
      // Before the application-capture cutover there is no lifecycle authority for stable owner
      // references.  Treat every ref slot on this owner-scoped API as owner-bearing—even when a
      // caller supplied it—and retain only the content-free operational fields in process output.
      const {
        ownerRef: _ownerRef,
        subjectRef: _subjectRef,
        targetRef: _targetRef,
        ...processFields
      } = copiedFields;
      telemetry[level](code, processFields);
      return;
    }
    const requiredRefs = [
      telemetry.opaqueRef("tenant", owner.tenantId),
      ...(owner.ownerKind === "tenant"
        ? []
        : [telemetry.opaqueRef(owner.ownerKind, owner.ownerId)]),
    ];
    const slots = ["ownerRef", "subjectRef", "targetRef"] as const;
    for (const ref of requiredRefs) {
      if (slots.some((slot) => copiedFields[slot] === ref)) continue;
      const empty = slots.find((slot) => copiedFields[slot] === undefined);
      if (!empty) {
        throw new TypeError("tenant telemetry record has no slot for its durable owner binding");
      }
      copiedFields[empty] = ref;
    }

    try {
      if (providerContract && (
        owner.ownerKind !== "tenant"
          || code !== "provider.upstream_request_failed"
      )) {
        throw new Error("emission is outside the activated provider producer contract");
      }
      const capture: RecordCaptureScope = {};
      recordCapture.run(capture, () => telemetry[level](code, copiedFields));
      const record = capture.record;
      if (!record) throw new Error("tenant telemetry scoped emission did not produce a record");
      const input: EnqueueTenantTelemetryArtifactInput = {
        tenantId: owner.tenantId,
        expectedControlGeneration: 1,
        domain: "logs",
        artifactIdSha256: artifactId(),
        artifactGeneration: 1,
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        ownerUserId: owner.ownerUserId,
        sourceSchema: schema,
        sourceGeneration: generation,
        // A process log has no independently trusted database high-water. Use the explicit
        // generation-zero sentinel; the store supplies createdAtDbMs from its own clock and binds
        // current policy/hold/restore state in the same transaction. The record's wall-clock
        // timestamp remains payload data and must not be mislabeled as database authority.
        sourceHighWaterDbMs: 0,
        producerProtocol: options.producerProtocol,
        producerContractSha256: options.producerContractSha256,
        payload: {
          schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
          domain: "logs",
          records: Object.freeze([record]),
        },
      };
      await enqueueInput(input);
    } catch {
      // This covers capture/provenance/serialization failures before enqueueInput can retain an
      // exact retry value. Permanently close this process-local admission boundary: a later record
      // cannot prove that the unreplayable gap disappeared. Never fall back to an unmanaged
      // owner-bearing process log.
      admissionFailed = true;
      failureWithoutThrow(options.onDurableFailure, "enqueue_failed");
    }
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending]);
  };

  const retryFailed = async (): Promise<void> => {
    if (closed) {
      failureWithoutThrow(options.onDurableFailure, "writer_closed");
      return;
    }
    const retry = [...failed.values()];
    await Promise.all(retry.map((input) => enqueueInput(input)));
  };

  const dualWrite: TenantTelemetryApplicationDualWrite = {
    telemetry,
    info: (
      owner: TenantTelemetryApplicationOwnerBinding,
      code: StructuredTelemetryEventCode,
      fields?: StructuredTelemetryFields,
    ) => emit("info", owner, code, fields),
    warn: (
      owner: TenantTelemetryApplicationOwnerBinding,
      code: StructuredTelemetryEventCode,
      fields?: StructuredTelemetryFields,
    ) => emit("warn", owner, code, fields),
    error: (
      owner: TenantTelemetryApplicationOwnerBinding,
      code: StructuredTelemetryEventCode,
      fields?: StructuredTelemetryFields,
    ) => emit("error", owner, code, fields),
    drain,
    retryFailed,
    async close() {
      closed = true;
      await drain();
    },
    get pendingCount() {
      return pending.size;
    },
    get failedCount() {
      return failed.size;
    },
    get durableReady() {
      return !closed && !admissionFailed && failed.size === 0;
    },
  };
  return Object.freeze(dualWrite);
}
