import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  listening: true,
  close(callback?: () => void) {
    this.listening = false;
    callback?.();
    return this;
  },
}));

vi.mock("@hono/node-server", () => ({
  serve: () => {
    mockedServer.listening = true;
    return mockedServer;
  },
}));

import {
  ErasureWorker,
  LegacyTombstoneCompensationWorker,
  PurgePolicyEvaluator,
  TenantContentInventoryWorker,
  TenantRuntimeRevocationWorker,
  UserDataExportCleanupWorker,
  UserDataExportWorker,
} from "@agent-service/core";
import { startRunner } from "../src/main.js";

const MASTER_KEY = "88".repeat(32);
const INTERNAL_TOKEN = "runner-main-private-router-token-0001";

describe("runner main blob wiring", () => {
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
});
