import { afterEach, describe, expect, it } from "vitest";
import { SessionHost, StaticToolRegistry, builtinTools, type AgentEngine, type EngineRun, type EngineSink, type EngineTurnParams, type ResolvedModel } from "@agent-service/core";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import { emptyUsage } from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";

/** typed json read: the suite used to be full of `unknown`, which hid drift from the real API */
const j = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** Echo engine: replies with the user's text; calls `current_time` when asked for time. */
class EchoEngine implements AgentEngine {
  readonly name = "echo";
  start(params: EngineTurnParams, sink: EngineSink): EngineRun {
    const text = params.input.map((p) => (p.type === "text" ? p.text : "")).join("");
    const done = (async () => {
      await sink.onStepStart(1);
      const wantsTime = /time/i.test(text);
      const toolCalls = wantsTime ? [{ id: "call_1", name: "current_time", args: {} }] : [];
      for (const ch of `echo: ${text}`.split(" ")) sink.onTextDelta(ch + " ");
      const msg = { text: `echo: ${text} `, toolCalls, usage: { ...emptyUsage(), inputTokens: 3, outputTokens: 2, totalTokens: 5 }, stopReason: toolCalls.length ? ("toolUse" as const) : ("stop" as const), provider: "fake", model: "fake" };
      await sink.onAssistantMessage(msg);
      for (const tc of toolCalls) {
        const d = await sink.beforeToolCall(tc, msg);
        if (!d.allow) continue;
        await sink.onToolExecutionStart(tc.id);
        const r = await params.tools.find((t) => t.name === tc.name)!.execute(tc.args, { ...params.toolContext, toolCallId: tc.id, signal: params.signal });
        await sink.onToolResult({ toolCallId: tc.id, name: tc.name, content: r.content, isError: !!r.isError });
      }
      if (toolCalls.length) {
        await sink.onStepEnd(1, msg);
        await sink.onStepStart(2);
        sink.onTextDelta("the time is above");
        await sink.onAssistantMessage({ ...msg, text: "the time is above", toolCalls: [] });
        await sink.onStepEnd(2, { ...msg, toolCalls: [] });
      } else await sink.onStepEnd(1, msg);
      return { steps: toolCalls.length ? 2 : 1, aborted: false };
    })();
    return { steer: () => {}, interrupt: () => {}, done };
  }
}

const hosts: SessionHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.drain(1_000).catch(() => {});
});

async function makeApp(heartbeatMs = 60_000) {
  const store = new MemorySessionStore();
  await store.createApiKey("t_dev", "k1", hashApiKey("dev-key"), ["runtime", "admin"]);
  const providers = new ProviderService({
    store,
    cipher: new LocalAesGcmCipher("33".repeat(32)),
    platform: [ProviderService.preset("dashscope", "x")],
    assertBaseUrl: async () => {},
  });
  const fake: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 1000, apiKey: async () => "k" };
  const tools = new StaticToolRegistry(builtinTools);
  const host = new SessionHost({ store, lease: new MemoryLeaseStore(), bus: new MemoryEventBus(), engine: new EchoEngine(), providers: { resolve: async () => fake }, tools, config: { runnerId: "r", runnerAddr: "x", leaseHoldMs: 10 } });
  const cipher = new LocalAesGcmCipher("33".repeat(32));
  const app = createApp({
    store, host, providers, tools, runnerId: "r", heartbeatMs, maxBodyBytes: 1_000_000, ready: () => true,
    decryptSecret: (s) => cipher.decrypt(s.ciphertext, s.keyId),
    encryptSecret: async (p) => ({ ciphertext: await cipher.encrypt(p), keyId: cipher.keyId }),
    assertPublicUrl: async () => {},
  });
  hosts.push(host);
  const H = { authorization: "Bearer dev-key", "x-user-id": "u_1", "content-type": "application/json" };
  const call = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...H, ...(init.headers as Record<string, string> | undefined) } });
  return { app, store, host, call, H };
}

const parseSse = (text: string) =>
  text
    .split("\n\n")
    .filter((b) => b.includes("data:"))
    .map((b) => {
      const id = /^id: (.*)$/m.exec(b)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(b)![1]!);
      return { id, ...data };
    });

describe("agent-runner HTTP API", () => {
  it("rejects M3-only agent declarations and turn inputs at the HTTP contract boundary", async () => {
    const { call } = await makeApp();
    const futureAgent = {
      name: "future",
      instructions: "",
      model: { provider: "dashscope", model: "qwen-plus" },
      skills: ["not-enabled"],
    };
    expect((await call("/v1/agents", { method: "POST", body: JSON.stringify(futureAgent) })).status).toBe(400);

    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "current", instructions: "", model: futureAgent.model }),
    }));
    const session = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));
    for (const input of [
      { type: "image", url: "https://example.test/image.png" },
      { type: "skill", name: "future" },
      { type: "mention", name: "future" },
    ]) {
      const response = await call(`/v1/sessions/${session.id}/turns`, {
        method: "POST",
        body: JSON.stringify({ input: [input], stream: false }),
      });
      expect(response.status).toBe(400);
    }
  });

  it("uses the shared HTTP schemas for boolean and numeric query validation", async () => {
    const { call } = await makeApp();
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "queries", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }),
    }));
    const session = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));
    const archivedResponse = await call(`/v1/sessions/${session.id}/archive`, { method: "POST" });
    expect(archivedResponse.status).toBe(200);
    expect((await j<{ archivedAtMs?: number }>(archivedResponse)).archivedAtMs).toEqual(expect.any(Number));

    const hidden = await j<{ data: unknown[] }>(await call("/v1/sessions?includeArchived=false"));
    const visible = await j<{ data: { id: string }[] }>(await call("/v1/sessions?includeArchived=true"));
    expect(hidden.data).toEqual([]);
    expect(visible.data.map(({ id }) => id)).toEqual([session.id]);
    const archivedTurn = await call(`/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "blocked" }], stream: false }),
    });
    expect(archivedTurn.status).toBe(409);
    expect((await j<{ error: { code: string } }>(archivedTurn)).error.code).toBe("session_archived");
    expect((await call("/v1/sessions?includeArchived=not-a-boolean")).status).toBe(400);
    expect((await call(`/v1/agents/${agent.id}?version=not-a-number`)).status).toBe(400);
    expect((await call(`/v1/sessions/${session.id}/events?after=not-a-number`)).status).toBe(400);
    expect((await call(`/v1/providers/${"p".repeat(129)}`, {
      method: "PUT",
      body: JSON.stringify({}),
    })).status).toBe(400);
    expect((await call("/v1/tenant/api-keys/invalid%20key", { method: "DELETE" })).status).toBe(400);
    expect((await call(`/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "idempotency-key": "   " },
      body: JSON.stringify({ input: [{ type: "text", text: "ignored" }], stream: false }),
    })).status).toBe(400);

    const unarchivedResponse = await call(`/v1/sessions/${session.id}/unarchive`, { method: "POST" });
    expect(unarchivedResponse.status).toBe(200);
    expect((await j<{ archivedAtMs?: number }>(unarchivedResponse)).archivedAtMs).toBeUndefined();
    expect((await call(`/v1/sessions/${session.id}/unarchive`, { method: "POST" })).status).toBe(200);
    expect((await j<{ data: { id: string }[] }>(await call("/v1/sessions"))).data.map(({ id }) => id)).toEqual([session.id]);
  });

  it("emits protocol-valid heartbeats with the subscribed session id", async () => {
    const { call } = await makeApp(5);
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "heartbeat", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }),
    }));
    const session = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));

    const response = await call(`/v1/sessions/${session.id}/events?after=1`);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const events = parseSse(new TextDecoder().decode(value ?? new Uint8Array()));
    expect(events[0]).toMatchObject({ type: "heartbeat", sessionId: session.id });
  });

  it("rejects missing/invalid auth and requires X-User-Id for user-scoped routes", async () => {
    const { app, call } = await makeApp();
    expect((await app.request("/v1/agents")).status).toBe(401);
    expect((await app.request("/v1/agents", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const r = await call("/v1/sessions", { method: "POST", headers: { "x-user-id": "" }, body: JSON.stringify({ agentId: "agt_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b" }) });
    expect(r.status).toBe(400);
    expect((await j<{ error: { code: string } }>(r)).error.code).toBe("invalid_request");
  });

  it("agent → session → streaming turn → items → replay", async () => {
    const { call } = await makeApp();
    const agentRes = await call("/v1/agents", { method: "POST", body: JSON.stringify({ name: "echo", instructions: "echo", model: { provider: "dashscope", model: "qwen-plus" }, tools: ["current_time"] }) });
    expect(agentRes.status).toBe(201);
    const agent = await j<{ id: string; version: number }>(agentRes);
    expect(agent.version).toBe(1);

    const sessRes = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) });
    expect(sessRes.status).toBe(201);
    const session = await j<{ id: string; status: { type: string } }>(sessRes);
    expect(session.status).toEqual({ type: "idle" });

    const turnRes = await call(`/v1/sessions/${session.id}/turns`, { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "what time is it" }] }) });
    expect(turnRes.status).toBe(200);
    expect(turnRes.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await turnRes.text());
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn/started");
    expect(types).toContain("item/agentMessage/delta");
    expect(types).toContain("item/started");
    expect(types.at(-2)).toBe("turn/completed");
    expect(types.at(-1)).toBe("session/status/changed");
    const ids = events.filter((e) => e.id).map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const completed = events.find((e) => e.type === "turn/completed");
    expect(completed.turn.status).toBe("completed");
    expect(completed.turn.toolCalls).toBe(1);

    const items = await j<{ data: { type: string; content: { text: string }[] }[] }>(await call(`/v1/sessions/${session.id}/items`));
    expect(items.data.map((i) => i.type)).toEqual(["userMessage", "agentMessage", "toolCall", "toolResult", "agentMessage"]);
    const toolResult = items.data.find((i) => i.type === "toolResult")!;
    expect(toolResult.content[0]!.text).toMatch(/Asia\/Shanghai/);

    // replay from the middle with Last-Event-ID; the stream ends because the session is idle
    const mid: number = ids[Math.floor(ids.length / 2)]!;
    const replayRes = await call(`/v1/sessions/${session.id}/events?after=${mid}`, { headers: { accept: "text/event-stream" } });
    // the events endpoint stays open (idle sessions still stream heartbeats); read the first chunk then cancel
    const reader = replayRes.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const replayed = parseSse(new TextDecoder().decode(value ?? new Uint8Array()));
    expect(replayed.every((e) => Number(e.id) > mid!)).toBe(true);
    expect(replayed.map((e) => e.type)).not.toContain("item/agentMessage/delta");

    const resume = await j<{ recentTurns: unknown[]; lastSeq: number }>(await call(`/v1/sessions/${session.id}/resume`, { method: "POST" }));
    expect(resume.recentTurns).toHaveLength(1);
    expect(resume.lastSeq).toBe(ids.at(-1));
  });

  it("non-streaming turn returns 202 and honours Idempotency-Key", async () => {
    const { call } = await makeApp();
    const agent = await j<{ id: string }>(await call("/v1/agents", { method: "POST", body: JSON.stringify({ name: "e", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }) }));
    const session = await j<{ id: string }>(await call("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) }));
    const body = JSON.stringify({ input: [{ type: "text", text: "hi" }], stream: false });
    const r1 = await call(`/v1/sessions/${session.id}/turns`, { method: "POST", headers: { "idempotency-key": "abc" }, body });
    expect(r1.status).toBe(202);
    const t1 = (await j<{ turn: { id: string } }>(r1)).turn;
    await new Promise((r) => setTimeout(r, 100));
    // `stream` is transport-only, so changing it must still replay the same resource as JSON.
    const r2 = await call(`/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "idempotency-key": "abc" },
      body: JSON.stringify({ input: [{ type: "text", text: "hi" }], stream: true }),
    });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("idempotency-replayed")).toBe("true");
    expect((await j<{ turn: { id: string } }>(r2)).turn.id).toBe(t1.id);
    const mismatch = await call(`/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "idempotency-key": "abc" },
      body: JSON.stringify({ input: [{ type: "text", text: "different" }], stream: false }),
    });
    expect(mismatch.status).toBe(409);
    expect((await j<{ error: { code: string } }>(mismatch)).error.code).toBe("idempotency_conflict");
    expect((await j<{ data: unknown[] }>(await call(`/v1/sessions/${session.id}/turns`))).data).toHaveLength(1);
    expect((await j<{ data: unknown[] }>(await call(`/v1/sessions/${session.id}/items`))).data).toHaveLength(2);
    const turn = await j<{ status: string }>(await call(`/v1/sessions/${session.id}/turns/${t1.id}`));
    expect(turn.status).toBe("completed");
  });

  it("authorizes idempotency replay and scopes the same key by user and session", async () => {
    const { call } = await makeApp();
    const agent = await j<{ id: string }>(await call("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "e", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }),
    }));
    const victimSession = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id }),
    }));
    const body = JSON.stringify({ input: [{ type: "text", text: "private" }], stream: false });
    const first = await call(`/v1/sessions/${victimSession.id}/turns`, {
      method: "POST", headers: { "idempotency-key": "shared-key" }, body,
    });
    expect(first.status).toBe(202);

    // Regression: tenant-wide key lookup used to return the victim's completed turn before checking
    // whether the current end user owned the session.
    const stolenReplay = await call(`/v1/sessions/${victimSession.id}/turns`, {
      method: "POST", headers: { "x-user-id": "u_2", "idempotency-key": "shared-key" }, body,
    });
    expect(stolenReplay.status).toBe(404);

    const attackerSession = await j<{ id: string }>(await call("/v1/sessions", {
      method: "POST", headers: { "x-user-id": "u_2" }, body: JSON.stringify({ agentId: agent.id }),
    }));
    const independent = await call(`/v1/sessions/${attackerSession.id}/turns`, {
      method: "POST", headers: { "x-user-id": "u_2", "idempotency-key": "shared-key" }, body,
    });
    expect(independent.status).toBe(202);
  });

  it("tenant isolation: another tenant's key cannot see the session", async () => {
    const { call, store } = await makeApp();
    await store.createApiKey("t_other", "k2", hashApiKey("other-key"), ["runtime", "admin"]);
    const agent = await j<{ id: string }>(await call("/v1/agents", { method: "POST", body: JSON.stringify({ name: "e", instructions: "", model: { provider: "dashscope", model: "qwen-plus" } }) }));
    const session = await j<{ id: string }>(await call("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) }));
    const r = await call(`/v1/sessions/${session.id}`, { headers: { authorization: "Bearer other-key" } });
    expect(r.status).toBe(404);
  });

  it("BYOK provider config is write-only and listed alongside platform presets", async () => {
    const { call } = await makeApp();
    const r = await call("/v1/providers/mine", { method: "PUT", body: JSON.stringify({ baseUrl: "https://example.com/v1", apiKey: "sk-xyz", models: [{ id: "m" }] }) });
    expect(r.status).toBe(200);
    const cfg = await j<Record<string, unknown>>(r);
    expect(JSON.stringify(cfg)).not.toContain("sk-xyz");
    const list = await j<{ data: { id: string }[] }>(await call("/v1/providers"));
    expect(list.data.map((p) => p.id)).toEqual(["mine", "dashscope"]);
    const models = await j<{ data: { provider: string; id: string }[] }>(await call("/v1/models"));
    expect(models.data.some((m) => m.provider === "mine" && m.id === "m")).toBe(true);
    expect((await call("/v1/providers/mine", { method: "DELETE" })).status).toBe(204);
  });
});
