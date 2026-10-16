import { describe, expect, it, vi } from "vitest";
import { MemorySessionStore } from "../src/memory.js";
import { TenantTelemetryCaptureRestoreIntegrityError } from "../src/tenant-telemetry-capture-restore.js";

// These pure tests exercise only the lifetime and input separation of the
// private synchronous read frame. They do not prove checkpoint lineage, owner,
// ACK, permit, three-source or database correctness; those remain real audits.
type ReadFrame = { nonce: symbol; succeeded: Set<string>; inflight: Set<string> };
type ScopeProbe = {
  withMemoryCaptureReadAuditFrame<T>(read: () => T): T;
  memoSuccessfulMemoryCaptureReadAudit(kind: "checkpoint" | "lineage", input: unknown, audit: () => void): void;
  captureReadAuditFrame?: ReadFrame;
  captureRestoreMaintenanceReadContext?: unknown;
  tenantTelemetryRefKey: Uint8Array;
};

function fixture() {
  const store = new MemorySessionStore({ now: () => 1_000 },
    { tenantTelemetryRefKey: Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 1)) });
  return store as unknown as ScopeProbe;
}

describe("Memory capture synchronous read audit scope (not source correctness proof)", () => {
  it("memoizes only a successful void audit within one frame and clears nonce and sets on exit", () => {
    const subject = fixture(), audit = vi.fn(), input = { checkpoint: { value: 1 } };
    let first!: ReadFrame, nested!: ReadFrame;
    subject.withMemoryCaptureReadAuditFrame(() => {
      first = subject.captureReadAuditFrame!;
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, audit);
      subject.withMemoryCaptureReadAuditFrame(() => {
        nested = subject.captureReadAuditFrame!;
        subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, audit);
      });
      expect(audit).toHaveBeenCalledOnce();
      expect(first.succeeded.size).toBe(1);
    });
    expect(nested).toBe(first);
    expect(subject.captureReadAuditFrame).toBeUndefined();
    expect(first.succeeded.size).toBe(0);
    expect(first.inflight.size).toBe(0);
    subject.withMemoryCaptureReadAuditFrame(() => {
      expect(subject.captureReadAuditFrame!.nonce).not.toBe(first.nonce);
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, audit);
    });
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("does not memoize failures or in-flight recursion and always releases an exceptional scope", () => {
    const subject = fixture(), input = { checkpoint: "same" }, broken = new Error("fixture-failure");
    const failed = vi.fn(() => { throw broken; }), succeeded = vi.fn();
    expect(() => subject.withMemoryCaptureReadAuditFrame(() => {
      expect(() => subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, failed)).toThrow(broken);
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, () => {
        expect(() => subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, succeeded))
          .toThrow(TenantTelemetryCaptureRestoreIntegrityError);
        throw broken;
      });
    })).toThrow(broken);
    expect(subject.captureReadAuditFrame).toBeUndefined();
    expect(failed).toHaveBeenCalledOnce();
    expect(succeeded).not.toHaveBeenCalled();
    subject.withMemoryCaptureReadAuditFrame(() => subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, succeeded));
    expect(succeeded).toHaveBeenCalledOnce();
  });

  it("distinguishes complete selector, purpose, historical context and audit kind", () => {
    const subject = fixture(), audit = vi.fn();
    const base = { record: { checkpoint: "a" }, selector: { backupId: "backup-a", restoreRunId: "run-a" },
      purpose: "operator", historical: false };
    subject.withMemoryCaptureReadAuditFrame(() => {
      for (const input of [base, base, { ...base, selector: { ...base.selector, restoreRunId: "run-b" } },
        { ...base, purpose: "runtime" }, { ...base, historical: true },
        { ...base, record: { checkpoint: "b" } }]) {
        subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, audit);
      }
      subject.memoSuccessfulMemoryCaptureReadAudit("checkpoint", base, audit);
    });
    expect(audit).toHaveBeenCalledTimes(6);
  });

  it("re-hashes in-place record and protected key bytes, and separates a new key object with equal bytes", () => {
    const subject = fixture(), audit = vi.fn(), record = { leaf: { evidence: "old" } };
    subject.withMemoryCaptureReadAuditFrame(() => {
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record }, audit);
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record }, audit);
      expect(audit).toHaveBeenCalledOnce();
      record.leaf.evidence = "tampered";
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record }, audit);
      subject.tenantTelemetryRefKey[0] = subject.tenantTelemetryRefKey[0]! ^ 1;
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record }, audit);
      subject.tenantTelemetryRefKey = Uint8Array.from(subject.tenantTelemetryRefKey);
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record }, audit);
    });
    expect(audit).toHaveBeenCalledTimes(4);
  });

  it("rejects getters, toJSON, non-plain objects and proxies without invoking their callbacks or reusing a success", () => {
    const subject = fixture(), audit = vi.fn(), record: { leaf: string; toJSON?: () => string } = { leaf: "clean" };
    let getterCalls = 0, toJsonCalls = 0, proxyTrapCalls = 0;
    subject.withMemoryCaptureReadAuditFrame(() => {
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record }, audit);
      Object.defineProperty(record, "leaf", { enumerable: true, configurable: true,
        get() { getterCalls++; return "clean"; } });
      expect(() => subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record }, audit))
        .toThrow(TenantTelemetryCaptureRestoreIntegrityError);
      expect(getterCalls).toBe(0);
      Object.defineProperty(record, "leaf", { value: "clean", enumerable: true, configurable: true, writable: true });
      Object.defineProperty(record, "toJSON", { value: () => { toJsonCalls++; return "clean"; }, enumerable: true,
        configurable: true });
      expect(() => subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record }, audit))
        .toThrow(TenantTelemetryCaptureRestoreIntegrityError);
      expect(toJsonCalls).toBe(0);
      const proxy = new Proxy({ leaf: "clean" }, { getPrototypeOf() { proxyTrapCalls++; throw new Error("trap"); },
        ownKeys() { proxyTrapCalls++; throw new Error("trap"); } });
      expect(() => subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record: proxy }, audit))
        .toThrow(TenantTelemetryCaptureRestoreIntegrityError);
      expect(proxyTrapCalls).toBe(0);
      expect(() => subject.memoSuccessfulMemoryCaptureReadAudit("lineage", { record: new Date(0) }, audit))
        .toThrow(TenantTelemetryCaptureRestoreIntegrityError);
    });
    expect(audit).toHaveBeenCalledOnce();
  });

  it("does not reuse a success after maintenance-read context changes, even inside the same frame", () => {
    const subject = fixture(), audit = vi.fn(), input = { checkpoint: "same" };
    subject.withMemoryCaptureReadAuditFrame(() => {
      subject.memoSuccessfulMemoryCaptureReadAudit("checkpoint", input, audit);
      subject.captureRestoreMaintenanceReadContext = { selector: { restoreRunId: "first" } };
      subject.memoSuccessfulMemoryCaptureReadAudit("checkpoint", input, audit);
      subject.captureRestoreMaintenanceReadContext = { selector: { restoreRunId: "second" } };
      subject.memoSuccessfulMemoryCaptureReadAudit("checkpoint", input, audit);
      subject.captureRestoreMaintenanceReadContext = undefined;
      subject.memoSuccessfulMemoryCaptureReadAudit("checkpoint", input, audit);
    });
    expect(audit).toHaveBeenCalledTimes(3);
  });

  it("does not retain a frame across an async boundary or a later read/tamper", async () => {
    const subject = fixture(), audit = vi.fn(), input = { leaf: "before" };
    const pending = subject.withMemoryCaptureReadAuditFrame(async () => {
      subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, audit);
      await Promise.resolve();
      expect(subject.captureReadAuditFrame).toBeUndefined();
    });
    expect(subject.captureReadAuditFrame).toBeUndefined();
    await pending;
    input.leaf = "after";
    subject.withMemoryCaptureReadAuditFrame(() => subject.memoSuccessfulMemoryCaptureReadAudit("lineage", input, audit));
    expect(audit).toHaveBeenCalledTimes(2);
  });
});
