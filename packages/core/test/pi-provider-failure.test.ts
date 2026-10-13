import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { emptyUsage } from "@agent-service/protocol";
import { PiEngine, getPiProviderStepFailure, type EngineSink, type EngineTurnParams } from "../src/index.js";

const originalMessage = (stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text: "" }], api: "openai-completions",
  provider: "fixture", model: "fixture", stopReason, timestamp: 1,
  errorMessage: "private vendor error must not cross the sink",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const params = (): EngineTurnParams => ({
  systemPrompt: "fixture", tools: [], history: [], input: [{ type: "text", text: "go" }],
  signal: new AbortController().signal,
  model: { handle: { provider: "fixture", id: "fixture", api: "openai-completions" }, provider: "fixture", model: "fixture", contextWindow: 1000, input: ["text"], apiKey: async () => undefined },
  toolContext: { principal: { tenantId: "t", userId: "u" }, sessionId: "sess", turnId: "turn" },
});
const sink = (): EngineSink => ({
  onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
  async onAssistantMessage() {}, async beforeToolCall() { return { allow: true }; },
  onToolExecutionStart() {}, onToolProgress() {}, async afterToolCall(value) { return value; },
  async onToolResult() {}, async onStepEnd() { return "end"; },
});

describe("Pi original provider failure provenance", () => {
  it("marks the original stream result before message_end, but neither wire copies nor raw errors", async () => {
    const raw = originalMessage();
    const models = { streamSimple: vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: raw });
      return stream;
    }) } as unknown as Models;
    const received: unknown[] = [];
    const target = sink();
    target.onAssistantMessage = async (message) => {
      received.push(message);
      expect(getPiProviderStepFailure(message)).toEqual({ failureKind: "provider_step_error", stepIndex: 1 });
      expect(JSON.stringify(message)).not.toContain(raw.errorMessage);
      expect(getPiProviderStepFailure(structuredClone(message))).toBeUndefined();
    };
    const result = await new PiEngine(models).start(params(), target).done;
    expect(received).toHaveLength(1);
    expect(getPiProviderStepFailure(result)).toEqual({ failureKind: "provider_step_error", stepIndex: 1 });
    expect(models.streamSimple).toHaveBeenCalledTimes(1);
  });

  it("does not classify a synthetic error caused by a callback or SDK/start exception as provider", async () => {
    for (const failureAt of ["callback", "stream-start", "api-key"] as const) {
      const models = { streamSimple: () => {
        if (failureAt === "stream-start") throw new Error("private SDK/runtime error");
        const stream = createAssistantMessageEventStream();
        const message = originalMessage("stop");
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      } } as unknown as Models;
      const target = sink();
      const messages: unknown[] = [];
      target.onAssistantMessage = async (message) => {
        messages.push(message);
        expect(getPiProviderStepFailure(message)).toBeUndefined();
        if (failureAt === "callback" && messages.length === 1) throw new Error("private store failure");
      };
      const input = params();
      if (failureAt === "api-key") input.model.apiKey = async () => { throw new Error("private credential fence failure"); };
      const result = await new PiEngine(models).start(input, target).done;
      expect(result.error).toBe("provider_error");
      expect(getPiProviderStepFailure(result)).toBeUndefined();
      expect(messages.length).toBe(failureAt === "callback" ? 2 : 1);
    }
  });

  it("keeps a genuine provider failure separate from the later synthetic callback error", async () => {
    const models = { streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: originalMessage() });
      return stream;
    } } as unknown as Models;
    const kinds: (string | undefined)[] = [];
    const target = sink();
    target.onAssistantMessage = async (message) => {
      kinds.push(getPiProviderStepFailure(message)?.failureKind);
      if (kinds.length === 1) throw new Error("store callback failure");
    };
    await new PiEngine(models).start(params(), target).done;
    expect(kinds).toEqual(["provider_step_error", undefined]);
    expect(getPiProviderStepFailure({ stopReason: "error", usage: emptyUsage() })).toBeUndefined();
  });

  it("does not classify a real provider aborted result as a failed upstream step", async () => {
    const models = { streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "aborted", error: originalMessage("aborted") });
      return stream;
    } } as unknown as Models;
    const target = sink();
    const messages: unknown[] = [];
    target.onAssistantMessage = async (message) => { messages.push(message); expect(getPiProviderStepFailure(message)).toBeUndefined(); };
    const result = await new PiEngine(models).start(params(), target).done;
    expect(result).toMatchObject({ aborted: true });
    expect(result.error).toBeUndefined();
    expect(getPiProviderStepFailure(result)).toBeUndefined();
    expect(messages).toHaveLength(1);
  });
});
