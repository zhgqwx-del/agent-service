import { describe, expect, it, vi } from "vitest";
import { runTelemetryCaptureCli, type TelemetryCaptureCliDependencies } from "../src/telemetry-capture-cli.js";
import type { TenantTelemetryCaptureOperatorFence } from "@agent-service/store";

function fixture() {
  const output: string[] = [];
  const key = Buffer.alloc(32, 41);
  const store = {
    getTenantTelemetryLifecycleControl: vi.fn(async () => ({ singletonId: 1, state: "inactive", controlGeneration: 0 })),
    getTenantTelemetryPersistedProviderCaptureControl: vi.fn(async () => ({ domain: "logs", state: "inactive", controlGeneration: 0 })),
    getTenantTelemetryPersistedProviderCapturePrerequisites: vi.fn(async () => ({
      runtimeEpochSha256: "a".repeat(64), runtimeBindingSha256: "b".repeat(64),
    })),
    listTenantTelemetryApplicationDomainControls: vi.fn(async () => ([
      { domain: "logs", state: "inactive" }, { domain: "traces", state: "inactive" },
    ])),
    listTenantTelemetryLifecycleTargets: vi.fn(async () => []),
    getTenantTelemetryPersistedProviderCaptureBinding: vi.fn(async () => null),
    verifyPersistedProviderStepFailureSource: vi.fn(),
    activateTenantTelemetryLifecycle: vi.fn(),
    activateTenantTelemetryPersistedProviderCapture: vi.fn(),
    withTenantTelemetryCaptureOperatorFence: vi.fn(async (work: (fence: TenantTelemetryCaptureOperatorFence) => Promise<unknown>) => work({
      scope: "tenant-telemetry-capture-operator-fence-v2", checkOwned: vi.fn(async () => {}),
    })),
    close: vi.fn(async () => {}),
  };
  const adapter = { validateStartup: vi.fn(async () => {}), destroy: vi.fn() };
  const deps = {
    readRefKey: vi.fn(async () => key),
    connectStore: vi.fn(async () => store),
    createAdapter: vi.fn(() => adapter),
    writeLine: (line: string) => output.push(line),
  } as unknown as TelemetryCaptureCliDependencies;
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", MYSQL_URL: "mysql://operator:private-dsn@127.0.0.1/disposable",
    TELEMETRY_CAPTURE_REF_KEY_FILE: "/private/operator/raw-key",
    TENANT_TELEMETRY_WRITER_ADAPTER: "s3", TENANT_TELEMETRY_S3_NAMESPACE_ID: "local-capture",
    TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID: "local-protocol-only", TENANT_TELEMETRY_S3_BUCKET: "private-capture",
    TENANT_TELEMETRY_S3_ENDPOINT: "http://127.0.0.1:9000", TENANT_TELEMETRY_S3_PRIVATE_BUCKET_ACK: "1",
    TENANT_TELEMETRY_S3_ACCESS_KEY_ID: "private-access", TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY: "private-secret",
  };
  return { store, adapter, deps, env, output, key };
}

describe("local telemetry capture one-shot operator", () => {
  it("status is a verify-only database read, without an external client or named lock", async () => {
    const f = fixture();
    delete f.env.TELEMETRY_CAPTURE_REF_KEY_FILE;
    await runTelemetryCaptureCli(["status"], f.env, f.deps);
    expect(f.deps.readRefKey).not.toHaveBeenCalled();
    expect(f.deps.connectStore).toHaveBeenCalledWith(expect.objectContaining({ migrationMode: "verify" }));
    expect(f.deps.createAdapter).not.toHaveBeenCalled();
    expect(f.store.withTenantTelemetryCaptureOperatorFence).not.toHaveBeenCalled();
    expect(f.store.activateTenantTelemetryLifecycle).not.toHaveBeenCalled();
    expect(JSON.parse(f.output[0]!)).toMatchObject({ command: "status", erasuresBlocked: true,
      allDomainsComplete: false, lifecycleState: "inactive", captureState: "inactive" });
  });

  it("passes the exact protected key to verify startup and wipes the local buffer", async () => {
    const f = fixture();
    let captured: Buffer | undefined;
    f.deps.connectStore = vi.fn(async (options) => {
      expect(options.tenantTelemetryRefKey instanceof Uint8Array).toBe(true);
      captured = Buffer.from(options.tenantTelemetryRefKey!);
      return f.store as unknown as Awaited<ReturnType<typeof f.deps.connectStore>>;
    });
    await runTelemetryCaptureCli(["status"], f.env, f.deps);
    expect(captured!.length).toBe(32);
    expect(captured!.every((byte) => byte === 41), "exact protected bytes required").toBe(true);
    expect(f.key.every((byte) => byte === 0), "temporary key must be zeroed").toBe(true);
    captured!.fill(0);
  });

  it("rejects production, unknown command flags and raw env keys before resource access", async () => {
    for (const [argv, override] of [
      [["status"], { NODE_ENV: "production" }],
      [["status", "--mysql-url=private-dsn"], {}],
      [["status"], { TENANT_TELEMETRY_REF_KEY: "private-raw-key" }],
      [["activate-logs"], {}],
    ] as const) {
      const f = fixture();
      await expect(runTelemetryCaptureCli(argv, { ...f.env, ...override }, f.deps)).rejects.toThrow("operation_failed");
      expect(f.deps.readRefKey).not.toHaveBeenCalled();
      expect(f.deps.connectStore).not.toHaveBeenCalled();
      expect(f.output).toEqual([]);
    }
  });

  it("preflight binds real primary prerequisites and discloses mutation of probe objects", async () => {
    const f = fixture();
    await runTelemetryCaptureCli(["preflight"], f.env, f.deps);
    expect(f.store.getTenantTelemetryPersistedProviderCapturePrerequisites).toHaveBeenCalledOnce();
    expect(f.store.withTenantTelemetryCaptureOperatorFence).toHaveBeenCalledOnce();
    expect(f.adapter.validateStartup).toHaveBeenCalledOnce();
    expect(f.store.activateTenantTelemetryLifecycle).not.toHaveBeenCalled();
    expect(f.deps.createAdapter).toHaveBeenCalledWith(expect.objectContaining({
      expectedTargets: [expect.objectContaining({ domain: "logs" }), expect.objectContaining({ domain: "traces" })],
      operationAbortSignal: expect.any(AbortSignal),
    }));
    expect(JSON.parse(f.output[0]!)).toMatchObject({ capabilityProbe: true, mutatedProbeObjects: true,
      executionReady: false, erasuresBlocked: true });
    for (const value of ["private-dsn", "raw-key", "private-secret", "private-access", "127.0.0.1"])
      expect(f.output.join("\n")).not.toContain(value);
  });

  it("cannot substitute gen0/env lineage for real active primary DB prerequisites", async () => {
    const f = fixture();
    f.store.getTenantTelemetryPersistedProviderCapturePrerequisites.mockRejectedValue(new Error("private-runtime-detail"));
    await expect(runTelemetryCaptureCli(["preflight"], { ...f.env, RESTORE_JOURNAL_RUNTIME_EPOCH_ID: "pretend" }, f.deps))
      .rejects.toThrow("operation_failed");
    expect(f.deps.createAdapter).not.toHaveBeenCalled();
    expect(f.output).toEqual([]);
    expect(f.store.close).toHaveBeenCalled();
  });

  it("rejects active v1/traces and never prints an adapter diagnostic", async () => {
    const f = fixture();
    f.store.listTenantTelemetryApplicationDomainControls.mockResolvedValue([
      { domain: "logs", state: "inactive" }, { domain: "traces", state: "active" },
    ]);
    await expect(runTelemetryCaptureCli(["preflight"], f.env, f.deps)).rejects.toThrow("operation_failed");
    expect(f.deps.createAdapter).not.toHaveBeenCalled();
    const g = fixture();
    g.adapter.validateStartup.mockRejectedValue(new Error("https://private-user:private-key@private-host/body"));
    await expect(runTelemetryCaptureCli(["preflight"], g.env, g.deps)).rejects.toThrow("operation_failed");
    expect(g.output).toEqual([]);
    expect(g.adapter.destroy).toHaveBeenCalled();
  });

  it("verify-source delegates one atomic store recheck and strips arbitrary extra fields", async () => {
    const f = fixture();
    f.store.getTenantTelemetryPersistedProviderCaptureBinding.mockResolvedValue({
      runtimeEpochSha256: "a".repeat(64), runtimeBindingSha256: "b".repeat(64),
    } as never);
    f.store.verifyPersistedProviderStepFailureSource.mockResolvedValue({ status: "source_verified_written", sourceCount: 1,
      failureCommitReceiptSha256: "1".repeat(64), sourceBindingReceiptSha256: "2".repeat(64),
      writeOperationSha256: "3".repeat(64), membershipSha256: "4".repeat(64),
      writeAckReceiptSha256: "5".repeat(64), inventoryReceiptSha256: "6".repeat(64),
      executionReady: false, allDomainsComplete: false, privateRawBody: "must-not-appear" });
    await runTelemetryCaptureCli(["verify-source"], { ...f.env,
      TELEMETRY_CAPTURE_TENANT_ID: "raw-tenant", TELEMETRY_CAPTURE_SESSION_ID: "raw-session",
      TELEMETRY_CAPTURE_TURN_ID: "raw-turn", TELEMETRY_CAPTURE_ITEM_ID: "raw-item", TELEMETRY_CAPTURE_STEP_INDEX: "0",
    }, f.deps);
    expect(f.store.verifyPersistedProviderStepFailureSource).toHaveBeenCalledOnce();
    expect(f.deps.createAdapter).not.toHaveBeenCalled();
    expect(JSON.parse(f.output[0]!)).toMatchObject({ sourceStatus: "source_verified_written", sourceCount: 1 });
    expect(f.output.join("\n")).not.toContain("raw-");
    expect(f.output.join("\n")).not.toContain("must-not-appear");
  });

  it("one shared abort signal reaches connection, probe and operator fence without late success", async () => {
    const f = fixture();
    f.adapter.validateStartup = vi.fn(() => new Promise<void>((_resolve, reject) => {
      const options = vi.mocked(f.deps.createAdapter).mock.calls[0]![0];
      expect(options.operationAbortSignal instanceof AbortSignal).toBe(true);
      options.operationAbortSignal!.addEventListener("abort", () => reject(new Error("private-timeout-detail")), { once: true });
    }));
    await expect(runTelemetryCaptureCli(["preflight"], { ...f.env, TELEMETRY_CAPTURE_OPERATION_TIMEOUT_MS: "100" }, f.deps))
      .rejects.toThrow("operation_failed");
    const connection = vi.mocked(f.deps.connectStore).mock.calls[0]![0];
    const probe = vi.mocked(f.deps.createAdapter).mock.calls[0]![0];
    expect(probe.operationAbortSignal).toBe(connection.operationAbortSignal);
    expect(connection.operationAbortSignal.aborted).toBe(true);
    expect(f.output).toEqual([]);
    expect(f.store.activateTenantTelemetryLifecycle).not.toHaveBeenCalled();
    expect(f.store.close).toHaveBeenCalled();
  });
});
