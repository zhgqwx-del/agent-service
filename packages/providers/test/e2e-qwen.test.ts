import { describe, expect, it } from "vitest";
import type { AgentDefinition, Event } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import { PiEngine, SessionHost, StaticToolRegistry, currentTimeTool, newId, projectItems, type RunnerTool } from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

const API_KEY = process.env.API_KEY;
const REAL_E2E = process.env.AGENT_SERVICE_REAL_E2E === "1";
const BASE_URL = process.env.API_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = process.env.DEFAULT_MODEL ?? "qwen3.8-max";

const weather: RunnerTool = {
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  kind: "builtin",
  readOnly: true,
  execute: async (args) => ({ content: [{ type: "text", text: `${(args as { city: string }).city}: 22°C, cloudy` }] }),
};

describe.skipIf(!REAL_E2E)("e2e: PiEngine + SessionHost against a real domestic model", () => {
  it("runs a tool-using turn, resumes with history, streams deltas, keeps the prefix stable", async () => {
    expect(API_KEY, "AGENT_SERVICE_REAL_E2E=1 requires API_KEY").toBeTruthy();
    const store = new MemorySessionStore();
    const principal = { tenantId: "t_e2e", userId: "u_1" };
    const providers = new ProviderService({ store, cipher: new LocalAesGcmCipher("22".repeat(32)) });
    // tenant BYOK config pointing at the .env endpoint (key encrypted at rest, decrypted per request)
    await providers.upsertTenantProvider(principal.tenantId, {
      id: "my-qwen", api: "openai-completions", baseUrl: BASE_URL, headers: {}, quota: {}, fallback: [], apiKey: API_KEY!,
      compat: { thinkingFormat: "qwen", supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      models: [{ id: MODEL, contextWindow: 128_000, maxOutputTokens: 4096, input: ["text"], reasoning: false, price: { input: 2.4, output: 9.6, cacheRead: 0.48, cacheWrite: 0 } }],
    });
    const agent: AgentDefinition = {
      id: newId("agt"), tenantId: principal.tenantId, version: 1, name: "weather-bot",
      instructions: "You are a concise assistant. Use tools for weather and time. Reply in Chinese.",
      model: { provider: "my-qwen", model: MODEL }, tools: ["get_weather", "current_time"], mcpServers: [], skills: [],
      limits: { maxSteps: 4 }, approvalPolicy: "on-request", busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now(),
    };
    await store.createAgent(agent);
    const host = new SessionHost({
      store, lease: new MemoryLeaseStore(), bus: new MemoryEventBus(), engine: new PiEngine(providers.models), providers,
      tools: new StaticToolRegistry([weather, currentTimeTool]),
      config: { runnerId: "r-e2e", runnerAddr: "local", leaseHoldMs: 10 },
    });
    const session = await host.createSession(principal, { agentId: agent.id, metadata: {} });
    const events: Event[] = [];
    await host.subscribe(principal, session.id, 0, (e) => events.push(e));

    const t1 = await host.startTurn(principal, session.id, { input: [{ type: "text", text: "上海现在的天气怎么样？" }], stream: true, metadata: {} });
    const done1 = await waitTurn(store, session.id, t1.turn.id);
    expect(done1.status).toBe("completed");
    expect(done1.stopReason).toBe("end_turn");
    expect(done1.toolCalls).toBeGreaterThanOrEqual(1);
    expect(done1.usage.totalTokens).toBeGreaterThan(0);
    expect(done1.usage.costCNY).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "item/agentMessage/delta").length).toBeGreaterThan(0);
    const items1 = await store.listItems(session.id, { limit: 100 });
    expect(items1.some((i) => i.type === "toolCall" && i.name === "get_weather")).toBe(true);
    const final1 = items1.filter((i) => i.type === "agentMessage").at(-1);
    expect(final1 && final1.type === "agentMessage" && final1.text).toMatch(/22|多云/);

    // second turn: model must see the first turn (projected from items) and answer from context
    const t2 = await host.startTurn(principal, session.id, { input: [{ type: "text", text: "我刚才问的是哪个城市？只回答城市名。" }], stream: true, metadata: {} });
    const done2 = await waitTurn(store, session.id, t2.turn.id);
    expect(done2.status).toBe("completed");
    const items2 = await store.listItems(session.id, { turnId: t2.turn.id, limit: 100 });
    const final2 = items2.filter((i) => i.type === "agentMessage").at(-1);
    expect(final2 && final2.type === "agentMessage" && final2.text).toContain("上海");

    const projected = projectItems(await store.listItems(session.id, { limit: 100 }));
    expect(projected.repaired).toEqual([]);
    expect(projected.messages[0]?.role).toBe("user");
    // seq contiguity across both turns
    const seqs = events.filter((e) => typeof (e as { seq?: number }).seq === "number").map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(store.usageLedger.length).toBe(done1.steps + done2.steps);
  }, 120_000);
});

async function waitTurn(store: MemorySessionStore, sessionId: string, turnId: string) {
  for (let i = 0; i < 1200; i++) {
    const t = await store.getTurn(sessionId, turnId);
    if (t && t.status !== "inProgress") return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("turn did not finish");
}
