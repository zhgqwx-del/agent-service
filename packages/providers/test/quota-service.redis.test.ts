import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { MemorySessionStore, RedisProviderQuotaCoordinator, type ProviderQuotaLimit } from "@agent-service/store";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

const principal = { tenantId: "quota-tenant", userId: "quota-user" };
const spec = { id: "quota-model", contextWindow: 1000, maxOutputTokens: 100, input: ["text" as const], reasoning: false };
async function fixture(signal: AbortSignal, work: (f: {
  first: ProviderService; second: ProviderService; calls(): number;
  request(service: ProviderService, owner?: typeof principal): Promise<Response>;
  endBodies(): void;
}) => Promise<void>, limits: { tenant?: ProviderQuotaLimit; user?: ProviderQuotaLimit; provider?: ProviderQuotaLimit } = {}) {
  const url = process.env.REDIS_TEST_URL;
  if (!url || !["redis:", "rediss:"].includes(new URL(url).protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)
    || !/^[1-9][0-9]*$/.test(new URL(url).port) || Number(new URL(url).port) > 65535
    || !/^\/(?:0|[1-9][0-9]*)$/.test(new URL(url).pathname)
    || new URL(url).search || new URL(url).hash || /[\u0000-\u0020\u007f]/.test(url)) throw new Error("Provider quota test requires an explicit local Redis fixture.");
  const prefix = `quota-${randomUUID()}`, namespaceId = `quota-${randomUUID()}`;
  const coordinators = [new RedisProviderQuotaCoordinator({ url, prefix, namespaceId }), new RedisProviderQuotaCoordinator({ url, prefix, namespaceId })];
  const store = new MemorySessionStore(), responses = new Set<Response>(), bodies = new Set<ServerResponse>();
  let calls = 0, passed = false;
  const server = createServer((_request, response) => {
    calls++; bodies.add(response); response.once("close", () => bodies.delete(response));
    response.writeHead(200, { "content-type": "text/plain" }); response.write("actual-provider-body");
  });
  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    listening = true; const address = server.address();
    if (!address || typeof address === "string") throw new Error("Provider quota HTTP fixture is unavailable.");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const services = coordinators.map(coordinator => new ProviderService({
      store, cipher: new LocalAesGcmCipher("11".repeat(32)), assertBaseUrl: async () => {},
      platform: [{ config: { id: "quota-provider", api: "openai-completions", baseUrl, headers: {}, models: [spec], quota: limits.provider ?? {}, fallback: [] }, apiKey: "test-only-quota-key" }],
      quota: { coordinator, tenant: limits.tenant ?? {}, user: limits.user ?? {} },
    }));
    await Promise.all(coordinators.map(coordinator => coordinator.assertReady()));
    const request = async (service: ProviderService, owner = principal) => {
      signal.throwIfAborted();
      const model = await service.resolve(owner, { provider: "quota-provider", model: spec.id });
      const response = await model.fetch!(`${baseUrl}/chat/completions`, { method: "POST", signal, body: "{}" });
      responses.add(response); return response;
    };
    await work({ first: services[0]!, second: services[1]!, calls: () => calls, request,
      endBodies: () => { for (const body of bodies) body.end(); } });
    passed = true;
  } finally {
    // Retain every acquired body through real cancellation, including failure/timeout paths.
    const cancelled = await Promise.allSettled([...responses].map(response => response.body && !response.body.locked ? response.body.cancel() : Promise.resolve()));
    const closed = await Promise.allSettled(coordinators.map(coordinator => coordinator.close()));
    for (const body of bodies) body.destroy();
    if (listening) {
      const ended = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await ended;
    }
    await store.close();
    if (passed && [...cancelled, ...closed].some(result => result.status === "rejected")) throw new Error("Provider quota fixture cleanup is not proven.");
  }
}

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("ProviderService actual Redis and actual HTTP admission", () => {
  it("shares a platform slot between two service instances and tenants until actual body EOF", async context => fixture(context.signal, async f => {
    const first = await f.request(f.first);
    expect(f.calls()).toBe(1);
    await expect(f.request(f.second, { tenantId: "other-tenant", userId: "other-user" })).rejects.toMatchObject({ reason: "concurrency" });
    expect(f.calls()).toBe(1);
    f.endBodies(); expect(await first.text()).toBe("actual-provider-body");
    const second = await f.request(f.second, { tenantId: "other-tenant", userId: "other-user" });
    expect(f.calls()).toBe(2); f.endBodies(); await second.text();
  }, { provider: { concurrency: 1 } }));

  it("retains real-attempt RPM across release and across service instances without a second vendor dispatch", async context => fixture(context.signal, async f => {
    const first = await f.request(f.first); f.endBodies(); await first.text();
    await expect(f.request(f.second)).rejects.toMatchObject({ reason: "rpm" });
    expect(f.calls()).toBe(1);
    const otherUser = await f.request(f.second, { ...principal, userId: "other-user" });
    expect(f.calls()).toBe(2); f.endBodies(); await otherUser.text();
  }, { user: { rpm: 1 } }));

  it("releases a cancelled real HTTP body before admitting a replacement request", async context => fixture(context.signal, async f => {
    const first = await f.request(f.first);
    await expect(f.request(f.second)).rejects.toMatchObject({ reason: "concurrency" });
    await first.body!.cancel();
    const second = await f.request(f.second);
    expect(f.calls()).toBe(2); f.endBodies(); await second.text();
  }, { tenant: { concurrency: 1 } }));
});
