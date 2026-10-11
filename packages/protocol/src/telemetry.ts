import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";

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

function validateFields(fields: StructuredTelemetryFields): Readonly<StructuredTelemetryFields> {
  const validated: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!FIELD_NAMES.has(name as keyof StructuredTelemetryFields)) {
      throw new TypeError(`telemetry field is not allowlisted: ${name}`);
    }
    if (value === undefined) continue;
    if (name.endsWith("Ref") && (typeof value !== "string" || !OPAQUE_REF.test(value))) {
      throw new TypeError(`telemetry ${name} must be an opaque reference`);
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

export function createStructuredTelemetry(options: StructuredTelemetryOptions): StructuredTelemetry {
  if (!COMPONENTS.has(options.component)) {
    throw new TypeError("telemetry component is not allowlisted");
  }
  // Validate at construction rather than deferring a configuration error to the first log line.
  const key = Buffer.from(options.opaqueRefKey);
  telemetryOpaqueRef("owner", "telemetry-key-validation", key);
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
      fields: validateFields(fields),
    };
    options.sink.write(Object.freeze(record));
  };
  const telemetry: StructuredTelemetry = {
    opaqueRef(kind: TelemetryOpaqueRefKind, value: string): TelemetryOpaqueRef {
      return telemetryOpaqueRef(kind, value, key);
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
