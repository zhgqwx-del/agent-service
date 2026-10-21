import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { createModels, createInitialSystemMessage, getSystemMessageText, toToolDeclaration, type Models } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ApiError, emptyUsage, type McpToolProgress, type ToolContentPart, type Usage } from "@agent-service/protocol";
import { SubjectDeletingError } from "@agent-service/store";
import type { RunnerTool, ToolResult } from "../tools/types.js";
import type { AgentEngine, AssistantStepResult, EngineInputPart, EngineModelStep, EngineRun, EngineSink, EngineTurnParams, ProviderAdmissionFailure, ProviderModelRequest, ResolvedModel, Summariser, TranscriptMessage } from "./types.js";

export interface PiProviderStepFailure {
  readonly failureKind: "provider_step_error";
  readonly stepIndex: number;
}
type NonDispatchFailure = "provider_error" | ProviderAdmissionFailure;

// Wire fields are not provenance. Pi synthesizes an assistant error after any executor/listener
// failure, including a rejected store commit. Only the original model stream result grants this
// process-local classification; no exported marker lets a generic engine forge it.
const providerStepFailures = new WeakMap<object, Readonly<PiProviderStepFailure>>();
const providerFailureMessages = new WeakMap<object, AssistantStepResult>();
// Only an original result from this exact dispatched request can authorize a configured-price
// estimate. Freeze the values too: later conversions must not reread a mutable SDK usage object.
const originalRequestUsages = new WeakMap<object, Readonly<{ request: ProviderModelRequest; usage: Readonly<Usage> }>>();
type RequestUsageSource = Readonly<{ provider: string; model: string; priceKnown: boolean }>;
type PiSummariserFailure = Readonly<{ provider: string; model: string; usage: Readonly<Usage> }>;
// A public Error/class/message cannot attest a paid attempt. Only the exact error created after
// this request's real dispatch carries its immutable accounting fact, bound to the resolved model.
const summariserFailures = new WeakMap<object, Readonly<{ model: ResolvedModel; failure: PiSummariserFailure }>>();

/** Consume once, only for the Host's exact request model; copied or foreign errors grant nothing. */
export function takePiSummariserFailure(value: unknown, model: ResolvedModel): PiSummariserFailure | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = summariserFailures.get(value);
  if (!source || source.model !== model) return undefined;
  summariserFailures.delete(value);
  return source.failure;
}

function dispatchedSummariserFailure(model: ResolvedModel, usage: Readonly<Usage> = emptyUsage()): Error {
  const error = new Error("Provider request failed.");
  summariserFailures.set(error, Object.freeze({ model, failure: Object.freeze({ provider: model.provider,
    model: model.model, usage: Object.freeze({ ...usage }) }) }));
  return error;
}

export function getPiProviderStepFailure(value: unknown): Readonly<PiProviderStepFailure> | undefined {
  return typeof value === "object" && value !== null ? providerStepFailures.get(value) : undefined;
}

/** Original in-memory failed step only; never an error string or a synthesized terminal turn. */
export function getPiProviderStepFailureMessage(value: unknown): AssistantStepResult | undefined {
  return typeof value === "object" && value !== null ? providerFailureMessages.get(value) : undefined;
}

/**
 * AgentEngine backed by @earendil-works/pi-agent-core's `Agent` class (route A in docs/design §6.1).
 * pi owns the loop (model call → tool batch → next call); the host owns everything else.
 */
export class PiEngine implements AgentEngine {
  readonly name = "pi";
  constructor(private readonly models: Models = createModels()) {}

  start(params: EngineTurnParams, sink: EngineSink): EngineRun {
    const model = params.model.handle as Model<any>;
    let requestModel = params.model;
    let requestMaxTokens = params.maxOutputTokens;
    let step = 0;
    let currentAssistant: AssistantStepResult | undefined;
    // Pi represents tool failures as thrown Errors and otherwise loses structured details. Keep
    // only this turn's actual MCP failure so outcome-unknown survives into the durable result.
    const mcpFailures = new Map<string, ToolResult>();
    const originalProviderFailures = new WeakMap<object, Readonly<PiProviderStepFailure>>();
    const originalNonDispatchFailures = new WeakMap<object, NonDispatchFailure>();
    let preStreamNonDispatchFailure: { step: number; code: NonDispatchFailure } | undefined;
    let streamStartedStep = 0;
    let stepRequest: { step: number; model: ResolvedModel; request?: ProviderModelRequest; signal?: AbortSignal; keyPromise?: Promise<string | undefined> } | undefined;
    const bindRequest = (signal?: AbortSignal) => {
      try {
        params.signal.throwIfAborted();
        signal?.throwIfAborted();
        stepRequest = { step, model: requestModel, request: requestModel.createRequest?.(), signal };
      } catch (error) {
        preStreamNonDispatchFailure = { step, code: "provider_error" };
        throw error;
      }
    };
    const stepResult = (message: AssistantMessage) => toStepResult(message, requestModel.priceKnown !== false,
      stepRequest?.request ?? (requestModel.createRequest ? null : undefined));
    let lastProviderFailure: Readonly<PiProviderStepFailure> | undefined;
    let lastProviderFailureMessage: AssistantStepResult | undefined;
    let sawToolArgsDelta = new Map<number, string>();
    const effectiveArguments = new Map<string, { name: string; args: unknown }>();
    const rewrittenMessages = new WeakMap<object, Map<string, unknown>>();
    const images = new Map<string, Extract<EngineInputPart, { type: "image" }>>();
    const rememberImages = (input: readonly EngineInputPart[]) => {
      for (const part of input) if (part.type === "image") images.set(JSON.stringify([part.mimeType ?? "image/png", part.url]), part);
    };
    for (const message of params.history) if (message.role === "user") rememberImages(message.content);
    const userMessage = (input: EngineInputPart[]) => { rememberImages(input); return toUserMessage(input); };
    // Pi's afterToolCall runs before it emits tool_execution_end and, critically, before it appends
    // the result to the live transcript. Track those calls so the later lifecycle event is not
    // persisted a second time; immediate Pi-generated failures still use the event fallback.
    const finalizedThroughSink = new Set<string>();
    const executableTools = params.tools.map((t) => toAgentTool(t, params.toolContext, sink, (id, result) => mcpFailures.set(id, result), (id, name, original) => {
      const effective = effectiveArguments.get(id);
      if (!effective) return original;
      if (effective.name !== name) throw new Error("Tool request failed.");
      return structuredClone(effective.args);
    }));
    // Pi 0.87 carries instructions and tool declarations in the transcript, not AgentContext fields.
    // Explicitly seed it even when cold history starts with a compaction system message.
    let requestSystem = createInitialSystemMessage(params.systemPrompt, executableTools.map(toToolDeclaration));
    let requestSystemPrompt = params.systemPrompt;

    const agent = new Agent({
      initialState: {
        systemPrompt: params.systemPrompt,
        model,
        tools: executableTools,
        messages: [...(requestSystem ? [requestSystem] : []), ...params.history.map(toPiMessage)],
        thinkingLevel: params.model.reasoning && params.model.reasoning !== "off" ? params.model.reasoning : "off",
      },
      streamFn: (m, ctx, opts) => {
        const streamStep = step;
        streamStartedStep = streamStep;
        const binding = stepRequest;
        if (!binding || binding.step !== streamStep || binding.model !== requestModel) throw new Error("Model request unavailable.");
        const request = binding.request;
        const usageSource: RequestUsageSource = { provider: binding.model.provider, model: binding.model.model,
          priceKnown: binding.model.priceKnown === true };
        const stream = (() => {
          try {
            return this.models.streamSimple(m, ctx, {
              ...opts,
              fetch: request?.fetch ?? requestModel.fetch,
              headers: requestModel.headers,
              maxTokens: requestMaxTokens,
              // A dispatched failure has unknown cost. Only our explicit candidate controller
              // may select an unattempted alternative; never let the SDK create hidden retries.
              maxRetries: 0,
            });
          } catch (error) {
            if (request && !request.wasDispatched()) preStreamNonDispatchFailure = {
              step: streamStep, code: request.admissionFailure() ?? "provider_error",
            };
            throw error;
          }
        })();
        const originalResult = stream.result.bind(stream);
        const result = async () => {
          const message = await originalResult();
          if (request) captureOriginalRequestUsage(message, request, usageSource);
          if (request && !request.wasDispatched() && (message.stopReason === "error" || message.stopReason === "aborted")) {
            originalNonDispatchFailures.set(message, request.admissionFailure() ?? "provider_error");
          } else if (message.stopReason === "error" && !request?.hasLocalFailure?.()
            && Number.isSafeInteger(streamStep) && streamStep > 0) {
            originalProviderFailures.set(message, Object.freeze({
              failureKind: "provider_step_error", stepIndex: streamStep,
            }));
          }
          return message;
        };
        // Preserve the provider stream and iterator. Bound methods retain EventStream state;
        // this wrapper never classifies callback, auth, tool or store exceptions as upstream.
        return new Proxy(stream, {
          get(target, property) {
            if (property === "result") return result;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      getApiKey: async (p) => {
        if (p !== requestModel.provider) return undefined;
        const binding = stepRequest;
        if (!binding || binding.step !== step || binding.model !== requestModel) throw new Error("Model request unavailable.");
        try {
          if (binding.keyPromise) {
            params.signal.throwIfAborted(); binding.signal?.throwIfAborted();
            const key = await binding.keyPromise;
            params.signal.throwIfAborted(); binding.signal?.throwIfAborted();
            return key;
          }
          return await (binding.request?.apiKey ? binding.request.apiKey(binding.signal) : binding.model.apiKey());
        }
        catch (error) {
          // The pinned Agent resolves the key before streamFn. A factory-aware model proves
          // there was no model dispatch; only the real T1 class grants a more specific code.
          if (binding.request && !binding.request.wasDispatched()
            && Number.isSafeInteger(step) && step > 0 && streamStartedStep !== step) {
            preStreamNonDispatchFailure = { step, code: binding.request.admissionFailure()
              ?? (error instanceof SubjectDeletingError ? "subject_deleting" : "provider_error") };
          }
          throw error;
        }
      },
      prepareRequest: async ({ context }, signal) => {
        // Replace only the matching message's tool blocks, never mutate Pi's already validated
        // arguments or its original assistant object. Cold projection uses the same durable args.
        const messages = context.messages.map(message => {
          const changes = rewrittenMessages.get(message);
          if (!changes || message.role !== "assistant") return message;
          return { ...message, content: message.content.map(part => part.type === "toolCall" && changes.has(part.id)
            ? { ...part, arguments: structuredClone(changes.get(part.id)) } : part) } as AgentMessage;
        });
        if (!sink.prepareModelStep && !(requestModel.fallbackEnabled === true && sink.prepareFallbackModelStep)) {
          bindRequest(signal);
          return messages.some((message, index) => message !== context.messages[index])
            ? { context: { ...context, messages } } : undefined;
        }
        const neutral = messages.filter(message => message !== requestSystem).map(message => toTranscriptMessage(message, images));
        const neutralIdentity = JSON.stringify(neutral);
        let prepared: EngineModelStep = { step, model: requestModel, systemPrompt: requestSystemPrompt,
          messages: neutral, ...(requestMaxTokens !== undefined ? { maxOutputTokens: requestMaxTokens } : {}) };
        if (sink.prepareModelStep) prepared = await sink.prepareModelStep(prepared);
        // The approved fixed packages cannot silently rewrite durable history. User prompt
        // changes belong to the host's user-message COMMIT; memory injection is system-only.
        if (params.signal.aborted || prepared.step !== step || JSON.stringify(prepared.messages) !== neutralIdentity) {
          throw new Error("Model request unavailable.");
        }
        requestModel = prepared.model;
        requestMaxTokens = prepared.maxOutputTokens;
        requestSystemPrompt = prepared.systemPrompt;
        // Selection-only fallback runs before Pi creates any stream, output or tool batch. The Host
        // alone authorizes a candidate from the original request capability; no fetch is retried here.
        bindRequest(signal);
        if (requestModel.fallbackEnabled === true && sink.prepareFallbackModelStep) {
          for (let alternatives = 0; ; alternatives++) {
            const binding = stepRequest!;
            try {
              params.signal.throwIfAborted(); signal?.throwIfAborted();
              binding.keyPromise = binding.request?.apiKey ? binding.request.apiKey(binding.signal) : binding.model.apiKey();
              await binding.keyPromise;
              params.signal.throwIfAborted(); signal?.throwIfAborted();
              preStreamNonDispatchFailure = undefined;
              break;
            } catch (error) {
              if (!binding.request || !binding.request.wasDispatched()) preStreamNonDispatchFailure = {
                step, code: binding.request?.admissionFailure() ?? (error instanceof SubjectDeletingError ? "subject_deleting" : "provider_error"),
              };
              if (params.signal.aborted || signal?.aborted || streamStartedStep === step || !binding.request
                || binding.request.wasDispatched() || alternatives >= 3) throw error;
              let next: EngineModelStep | undefined;
              try { next = await sink.prepareFallbackModelStep(prepared, binding.request); }
              catch (fallbackError) {
                // A failed Host/source check is not the preceding candidate's key rejection.
                preStreamNonDispatchFailure = { step, code: fallbackError instanceof SubjectDeletingError ? "subject_deleting"
                  : fallbackError instanceof ApiError && (fallbackError.code === "draining" || fallbackError.code === "quota_exceeded"
                    || fallbackError.code === "subject_deleting") ? fallbackError.code : "provider_error" };
                throw fallbackError;
              }
              if (!next) throw error;
              if (params.signal.aborted || signal?.aborted || streamStartedStep === step || next.step !== step
                || JSON.stringify(next.messages) !== neutralIdentity) {
                preStreamNonDispatchFailure = { step, code: "provider_error" };
                throw new Error("Model request unavailable.");
              }
              prepared = next; requestModel = next.model; requestMaxTokens = next.maxOutputTokens; requestSystemPrompt = next.systemPrompt;
              preStreamNonDispatchFailure = undefined;
              bindRequest(signal);
            }
          }
        }
        if (requestSystem) {
          const prior = requestSystem;
          requestSystem = { ...prior, content: requestSystemPrompt };
          for (let index = 0; index < messages.length; index++) if (messages[index] === prior) messages[index] = requestSystem;
        } else {
          requestSystem = createInitialSystemMessage(requestSystemPrompt, undefined);
          if (requestSystem) messages.unshift(requestSystem);
        }
        // The pinned Agent uses this final model/context before getApiKey and streamFn. Any early
        // key belongs to the exact final binding, including a successfully selected undefined key.
        return { context: { ...context, messages },
          model: requestModel.handle as Model<any>, thinkingLevel: requestModel.reasoning ?? "off" };
      },
      toolExecution: "parallel",
      beforeToolCall: async ({ toolCall, args, assistantMessage }) => {
        const msg = currentAssistant ?? stepResult(assistantMessage);
        const decision = await sink.beforeToolCall({ id: toolCall.id, name: toolCall.name, args }, msg);
        if (Object.hasOwn(decision, "effectiveArgs")) {
          const effective = structuredClone(decision.effectiveArgs);
          effectiveArguments.set(toolCall.id, { name: toolCall.name, args: effective });
          let changes = rewrittenMessages.get(assistantMessage);
          if (!changes) rewrittenMessages.set(assistantMessage, changes = new Map());
          changes.set(toolCall.id, effective);
        }
        if (decision.allow) return undefined;
        if (decision.interrupt) queueMicrotask(() => agent.abort());
        return { block: true, reason: decision.reason, terminate: decision.interrupt === true };
      },
      afterToolCall: async ({ toolCall, result, isError }) => {
        const mcpFailure = mcpFailures.get(toolCall.id);
        mcpFailures.delete(toolCall.id);
        const canonical = await sink.afterToolCall({
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: mcpFailure?.content ?? toProtocolContent(result.content ?? []),
          isError: mcpFailure ? true : isError,
          details: mcpFailure?.details ?? result.details,
        });
        finalizedThroughSink.add(toolCall.id);
        return {
          content: toPiContent(canonical.content),
          details: canonical.details,
          isError: canonical.isError,
        };
      },
      finishTurn: async ({ message }) => {
        if (message.role !== "assistant") return undefined;
        const res = stepResult(message);
        if (res.stopReason === "error" || res.stopReason === "aborted") return undefined;
        const d = await sink.onStepEnd(step, res);
        return d === "end" ? { action: "end" } : undefined;
      },
    });

    let aborted = false;
    let lastError: "provider_error" | ProviderAdmissionFailure | undefined;
    agent.subscribe(async (ev: AgentEvent) => {
      switch (ev.type) {
        case "turn_start":
          step += 1;
          effectiveArguments.clear();
          sawToolArgsDelta = new Map();
          currentAssistant = undefined;
          preStreamNonDispatchFailure = undefined;
          stepRequest = undefined;
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
            const nonDispatchFailure = originalNonDispatchFailures.get(ev.message)
              ?? (preStreamNonDispatchFailure?.step === step && (ev.message.stopReason === "error" || ev.message.stopReason === "aborted")
                ? preStreamNonDispatchFailure.code : undefined);
            if (nonDispatchFailure) {
              // Known absence of dispatch grants no provider response or usage, including unknown
              // local DB/build failures. Those keep provider_error, not a made-up quota denial.
              lastError = nonDispatchFailure;
              lastProviderFailure = undefined; lastProviderFailureMessage = undefined;
              currentAssistant = undefined;
              break;
            }
            currentAssistant = stepResult(ev.message);
            const providerFailure = originalProviderFailures.get(ev.message);
            if (providerFailure) {
              providerStepFailures.set(currentAssistant, providerFailure);
              lastProviderFailure = providerFailure;
              lastProviderFailureMessage = currentAssistant;
              providerFailureMessages.set(currentAssistant, currentAssistant);
            }
            if (currentAssistant.stopReason === "error") lastError = "provider_error";
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
          if (finalizedThroughSink.delete(ev.toolCallId)) break;
          // Unknown/invalid/blocked calls are finalized inside Pi before a real tool execution and
          // Pi 0.87 does not run afterToolCall for that immediate path. Its synthesized result is
          // already JSON-safe, so persist it here before Pi emits the corresponding result message.
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
        await agent.prompt(userMessage(params.input));
        await agent.waitForIdle();
      } catch {
        // The provider or transport exception can contain credentials, URLs and response bodies.
        lastError ??= "provider_error";
      } finally {
        params.signal.removeEventListener("abort", onAbort);
      }
      if (preStreamNonDispatchFailure?.step === step) {
        lastError = preStreamNonDispatchFailure.code;
        lastProviderFailure = undefined; lastProviderFailureMessage = undefined;
      }
      const result = { steps: step, aborted: aborted || params.signal.aborted, error: lastError };
      if (lastError === "provider_error" && lastProviderFailure) providerStepFailures.set(result, lastProviderFailure);
      if (lastError === "provider_error" && lastProviderFailureMessage) providerFailureMessages.set(result, lastProviderFailureMessage);
      return result;
    })();

    return {
      steer: (input) => agent.steer(userMessage(input)),
      interrupt: () => agent.abort(),
      done,
    };
  }
}

/** Summariser backed by the same pi model registry the engine uses. */
export class PiSummariser implements Summariser {
  constructor(private readonly models: Models = createModels()) {}

  async summarise(input: { model: ResolvedModel; systemPrompt: string; text: string; maxTokens?: number; signal?: AbortSignal }) {
    input.signal?.throwIfAborted();
    const usageSource: RequestUsageSource = { provider: input.model.provider, model: input.model.model,
      priceKnown: input.model.priceKnown === true };
    let request: ProviderModelRequest | undefined;
    let apiKey: string | undefined;
    try {
      request = input.model.createRequest?.();
      apiKey = await (request?.apiKey ? request.apiKey(input.signal) : input.model.apiKey());
    }
    catch (error) {
      if (typeof input.model.createRequest === "function") {
        throw providerAdmissionError((request && !request.wasDispatched() ? request.admissionFailure() : undefined)
          ?? (error instanceof SubjectDeletingError ? "subject_deleting" : "provider_error"));
      }
      throw error;
    }
    let msg: AssistantMessage;
    try {
      msg = await this.models.completeSimple(
        input.model.handle as Model<any>,
        { systemPrompt: input.systemPrompt, messages: [{ role: "user", content: input.text, timestamp: Date.now() }] },
        {
          apiKey,
          headers: input.model.headers,
          fetch: request?.fetch ?? input.model.fetch,
          maxTokens: input.maxTokens ?? 1_500,
          maxRetries: 0,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
    } catch (error) {
      if (request && !request.wasDispatched()) throw providerAdmissionError(request.admissionFailure() ?? "provider_error");
      if (request?.wasDispatched()) throw dispatchedSummariserFailure(input.model);
      throw error;
    }
    if (request) captureOriginalRequestUsage(msg, request, usageSource);
    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      if (request && !request.wasDispatched()) throw providerAdmissionError(request.admissionFailure() ?? "provider_error");
      if (request?.wasDispatched()) throw dispatchedSummariserFailure(input.model,
        originalRequestUsages.get(msg)?.usage ?? emptyUsage());
      throw new Error("summarisation failed");
    }
    const res = toStepResult(msg, input.model.priceKnown !== false, request ?? (input.model.createRequest ? null : undefined));
    // A successful transport with an unusable summary still spent this attempt. Preserve a
    // legitimate original success estimate, rather than manufacturing either a summary or free I/O.
    if (!res.text.trim() && request?.wasDispatched()) throw dispatchedSummariserFailure(input.model, res.usage);
    return { text: res.text, usage: res.usage };
  }
}

function providerAdmissionError(code: NonDispatchFailure): ApiError {
  return new ApiError(code, code === "quota_exceeded" ? "Provider quota exceeded."
    : code === "subject_deleting" ? "Subject is being deleted."
    : code === "draining" ? "Provider admission is unavailable." : "Provider request failed.");
}

// ---------- conversions ----------

function toAgentTool(tool: RunnerTool, ctx: EngineTurnParams["toolContext"], sink: EngineSink, onMcpFailure?: (id: string, result: ToolResult) => void,
  effectiveArgs?: (id: string, name: string, original: unknown) => unknown): AgentTool<any> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
    executionMode: tool.concurrencySafe === false ? "sequential" : "parallel",
    execute: async (toolCallId, params, signal, onUpdate) => {
      const executionSignal = signal ?? new AbortController().signal;
      let acceptingProgress = true;
      let report: ReturnType<NonNullable<EngineSink["createMcpProgressReporter"]>> = undefined;
      if (tool.kind === "mcp") {
        try { report = sink.createMcpProgressReporter?.(toolCallId, tool.name, executionSignal); }
        catch { /* A progress observer cannot change an approved tool's result. */ }
      }
      let res: ToolResult;
      try {
        res = await tool.execute(effectiveArgs ? effectiveArgs(toolCallId, tool.name, params) : params, {
          ...ctx,
          toolCallId,
          signal: executionSignal,
          onProgress: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
          ...(report ? { onMcpProgress: (progress: McpToolProgress) => {
            if (!acceptingProgress || executionSignal.aborted) return;
            try { report?.(progress); } catch { /* Observation is fail-open, not tool execution. */ }
          } } : {}),
        });
      } finally { acceptingProgress = false; }
      if (res.isError) {
        if (tool.kind === "mcp") onMcpFailure?.(toolCallId, res);
        throw new ToolError(res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
      }
      return { content: toPiContent(res.content), details: (res.details ?? {}) as any };
    },
  };
}

class ToolError extends Error {}

function toUserMessage(input: EngineInputPart[]): AgentMessage {
  return { role: "user", content: toPiUserContent(input), timestamp: Date.now() };
}

function toPiUserContent(input: EngineInputPart[]): (TextContent | ImageContent)[] {
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
      return { role: "toolResult", toolCallId: m.toolCallId, toolName: m.name, content: toPiContent(m.content), details: m.details as any, isError: m.isError, timestamp: 0 };
    case "system":
      return { role: "system", content: m.text, timestamp: 0 };
  }
}

function toTranscriptMessage(message: AgentMessage, images: ReadonlyMap<string, Extract<EngineInputPart, { type: "image" }>>): TranscriptMessage {
  if (message.role === "assistant") {
    const value = toStepResult(message, true, originalRequestUsages.get(message)?.request);
    return { role: "assistant", text: value.text, ...(value.reasoning ? { reasoning: value.reasoning } : {}),
      toolCalls: value.toolCalls, provider: value.provider, model: value.model };
  }
  if (message.role === "user") {
    const content: EngineInputPart[] = typeof message.content === "string" ? [{ type: "text", text: message.content }]
      : message.content.map(part => {
        if (part.type === "text") return { type: "text" as const, text: part.text };
        const original = images.get(JSON.stringify([part.mimeType, part.data]));
        if (!original) throw new Error("Model input unavailable.");
        return { ...original };
      });
    return { role: "user", content };
  }
  if (message.role === "toolResult") return { role: "toolResult", toolCallId: message.toolCallId, name: message.toolName,
    content: toProtocolContent(message.content), isError: message.isError, ...(message.details !== undefined ? { details: message.details } : {}) };
  if (message.role === "system") return { role: "system", text: getSystemMessageText(message) };
  throw new Error("Model input unavailable.");
}

function captureOriginalRequestUsage(msg: AssistantMessage, request: ProviderModelRequest, source: RequestUsageSource): void {
  if (originalRequestUsages.get(msg)?.request === request) return;
  const u = msg.usage;
  const billable = [u.input, u.output, u.cacheRead, u.cacheWrite];
  const total = billable.reduce((sum, count) => sum + count, 0);
  const successful = msg.stopReason === "stop" || msg.stopReason === "length" || msg.stopReason === "toolUse";
  const knownEstimate = request.wasDispatched() && !request.hasLocalFailure?.() && source.priceKnown && successful
    && msg.provider === source.provider && msg.model === source.model
    && billable.every(count => Number.isSafeInteger(count) && count >= 0) && billable.some(count => count > 0)
    && Number.isSafeInteger(total) && Number.isSafeInteger(u.totalTokens) && u.totalTokens === total
    && Number.isSafeInteger(u.reasoning ?? 0) && (u.reasoning ?? 0) >= 0
    && typeof u.cost?.total === "number" && Number.isFinite(u.cost.total) && u.cost.total >= 0;
  const usage: Readonly<Usage> = Object.freeze({
    inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite,
    reasoningTokens: u.reasoning ?? 0, totalTokens: u.totalTokens,
    ...(knownEstimate ? { costCNY: u.cost.total } : {}),
  });
  originalRequestUsages.set(msg, Object.freeze({ request, usage }));
}

function toStepResult(msg: AssistantMessage, priceKnown = true, request?: ProviderModelRequest | null): AssistantStepResult {
  const text = msg.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("");
  const reasoning = msg.content.filter((c) => c.type === "thinking").map((c) => (c as { thinking: string }).thinking).join("") || undefined;
  const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall").map((c) => ({ id: c.id, name: c.name, args: c.arguments }));
  const u = msg.usage;
  const captured = originalRequestUsages.get(msg);
  const snapshot = request && captured?.request === request ? captured.usage : undefined;
  const usage: Usage = snapshot ? { ...snapshot } : {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
    reasoningTokens: u.reasoning ?? 0,
    totalTokens: u.totalTokens,
    // The SDK retains initialized zeroes or partial usage on failure, not a final charge receipt.
    ...(request === undefined && priceKnown && msg.stopReason !== "error" && msg.stopReason !== "aborted"
      && u.cost?.total !== undefined ? { costCNY: u.cost.total } : {}),
  };
  const stop = msg.stopReason === "stop" || msg.stopReason === "length" || msg.stopReason === "toolUse" || msg.stopReason === "error" || msg.stopReason === "aborted" ? msg.stopReason : "stop";
  // Pi's errorMessage can include provider response bodies, URLs, and credentials. It must not
  // cross the engine/sink boundary where a future persistence path might accidentally capture it.
  return { text, reasoning, toolCalls, usage, stopReason: stop, provider: msg.provider, model: msg.model };
}
