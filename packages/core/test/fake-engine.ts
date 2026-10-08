import { emptyUsage, type InputPart, type Usage } from "@agent-service/protocol";
import type { AgentEngine, AssistantStepResult, EngineRun, EngineSink, EngineToolResult, EngineTurnParams } from "../src/index.js";

export interface ScriptStep {
  /** A function models a response that genuinely depends on the previous step's tool results. */
  text?: string | ((previousToolResults: EngineToolResult[]) => string);
  reasoning?: string;
  toolCalls?: { name: string; args: unknown }[];
  stopReason?: AssistantStepResult["stopReason"];
  errorMessage?: string;
  usage?: Partial<Usage>;
  /** pause this long before emitting the message (to let tests interrupt/steer mid-step) */
  delayMs?: number;
}

/**
 * Deterministic engine for host tests. Each script step is one model call: it streams the text in
 * chunks, then runs the tool calls through the sink gate exactly like PiEngine would.
 */
export class ScriptedEngine implements AgentEngine {
  readonly name = "scripted";
  received: { history: EngineTurnParams["history"]; input: EngineTurnParams["input"]; systemPrompt: string }[] = [];
  steers: InputPart[][] = [];
  startedSteps = 0;
  executedToolCalls = 0;
  constructor(private readonly script: ScriptStep[]) {}

  start(params: EngineTurnParams, sink: EngineSink): EngineRun {
    this.received.push({ history: params.history, input: params.input, systemPrompt: params.systemPrompt });
    let interrupted = false;
    let callSeq = 0;
    const done = (async () => {
      let step = 0;
      let error: string | undefined;
      let previousToolResults: EngineToolResult[] = [];
      for (const s of this.script) {
        if (interrupted || params.signal.aborted) break;
        step += 1;
        this.startedSteps += 1;
        await sink.onStepStart(step);
        if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
        if (interrupted || params.signal.aborted) break;
        if (s.reasoning) sink.onReasoningDelta(s.reasoning);
        const text = typeof s.text === "function" ? s.text(previousToolResults) : (s.text ?? "");
        for (const chunk of text.match(/.{1,4}/gs) ?? []) sink.onTextDelta(chunk);
        const toolCalls = (s.toolCalls ?? []).map((tc) => ({ id: `call_${++callSeq}`, ...tc }));
        const usage: Usage = {
          ...emptyUsage(), inputTokens: 10, outputTokens: 5, totalTokens: 15, costCNY: 0, ...(s.usage ?? {}),
        };
        if (usage.costCNY === undefined) delete usage.costCNY;
        const msg: AssistantStepResult = {
          text,
          reasoning: s.reasoning,
          toolCalls,
          // Deterministic tests use a known-free fake provider by default. Individual scripts set
          // `costCNY: undefined` to exercise genuinely unpriced responses.
          usage,
          stopReason: s.stopReason ?? (toolCalls.length ? "toolUse" : "stop"),
          errorMessage: s.errorMessage,
          provider: "fake",
          model: "fake-1",
        };
        await sink.onAssistantMessage(msg);
        if (msg.stopReason === "error") {
          error = msg.errorMessage ?? "error";
          break;
        }
        let terminate = false;
        previousToolResults = await Promise.all(
          toolCalls.map(async (tc) => {
            const d = await sink.beforeToolCall(tc, msg);
            if (!d.allow) {
              if (d.interrupt) terminate = true;
              return sink.afterToolCall({ toolCallId: tc.id, name: tc.name, content: [{ type: "text", text: d.reason }], isError: true });
            }
            await sink.onToolExecutionStart(tc.id);
            const tool = params.tools.find((t) => t.name === tc.name)!;
            try {
              this.executedToolCalls += 1;
              const r = await tool.execute(tc.args, { ...params.toolContext, toolCallId: tc.id, signal: params.signal });
              return await sink.afterToolCall({ toolCallId: tc.id, name: tc.name, content: r.content, isError: !!r.isError, details: r.details });
            } catch (err) {
              return sink.afterToolCall({ toolCallId: tc.id, name: tc.name, content: [{ type: "text", text: String(err) }], isError: true });
            }
          }),
        );
        if (terminate || interrupted || params.signal.aborted) break;
        const decision = await sink.onStepEnd(step, msg);
        if (decision === "end") break;
        if (toolCalls.length === 0 && this.steers.length === 0) break;
      }
      return { steps: step, aborted: interrupted || params.signal.aborted, error };
    })();
    return {
      steer: (input) => this.steers.push(input),
      interrupt: () => {
        interrupted = true;
      },
      done,
    };
  }
}
