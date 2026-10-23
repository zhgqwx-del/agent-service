import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes } from "node:crypto";

export const TRACEPARENT_HEADER = "traceparent";

type LowercaseHexDigit =
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7"
  | "8" | "9" | "a" | "b" | "c" | "d" | "e" | "f";
export type TraceFlags = `${LowercaseHexDigit}${LowercaseHexDigit}`;

export interface TraceContext {
  version: "00";
  traceId: string;
  spanId: string;
  traceFlags: TraceFlags;
}

const TRACEPARENT_V00 = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const traceStorage = new AsyncLocalStorage<TraceContext>();
const trustedStructuredTelemetryRecords = new WeakMap<object, string>();

/**
 * Parse only the W3C version-00 wire shape that this service emits. Invalid or future-version
 * input is untrusted and is replaced with a fresh root rather than being relayed downstream.
 */
export function parseTraceparent(value: string | null | undefined): TraceContext | undefined {
  if (value === undefined || value === null) return undefined;
  const match = TRACEPARENT_V00.exec(value);
  if (!match || match[1] === ZERO_TRACE_ID || match[2] === ZERO_SPAN_ID) return undefined;
  return Object.freeze({
    version: "00",
    traceId: match[1]!,
    spanId: match[2]!,
    traceFlags: match[3] as TraceFlags,
  });
}

export function formatTraceparent(context: TraceContext): string {
  const value = `${context.version}-${context.traceId}-${context.spanId}-${context.traceFlags}`;
  if (!parseTraceparent(value)) throw new TypeError("trace context is not canonical W3C version 00");
  return value;
}

function randomNonZeroHex(bytes: number): string {
  for (;;) {
    const value = randomBytes(bytes).toString("hex");
    if (!/^0+$/.test(value)) return value;
  }
}

/** Start a local span, preserving a strictly valid trace id and all version-00 trace-flags bits. */
export function startTraceContext(incoming?: string | null): TraceContext {
  const parent = parseTraceparent(incoming);
  return Object.freeze({
    version: "00" as const,
    traceId: parent?.traceId ?? randomNonZeroHex(16),
    spanId: randomNonZeroHex(8),
    traceFlags: parent?.traceFlags ?? "00",
  });
}

/**
 * Start a fresh internal root at a public trust boundary.
 *
 * A caller-controlled trace id is valid transport syntax, not a provenance proof. Public ingress
 * must therefore discard it before structured telemetry or internal downstream propagation.
 */
export function startBoundaryTraceContext(): TraceContext {
  return Object.freeze({
    version: "00" as const,
    traceId: randomNonZeroHex(16),
    spanId: randomNonZeroHex(8),
    traceFlags: "00" as const,
  });
}

export function withTraceContext<T>(context: TraceContext, work: () => T): T {
  const parsed = parseTraceparent(formatTraceparent(context));
  // formatTraceparent already proved this exact value canonical. Copy/freeze it so a caller cannot
  // mutate an active async context and smuggle arbitrary identifiers into structured records.
  return traceStorage.run(Object.freeze(parsed!), work);
}

export function currentTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/** Create the exact header for a downstream client span. */
export function outgoingTraceparent(): string {
  const current = currentTraceContext();
  return formatTraceparent(startTraceContext(current ? formatTraceparent(current) : undefined));
}

export const STRUCTURED_TELEMETRY_EVENT_CODES = [
  "router.lifecycle.draining",
  "router.lifecycle.started",
  "router.process.start_failed",
  "router.process.shutdown_failed",
  "router.unhandled_error",
  "router.tenant_erasure_target_unreachable",
  "router.upstream_unreachable",
  "router.owner_unconfigured",
  "router.owner_reroute",
  "runner.bootstrap.dev_key_skipped",
  "runner.bootstrap.dev_key_seeded",
  "runner.bootstrap.admin_key_inactive",
  "runner.bootstrap.admin_key_present",
  "runner.bootstrap.admin_key_output_rejected",
  "runner.bootstrap.admin_key_store_failed",
  "runner.bootstrap.admin_key_written",
  "runner.lifecycle.draining",
  "runner.lifecycle.started",
  "runner.process.start_failed",
  "runner.process.shutdown_failed",
  "runner.runtime.info",
  "runner.runtime.warning",
  "runner.runtime.error",
  "runner.runtime.ownership_lost",
  "runner.unhandled_error",
  "provider.upstream_request_failed",
] as const;

export type StructuredTelemetryEventCode = typeof STRUCTURED_TELEMETRY_EVENT_CODES[number];
export type StructuredTelemetryLevel = "info" | "warn" | "error";
export type StructuredTelemetryComponent = "router" | "runner" | "provider" | "core";
export type TelemetryOpaqueRefKind =
  | "owner"
  | "tenant"
  | "user"
  | "session"
  | "turn"
  | "request"
  | "runner"
  | "provider";
export type TelemetryOpaqueRef = `oref_${TelemetryOpaqueRefKind}_${string}`;
export type TenantTelemetryOwnerKind = Extract<
  TelemetryOpaqueRefKind,
  "tenant" | "user" | "session"
>;
export type TelemetryErrorKind = "aborted" | "timeout" | "network" | "unavailable" | "unknown";

export interface StructuredTelemetryFields {
  ownerRef?: TelemetryOpaqueRef;
  subjectRef?: TelemetryOpaqueRef;
  targetRef?: TelemetryOpaqueRef;
  errorKind?: TelemetryErrorKind;
  attempt?: number;
  retryable?: boolean;
  statusCode?: number;
  runnerCount?: number;
  shutdownGraceMs?: number;
  gateEnabledCount?: number;
  gateDisabledCount?: number;
}

export interface StructuredTelemetryRecord {
  schema: "agent-service.telemetry.v1";
  timestampMs: number;
  level: StructuredTelemetryLevel;
  component: StructuredTelemetryComponent;
  code: StructuredTelemetryEventCode;
  traceId?: string;
  spanId?: string;
  fields: Readonly<StructuredTelemetryFields>;
}

export interface StructuredTelemetrySink {
  write(record: Readonly<StructuredTelemetryRecord>): void;
}

export interface StructuredTelemetry {
  opaqueRef(kind: TelemetryOpaqueRefKind, value: string): TelemetryOpaqueRef;
  info(code: StructuredTelemetryEventCode, fields?: StructuredTelemetryFields): void;
  warn(code: StructuredTelemetryEventCode, fields?: StructuredTelemetryFields): void;
  error(code: StructuredTelemetryEventCode, fields?: StructuredTelemetryFields): void;
}

export interface StructuredTelemetryOptions {
  component: StructuredTelemetryComponent;
  /** Process secret or KMS-derived material. It is never emitted; require 256 bits or more. */
  opaqueRefKey: Uint8Array;
  sink: StructuredTelemetrySink;
  now?: () => number;
}

const OPAQUE_REF_KINDS = new Set<TelemetryOpaqueRefKind>([
  "owner",
  "tenant",
  "user",
  "session",
  "turn",
  "request",
  "runner",
  "provider",
]);

/**
 * Derive the shared, content-free owner identity used by runtime telemetry and lifecycle ledgers.
 * Callers must persist only the result and a key identifier/digest, never the HMAC key itself.
 */
export function telemetryOpaqueRefSha256(
  kind: TelemetryOpaqueRefKind,
  value: string,
  opaqueRefKey: Uint8Array,
): string {
  if (!OPAQUE_REF_KINDS.has(kind)) {
    throw new TypeError("telemetry opaque reference kind is not allowlisted");
  }
  const key = Buffer.from(opaqueRefKey);
  if (key.byteLength < 32) {
    throw new TypeError("telemetry opaqueRefKey must contain at least 32 bytes");
  }
  return createHmac("sha256", key)
    .update("agent-service-opaque-ref-v1\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function telemetryOpaqueRef(
  kind: TelemetryOpaqueRefKind,
  value: string,
  opaqueRefKey: Uint8Array,
): TelemetryOpaqueRef {
  return `oref_${kind}_${telemetryOpaqueRefSha256(kind, value, opaqueRefKey)}`;
}

function telemetryProducerKeyIdSha256(opaqueRefKey: Uint8Array): string {
  const key = Buffer.from(opaqueRefKey);
  if (key.byteLength < 32) {
    throw new TypeError("telemetry opaqueRefKey must contain at least 32 bytes");
  }
  return createHash("sha256")
    .update("agent-service/structured-telemetry-producer-key-id/v1\0", "utf8")
    .update(key)
    .digest("hex");
}

const FIELD_NAMES = new Set<keyof StructuredTelemetryFields>([
  "ownerRef",
  "subjectRef",
  "targetRef",
  "errorKind",
  "attempt",
  "retryable",
  "statusCode",
  "runnerCount",
  "shutdownGraceMs",
  "gateEnabledCount",
  "gateDisabledCount",
]);
const OPAQUE_REF = /^oref_(?:owner|tenant|user|session|turn|request|runner|provider)_[0-9a-f]{64}$/;
const ERROR_KINDS = new Set<TelemetryErrorKind>([
  "aborted",
  "timeout",
  "network",
  "unavailable",
  "unknown",
]);
const COMPONENTS = new Set<StructuredTelemetryComponent>([
  "router",
  "runner",
  "provider",
  "core",
]);

const LEVELS = new Set<StructuredTelemetryLevel>(["info", "warn", "error"]);

function exactRecordKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError("telemetry record has unknown or missing fields");
  }
}

function validateFields(
  fields: StructuredTelemetryFields,
  trustedOpaqueRefs?: ReadonlySet<TelemetryOpaqueRef>,
): Readonly<StructuredTelemetryFields> {
  const validated: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!FIELD_NAMES.has(name as keyof StructuredTelemetryFields)) {
      throw new TypeError(`telemetry field is not allowlisted: ${name}`);
    }
    if (value === undefined) continue;
    if (name.endsWith("Ref") && (typeof value !== "string" || !OPAQUE_REF.test(value))) {
      throw new TypeError(`telemetry ${name} must be an opaque reference`);
    }
    if (name.endsWith("Ref") && trustedOpaqueRefs !== undefined
      && !trustedOpaqueRefs.has(value as TelemetryOpaqueRef)) {
      throw new TypeError(`telemetry ${name} was not produced by this telemetry instance`);
    }
    if (name === "errorKind" && !ERROR_KINDS.has(value as TelemetryErrorKind)) {
      throw new TypeError("telemetry errorKind is not allowlisted");
    }
    if (name === "attempt" && (!Number.isSafeInteger(value) || Number(value) < 1)) {
      throw new TypeError("telemetry attempt must be a positive safe integer");
    }
    if (name === "statusCode" && (!Number.isSafeInteger(value) || Number(value) < 100 || Number(value) > 599)) {
      throw new TypeError("telemetry statusCode must be an HTTP status");
    }
    if (
      (name === "runnerCount" || name === "gateEnabledCount" || name === "gateDisabledCount")
      && (!Number.isSafeInteger(value) || Number(value) < 0)
    ) {
      throw new TypeError(`telemetry ${name} must be a non-negative safe integer`);
    }
    if (
      name === "shutdownGraceMs"
      && (!Number.isSafeInteger(value) || Number(value) < 1)
    ) {
      throw new TypeError("telemetry shutdownGraceMs must be a positive safe integer");
    }
    if (name === "retryable" && typeof value !== "boolean") {
      throw new TypeError("telemetry retryable must be boolean");
    }
    validated[name] = value;
  }
  return Object.freeze(validated as StructuredTelemetryFields);
}

/**
 * Validate the closed structured telemetry wire shape and return a canonical, deeply immutable copy.
 *
 * This is a syntax/integrity validator for persisted records. It deliberately does not prove that
 * an opaque-looking ref or trace id came from a trusted producer; live durable admission separately
 * requires records marked by createStructuredTelemetry.
 */
export function validateStructuredTelemetryRecord(
  value: unknown,
): Readonly<StructuredTelemetryRecord> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("telemetry record must be an object");
  }
  const record = value as Record<string, unknown>;
  const hasTraceId = Object.prototype.hasOwnProperty.call(record, "traceId");
  const hasSpanId = Object.prototype.hasOwnProperty.call(record, "spanId");
  if (hasTraceId !== hasSpanId) {
    throw new TypeError("telemetry trace id and span id must be provided together");
  }
  exactRecordKeys(record, [
    "schema",
    "timestampMs",
    "level",
    "component",
    "code",
    ...(hasTraceId ? ["traceId", "spanId"] : []),
    "fields",
  ]);
  if (record.schema !== "agent-service.telemetry.v1") {
    throw new TypeError("telemetry schema is invalid");
  }
  if (!Number.isSafeInteger(record.timestampMs) || Number(record.timestampMs) < 0) {
    throw new TypeError("telemetry timestamp must be a non-negative safe integer");
  }
  if (!LEVELS.has(record.level as StructuredTelemetryLevel)) {
    throw new TypeError("telemetry level is not allowlisted");
  }
  if (!COMPONENTS.has(record.component as StructuredTelemetryComponent)) {
    throw new TypeError("telemetry component is not allowlisted");
  }
  if (!(STRUCTURED_TELEMETRY_EVENT_CODES as readonly unknown[]).includes(record.code)) {
    throw new TypeError("telemetry event code is not allowlisted");
  }
  if (!(record.code as string).startsWith(`${String(record.component)}.`)) {
    throw new TypeError("telemetry event code does not match its component");
  }
  let trace: { traceId: string; spanId: string } | undefined;
  if (hasTraceId) {
    if (typeof record.traceId !== "string" || typeof record.spanId !== "string") {
      throw new TypeError("telemetry trace context is invalid");
    }
    const parsed = parseTraceparent(`00-${record.traceId}-${record.spanId}-00`);
    if (!parsed) throw new TypeError("telemetry trace context is invalid");
    trace = { traceId: parsed.traceId, spanId: parsed.spanId };
  }
  if (typeof record.fields !== "object" || record.fields === null
    || Array.isArray(record.fields)) {
    throw new TypeError("telemetry fields must be an object");
  }
  const fields = validateFields(record.fields as StructuredTelemetryFields);
  return Object.freeze({
    schema: "agent-service.telemetry.v1" as const,
    timestampMs: record.timestampMs as number,
    level: record.level as StructuredTelemetryLevel,
    component: record.component as StructuredTelemetryComponent,
    code: record.code as StructuredTelemetryEventCode,
    ...(trace ?? {}),
    fields,
  });
}

/** Return true only for the exact frozen record object emitted by createStructuredTelemetry. */
export function isTrustedStructuredTelemetryRecord(
  value: unknown,
): value is Readonly<StructuredTelemetryRecord> {
  return typeof value === "object" && value !== null
    && Object.isFrozen(value)
    && trustedStructuredTelemetryRecords.has(value);
}

/** Assert the in-process producer provenance required before a live record enters durable storage. */
export function assertTrustedStructuredTelemetryRecord(
  value: unknown,
): asserts value is Readonly<StructuredTelemetryRecord> {
  if (!isTrustedStructuredTelemetryRecord(value)) {
    throw new TypeError("telemetry record was not produced by createStructuredTelemetry");
  }
}

/**
 * Require a live record to come from the configured opaque-ref key and bind both the principal
 * tenant and the lifecycle owner. Tenant-owned records require the exact tenant ref; user/session
 * records require both the exact tenant ref and exact owner ref. Any other tenant/user/session ref
 * is rejected. This provenance is deliberately process-local: persisted records are validated as
 * wire data and never regain producer authority.
 */
export function assertTrustedStructuredTelemetryRecordOwnerBinding(
  value: unknown,
  tenantId: string,
  ownerKind: TenantTelemetryOwnerKind,
  ownerId: string,
  opaqueRefKey: Uint8Array,
): asserts value is Readonly<StructuredTelemetryRecord> {
  assertTrustedStructuredTelemetryRecord(value);
  const producerKeyIdSha256 = trustedStructuredTelemetryRecords.get(value);
  if (producerKeyIdSha256 !== telemetryProducerKeyIdSha256(opaqueRefKey)) {
    throw new TypeError("telemetry record producer key does not match durable owner binding");
  }
  const expectedTenant = telemetryOpaqueRef("tenant", tenantId, opaqueRefKey);
  const expectedOwner = telemetryOpaqueRef(ownerKind, ownerId, opaqueRefKey);
  const allowedLifecycleRefs = new Set<TelemetryOpaqueRef>([
    expectedTenant,
    ...(ownerKind === "tenant" ? [] : [expectedOwner]),
  ]);
  const refs = [value.fields.ownerRef, value.fields.subjectRef, value.fields.targetRef];
  if (!refs.includes(expectedTenant)) {
    throw new TypeError("telemetry record does not match durable tenant binding");
  }
  if (ownerKind !== "tenant" && !refs.includes(expectedOwner)) {
    throw new TypeError("telemetry record does not match durable owner binding");
  }
  for (const ref of refs) {
    if (ref !== undefined
      && (ref.startsWith("oref_tenant_")
        || ref.startsWith("oref_user_")
        || ref.startsWith("oref_session_"))
      && !allowedLifecycleRefs.has(ref)) {
      throw new TypeError("telemetry record contains a cross-owner lifecycle reference");
    }
  }
}

export function createStructuredTelemetry(options: StructuredTelemetryOptions): StructuredTelemetry {
  if (!COMPONENTS.has(options.component)) {
    throw new TypeError("telemetry component is not allowlisted");
  }
  // Validate at construction rather than deferring a configuration error to the first log line.
  const key = Buffer.from(options.opaqueRefKey);
  telemetryOpaqueRef("owner", "telemetry-key-validation", key);
  const producerKeyIdSha256 = telemetryProducerKeyIdSha256(key);
  const trustedOpaqueRefs = new Set<TelemetryOpaqueRef>();
  const now = options.now ?? Date.now;
  const emit = (
    level: StructuredTelemetryLevel,
    code: StructuredTelemetryEventCode,
    fields: StructuredTelemetryFields = {},
  ) => {
    if (!(STRUCTURED_TELEMETRY_EVENT_CODES as readonly string[]).includes(code)) {
      throw new TypeError("telemetry event code is not allowlisted");
    }
    if (!code.startsWith(`${options.component}.`)) {
      throw new TypeError("telemetry event code does not match its component");
    }
    const timestampMs = now();
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
      throw new TypeError("telemetry timestamp must be a non-negative safe integer");
    }
    const trace = currentTraceContext();
    const record: StructuredTelemetryRecord = {
      schema: "agent-service.telemetry.v1",
      timestampMs,
      level,
      component: options.component,
      code,
      ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
      fields: validateFields(fields, trustedOpaqueRefs),
    };
    const frozen = Object.freeze(record);
    trustedStructuredTelemetryRecords.set(frozen, producerKeyIdSha256);
    options.sink.write(frozen);
  };
  const telemetry: StructuredTelemetry = {
    opaqueRef(kind: TelemetryOpaqueRefKind, value: string): TelemetryOpaqueRef {
      const ref = telemetryOpaqueRef(kind, value, key);
      trustedOpaqueRefs.add(ref);
      return ref;
    },
    info: (code, fields) => emit("info", code, fields),
    warn: (code, fields) => emit("warn", code, fields),
    error: (code, fields) => emit("error", code, fields),
  };
  return Object.freeze(telemetry);
}

export function consoleTelemetrySink(
  output: Pick<Console, "info" | "warn" | "error"> = console,
): StructuredTelemetrySink {
  return {
    write(record) {
      const line = JSON.stringify(record);
      output[record.level](line);
    },
  };
}

export function createEphemeralStructuredTelemetry(
  component: StructuredTelemetryComponent,
  output: Pick<Console, "info" | "warn" | "error"> = console,
): StructuredTelemetry {
  return createStructuredTelemetry({
    component,
    opaqueRefKey: randomBytes(32),
    sink: consoleTelemetrySink(output),
  });
}

/** Collapse arbitrary Error names/messages into a fixed, content-free vocabulary. */
export function telemetryErrorKind(error: unknown): TelemetryErrorKind {
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error) {
    if (error.name === "AbortError") return "aborted";
    if (error.name === "TimeoutError") return "timeout";
    if (error.name === "TypeError") return "network";
  }
  return "unknown";
}
