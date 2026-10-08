import type { InputPart, ModelSpec, Principal, ToolContentPart, Usage } from "@agent-service/protocol";
import type { RunnerTool } from "../tools/types.js";

/** Persisted image parts carry only a blob id; the host adds a verified data URL in memory. */
export type EngineInputPart =
  | Extract<InputPart, { type: "text" }>
  | (Extract<InputPart, { type: "image" }> & { url: string });

/**
 * Engine-neutral transcript. This is what the store's items are projected into before a turn and
 * what an engine consumes. It deliberately mirrors the chat-completions shape.
 */
export type TranscriptMessage =
  | { role: "user"; content: EngineInputPart[] }
  | {
      role: "assistant";
      text: string;
      reasoning?: string;
      toolCalls: { id: string; name: string; args: unknown }[];
      /** provider/model that produced it, for replay fidelity (reasoning_content requirements etc.) */
      provider?: string;
      model?: string;
    }
  | { role: "toolResult"; toolCallId: string; name: string; content: ToolContentPart[]; isError: boolean; details?: unknown }
  | { role: "system"; text: string };

export interface ResolvedModel {
  /** opaque handle understood by the engine (PiEngine: pi Model) */
  handle: unknown;
  provider: string;
  model: string;
  contextWindow: number;
  /** Input modalities accepted by the selected model, copied from its provider model spec. */
  input: ModelSpec["input"];
  /**
   * Whether the configured price table is authoritative for this model. Pi requires numeric cost
   * coefficients, so an unpriced model is registered with zeroes internally; this bit prevents
   * those compatibility zeroes from being persisted as a known free charge.
   */
  priceKnown?: boolean;
  /** returns the API key for this request (BYOK), or undefined for keyless endpoints */
  apiKey: () => Promise<string | undefined>;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  reasoning?: "off" | "low" | "medium" | "high";
}

export interface EngineTurnParams {
  systemPrompt: string;
  tools: RunnerTool[];
  history: TranscriptMessage[];
  input: EngineInputPart[];
  model: ResolvedModel;
  maxOutputTokens?: number;
  signal: AbortSignal;
  /** identity threaded into every tool execution */
  toolContext: { principal: Principal; sessionId: string; turnId: string };
}

export interface AssistantStepResult {
  text: string;
  reasoning?: string;
  toolCalls: { id: string; name: string; args: unknown }[];
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  provider: string;
  model: string;
}

export type BeforeToolCallDecision = { allow: true } | { allow: false; reason: string; interrupt?: boolean };

/**
 * One finalized tool result. `afterToolCall` returns the exact JSON-safe value that the engine
 * must append to its live transcript; this prevents the model from observing a different result
 * from the one the host durably recorded.
 */
export interface EngineToolResult {
  toolCallId: string;
  name: string;
  content: ToolContentPart[];
  isError: boolean;
  details?: unknown;
}

/**
 * Callbacks the engine drives during a turn. The host implements persistence, approvals,
 * limits and event publishing behind these.
 */
export interface EngineSink {
  /** one model request is about to start (step = 1-based) */
  onStepStart(step: number): Promise<void> | void;
  onTextDelta(delta: string): void;
  onReasoningDelta(delta: string): void;
  onToolArgsDelta(toolCallId: string | undefined, delta: string): void;
  /** the assistant message for this step is complete (tool calls not yet executed) */
  onAssistantMessage(msg: AssistantStepResult): Promise<void>;
  /** write-ahead + approval gate; must resolve before the tool runs */
  beforeToolCall(call: { id: string; name: string; args: unknown }, msg: AssistantStepResult): Promise<BeforeToolCallDecision>;
  onToolExecutionStart(toolCallId: string): Promise<void> | void;
  onToolProgress(toolCallId: string, text: string): void;
  /** Persist and return the canonical result before an engine exposes it to the next model step. */
  afterToolCall(result: EngineToolResult): Promise<EngineToolResult>;
  /**
   * Compatibility path for engine-generated immediate failures that cannot pass through a tool
   * post-processing hook (for example an unknown or blocked tool in Pi).
   */
  onToolResult(result: EngineToolResult): Promise<void>;
  /** after the assistant message and all tool results of this step are final; return "end" to stop */
  onStepEnd(step: number, msg: AssistantStepResult): Promise<"continue" | "end">;
}

export interface EngineRun {
  /** inject a user message at the next step boundary */
  steer(input: EngineInputPart[]): void;
  interrupt(): void;
  /** resolves when the engine loop has fully settled */
  done: Promise<{ steps: number; aborted: boolean; error?: string }>;
}

export interface AgentEngine {
  readonly name: string;
  start(params: EngineTurnParams, sink: EngineSink): EngineRun;
}

/**
 * A single non-streaming model call used to compress history. Separate from AgentEngine on purpose:
 * compaction is not part of the agent loop, and a host can compact without running one.
 */
export interface Summariser {
  summarise(input: { model: ResolvedModel; systemPrompt: string; text: string; maxTokens?: number; signal?: AbortSignal }): Promise<{ text: string; usage: Usage }>;
}
