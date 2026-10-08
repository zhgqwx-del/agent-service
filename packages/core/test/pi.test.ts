import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import {
  PiEngine,
  type EngineSink,
  type EngineToolResult,
  type ResolvedModel,
  type RunnerTool,
} from "../src/index.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-completions"> = {
  id: "fake-model",
  name: "fake-model",
  api: "openai-completions",
  provider: "fake-provider",
  baseUrl: "http://127.0.0.1.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

function assistant(content: AssistantMessage["content"], stopReason: "toolUse" | "stop"): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

class TwoStepModels {
  readonly contexts: Context[] = [];
  private call = 0;

  streamSimple(_model: Model<never>, context: Context) {
    this.contexts.push(structuredClone(context));
    const message = this.call++ === 0
      ? assistant([{ type: "toolCall", id: "call_1", name: "raw_tool", arguments: {} }], "toolUse")
      : assistant([{ type: "text", text: "done" }], "stop");
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
    });
    return stream;
  }
}

describe("PiEngine tool-result finalization", () => {
  it("uses the host-returned canonical result in the next model request", async () => {
    const models = new TwoStepModels();
    const engine = new PiEngine(models as unknown as Models);
    const rawTool: RunnerTool = {
      name: "raw_tool",
      description: "returns a raw success",
      parameters: { type: "object", properties: {} },
      kind: "builtin",
      readOnly: true,
      execute: async () => ({ content: [{ type: "text", text: "RAW_SUCCESS" }], details: { raw: true } }),
    };
    const observedCosts: Array<number | undefined> = [];
    const canonical: EngineToolResult = {
      toolCallId: "call_1",
      name: "raw_tool",
      content: [{ type: "text", text: "TOOL_OUTPUT_TOO_LARGE: canonical failure" }],
      isError: true,
      details: { code: "TOOL_OUTPUT_TOO_LARGE" },
    };
    let afterCalls = 0;
    const sink: EngineSink = {
      onStepStart: () => {},
      onTextDelta: () => {},
      onReasoningDelta: () => {},
      onToolArgsDelta: () => {},
      onAssistantMessage: async () => {},
      beforeToolCall: async () => ({ allow: true }),
      onToolExecutionStart: () => {},
      onToolProgress: () => {},
      afterToolCall: async (raw) => {
        afterCalls += 1;
        expect(raw).toMatchObject({ content: [{ type: "text", text: "RAW_SUCCESS" }], isError: false });
        return canonical;
      },
      onToolResult: async () => {
        throw new Error("executed tools must be finalized through afterToolCall");
      },
      onStepEnd: async (step, message) => {
        observedCosts.push(message.usage.costCNY);
        return step >= 2 ? "end" : "continue";
      },
    };
    const resolved: ResolvedModel = {
      handle: model,
      provider: model.provider,
      model: model.id,
      contextWindow: model.contextWindow,
      input: model.input,
      priceKnown: false,
      apiKey: async () => "unused",
    };

    const run = engine.start({
      systemPrompt: "test",
      tools: [rawTool],
      history: [],
      input: [{ type: "text", text: "go" }],
      model: resolved,
      signal: new AbortController().signal,
      toolContext: { principal: { tenantId: "tenant", userId: "user" }, sessionId: "sess_test", turnId: "turn_test" },
    }, sink);
    const result = await run.done;

    expect(result.error).toBeUndefined();
    expect(afterCalls).toBe(1);
    expect(observedCosts).toEqual([undefined, undefined]);
    expect(models.contexts).toHaveLength(2);
    const nextResult = models.contexts[1]?.messages.find((message) => message.role === "toolResult");
    expect(nextResult).toMatchObject({
      role: "toolResult",
      content: canonical.content,
      isError: true,
      details: canonical.details,
    });
    expect(JSON.stringify(models.contexts[1])).not.toContain("RAW_SUCCESS");
  });
});
