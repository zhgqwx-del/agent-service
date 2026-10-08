import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const mockedServer = vi.hoisted(() => ({
  listening: true,
  close(callback?: () => void) {
    this.listening = false;
    callback?.();
    return this;
  },
}));

vi.mock("@hono/node-server", () => ({ serve: () => mockedServer }));

import { startRunner } from "../src/main.js";

const MASTER_KEY = "88".repeat(32);

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
        features: { blobAttachments: true },
      });

      await runner.close();
      expect(runner.server.listening).toBe(false);
      runner = undefined;
    } finally {
      await runner?.close();
      log.mockRestore();
      await rm(blobDir, { recursive: true, force: true });
    }
  });
});
