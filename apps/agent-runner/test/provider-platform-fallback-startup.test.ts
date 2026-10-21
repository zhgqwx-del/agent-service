import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderGatewayConfigError } from "../src/provider-gateway-config.js";
import { startRunner } from "../src/main.js";

const allocation = vi.hoisted(() => ({ calls: 0, stop: new Error("Fixed runtime allocation sentinel.") }));
vi.mock("@agent-service/store", async () => {
  const actual = await vi.importActual<typeof import("@agent-service/store")>("@agent-service/store");
  return { ...actual, MemorySessionStore: class { constructor() { allocation.calls++; throw allocation.stop; } } };
});
const directories: string[] = [];
afterEach(async () => { allocation.calls = 0; for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const pool = (providerId: string) => ({ version: "provider-key-pool-v1", providerId, slots: [{ id: "slot", version: "v1", apiKey: `private-startup-${providerId}` }] });
async function fixture(providers: string[], v1 = false) {
  const directory = await mkdtemp(join(tmpdir(), "platform-fallback-startup-")); directories.push(directory); await chmod(directory, 0o700);
  const path = join(directory, "pool.json");
  await writeFile(path, JSON.stringify(v1 ? pool(providers[0]!) : { version: "provider-key-pools-v2", providers: providers.map(pool) }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", STORE: "memory", SECRETS_MASTER_KEY: "43".repeat(32),
    RUNNER_ID: "fallback-resource-free", RUNNER_ADDR: "127.0.0.1:8787", PROVIDER_GATEWAY_ENABLED: "1",
    REDIS_URL: "redis://127.0.0.1:6479/1", REDIS_NAMESPACE_ID: "fallback-resource-free", ERASURE_ROUTER_URL: "http://127.0.0.1:8080",
    INTERNAL_ROUTER_TOKEN: "fallback-private-internal-token-001", PLATFORM_PROVIDER_KEY_POOL_FILE: path,
    PLATFORM_PROVIDER_FALLBACK_JSON: JSON.stringify([{ provider: "dashscope", rules: [{ model: "qwen-plus", targets: [{ provider: "deepseek", model: "deepseek-chat" }] }] }]) };
  return env;
}

describe("actual runner early platform inventory validation without runtime I/O", () => {
  it("accepts an explicitly credentialed two-platform mapping before the first runtime allocation", async () => {
    await expect(startRunner(await fixture(["dashscope", "deepseek"]))).rejects.toBe(allocation.stop);
    expect(allocation.calls).toBe(1);
  });
  it.each([["missing-primary", ["deepseek"]], ["unknown-preset", ["dashscope", "unknown-provider"]],
    ["uncredentialed-target", ["dashscope"]]] as const)("rejects %s before any runtime allocation", async (_label, providers) => {
    const env = await fixture([...providers]);
    await expect(startRunner(env)).rejects.toBeInstanceOf(ProviderGatewayConfigError); expect(allocation.calls).toBe(0);
  });
  it("keeps the v1 primary identity check and cannot treat a preset as a configured target", async () => {
    const env = await fixture(["deepseek"], true); delete env.PLATFORM_PROVIDER_FALLBACK_JSON;
    await expect(startRunner(env)).rejects.toBeInstanceOf(ProviderGatewayConfigError); expect(allocation.calls).toBe(0);
  });
  it("validates source and target model existence before store, transport, Blob or listener creation", async () => {
    const env = await fixture(["dashscope", "deepseek"]);
    env.PLATFORM_PROVIDER_FALLBACK_JSON = JSON.stringify([{ provider: "dashscope", rules: [{ model: "qwen-plus", targets: [{ provider: "deepseek", model: "missing" }] }] }]);
    await expect(startRunner(env)).rejects.toBeInstanceOf(ProviderGatewayConfigError); expect(allocation.calls).toBe(0);
  });
});
