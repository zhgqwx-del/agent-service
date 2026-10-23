import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { ProviderService } from "@agent-service/providers";
import { ConfiguredMcpToolSource } from "../../../packages/core/src/mcp/service.js";
import { MemorySessionAuthority } from "../../../packages/store/src/memory-session-authority.js";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createStructuredTelemetry,
  type StructuredTelemetryRecord,
} from "@agent-service/protocol";
import {
  INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER,
  INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE,
  INTERNAL_ERASURE_JOB_CONTROL_READY_PATH,
  INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER,
  INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE,
  INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH,
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_ERASURE_ACTOR_HEADER,
  INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ADMISSION_ACK_VALUE,
  INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH,
  INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
} from "@agent-service/protocol";

const mockedServer = vi.hoisted(() => ({
  fetch: undefined as undefined | ((request: Request) => Promise<Response>),
  listening: true,
  close(callback?: () => void) {
    this.listening = false;
    callback?.();
    return this;
  },
}));

vi.mock("@hono/node-server", () => ({
  serve: (options: { fetch: (request: Request) => Promise<Response> }) => {
    mockedServer.fetch = options.fetch;
    mockedServer.listening = true;
    return mockedServer;
  },
}));

import {
  ErasureWorker,
  LegacyTombstoneCompensationWorker,
  PiEngine,
  newId,
  OrdinarySessionDeleteGraceRecovery,
  OrdinarySessionUsageRetentionWorker,
  PurgePolicyEvaluator,
  TenantContentInventoryWorker,
  TenantCredentialTargetExecutionWorker,
  TenantDatabasePurgeWorker,
  TenantPurgeExecutionWorker,
  TenantPurgePlanWorker,
  TenantRuntimeRevocationWorker,
  UserDataExportCleanupWorker,
  UserDataExportWorker,
} from "@agent-service/core";
import {
  MemoryEventBus,
  MemorySessionStore,
  RedisEventBus,
} from "@agent-service/store";
import {
  createContentFreeRunnerLogger,
  startRunner,
  writeAdminBootstrapOutputFile,
} from "../src/main.js";
import { SseAdmission } from "../src/sse.js";

const MASTER_KEY = "88".repeat(32);
const INTERNAL_TOKEN = "runner-main-private-router-token-0001";

describe("runner bootstrap telemetry", () => {
  it("starts cancellable MCP stop before joining an admitted HTTP handler and keeps its store alive", async context => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-stop-before-join-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined, response: Promise<Response> | undefined;
    let entered!: () => void, cancel!: () => void, finish!: () => void, stopped!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const stopBegan = new Promise<void>(resolve => { stopped = resolve; });
    const originalStop = ConfiguredMcpToolSource.prototype.stop;
    const stop = vi.spyOn(ConfiguredMcpToolSource.prototype, "stop").mockImplementation(function (this: ConfiguredMcpToolSource) {
      originalStop.call(this); cancel(); stopped();
    });
    const closeStore = vi.spyOn(MemorySessionStore.prototype, "close");
    const abort = () => { cancel(); finish(); }; context.signal.addEventListener("abort", abort, { once: true });
    try {
      runner = await startRunner({ SECRETS_MASTER_KEY: MASTER_KEY, RUNNER_PORT: "0", RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir, BOOTSTRAP_API_KEY: "synthetic-admin-stop-before-join", BOOTSTRAP_TENANT_ID: "shutdown-admin",
        MCP_ENABLED: "1", MCP_SERVERS_JSON: JSON.stringify([{ id: "synthetic", endpoint: "https://mcp-stop.invalid/mcp",
          subjects: [{ tenantId: "shutdown-admin", userId: "synthetic-user" }] }]) });
      const original = runner.store.listAgents.bind(runner.store);
      vi.spyOn(runner.store, "listAgents").mockImplementation(async (...args) => {
        entered(); await cancelled; await completed; return original(...args);
      });
      response = mockedServer.fetch!(new Request("http://127.0.0.1/v1/agents", {
        headers: { Authorization: "Bearer synthetic-admin-stop-before-join" } }));
      void response.catch(() => {});
      await Promise.race([started, response.then(() => { throw new Error("admin handler did not reach its owned store call"); })]);
      const closing = runner.close(); expect(runner.close()).toBe(closing);
      await Promise.race([stopBegan, closing.then(() => { throw new Error("process closed before cancellable source stop"); })]);
      expect(stop).toHaveBeenCalledOnce(); expect(closeStore).not.toHaveBeenCalled();
      finish(); await response; await closing; expect(closeStore).toHaveBeenCalledOnce(); runner = undefined;
    } finally {
      abort(); await response?.catch(() => {}); await runner?.close().catch(() => {});
      context.signal.removeEventListener("abort", abort); vi.restoreAllMocks();
      log.mockRestore(); await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("joins an admitted admin handler before closing stores and fences later keep-alive requests", async context => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-http-settlement-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    let release!: () => void, entered!: () => void;
    const allowed = new Promise<void>(done => { release = done; });
    const started = new Promise<void>(done => { entered = done; });
    const abort = () => release(); context.signal.addEventListener("abort", abort, { once: true });
    const closeStore = vi.spyOn(MemorySessionStore.prototype, "close");
    let response: Promise<Response> | undefined;
    try {
      runner = await startRunner({ SECRETS_MASTER_KEY: MASTER_KEY, RUNNER_PORT: "0", RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir, BOOTSTRAP_API_KEY: "synthetic-admin-shutdown-key", BOOTSTRAP_TENANT_ID: "shutdown-admin" });
      const original = runner.store.listAgents.bind(runner.store);
      vi.spyOn(runner.store, "listAgents").mockImplementation(async (...args) => {
        entered(); await allowed; return original(...args);
      });
      const fetch = mockedServer.fetch!;
      response = fetch(new Request("http://127.0.0.1/v1/agents", { headers: { Authorization: "Bearer synthetic-admin-shutdown-key" } }));
      void response.catch(() => {});
      await Promise.race([started, response.then(() => { throw new Error("admin request ended before its controlled store call"); })]);
      const closing = runner.close(); expect(runner.close()).toBe(closing);
      expect((await fetch(new Request("http://127.0.0.1/readyz"))).status).toBe(503);
      expect((await fetch(new Request("http://127.0.0.1/v1/agents"))).status).toBe(503);
      await Promise.resolve(); expect(closeStore).not.toHaveBeenCalled();
      release(); await response; await closing; expect(closeStore).toHaveBeenCalledOnce(); runner = undefined;
    } finally {
      release(); await response?.catch(() => {}); await runner?.close().catch(() => {});
      context.signal.removeEventListener("abort", abort); closeStore.mockRestore(); vi.restoreAllMocks();
      log.mockRestore(); await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("retains the first stop failure while joining later cleanup and never exits an embedding caller", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-stop-failure-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const failure = new Error("synthetic private stop error");
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    const closeStore = vi.spyOn(MemorySessionStore.prototype, "close");
    try {
      runner = await startRunner({ SECRETS_MASTER_KEY: MASTER_KEY, RUNNER_PORT: "0", RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir, SESSION_DELETE_GRACE_RECOVERY_ENABLED: "1", SESSION_DELETE_GRACE_RECOVERY_POLL_MS: "60000" });
      const worker = runner.ordinarySessionDeleteGraceRecovery!;
      const originalStop = worker.stop.bind(worker);
      const stop = vi.spyOn(worker, "stop").mockImplementation(async () => { await originalStop(); throw failure; });
      const drain = vi.spyOn(runner.host, "drain"); const settle = vi.spyOn(runner.host, "settle");
      const closeBus = vi.spyOn(runner.bus, "close");
      const closing = runner.close(); expect(runner.close()).toBe(closing);
      await expect(closing).rejects.toBe(failure);
      expect(stop).toHaveBeenCalledOnce(); expect(drain).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledOnce();
      expect(closeStore).toHaveBeenCalledOnce(); expect(closeBus).toHaveBeenCalledOnce(); expect(exit).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join("\n")).not.toContain(failure.message); runner = undefined;
    } finally {
      await runner?.close().catch(() => {}); vi.restoreAllMocks(); log.mockRestore(); exit.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("fences new SSE admission and waits for outstanding observer cleanup before closing stores", async context => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-sse-drain-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    let release!: () => void;
    const cleanup = new Promise<void>(done => { release = done; });
    let reached!: () => void;
    let failClosing!: (error: unknown) => void;
    const closing = new Promise<void>((done, reject) => { reached = done; failClosing = reject; });
    const abort = () => { release(); failClosing(context.signal.reason); };
    context.signal.addEventListener("abort", abort, { once: true });
    const originalClose = SseAdmission.prototype.close;
    const stop = vi.spyOn(SseAdmission.prototype, "stopAccepting");
    const close = vi.spyOn(SseAdmission.prototype, "close").mockImplementation(async function (this: SseAdmission) {
      reached(); await cleanup; await originalClose.call(this);
    });
    const storeClose = vi.spyOn(MemorySessionStore.prototype, "close");
    try {
      runner = await startRunner({ SECRETS_MASTER_KEY: MASTER_KEY, RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0", BLOB_DIR: blobDir, BLOB_FILESYSTEM_SINGLE_RUNNER: "1" });
      const pending = runner.close();
      let settled = false; void pending.then(() => { settled = true; });
      await closing;
      expect(stop).toHaveBeenCalledOnce(); expect(storeClose).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      release(); await pending;
      expect(close).toHaveBeenCalledOnce(); expect(storeClose).toHaveBeenCalledOnce();
      expect(runner.server.listening).toBe(false); runner = undefined;
    } finally {
      release(); await runner?.close(); context.signal.removeEventListener("abort", abort); close.mockRestore(); stop.mockRestore();
      storeClose.mockRestore(); log.mockRestore(); await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("drops every dynamic argument at the legacy core logger boundary", () => {
    const records: Readonly<StructuredTelemetryRecord>[] = [];
    const telemetry = createStructuredTelemetry({
      component: "runner",
      opaqueRefKey: Buffer.alloc(32, 6),
      sink: { write: (record) => records.push(record) },
      now: () => 1,
    });
    const logger = createContentFreeRunnerLogger(telemetry);
    logger.info("session-private", { tenantId: "tenant-private" });
    logger.warn("https://private.invalid", new Error("secret warning"));
    logger.error("ask_private", new Error("secret error"));

    expect(records.map((record) => record.code)).toEqual([
      "runner.runtime.info",
      "runner.runtime.warning",
      "runner.runtime.error",
    ]);
    expect(records.every((record) => Object.keys(record.fields).length === 0)).toBe(true);
    const encoded = JSON.stringify(records);
    expect(encoded).not.toContain("session-private");
    expect(encoded).not.toContain("tenant-private");
    expect(encoded).not.toContain("private.invalid");
    expect(encoded).not.toContain("ask_private");
    expect(encoded).not.toContain("secret");
  });

  it("does not let a failing telemetry sink escape the legacy core logger boundary", () => {
    const telemetry = createStructuredTelemetry({
      component: "runner",
      opaqueRefKey: Buffer.alloc(32, 7),
      sink: { write: () => { throw new Error("sink unavailable"); } },
      now: () => 1,
    });
    const logger = createContentFreeRunnerLogger(telemetry);

    expect(() => logger.info("private-info")).not.toThrow();
    expect(() => logger.warn("private-warning")).not.toThrow();
    expect(() => logger.error("private-error")).not.toThrow();
  });

  it("writes the first admin key only to an owner-readable create-only file", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "agent-runner-admin-bootstrap-"));
    const blobDir = join(workDir, "blobs");
    const outputFile = join(workDir, "first-admin-key");
    const tenantId = "t_sensitive_admin_bootstrap";
    const providerSecret = "provider-secret-must-not-enter-logs";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        NODE_ENV: "test",
        STORE: "memory",
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "runner-sensitive.internal:8787",
        BLOB_DIR: blobDir,
        ADMIN_BOOTSTRAP_TENANT: tenantId,
        ADMIN_BOOTSTRAP_OUTPUT_FILE: outputFile,
        API_KEY: providerSecret,
        PLATFORM_PROVIDER: "dashscope",
      });

      const key = (await readFile(outputFile, "utf8")).trim();
      expect(key).toMatch(/^ask_[A-Za-z0-9_-]+$/);
      expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
      const output = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
        .flat().join("\n");
      expect(output).toContain('"code":"runner.bootstrap.admin_key_written"');
      expect(output).toContain('"code":"runner.lifecycle.started"');
      expect(output).not.toContain(key);
      expect(output).not.toContain(tenantId);
      expect(output).not.toContain(outputFile);
      expect(output).not.toContain(providerSecret);
      expect(output).not.toContain("dashscope");
      expect(output).not.toContain("runner-sensitive.internal");
      expect(error).not.toHaveBeenCalled();
      await runner.close();
      runner = undefined;
    } finally {
      await runner?.close();
      error.mockRestore();
      warn.mockRestore();
      log.mockRestore();
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("never overwrites a pre-existing admin bootstrap output file", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "agent-runner-admin-existing-"));
    const outputFile = join(workDir, "first-admin-key");
    try {
      await writeFile(outputFile, "operator-owned-content\n", { mode: 0o600 });
      await expect(writeAdminBootstrapOutputFile(outputFile, "ask_replacement"))
        .rejects.toThrow("admin bootstrap output file could not be created safely");
      expect(await readFile(outputFile, "utf8")).toBe("operator-owned-content\n");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("allows exactly one concurrent writer for the same admin bootstrap output file", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "agent-runner-admin-concurrent-"));
    const outputFile = join(workDir, "first-admin-key");
    try {
      const results = await Promise.allSettled([
        writeAdminBootstrapOutputFile(outputFile, "ask_concurrent_a"),
        writeAdminBootstrapOutputFile(outputFile, "ask_concurrent_b"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await readFile(outputFile, "utf8")).trim())
        .toMatch(/^ask_concurrent_[ab]$/);
      expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("preserves the one-time file but redacts a database failure after output reservation", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "agent-runner-admin-store-failure-"));
    const outputFile = join(workDir, "first-admin-key");
    const tenantId = "t_sensitive_store_failure";
    const rawFailure = "mysql://user:password@db/internal-sensitive-error";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.spyOn(MemorySessionStore.prototype, "createApiKey")
      .mockRejectedValueOnce(new Error(rawFailure));
    const close = vi.spyOn(MemorySessionStore.prototype, "close");
    try {
      await expect(startRunner({
        NODE_ENV: "test",
        STORE: "memory",
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: join(workDir, "blobs"),
        ADMIN_BOOTSTRAP_TENANT: tenantId,
        ADMIN_BOOTSTRAP_OUTPUT_FILE: outputFile,
      })).rejects.toThrow("admin bootstrap store write failed after output reservation");

      const key = (await readFile(outputFile, "utf8")).trim();
      expect(key).toMatch(/^ask_[A-Za-z0-9_-]+$/);
      expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
      expect(create).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      const output = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
        .flat().join("\n");
      expect(output).toContain('"code":"runner.bootstrap.admin_key_store_failed"');
      expect(output).not.toContain(key);
      expect(output).not.toContain(tenantId);
      expect(output).not.toContain(outputFile);
      expect(output).not.toContain(rawFailure);
    } finally {
      close.mockRestore();
      create.mockRestore();
      error.mockRestore();
      warn.mockRestore();
      log.mockRestore();
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("runner main blob wiring", () => {
  it("wires the explicit local fake credential target executor without exposing references", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-credential-target-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        NODE_ENV: "test",
        STORE: "memory",
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: "1",
        CREDENTIAL_TARGET_EXECUTION_ADAPTER: "fake",
        TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED: "1",
        TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_POLL_MS: "60000",
        ERASURE_ROUTER_URL: "http://router.internal",
      });
      expect(runner.tenantCredentialTargetExecutionWorker)
        .toBeInstanceOf(TenantCredentialTargetExecutionWorker);
      expect(runner.credentialTargetExecutionAdapter).toBeDefined();
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: {
          tenantCredentialLifecycleTrackingActive: true,
          tenantCredentialTargetExecution: ["external-credential-execution-v1"],
          tenantCredentialTargetExecutionWorker: true,
        },
      });
      expect(JSON.stringify([...runner.credentialTargetExecutionState!.operations.values()]))
        .not.toContain(MASTER_KEY);
      await runner.close();
      runner = undefined;
    } finally {
      await runner?.close();
      warn.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("activates the durable credential tracking cutover before advertising it", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-credential-tracking-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: "1",
      });
      expect(await runner.store.readTenantCredentialTrackingCutover()).toMatchObject({
        controlGeneration: 1,
      });
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: {
          tenantCredentialLifecycle: ["versioned-target-ledger-v1"],
          tenantCredentialLifecycleTrackingActive: true,
        },
      });
      await runner.close();
      runner = undefined;
    } finally {
      await runner?.close();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("keeps credential tracking dormant when the durable T3g preflight fails", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-credential-preflight-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let failedStore: MemorySessionStore | undefined;
    const preflight = vi.spyOn(MemorySessionStore.prototype, "hasTenantRedisPurgeJobs")
      .mockImplementationOnce(async function (this: MemorySessionStore) {
        failedStore = this;
        throw new Error("injected durable T3g preflight failure");
      });
    const activate = vi.spyOn(
      MemorySessionStore.prototype,
      "activateTenantCredentialTrackingCutover",
    );
    const close = vi.spyOn(MemorySessionStore.prototype, "close");
    try {
      await expect(startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: "1",
      })).rejects.toThrow("injected durable T3g preflight failure");
      expect(failedStore).toBeDefined();
      expect(await failedStore!.readTenantCredentialTrackingCutover()).toEqual({
        controlGeneration: 0,
      });
      expect(activate).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      activate.mockRestore();
      preflight.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it.each(["job", "cutover"] as const)(
    "fails closed before bootstrap when durable 0029 %s evidence exists without the executor",
    async (evidence) => {
      const blobDir = await mkdtemp(join(tmpdir(), `agent-runner-target-${evidence}-`));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const cutover = vi.spyOn(
        MemorySessionStore.prototype,
        "getTenantCredentialTargetExecutionCutover",
      ).mockResolvedValue(evidence === "cutover"
        ? ({ singletonId: 1, controlGeneration: 1 } as never)
        : { singletonId: 1, controlGeneration: 0 });
      const jobs = vi.spyOn(
        MemorySessionStore.prototype,
        "hasTenantCredentialTargetExecutionJobs",
      ).mockResolvedValue(evidence === "job");
      const bootstrap = vi.spyOn(MemorySessionStore.prototype, "createApiKey");
      const close = vi.spyOn(MemorySessionStore.prototype, "close");
      try {
        mockedServer.listening = false;
        await expect(startRunner({
          NODE_ENV: "test",
          STORE: "memory",
          SECRETS_MASTER_KEY: MASTER_KEY,
          RUNNER_PORT: "0",
          RUNNER_ADDR: "127.0.0.1:0",
          BLOB_DIR: blobDir,
          BOOTSTRAP_API_KEY: "must-not-be-written",
        })).rejects.toThrow(
          "the credential target execution worker and adapter are required after durable 0029 work exists",
        );
        expect(bootstrap).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        expect(mockedServer.listening).toBe(false);
      } finally {
        close.mockRestore();
        bootstrap.mockRestore();
        jobs.mockRestore();
        cutover.mockRestore();
        log.mockRestore();
        await rm(blobDir, { recursive: true, force: true });
      }
    },
  );

  it("closes startup resources when credential tracking activation fails before commit", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-credential-activation-failure-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let failedStore: MemorySessionStore | undefined;
    const activate = vi.spyOn(
      MemorySessionStore.prototype,
      "activateTenantCredentialTrackingCutover",
    ).mockImplementationOnce(async function (this: MemorySessionStore) {
      failedStore = this;
      throw new Error("injected credential activation failure");
    });
    const storeClose = vi.spyOn(MemorySessionStore.prototype, "close");
    const leaseClose = vi.spyOn(MemorySessionAuthority.prototype, "close");
    const busClose = vi.spyOn(MemoryEventBus.prototype, "close");
    try {
      await expect(startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: "1",
      })).rejects.toThrow("injected credential activation failure");
      expect(failedStore).toBeDefined();
      expect(await failedStore!.readTenantCredentialTrackingCutover()).toEqual({
        controlGeneration: 0,
      });
      expect(storeClose).toHaveBeenCalledOnce();
      expect(leaseClose).toHaveBeenCalledOnce();
      expect(busClose).toHaveBeenCalledOnce();
    } finally {
      busClose.mockRestore();
      leaseClose.mockRestore();
      storeClose.mockRestore();
      activate.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("recovers an active credential cutover after the activation response is lost", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-credential-response-loss-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const activateCutover = MemorySessionStore.prototype
      .activateTenantCredentialTrackingCutover;
    const activate = vi.spyOn(
      MemorySessionStore.prototype,
      "activateTenantCredentialTrackingCutover",
    ).mockImplementationOnce(async function (this: MemorySessionStore, input) {
      await activateCutover.call(this, input);
      throw new Error("injected lost activation response");
    });
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: "1",
      });
      expect(activate).toHaveBeenCalledOnce();
      expect(await runner.store.readTenantCredentialTrackingCutover()).toMatchObject({
        controlGeneration: 1,
      });
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: { tenantCredentialLifecycleTrackingActive: true },
      });
      await runner.close();
      runner = undefined;
    } finally {
      await runner?.close();
      activate.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("constructs one filesystem data plane, advertises the write gate, and closes workers cleanly", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-blobs-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
        BLOB_CLEANUP_ENABLED: "1",
        BLOB_ATTACHMENTS_ENABLED: "1",
        BLOB_CLEANUP_POLL_MS: "60000",
      });
      expect(runner.blobStore.backend).toBe("filesystem-v1");
      expect(runner.blobs.objects).toBe(runner.blobStore);
      expect(await runner.blobCleanup.cleanupOnce()).toBe(0);
      const capabilityResponse = await runner.app.request("/v1/capabilities");
      expect(await capabilityResponse.json()).toMatchObject({
        features: {
          blobAttachments: true,
          userErasureWorker: ["drain-v1"],
          erasureJobControl: ["quarantine-v1"],
          purgePolicyEvaluation: ["policy-evaluator-v1"],
          dataPurgeExecution: false,
        },
      });
      expect(runner.erasureWorker).toBeUndefined();
      expect(runner.legacyTombstoneCompensationWorker).toBeUndefined();

      await runner.close();
      expect(runner.server.listening).toBe(false);
      runner = undefined;
    } finally {
      await runner?.close();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("gates the embedded erasure worker through the router probe and stops it before host drain", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-erasure-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER]: INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE,
      },
    }));
    const startSpy = vi.spyOn(ErasureWorker.prototype, "start");
    const legacyStartSpy = vi.spyOn(LegacyTombstoneCompensationWorker.prototype, "start");
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        ERASURE_WORKER_ENABLED: "1",
        LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "1",
        LEGACY_TOMBSTONE_COMPENSATION_POLL_MS: "60000",
        ERASURE_ROUTER_URL: "http://127.0.0.1:8080",
        ERASURE_WORKER_POLL_MS: "60000",
        DATA_ERASURE_REQUESTS_ENABLED: "1",
        INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
      });
      expect(startSpy).toHaveBeenCalledOnce();
      expect(legacyStartSpy).toHaveBeenCalledOnce();
      expect(runner.erasureWorker).toBeInstanceOf(ErasureWorker);
      expect(runner.legacyTombstoneCompensationWorker).toBeInstanceOf(
        LegacyTombstoneCompensationWorker,
      );
      const capabilityResponse = await runner.app.request("/v1/capabilities");
      expect(await capabilityResponse.json()).toMatchObject({
        features: {
          dataErasureRequests: true,
          userErasureWorker: ["drain-v1"],
          erasureJobControl: ["quarantine-v1", "legacy-tombstone-compensation-v1"],
        },
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      for (const [input, init] of fetchSpy.mock.calls) {
        expect(String(input)).toBe(`http://127.0.0.1:8080${INTERNAL_ERASURE_JOB_CONTROL_READY_PATH}`);
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);
      }

      const stopSpy = vi.spyOn(runner.erasureWorker!, "stop");
      const legacyStopSpy = vi.spyOn(runner.legacyTombstoneCompensationWorker!, "stop");
      const drainSpy = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(stopSpy).toHaveBeenCalledOnce();
      expect(legacyStopSpy).toHaveBeenCalledOnce();
      expect(drainSpy).toHaveBeenCalledOnce();
      expect(stopSpy.mock.invocationCallOrder[0]).toBeLessThan(drainSpy.mock.invocationCallOrder[0]!);
      expect(legacyStopSpy.mock.invocationCallOrder[0]).toBeLessThan(
        drainSpy.mock.invocationCallOrder[0]!,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(runner.server.listening).toBe(false);
      runner = undefined;
    } finally {
      await runner?.close();
      startSpy.mockRestore();
      legacyStartSpy.mockRestore();
      fetchSpy.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("wires the independent policy evaluator through its dedicated default-off barrier", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-policy-evaluator-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER]:
          INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE,
      },
    }));
    const startSpy = vi.spyOn(PurgePolicyEvaluator.prototype, "start");
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        PURGE_POLICY_EVALUATOR_ENABLED: "1",
        PURGE_POLICY_EVALUATOR_POLL_MS: "60000",
        ERASURE_ROUTER_URL: "http://127.0.0.1:8080",
        INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
      });
      expect(startSpy).toHaveBeenCalledOnce();
      expect(runner.purgePolicyEvaluator).toBeInstanceOf(PurgePolicyEvaluator);
      expect(runner.erasureWorker).toBeUndefined();
      expect(runner.legacyTombstoneCompensationWorker).toBeUndefined();
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: {
          purgePolicyEvaluation: ["policy-evaluator-v1"],
          dataPurgeExecution: false,
        },
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
      const [input, init] = fetchSpy.mock.calls[0]!;
      expect(String(input)).toBe(
        `http://127.0.0.1:8080${INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH}`,
      );
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);

      const stopSpy = vi.spyOn(runner.purgePolicyEvaluator!, "stop");
      const drainSpy = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(stopSpy).toHaveBeenCalledOnce();
      expect(stopSpy.mock.invocationCallOrder[0]).toBeLessThan(drainSpy.mock.invocationCallOrder[0]!);
      expect(fetchSpy).toHaveBeenCalledOnce();
      runner = undefined;
    } finally {
      await runner?.close();
      startSpy.mockRestore();
      fetchSpy.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("wires tenant admission through the fresh router barrier without a platform token on the runner", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-tenant-erasure-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 204,
      headers: {
        [INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER]:
          INTERNAL_TENANT_ERASURE_ADMISSION_ACK_VALUE,
      },
    }));
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        BOOTSTRAP_API_KEY: "tenant-bootstrap-key",
        BOOTSTRAP_TENANT_ID: "t_tenant_erasure",
        TENANT_ERASURE_REQUESTS_ENABLED: "1",
        TENANT_ERASURE_BARRIER_TIMEOUT_MS: "1000",
        ERASURE_ROUTER_URL: "http://127.0.0.1:8080",
        INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
      });
      expect(runner.tenantErasureAdmissionGate).toBeDefined();
      const bootstrapOutput = [...log.mock.calls, ...warn.mock.calls].flat().join("\n");
      expect(bootstrapOutput).toContain('"code":"runner.bootstrap.dev_key_seeded"');
      expect(bootstrapOutput).not.toContain("tenant-bootstrap-key");
      expect(bootstrapOutput).not.toContain("t_tenant_erasure");
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: {
          tenantErasureControl: ["platform-control-v1"],
          tenantErasureRequests: true,
        },
      });
      const response = await runner.app.request(INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "main-tenant-erasure",
          [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN,
          [INTERNAL_TENANT_ERASURE_ACTOR_HEADER]: "platform-main-test",
        },
        body: JSON.stringify({ tenantId: "t_tenant_erasure" }),
      });
      expect(response.status).toBe(202);
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [input, init] = fetchSpy.mock.calls[0]!;
      expect(String(input)).toBe(
        `http://127.0.0.1:8080${INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH}`,
      );
      expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);
      await runner.close();
      runner = undefined;
    } finally {
      await runner?.close();
      fetchSpy.mockRestore();
      warn.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("starts export build and cleanup workers independently from admission and stops both before host drain", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-data-export-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const workerStart = vi.spyOn(UserDataExportWorker.prototype, "start");
    const cleanupStart = vi.spyOn(UserDataExportCleanupWorker.prototype, "start");
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
        DATA_EXPORT_REQUESTS_ENABLED: "1",
        DATA_EXPORT_WORKER_ENABLED: "1",
        DATA_EXPORT_CLEANUP_ENABLED: "1",
        DATA_EXPORT_WORKER_POLL_MS: "60000",
        DATA_EXPORT_CLEANUP_POLL_MS: "60000",
      });
      expect(workerStart).toHaveBeenCalledOnce();
      expect(cleanupStart).toHaveBeenCalledOnce();
      expect(runner.dataExportWorker).toBeInstanceOf(UserDataExportWorker);
      expect(runner.dataExportCleanup).toBeInstanceOf(UserDataExportCleanupWorker);
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: {
          userDataExport: ["artifact-ndjson-v1"],
          dataExportRequests: true,
        },
      });

      const workerStop = vi.spyOn(runner.dataExportWorker!, "stop");
      const cleanupStop = vi.spyOn(runner.dataExportCleanup!, "stop");
      const drain = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(workerStop).toHaveBeenCalledOnce();
      expect(cleanupStop).toHaveBeenCalledOnce();
      expect(workerStop.mock.invocationCallOrder[0]).toBeLessThan(drain.mock.invocationCallOrder[0]!);
      expect(cleanupStop.mock.invocationCallOrder[0]).toBeLessThan(drain.mock.invocationCallOrder[0]!);
      expect(runner.server.listening).toBe(false);
      runner = undefined;
    } finally {
      await runner?.close();
      workerStart.mockRestore();
      cleanupStart.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("seals and exposes the boot-bound T3b endpoint before starting its optional claimant", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-runtime-drain-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = vi.spyOn(TenantRuntimeRevocationWorker.prototype, "start");
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        RUNNER_ID: "runner-runtime-main",
        BLOB_DIR: blobDir,
        TENANT_RUNTIME_DRAIN_ENABLED: "1",
        TENANT_RUNTIME_REVOCATION_WORKER_ENABLED: "1",
        TENANT_RUNTIME_REVOCATION_WORKER_POLL_MS: "60000",
        ERASURE_ROUTER_URL: "http://127.0.0.1:8080",
        INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
      });
      expect(start).toHaveBeenCalledOnce();
      expect(runner.tenantRuntimeRevocationWorker).toBeInstanceOf(
        TenantRuntimeRevocationWorker,
      );
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: {
          tenantRuntimeDrain: ["runtime-drain-v1"],
          tenantRuntimeDrainEndpoint: true,
        },
      });
      const ready = await runner.app.request(INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH, {
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: INTERNAL_TOKEN },
      });
      expect(ready.status).toBe(200);
      expect(ready.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBe(
        INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
      );
      expect(await ready.json()).toMatchObject({
        runnerId: "runner-runtime-main",
        bootId: runner.tenantRuntimeBootId,
      });

      const stop = vi.spyOn(runner.tenantRuntimeRevocationWorker!, "stop");
      const hostDrain = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(stop).toHaveBeenCalledOnce();
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(hostDrain.mock.invocationCallOrder[0]!);
      runner = undefined;
    } finally {
      await runner?.close();
      start.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("starts and stops the independent default-off T3c inventory worker", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-content-inventory-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = vi.spyOn(TenantContentInventoryWorker.prototype, "start");
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        TENANT_CONTENT_INVENTORY_WORKER_ENABLED: "1",
        TENANT_CONTENT_INVENTORY_WORKER_POLL_MS: "60000",
      });
      expect(start).toHaveBeenCalledOnce();
      expect(runner.tenantContentInventoryWorker).toBeInstanceOf(
        TenantContentInventoryWorker,
      );
      expect(runner.tenantRuntimeRevocationWorker).toBeUndefined();
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: { dataPurgeExecution: false },
      });

      const stop = vi.spyOn(runner.tenantContentInventoryWorker!, "stop");
      const hostDrain = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(stop).toHaveBeenCalledOnce();
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(hostDrain.mock.invocationCallOrder[0]!);
      runner = undefined;
    } finally {
      await runner?.close();
      start.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("starts and stops the independent default-off T3d purge-plan worker", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-purge-plan-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = vi.spyOn(TenantPurgePlanWorker.prototype, "start");
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        TENANT_PURGE_PLAN_WORKER_ENABLED: "1",
        TENANT_PURGE_PLAN_WORKER_POLL_MS: "60000",
      });
      expect(start).toHaveBeenCalledOnce();
      expect(runner.tenantPurgePlanWorker).toBeInstanceOf(TenantPurgePlanWorker);
      expect(runner.tenantContentInventoryWorker).toBeUndefined();
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: { dataPurgeExecution: false },
      });

      const stop = vi.spyOn(runner.tenantPurgePlanWorker!, "stop");
      const hostDrain = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(stop).toHaveBeenCalledOnce();
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(hostDrain.mock.invocationCallOrder[0]!);
      runner = undefined;
    } finally {
      await runner?.close();
      start.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("wires only the default-off ordinary DELETE origin sealer into the runner lifecycle", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-delete-grace-recovery-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = vi.spyOn(OrdinarySessionDeleteGraceRecovery.prototype, "start");
    const recover = vi.spyOn(MemorySessionStore.prototype,
      "retryUnsealedOrdinarySessionDeleteGraceOrigins");
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        SESSION_DELETE_GRACE_RECOVERY_ENABLED: "1",
        SESSION_DELETE_GRACE_RECOVERY_POLL_MS: "60000",
        SESSION_DELETE_GRACE_RECOVERY_BATCH_SIZE: "3",
      });
      expect(start).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(recover).toHaveBeenCalledWith(3));
      expect(runner.ordinarySessionDeleteGraceRecovery)
        .toBeInstanceOf(OrdinarySessionDeleteGraceRecovery);
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: { dataPurgeExecution: false },
      });
      const stop = vi.spyOn(runner.ordinarySessionDeleteGraceRecovery!, "stop");
      const hostDrain = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(stop).toHaveBeenCalledOnce();
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(hostDrain.mock.invocationCallOrder[0]!);
      runner = undefined;
    } finally {
      await runner?.close();
      start.mockRestore();
      recover.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("constructs ordinary usage retention only when explicitly enabled and drains it before the host", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-ordinary-usage-retention-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = vi.spyOn(OrdinarySessionUsageRetentionWorker.prototype, "start").mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      for (const enabled of [false, true]) {
        runner = await startRunner({ SECRETS_MASTER_KEY: MASTER_KEY, INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
          RUNNER_PORT: "0", RUNNER_ADDR: "127.0.0.1:0", BLOB_DIR: blobDir,
          ERASURE_ROUTER_URL: "http://router.internal:8080",
          ...(enabled ? { SESSION_USAGE_RETENTION_WORKER_ENABLED: "1", SESSION_USAGE_RETENTION_WORKER_POLL_MS: "60000" } : {}),
        });
        expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({ features: {
          ordinarySessionUsageRetention: ["local-operational-usage-v1"],
          ordinarySessionUsageRetentionWorker: enabled, dataPurgeExecution: false,
        } });
        if (!enabled) {
          expect(runner.ordinarySessionUsageRetentionWorker).toBeUndefined();
          expect(runner.ordinarySessionUsageRetentionGate).toBeUndefined();
          expect(start).not.toHaveBeenCalled();
          await runner.close(); runner = undefined;
          continue;
        }
        expect(runner.ordinarySessionUsageRetentionWorker).toBeInstanceOf(OrdinarySessionUsageRetentionWorker);
        expect(runner.ordinarySessionUsageRetentionGate).toBeDefined();
        expect(start).toHaveBeenCalledOnce();
        const stop = vi.spyOn(runner.ordinarySessionUsageRetentionWorker!, "stop");
        const hostDrain = vi.spyOn(runner.host, "drain");
        await runner.close();
        expect(stop).toHaveBeenCalledOnce();
        expect(stop.mock.invocationCallOrder[0]).toBeLessThan(hostDrain.mock.invocationCallOrder[0]!);
        runner = undefined;
      }
    } finally {
      await runner?.close(); start.mockRestore(); log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("starts T3e only with its local delete adapters and advertises active separately", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-purge-execution-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = vi.spyOn(TenantPurgeExecutionWorker.prototype, "start")
      .mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
        BLOB_CLEANUP_ENABLED: "1",
        DATA_EXPORT_CLEANUP_ENABLED: "1",
        TENANT_PURGE_EXECUTION_WORKER_ENABLED: "1",
        TENANT_PURGE_EXECUTION_WORKER_POLL_MS: "60000",
        ERASURE_ROUTER_URL: "http://router.internal:8080",
      });
      expect(start).toHaveBeenCalledOnce();
      expect(runner.tenantPurgeExecutionWorker).toBeInstanceOf(TenantPurgeExecutionWorker);
      expect(runner.tenantPurgeExecutionGate).toBeDefined();
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: {
          tenantPurgeExecution: ["local-execution-ack-v1", "local-db-content-delete-v1"],
          tenantPurgeExecutionWorker: true,
          tenantDatabasePurgeWorker: false,
          dataPurgeExecution: false,
        },
      });

      const stop = vi.spyOn(runner.tenantPurgeExecutionWorker!, "stop");
      const hostDrain = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(stop).toHaveBeenCalledOnce();
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(hostDrain.mock.invocationCallOrder[0]!);
      runner = undefined;
    } finally {
      await runner?.close();
      start.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it("starts and drains the independently gated T3f database purge worker", async () => {
    const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-database-purge-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const start = vi.spyOn(TenantDatabasePurgeWorker.prototype, "start")
      .mockImplementation(() => {});
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        TENANT_DATABASE_PURGE_WORKER_ENABLED: "1",
        TENANT_DATABASE_PURGE_WORKER_POLL_MS: "60000",
        ERASURE_ROUTER_URL: "http://router.internal:8080",
      });
      expect(start).toHaveBeenCalledOnce();
      expect(runner.tenantDatabasePurgeWorker).toBeInstanceOf(TenantDatabasePurgeWorker);
      expect(runner.tenantDatabasePurgeGate).toBeDefined();
      expect(runner.tenantPurgeExecutionWorker).toBeUndefined();
      expect(await (await runner.app.request("/v1/capabilities")).json()).toMatchObject({
        features: {
          tenantPurgeExecution: ["local-execution-ack-v1", "local-db-content-delete-v1"],
          tenantPurgeExecutionWorker: false,
          tenantDatabasePurgeWorker: true,
          dataPurgeExecution: false,
        },
      });

      const stop = vi.spyOn(runner.tenantDatabasePurgeWorker!, "stop");
      const hostDrain = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(stop).toHaveBeenCalledOnce();
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(hostDrain.mock.invocationCallOrder[0]!);
      runner = undefined;
    } finally {
      await runner?.close();
      start.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });
});

// Native Redis + actual Host finalization; the HTTP listener and provider resolution remain
// controlled test seams. No model dispatch, MySQL durability or production shutdown is claimed.
if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("runner shutdown native Redis publisher ownership", () => {
    it("cancels a response-paused publisher before joining the actual Host terminal work and keeps the store alive", async context => {
      const blobDir = await mkdtemp(join(tmpdir(), "agent-runner-native-pub-join-"));
      const prefix = `m4-pub-${randomBytes(12).toString("hex")}`;
      const redisUrl = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/1";
      const events: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const resolve = vi.spyOn(ProviderService.prototype, "resolve").mockResolvedValue({
        handle: {}, provider: "synthetic", model: "synthetic", contextWindow: 32_000,
        input: ["text"], apiKey: async () => "synthetic-only-never-dispatched",
      });
      const dispatch = vi.spyOn(PiEngine.prototype, "start").mockImplementation(() => {
        throw new Error("native publisher shutdown must not dispatch a model");
      });
      let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
      let admin: Redis | undefined, publisher: Redis | undefined, publisherSocket: Redis["stream"] | undefined;
      let streamKey: string | undefined, closing: Promise<void> | undefined;
      let actualPublish: Promise<unknown> | undefined, publishSettled = false, passed = false, fakeTimers = false;
      let entered!: () => void;
      const dispatched = new Promise<void>(done => { entered = done; });
      const abort = () => {
        // Failure cancellation still uses the actual owned native transport; it does not resolve
        // the command substitute or fabricate a close event/Host completion receipt.
        publisher?.disconnect(false); publisherSocket?.destroy();
        if (context.signal.aborted) { admin?.disconnect(false); admin?.stream?.destroy(); }
      };
      context.signal.addEventListener("abort", abort, { once: true });
      const boundary = <T>(work: Promise<T>): Promise<T> => new Promise((done, reject) => {
        const aborted = () => reject(context.signal.reason);
        context.signal.addEventListener("abort", aborted, { once: true });
        if (context.signal.aborted) aborted();
        void work.then(value => { context.signal.removeEventListener("abort", aborted); done(value); }, error => {
          context.signal.removeEventListener("abort", aborted); reject(error);
        });
      });
      try {
        admin = new Redis(redisUrl); admin.on("error", () => {});
        runner = await startRunner({ NODE_ENV: "test", STORE: "memory", REDIS_URL: redisUrl,
          REDIS_PREFIX: prefix, SECRETS_MASTER_KEY: MASTER_KEY, RUNNER_PORT: "0",
          RUNNER_ADDR: "127.0.0.1:0", BLOB_DIR: blobDir });
        if (!(runner.bus instanceof RedisEventBus)) throw new Error("native Redis bus fixture was not selected");
        const bus = runner.bus;
        const principal = { tenantId: `native-pub-${randomBytes(8).toString("hex")}`, userId: "synthetic-user" };
        const agent = { id: newId("agt"), tenantId: principal.tenantId, version: 1, name: "native publisher shutdown",
          instructions: "", model: { provider: "synthetic", model: "synthetic" }, tools: [], mcpServers: [], skills: [],
          limits: {}, approvalPolicy: "on-request" as const, busyPolicy: "steer" as const, sandbox: "none" as const,
          metadata: {}, createdAtMs: Date.now() };
        await runner.store.createAgent(agent);
        const session = await runner.host.createSession(principal, { agentId: agent.id, metadata: {} });
        streamKey = `${prefix}:stream:{${session.id}}`;
        // Include Date and the original renewal setTimeouts: the default lease remains live while
        // the exact original 30s + 10s drain is observed under the controlled clock.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); fakeTimers = true;
        const begun = await runner.host.beginTurn(principal, session.id, {
          input: [{ type: "text", text: "synthetic reserved turn; no model call" }], stream: false, metadata: {},
        });
        expect(resolve).toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
        publisher = (bus as unknown as { pub: Redis }).pub;
        publisherSocket = publisher.stream;
        const socket = publisherSocket;
        const nativeClosed = socket.closed ? Promise.resolve() : new Promise<void>(done => socket.once("close", () => {
          events.push("publisher-native-close"); done();
        }));
        type NativePublisher = Redis & { eventPublishPersisted(...args: string[]): Promise<unknown> };
        const nativePublisher = publisher as NativePublisher;
        const originalPublish = nativePublisher.eventPublishPersisted.bind(nativePublisher);
        vi.spyOn(nativePublisher, "eventPublishPersisted").mockImplementationOnce((...args) => {
          const raw = originalPublish(...args); actualPublish = raw;
          void raw.then(() => { publishSettled = true; events.push("unexpected-publish-success"); }, () => {
            publishSettled = true; events.push("publisher-command-rejected");
          });
          entered(); return raw; // Exact ioredis promise; no independently resolvable gate.
        });
        const closeBus = vi.spyOn(bus, "close");
        const originalSettle = runner.host.settle.bind(runner.host);
        const settle = vi.spyOn(runner.host, "settle").mockImplementation(async () => {
          await originalSettle(); events.push("actual-host-settled");
        });
        const originalCloseStore = runner.store.close.bind(runner.store);
        const closeStore = vi.spyOn(runner.store, "close").mockImplementation(async () => {
          events.push("store-close"); await originalCloseStore();
        });
        const drain = vi.spyOn(runner.host, "drain");
        // The real Redis command is accepted/executed, but the existing connected native stream
        // stops delivering replies. maxRetriesPerRequest alone cannot end this response blackhole.
        socket.pause();
        closing = runner.close(); expect(runner.close()).toBe(closing);
        void closing.catch(() => {});
        await boundary(dispatched);
        await vi.waitFor(async () => {
          const rows = await admin!.xrange(streamKey!, "-", "+");
          const decoded = rows.map(([, fields]) => JSON.parse(fields[fields.indexOf("e") + 1]!));
          expect(decoded.some(event => event.type === "turn/completed" && event.turn.id === begun.turn.id)).toBe(true);
        });
        const terminalBefore = await runner.store.getTurn(session.id, begun.turn.id);
        expect(terminalBefore).toMatchObject({ status: "interrupted" });
        expect(publishSettled).toBe(false); expect(socket.closed).toBe(false);
        expect(closeBus).not.toHaveBeenCalled(); expect(closeStore).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(40_001);
        await boundary(closing); await nativeClosed;
        expect(drain).toHaveBeenCalledWith(30_000); expect(settle).toHaveBeenCalledOnce();
        expect(closeBus).toHaveBeenCalledTimes(2); // Same cached native barrier, phase one + final infrastructure.
        expect(closeBus.mock.results[1]!.value).toBe(closeBus.mock.results[0]!.value);
        expect(closeBus.mock.invocationCallOrder[0]).toBeLessThan(settle.mock.invocationCallOrder[0]!);
        expect(socket.closed).toBe(true); expect(publishSettled).toBe(true);
        expect(events).toContain("publisher-native-close"); expect(events).toContain("publisher-command-rejected");
        expect(events).toContain("actual-host-settled"); expect(events).not.toContain("unexpected-publish-success");
        for (const finished of ["publisher-native-close", "publisher-command-rejected", "actual-host-settled"]) {
          expect(events.indexOf(finished)).toBeLessThan(events.indexOf("store-close"));
        }
        expect(closeStore).toHaveBeenCalledOnce(); expect(dispatch).not.toHaveBeenCalled();
        // The durable result is not rewritten by a failed live hint or by the second close join.
        expect(await runner.store.getTurn(session.id, begun.turn.id)).toEqual(terminalBefore);
        passed = true; runner = undefined;
      } finally {
        abort();
        if (fakeTimers) await vi.advanceTimersByTimeAsync(40_001);
        await actualPublish?.catch(() => {});
        await closing?.catch(() => {}); await runner?.close().catch(() => {});
        if (fakeTimers) vi.useRealTimers();
        try {
          if (passed && streamKey && admin && !context.signal.aborted) await admin.del(streamKey);
        } finally {
          const peer = admin?.stream;
          const nativeClosed = !peer || peer.closed ? Promise.resolve() : new Promise<void>(done => peer.once("close", () => done()));
          try { if (admin && !context.signal.aborted) await admin.quit(); }
          finally {
            admin?.disconnect(false); peer?.destroy(); await nativeClosed;
            context.signal.removeEventListener("abort", abort); vi.restoreAllMocks(); log.mockRestore();
            await rm(blobDir, { recursive: true, force: true });
          }
        }
      }
    });
  });
}
