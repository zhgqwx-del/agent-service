import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Models } from "@earendil-works/pi-ai";
import type { McpToolProgress } from "@agent-service/protocol";
import { PiEngine, type EngineSink, type ResolvedModel, type RunnerTool, type ToolExecutionContext } from "../src/index.js";

const TOOL = "mcp_progress_fixture";
const model: Model<"openai-completions"> = {
  id: "fake-model", name: "fake", api: "openai-completions", provider: "fake-provider",
  baseUrl: "http://127.0.0.1.invalid", reasoning: false, input: ["text"], contextWindow: 8_192, maxTokens: 1_024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
class LocalModels {
  readonly contexts: Context[] = [];
  streamSimple(_model: Model<never>, context: Context) {
    const first = this.contexts.length === 0;
    this.contexts.push(structuredClone(context));
    const message: AssistantMessage = { role: "assistant", content: first
      ? [{ type: "toolCall", id: "call_1", name: TOOL, arguments: {} }]
      : [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id,
    usage, stopReason: first ? "toolUse" : "stop", timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); });
    return stream;
  }
}
const resolved: ResolvedModel = { handle: model, provider: model.provider, model: model.id,
  contextWindow: model.contextWindow, input: model.input, apiKey: async () => undefined };
function sink(patch: Partial<EngineSink> = {}): EngineSink {
  return {
    onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
    onAssistantMessage: async () => {}, beforeToolCall: async () => ({ allow: true }),
    onToolExecutionStart() {}, onToolProgress() {}, afterToolCall: async value => value,
    onToolResult: async () => {}, onStepEnd: async step => step >= 2 ? "end" : "continue", ...patch,
  };
}
async function run(tool: RunnerTool, observer: EngineSink) {
  const models = new LocalModels(), engine = new PiEngine(models as unknown as Models);
  const active = engine.start({ systemPrompt: "fixture", tools: [tool], history: [],
    input: [{ type: "text", text: "execute" }], model: resolved, signal: new AbortController().signal,
    toolContext: { principal: { tenantId: "fixture", userId: "alice" }, sessionId: "sess_fixture", turnId: "turn_fixture" },
  }, observer);
  return { result: await active.done, models };
}
function tool(execute: RunnerTool["execute"], kind: RunnerTool["kind"] = "mcp"): RunnerTool {
  return { name: TOOL, description: "fixture", parameters: { type: "object", properties: {} }, kind,
    readOnly: false, execute };
}

describe("Pi typed MCP progress execution seam", () => {
  it("mints at actual approved execute entry and never puts typed progress in text/result content", async () => {
    let approved = false, executions = 0, textUpdates = 0;
    const values: McpToolProgress[] = [], bindings: Array<[string, string, boolean]> = [];
    const result = await run(tool(async (_args, ctx) => {
      executions++; expect(ctx.onMcpProgress).toBeTypeOf("function");
      ctx.onMcpProgress?.({ progress: 1, total: 2, message: "typed observation" });
      return { content: [{ type: "text", text: "actual tool result" }] };
    }), sink({
      beforeToolCall: async () => { approved = true; return { allow: true }; },
      createMcpProgressReporter: (id, name, signal) => {
        expect(approved).toBe(true); bindings.push([id, name, signal.aborted]); return value => values.push(value);
      },
      onToolProgress: () => { textUpdates++; },
    }));
    expect(result.result.error).toBeUndefined(); expect(executions).toBe(1);
    expect(bindings).toEqual([["call_1", TOOL, false]]);
    expect(values).toEqual([{ progress: 1, total: 2, message: "typed observation" }]); expect(textUpdates).toBe(0);
    const messages = result.models.contexts[1]?.messages ?? [];
    const output = messages.find(message => message.role === "toolResult");
    expect(output).toMatchObject({ content: [{ type: "text", text: "actual tool result" }] });
    expect(JSON.stringify(messages).includes("typed observation")).toBe(false);
  });

  it("does not mint or execute when the actual approval gate denies", async () => {
    let mints = 0, executions = 0;
    await run(tool(async () => { executions++; return { content: [] }; }), sink({
      beforeToolCall: async () => ({ allow: false, reason: "declined" }),
      createMcpProgressReporter: () => { mints++; return () => {}; },
    }));
    expect(mints).toBe(0); expect(executions).toBe(0);
  });

  it("does not expose an MCP callback to a builtin tool", async () => {
    let mints = 0;
    const result = await run(tool(async (_args, ctx) => {
      expect(ctx.onMcpProgress).toBeUndefined(); return { content: [] };
    }, "builtin"), sink({ createMcpProgressReporter: () => { mints++; return () => {}; } }));
    expect(result.result.error).toBeUndefined(); expect(mints).toBe(0);
  });

  it.each(["mint", "report"] as const)("keeps an observation %s failure out of the canonical tool result", async mode => {
    let observed = 0; let late: ToolExecutionContext["onMcpProgress"];
    const result = await run(tool(async (_args, ctx) => {
      late = ctx.onMcpProgress; ctx.onMcpProgress?.({ progress: 1 });
      return { content: [{ type: "text", text: "unchanged success" }] };
    }), sink({ createMcpProgressReporter: () => {
      if (mode === "mint") throw new Error("Fixture observer failed.");
      return () => { observed++; throw new Error("Fixture observer failed."); };
    } }));
    expect(result.result.error).toBeUndefined();
    expect(result.models.contexts[1]?.messages.find(message => message.role === "toolResult"))
      .toMatchObject({ content: [{ type: "text", text: "unchanged success" }], isError: false });
    expect(observed).toBe(mode === "report" ? 1 : 0);
    late?.({ progress: 2 }); expect(observed).toBe(mode === "report" ? 1 : 0);
  });
});
