import { describe, expect, it } from "vitest";
import {
  assertTrustedStructuredTelemetryRecord,
  assertTrustedStructuredTelemetryRecordOwnerBinding,
  createStructuredTelemetry,
  currentTraceContext,
  formatTraceparent,
  isTrustedStructuredTelemetryRecord,
  outgoingTraceparent,
  parseTraceparent,
  startBoundaryTraceContext,
  startTraceContext,
  telemetryErrorKind,
  telemetryOpaqueRef,
  telemetryOpaqueRefSha256,
  validateStructuredTelemetryRecord,
  withTraceContext,
  type StructuredTelemetryRecord,
} from "../src/index.js";

const PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("W3C trace context", () => {
  it("strictly parses only canonical version-00 traceparent values", () => {
    expect(parseTraceparent(PARENT)).toEqual({
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    for (const invalid of [
      ` ${PARENT}`,
      PARENT.toUpperCase(),
      PARENT.replace(/^00/, "01"),
      PARENT.replace(/-01$/, "-0A"),
      PARENT.replace(/-01$/, "-0"),
      PARENT.replace(/-01$/, "-000"),
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      `${PARENT}-extra`,
    ]) expect(parseTraceparent(invalid)).toBeUndefined();
  });

  it("accepts and preserves every lowercase version-00 trace-flags bit", () => {
    for (const flags of ["02", "03", "7e", "ff"] as const) {
      const incoming = PARENT.replace(/-01$/, `-${flags}`);
      expect(parseTraceparent(incoming)?.traceFlags).toBe(flags);
      const local = startTraceContext(incoming);
      expect(local.traceFlags).toBe(flags);
      withTraceContext(local, () => {
        expect(parseTraceparent(outgoingTraceparent())?.traceFlags).toBe(flags);
      });
    }
  });

  it("preserves the trace id, generates new spans, and isolates async contexts", async () => {
    const server = startTraceContext(PARENT);
    expect(server.traceId).toBe(parseTraceparent(PARENT)!.traceId);
    expect(server.spanId).not.toBe(parseTraceparent(PARENT)!.spanId);
    await withTraceContext(server, async () => {
      await Promise.resolve();
      expect(currentTraceContext()).toEqual(server);
      const downstream = parseTraceparent(outgoingTraceparent())!;
      expect(downstream.traceId).toBe(server.traceId);
      expect(downstream.spanId).not.toBe(server.spanId);
      expect(downstream.traceFlags).toBe("01");
    });
    expect(currentTraceContext()).toBeUndefined();
  });

  it("rejects structurally typed contexts that could smuggle raw identifiers", () => {
    expect(() => formatTraceparent({
      version: "00",
      traceId: "raw-private-tenant".padEnd(32, "0"),
      spanId: "raw-private".padEnd(16, "0"),
      traceFlags: "01",
    })).toThrow(/not canonical/);
    expect(() => withTraceContext({
      version: "00",
      traceId: "0".repeat(32),
      spanId: "1".repeat(16),
      traceFlags: "00",
    }, () => undefined)).toThrow(/not canonical/);
  });

  it("starts a fresh root for malformed input", () => {
    const context = startTraceContext("private-header-value");
    expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
    expect(formatTraceparent(context)).not.toContain("private-header-value");
  });

  it("starts a fresh internal root at a public boundary", () => {
    const incoming = parseTraceparent(PARENT)!;
    const first = startBoundaryTraceContext();
    const second = startBoundaryTraceContext();
    expect(parseTraceparent(formatTraceparent(first))).toEqual(first);
    expect(first.traceId).not.toBe(incoming.traceId);
    expect(first.spanId).not.toBe(incoming.spanId);
    expect(second.traceId).not.toBe(first.traceId);
    expect(first.traceFlags).toBe("00");
  });
});

describe("structured telemetry", () => {
  it("canonicalizes untrusted records and rejects extra or partial trace fields", () => {
    const record = validateStructuredTelemetryRecord({
      schema: "agent-service.telemetry.v1",
      timestampMs: 123,
      level: "warn",
      component: "runner",
      code: "runner.runtime.warning",
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      fields: {
        ownerRef: `oref_owner_${"3".repeat(64)}`,
        retryable: true,
      },
    });
    expect(record).toEqual({
      schema: "agent-service.telemetry.v1",
      timestampMs: 123,
      level: "warn",
      component: "runner",
      code: "runner.runtime.warning",
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      fields: {
        ownerRef: `oref_owner_${"3".repeat(64)}`,
        retryable: true,
      },
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.fields)).toBe(true);
    expect(isTrustedStructuredTelemetryRecord(record)).toBe(false);
    expect(() => assertTrustedStructuredTelemetryRecord(record))
      .toThrow(/not produced by createStructuredTelemetry/);

    expect(() => validateStructuredTelemetryRecord({
      ...record,
      rawTenantId: "tenant-secret",
    })).toThrow(/unknown or missing/);
    const { spanId: _spanId, ...partialTrace } = record;
    expect(() => validateStructuredTelemetryRecord(partialTrace)).toThrow(/provided together/);
    expect(() => validateStructuredTelemetryRecord({
      ...record,
      fields: { ...record.fields, message: "secret" },
    })).toThrow(/not allowlisted/);
    expect(() => validateStructuredTelemetryRecord({
      ...record,
      component: "router",
    })).toThrow(/match its component/);
  });

  it("emits only allowlisted fields with keyed, domain-separated opaque refs", () => {
    const records: Readonly<StructuredTelemetryRecord>[] = [];
    const mutableKey = Buffer.alloc(32, 7);
    const telemetry = createStructuredTelemetry({
      component: "router",
      opaqueRefKey: mutableKey,
      sink: { write: (record) => records.push(record) },
      now: () => 123,
    });
    const rawOwner = "http://runner.internal:9000/super-secret";
    const ownerRef = telemetry.opaqueRef("owner", rawOwner);
    expect(ownerRef).toMatch(/^oref_owner_[0-9a-f]{64}$/);
    expect(ownerRef).toBe(telemetry.opaqueRef("owner", rawOwner));
    expect(ownerRef).toBe(telemetryOpaqueRef("owner", rawOwner, Buffer.alloc(32, 7)));
    expect(ownerRef).toBe(
      `oref_owner_${telemetryOpaqueRefSha256("owner", rawOwner, Buffer.alloc(32, 7))}`,
    );
    expect(ownerRef).toBe(
      "oref_owner_a5ef20d32eca30879a04256e8b00330729b176b3c44b3589fe977b52a9cc4746",
    );
    expect(ownerRef).not.toBe(telemetry.opaqueRef("runner", rawOwner));
    expect(ownerRef).not.toContain(rawOwner);
    mutableKey.fill(8);
    expect(telemetry.opaqueRef("owner", rawOwner)).toBe(ownerRef);

    withTraceContext(startTraceContext(PARENT), () => {
      telemetry.warn("router.owner_unconfigured", {
        ownerRef,
        subjectRef: telemetry.opaqueRef("session", "sess_private"),
        targetRef: undefined,
        errorKind: "unavailable",
      });
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schema: "agent-service.telemetry.v1",
      timestampMs: 123,
      level: "warn",
      component: "router",
      code: "router.owner_unconfigured",
      traceId: parseTraceparent(PARENT)!.traceId,
    });
    const encoded = JSON.stringify(records[0]);
    expect(encoded).not.toContain(rawOwner);
    expect(encoded).not.toContain("sess_private");
    expect(records[0]!.fields).not.toHaveProperty("targetRef");
    expect(isTrustedStructuredTelemetryRecord(records[0])).toBe(true);
    expect(() => assertTrustedStructuredTelemetryRecord(records[0])).not.toThrow();
  });

  it("binds durable record provenance to the producer key and exact lifecycle owner", () => {
    const key = Buffer.alloc(32, 9);
    let record: Readonly<StructuredTelemetryRecord> | undefined;
    const telemetry = createStructuredTelemetry({
      component: "runner",
      opaqueRefKey: key,
      sink: { write(value) { record = value; } },
      now: () => 456,
    });
    telemetry.info("runner.runtime.info", {
      ownerRef: telemetry.opaqueRef("tenant", "tenant-a"),
      subjectRef: telemetry.opaqueRef("session", "session-owner"),
    });
    expect(record).toBeDefined();
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      record,
      "tenant-a",
      "session",
      "session-owner",
      Buffer.alloc(32, 9),
    )).not.toThrow();
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      record,
      "tenant-a",
      "session",
      "session-owner",
      Buffer.alloc(32, 10),
    )).toThrow(/producer key/);
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      record,
      "tenant-a",
      "session",
      "another-session",
      Buffer.alloc(32, 9),
    )).toThrow(/owner binding/);
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      record,
      "tenant-b",
      "session",
      "session-owner",
      Buffer.alloc(32, 9),
    )).toThrow(/tenant binding/);

    let userRecord: Readonly<StructuredTelemetryRecord> | undefined;
    const userTelemetry = createStructuredTelemetry({
      component: "runner",
      opaqueRefKey: key,
      sink: { write(value) { userRecord = value; } },
      now: () => 457,
    });
    userTelemetry.info("runner.runtime.info", {
      ownerRef: userTelemetry.opaqueRef("tenant", "tenant-a"),
      subjectRef: userTelemetry.opaqueRef("user", "shared-user"),
    });
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      userRecord,
      "tenant-a",
      "user",
      "shared-user",
      key,
    )).not.toThrow();
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      userRecord,
      "tenant-b",
      "user",
      "shared-user",
      key,
    )).toThrow(/tenant binding/);

    let crossOwnerRecord: Readonly<StructuredTelemetryRecord> | undefined;
    const crossOwnerTelemetry = createStructuredTelemetry({
      component: "runner",
      opaqueRefKey: key,
      sink: { write(value) { crossOwnerRecord = value; } },
      now: () => 458,
    });
    crossOwnerTelemetry.info("runner.runtime.info", {
      ownerRef: crossOwnerTelemetry.opaqueRef("tenant", "tenant-a"),
      subjectRef: crossOwnerTelemetry.opaqueRef("session", "session-owner"),
      targetRef: crossOwnerTelemetry.opaqueRef("session", "another-session"),
    });
    expect(() => assertTrustedStructuredTelemetryRecordOwnerBinding(
      crossOwnerRecord,
      "tenant-a",
      "session",
      "session-owner",
      key,
    )).toThrow(/cross-owner lifecycle reference/);
  });

  it("rejects non-allowlisted fields, codes, refs, and short keys", () => {
    expect(() => createStructuredTelemetry({
      component: "raw-private" as never,
      opaqueRefKey: Buffer.alloc(32),
      sink: { write: () => {} },
    })).toThrow(/component is not allowlisted/);
    expect(() => createStructuredTelemetry({
      component: "core",
      opaqueRefKey: Buffer.alloc(31),
      sink: { write: () => {} },
    })).toThrow(/at least 32 bytes/);
    expect(() => telemetryOpaqueRefSha256(
      "raw-owner" as never,
      "value",
      Buffer.alloc(32),
    )).toThrow(/kind is not allowlisted/);
    const telemetry = createStructuredTelemetry({
      component: "runner",
      opaqueRefKey: Buffer.alloc(32),
      sink: { write: () => {} },
    });
    expect(() => telemetry.info(
      "runner.unhandled_error",
      { message: "secret" } as never,
    )).toThrow(/not allowlisted/);
    expect(() => telemetry.info(
      "runner.unhandled_error",
      { ownerRef: "raw-owner" } as never,
    )).toThrow(/opaque reference/);
    expect(() => telemetry.info(
      "runner.unhandled_error",
      { ownerRef: `oref_owner_${"f".repeat(64)}` },
    )).toThrow(/not produced by this telemetry instance/);
    const other = createStructuredTelemetry({
      component: "runner",
      opaqueRefKey: Buffer.alloc(32, 1),
      sink: { write: () => {} },
    });
    expect(() => telemetry.info(
      "runner.unhandled_error",
      { ownerRef: other.opaqueRef("owner", "same-shape-different-producer") },
    )).toThrow(/not produced by this telemetry instance/);
    expect(() => telemetry.info("secret-as-code" as never)).toThrow(/event code/);
    expect(() => telemetry.info("router.owner_reroute")).toThrow(/match its component/);
    const invalidClock = createStructuredTelemetry({
      component: "runner",
      opaqueRefKey: Buffer.alloc(32),
      sink: { write: () => {} },
      now: () => Number.NaN,
    });
    expect(() => invalidClock.info("runner.unhandled_error")).toThrow(/timestamp/);
  });

  it("maps arbitrary errors to a fixed vocabulary without retaining their message", () => {
    expect(telemetryErrorKind(new DOMException("secret", "AbortError"))).toBe("aborted");
    expect(telemetryErrorKind(new DOMException("secret", "TimeoutError"))).toBe("timeout");
    expect(telemetryErrorKind(new TypeError("https://secret.invalid"))).toBe("network");
    const custom = new Error("api-key=secret");
    custom.name = "api-key=secret";
    expect(telemetryErrorKind(custom)).toBe("unknown");
  });
});
