import { afterEach, describe, expect, it } from "vitest";
import type { AgentDefinition, Event } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import { PiEngine, SessionHost, StaticToolRegistry, newId, type RunnerTool } from "@agent-service/core";
import { FakeVendor, type CacheDialect, type ScriptedReply } from "@agent-service/testkit";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

/**
 * These drive the real PiEngine and the real provider layer against a local server that reproduces
 * the domestic vendors' chat-completions dialects. Everything here runs in CI without an API key.
 */

const KEY = "44".repeat(32);
const principal = { tenantId: "t_d", userId: "u_1" };
const allowAnyBaseUrl = async () => {};

const weather: RunnerTool = {
  name: "get_weather",
  description: "Get weather",
  parameters: { type: "object", properties: { city: { type: "string" }, unit: { type: "string" } }, required: ["city"] },
  kind: "builtin",
  readOnly: true,
  execute: async (args) => ({ content: [{ type: "text", text: `weather(${JSON.stringify(args)})` }], details: args }),
};

let vendor: FakeVendor | undefined;
const hosts: SessionHost[] = [];
afterEach(async () => {
  // drain before stopping the vendor: a turn still waiting on it would otherwise log an aborted fetch
  for (const h of hosts.splice(0)) await h.drain(1_000).catch(() => {});
  await vendor?.stop();
  vendor = undefined;
});

async function harness(opts: { cacheDialect?: CacheDialect; reasoning?: boolean; script: ScriptedReply[]; thinkingFormat?: "qwen" | "deepseek" | "zai" | "openai" }) {
  vendor = new FakeVendor({ cacheDialect: opts.cacheDialect, expectApiKey: "sk-fake" });
  vendor.script(...opts.script);
  const baseUrl = await vendor.start();
  const store = new MemorySessionStore();
  const providers = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), assertBaseUrl: allowAnyBaseUrl });
  await providers.upsertTenantProvider(principal.tenantId, {
    id: "vendor", api: "openai-completions", baseUrl, headers: {}, quota: {}, fallback: [], apiKey: "sk-fake",
    compat: { thinkingFormat: opts.thinkingFormat ?? "deepseek", supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    models: [{
      id: "fake-model", contextWindow: 32_000, maxOutputTokens: 4096, input: ["text"], reasoning: opts.reasoning ?? false,
      // CNY per 1M tokens: input 2, output 8, cacheRead 0.2
      price: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 },
    }],
  });
  const agent: AgentDefinition = {
    id: newId("agt"), tenantId: principal.tenantId, version: 1, name: "d", instructions: "be brief",
    model: { provider: "vendor", model: "fake-model", ...(opts.reasoning ? { reasoning: "medium" as const } : {}) },
    tools: ["get_weather"], mcpServers: [], skills: [], limits: { maxSteps: 4 },
    approvalPolicy: "on-request", busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now(),
  };
  await store.createAgent(agent);
  const host = new SessionHost({
    store, lease: new MemoryLeaseStore(), bus: new MemoryEventBus(), providers,
    engine: new PiEngine(providers.models), tools: new StaticToolRegistry([weather]),
    config: { runnerId: "r", runnerAddr: "local", leaseHoldMs: 10 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  hosts.push(host);
  const session = await host.createSession(principal, { agentId: agent.id, metadata: {} });
  const events: Event[] = [];
  await host.subscribe(principal, session.id, 0, (e) => events.push(e));
  const run = async (text = "hi") => {
    const r = await host.startTurn(principal, session.id, { input: [{ type: "text", text }], stream: true, metadata: {} });
    for (let i = 0; i < 300; i++) {
      const t = await store.getTurn(session.id, r.turn.id);
      if (t && t.status !== "inProgress") return t;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error("turn did not finish");
  };
  return { store, host, session, events, run, vendor: vendor!, providers };
}

describe("domestic chat-completions dialects (fake vendor, no API key needed)", () => {
  it("reassembles tool_call arguments split across chunks and runs the tool with them", async () => {
    const h = await harness({
      script: [
        { toolCalls: [{ id: "call_a", name: "get_weather", args: '{"city":"上海","unit":"c"}', argChunks: 5 }] },
        { text: "上海 22 度" },
      ],
    });
    const turn = await h.run("上海天气");
    expect(turn.status).toBe("completed");
    const items = await h.store.listItems(h.session.id, { limit: 100 });
    const call = items.find((i) => i.type === "toolCall");
    expect(call && call.type === "toolCall" && call.args).toEqual({ city: "上海", unit: "c" });
    const result = items.find((i) => i.type === "toolResult");
    expect(result && result.type === "toolResult" && result.content[0]).toMatchObject({ text: expect.stringContaining("上海") });
  });

  it("captures reasoning_content as reasoning, not as answer text", async () => {
    const h = await harness({ reasoning: true, script: [{ reasoning: "先想一下这个问题的边界。", text: "答案是 42。" }] });
    await h.run();
    const items = await h.store.listItems(h.session.id, { limit: 100 });
    const reasoning = items.find((i) => i.type === "reasoning");
    const answer = items.find((i) => i.type === "agentMessage");
    expect(reasoning && reasoning.type === "reasoning" && reasoning.text).toContain("边界");
    expect(answer && answer.type === "agentMessage" && answer.text).toBe("答案是 42。");
    expect(answer && answer.type === "agentMessage" && answer.text).not.toContain("边界");
    expect(h.events.some((e) => e.type === "item/reasoning/delta")).toBe(true);
  });

  for (const dialect of ["deepseek", "dashscope", "kimi"] as const) {
    it(`parses cache-hit tokens in the ${dialect} dialect and prices them at the cache rate`, async () => {
      const h = await harness({
        cacheDialect: dialect,
        script: [{ text: "ok", usage: { promptTokens: 1000, completionTokens: 10, cachedTokens: 800 } }],
      });
      const turn = await h.run();
      expect(turn.usage.cacheReadTokens).toBe(800);
      expect(turn.usage.inputTokens).toBe(200); // prompt minus cached
      expect(turn.usage.outputTokens).toBe(10);
      // input 200*2/1e6 + output 10*8/1e6 + cacheRead 800*0.2/1e6 = 0.00064 CNY
      expect(turn.usage.costCNY).toBeCloseTo(0.00064, 8);
    });
  }

  it("ignores `: keep-alive` comment lines injected by gateways", async () => {
    const h = await harness({ script: [{ keepAlive: true, text: "still fine" }] });
    const turn = await h.run();
    expect(turn.status).toBe("completed");
    const answer = (await h.store.listItems(h.session.id, { limit: 100 })).find((i) => i.type === "agentMessage");
    expect(answer && answer.type === "agentMessage" && answer.text).toBe("still fine");
  });

  it("discards ALL tool calls when the response was truncated (finish_reason=length)", async () => {
    // Production pitfall #2: truncated arguments must never be executed, not even the complete-looking ones.
    const h = await harness({
      script: [
        {
          finishReason: "length",
          toolCalls: [
            { id: "call_ok", name: "get_weather", args: '{"city":"北京"}' },
            { id: "call_cut", name: "get_weather", args: '{"city":"上' },
          ],
        },
      ],
    });
    const turn = await h.run();
    const items = await h.store.listItems(h.session.id, { limit: 100 });
    const executed = items.filter((i) => i.type === "toolResult" && !i.isError);
    expect(executed).toHaveLength(0);
    expect(turn.status).not.toBe("inProgress");
  });

  it("sends the qwen thinking switch only for the qwen dialect", async () => {
    const q = await harness({ reasoning: true, thinkingFormat: "qwen", script: [{ text: "a" }] });
    await q.run();
    expect(q.vendor.lastRequest?.body).toHaveProperty("enable_thinking");
    await q.vendor.stop();

    const d = await harness({ reasoning: true, thinkingFormat: "deepseek", script: [{ text: "a" }] });
    await d.run();
    expect(d.vendor.lastRequest?.body).not.toHaveProperty("enable_thinking");
  });

  it("uses max_tokens (not max_completion_tokens) and never leaks the key into the payload", async () => {
    const h = await harness({ script: [{ text: "a" }] });
    await h.run();
    const req = h.vendor.lastRequest!;
    expect(req.body).toHaveProperty("max_tokens");
    expect(req.body).not.toHaveProperty("max_completion_tokens");
    expect(req.headers.authorization).toBe("Bearer sk-fake");
    expect(JSON.stringify(req.body)).not.toContain("sk-fake");
    expect(req.body.stream).toBe(true);
  });

  it("surfaces a vendor 429 as a failed turn with the error recorded", async () => {
    const h = await harness({ script: [{ httpError: { status: 429, retryAfter: "1", body: { error: { message: "rate limited" } } } }] });
    const turn = await h.run();
    expect(turn.status).toBe("failed");
    expect(turn.stopReason).toBe("error");
    expect(`${turn.error?.message}`.toLowerCase()).toMatch(/429|rate/);
    expect(h.events.some((e) => e.type === "error")).toBe(true);
  });

  it("fails the turn cleanly when the vendor drops the socket mid-stream", async () => {
    const h = await harness({ script: [{ text: "this answer will be cut off half way through", dropAfterChunks: 3 }] });
    const turn = await h.run();
    expect(turn.status).toBe("failed");
    // whatever streamed before the drop is preserved for the client
    const items = await h.store.listItems(h.session.id, { limit: 100 });
    // The invariant that always holds: nothing is left half-written for the next owner to puzzle over.
    expect(items.filter((i) => i.status === "inProgress")).toHaveLength(0);
    // And when text did reach the client before the drop, it is persisted rather than lost. Keying this
    // off the delta events makes the assertion precise instead of dependent on how far the stream got.
    const streamed = h.events
      .filter((e) => e.type === "item/agentMessage/delta")
      .map((e) => (e as Extract<Event, { type: "item/agentMessage/delta" }>).delta)
      .join("");
    if (streamed) {
      const answer = items.find((i) => i.type === "agentMessage");
      expect(answer, "text was streamed to the client, so it must also be in the store").toBeDefined();
      expect(answer!.type === "agentMessage" ? answer!.text : "").toBe(streamed);
    }
  });

  it("rejects a request whose BYOK key does not match (401 from the vendor)", async () => {
    vendor = new FakeVendor({ expectApiKey: "sk-right" });
    vendor.script({ text: "never" });
    const baseUrl = await vendor.start();
    const store = new MemorySessionStore();
    const providers = new ProviderService({ store, cipher: new LocalAesGcmCipher(KEY), assertBaseUrl: allowAnyBaseUrl });
    await providers.upsertTenantProvider("t_x", {
      id: "v", api: "openai-completions", baseUrl, headers: {}, quota: {}, fallback: [], apiKey: "sk-wrong",
      models: [{ id: "fake-model", contextWindow: 100, maxOutputTokens: 10, input: ["text"], reasoning: false }],
    });
    const model = await providers.resolve({ tenantId: "t_x", userId: "u" }, { provider: "v", model: "fake-model" });
    const stream = providers.models.streamSimple(model.handle as never, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey: await model.apiKey() });
    const msg = await stream.result();
    expect(msg.stopReason).toBe("error");
    expect(`${msg.errorMessage}`).toMatch(/401|api key/i);
  });
});
