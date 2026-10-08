import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER,
  INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE,
  INTERNAL_ERASURE_JOB_CONTROL_READY_PATH,
  INTERNAL_ROUTER_TOKEN_HEADER,
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

import { ErasureWorker } from "@agent-service/core";
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
        },
      });
      expect(runner.erasureWorker).toBeUndefined();

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
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    try {
      runner = await startRunner({
        SECRETS_MASTER_KEY: MASTER_KEY,
        RUNNER_PORT: "0",
        RUNNER_ADDR: "127.0.0.1:0",
        BLOB_DIR: blobDir,
        ERASURE_WORKER_ENABLED: "1",
        ERASURE_ROUTER_URL: "http://127.0.0.1:8080",
        ERASURE_WORKER_POLL_MS: "60000",
        DATA_ERASURE_REQUESTS_ENABLED: "1",
        INTERNAL_ROUTER_TOKEN: INTERNAL_TOKEN,
      });
      expect(startSpy).toHaveBeenCalledOnce();
      expect(runner.erasureWorker).toBeInstanceOf(ErasureWorker);
      const capabilityResponse = await runner.app.request("/v1/capabilities");
      expect(await capabilityResponse.json()).toMatchObject({
        features: {
          dataErasureRequests: true,
          userErasureWorker: ["drain-v1"],
          erasureJobControl: ["quarantine-v1"],
        },
      });
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
      const [input, init] = fetchSpy.mock.calls[0]!;
      expect(String(input)).toBe(`http://127.0.0.1:8080${INTERNAL_ERASURE_JOB_CONTROL_READY_PATH}`);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(INTERNAL_TOKEN);

      const stopSpy = vi.spyOn(runner.erasureWorker!, "stop");
      const drainSpy = vi.spyOn(runner.host, "drain");
      await runner.close();
      expect(stopSpy).toHaveBeenCalledOnce();
      expect(drainSpy).toHaveBeenCalledOnce();
      expect(stopSpy.mock.invocationCallOrder[0]).toBeLessThan(drainSpy.mock.invocationCallOrder[0]!);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(runner.server.listening).toBe(false);
      runner = undefined;
    } finally {
      await runner?.close();
      startSpy.mockRestore();
      fetchSpy.mockRestore();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });
});
