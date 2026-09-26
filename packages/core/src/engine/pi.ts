import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { InputPart, ToolContentPart, Usage } from "@agent-service/protocol";
import type { RunnerTool } from "../tools/types.js";
import type { AgentEngine, AssistantStepResult, EngineRun, EngineSink, EngineTurnParams, ResolvedModel, Summariser, TranscriptMessage } from "./types.js";

/**
 * AgentEngine backed by @earendil-works/pi-agent-core's `Agent` class (route A in docs/design §6.1).
 * pi owns the loop (model call → tool batch → next call); the host owns everything else.
 */
export class PiEngine implements AgentEngine {
  readonly name = "pi";
  constructor(private readonly models: Models = createModels()) {}

  start(params: EngineTurnParams, sink: EngineSink): EngineRun {
    const model = params.model.handle as Model<any>;
    const provider = params.model.provider;
    let step = 0;
    let currentAssistant: AssistantStepResult | undefined;
    let sawToolArgsDelta = new Map<number, string>();

    const agent = new Agent({
      initialState: {
        systemPrompt: params.systemPrompt,
        model,
        tools: params.tools.map((t) => toAgentTool(t, params.toolContext)),
        messages: params.history.map(toPiMessage),
        thinkingLevel: params.model.reasoning && params.model.reasoning !== "off" ? params.model.reasoning : "off",
      },
      streamFn: (m, ctx, opts) =>
        this.models.streamSimple(m, ctx, {
          ...opts,
          fetch: params.model.fetch,
          headers: params.model.headers,
          maxTokens: params.maxOutputTokens,
        }),
      getApiKey: async (p) => (p === provider ? await params.model.apiKey() : undefined),
      toolExecution: "parallel",
      beforeToolCall: async ({ toolCall, args, assistantMessage }) => {
        const msg = currentAssistant ?? toStepResult(assistantMessage);
        const decision = await sink.beforeToolCall({ id: toolCall.id, name: toolCall.name, args }, msg);
        if (decision.allow) return undefined;
        if (decision.interrupt) queueMicrotask(() => agent.abort());
        return { block: true, reason: decision.reason, terminate: decision.interrupt === true };
      },
      finishTurn: async ({ message }) => {
        if (message.role !== "assistant") return undefined;
        const res = toStepResult(message);
        if (res.stopReason === "error" || res.stopReason === "aborted") return undefined;
        const d = await sink.onStepEnd(step, res);
        return d === "end" ? { action: "end" } : undefined;
      },
    });

    let aborted = false;
    let lastError: string | undefined;
    agent.subscribe(async (ev: AgentEvent) => {
      switch (ev.type) {
        case "turn_start":
          step += 1;
          sawToolArgsDelta = new Map();
          currentAssistant = undefined;
          await sink.onStepStart(step);
          break;
        case "message_update": {
          const e = ev.assistantMessageEvent;
          if (e.type === "text_delta") sink.onTextDelta(e.delta);
          else if (e.type === "thinking_delta") sink.onReasoningDelta(e.delta);
          else if (e.type === "toolcall_delta") {
            const idx = (e as { contentIndex?: number }).contentIndex ?? 0;
            const tc = e.partial.content[idx];
            sink.onToolArgsDelta(tc && tc.type === "toolCall" ? tc.id : undefined, e.delta);
            sawToolArgsDelta.set(idx, (sawToolArgsDelta.get(idx) ?? "") + e.delta);
          }
          break;
        }
        case "message_end":
          if (ev.message.role === "assistant") {
            currentAssistant = toStepResult(ev.message);
            if (currentAssistant.stopReason === "error") lastError = currentAssistant.errorMessage ?? "provider error";
            if (currentAssistant.stopReason === "aborted") aborted = true;
            await sink.onAssistantMessage(currentAssistant);
          }
          break;
        case "tool_execution_start":
          await sink.onToolExecutionStart(ev.toolCallId);
          break;
        case "tool_execution_update": {
          const text = (ev.partialResult?.content ?? []).map((c: TextContent | ImageContent) => (c.type === "text" ? c.text : "")).join("");
          if (text) sink.onToolProgress(ev.toolCallId, text);
          break;
        }
        case "tool_execution_end":
          await sink.onToolResult({
            toolCallId: ev.toolCallId,
            name: ev.toolName,
            content: toProtocolContent(ev.result?.content ?? []),
            isError: ev.isError,
            details: ev.result?.details,
          });
          break;
        default:
          break;
      }
    });

    const onAbort = () => agent.abort();
    params.signal.addEventListener("abort", onAbort, { once: true });

    const done = (async () => {
      try {
        await agent.prompt(toUserMessage(params.input));
        await agent.waitForIdle();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      } finally {
        params.signal.removeEventListener("abort", onAbort);
      }
      return { steps: step, aborted: aborted || params.signal.aborted, error: lastError };
    })();

    return {
      steer: (input) => agent.steer(toUserMessage(input)),
      interrupt: () => agent.abort(),
      done,
    };
  }
}

/** Summariser backed by the same pi model registry the engine uses. */
export class PiSummariser implements Summariser {
  constructor(private readonly models: Models = createModels()) {}

  async summarise(input: { model: ResolvedModel; systemPrompt: string; text: string; maxTokens?: number; signal?: AbortSignal }) {
    const msg = await this.models.completeSimple(
      input.model.handle as Model<any>,
      { systemPrompt: input.systemPrompt, messages: [{ role: "user", content: input.text, timestamp: Date.now() }] },
      {
        apiKey: await input.model.apiKey(),
        headers: input.model.headers,
        fetch: input.model.fetch,
        maxTokens: input.maxTokens ?? 1_500,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      throw new Error(`summarisation failed: ${msg.errorMessage ?? msg.stopReason}`);
    }
    const res = toStepResult(msg);
    return { text: res.text, usage: res.usage };
  }
}

// ---------- conversions ----------

function toAgentTool(tool: RunnerTool, ctx: EngineTurnParams["toolContext"]): AgentTool<any> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
    executionMode: tool.concurrencySafe === false ? "sequential" : "parallel",
    execute: async (toolCallId, params, signal, onUpdate) => {
      const res = await tool.execute(params, {
        ...ctx,
        toolCallId,
        signal: signal ?? new AbortController().signal,
        onProgress: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
      });
      if (res.isError) throw new ToolError(res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
      return { content: toPiContent(res.content), details: (res.details ?? {}) as any };
    },
  };
}

class ToolError extends Error {}

function toUserMessage(input: (InputPart & { type: "text" | "image" })[]): AgentMessage {
  return { role: "user", content: toPiUserContent(input), timestamp: Date.now() };
}

function toPiUserContent(input: (InputPart & { type: "text" | "image" })[]): (TextContent | ImageContent)[] {
  return input.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image", data: p.url, mimeType: p.mimeType ?? "image/png" }));
}

function toPiContent(parts: ToolContentPart[]): (TextContent | ImageContent)[] {
  return parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image", data: p.url, mimeType: p.mimeType ?? "image/png" }));
}

function toProtocolContent(parts: (TextContent | ImageContent)[]): ToolContentPart[] {
  return parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image", url: p.data, mimeType: p.mimeType }));
}

function toPiMessage(m: TranscriptMessage): Message {
  switch (m.role) {
    case "user":
      return { role: "user", content: toPiUserContent(m.content), timestamp: 0 };
    case "assistant": {
      const content: (TextContent | { type: "thinking"; thinking: string } | ToolCall)[] = [];
      if (m.reasoning) content.push({ type: "thinking", thinking: m.reasoning });
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls) content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: (tc.args ?? {}) as any });
      return {
        role: "assistant",
        content,
        api: "openai-completions",
        provider: m.provider ?? "unknown",
        model: m.model ?? "unknown",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: m.toolCalls.length ? "toolUse" : "stop",
        timestamp: 0,
      };
    }
    case "toolResult":
      return { role: "toolResult", toolCallId: m.toolCallId, toolName: m.name, content: toPiContent(m.content), isError: m.isError, timestamp: 0 };
    case "system":
      return { role: "system", content: m.text, timestamp: 0 };
  }
}

function toStepResult(msg: AssistantMessage): AssistantStepResult {
  const text = msg.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("");
  const reasoning = msg.content.filter((c) => c.type === "thinking").map((c) => (c as { thinking: string }).thinking).join("") || undefined;
  const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall").map((c) => ({ id: c.id, name: c.name, args: c.arguments }));
  const u = msg.usage;
  const usage: Usage = {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
    reasoningTokens: u.reasoning ?? 0,
    totalTokens: u.totalTokens,
    costCNY: u.cost?.total,
  };
  const stop = msg.stopReason === "stop" || msg.stopReason === "length" || msg.stopReason === "toolUse" || msg.stopReason === "error" || msg.stopReason === "aborted" ? msg.stopReason : "stop";
  return { text, reasoning, toolCalls, usage, stopReason: stop, errorMessage: msg.errorMessage, provider: msg.provider, model: msg.model };
}
