import { emptyUsage, type InputPart, type Usage } from "@agent-service/protocol";
import type { AgentEngine, AssistantStepResult, EngineRun, EngineSink, EngineTurnParams } from "../src/index.js";

export interface ScriptStep {
  text?: string;
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
  constructor(private readonly script: ScriptStep[]) {}

  start(params: EngineTurnParams, sink: EngineSink): EngineRun {
    this.received.push({ history: params.history, input: params.input, systemPrompt: params.systemPrompt });
    let interrupted = false;
    let callSeq = 0;
    const done = (async () => {
      let step = 0;
      let error: string | undefined;
      for (const s of this.script) {
        if (interrupted || params.signal.aborted) break;
        step += 1;
        await sink.onStepStart(step);
        if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
        if (interrupted || params.signal.aborted) break;
        if (s.reasoning) sink.onReasoningDelta(s.reasoning);
        for (const chunk of (s.text ?? "").match(/.{1,4}/gs) ?? []) sink.onTextDelta(chunk);
        const toolCalls = (s.toolCalls ?? []).map((tc) => ({ id: `call_${++callSeq}`, ...tc }));
        const msg: AssistantStepResult = {
          text: s.text ?? "",
          reasoning: s.reasoning,
          toolCalls,
          usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5, totalTokens: 15, ...(s.usage ?? {}) },
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
        await Promise.all(
          toolCalls.map(async (tc) => {
            const d = await sink.beforeToolCall(tc, msg);
            if (!d.allow) {
              if (d.interrupt) terminate = true;
              await sink.onToolResult({ toolCallId: tc.id, name: tc.name, content: [{ type: "text", text: d.reason }], isError: true });
              return;
            }
            await sink.onToolExecutionStart(tc.id);
            const tool = params.tools.find((t) => t.name === tc.name)!;
            try {
              const r = await tool.execute(tc.args, { ...params.toolContext, toolCallId: tc.id, signal: params.signal });
              await sink.onToolResult({ toolCallId: tc.id, name: tc.name, content: r.content, isError: !!r.isError, details: r.details });
            } catch (err) {
              await sink.onToolResult({ toolCallId: tc.id, name: tc.name, content: [{ type: "text", text: String(err) }], isError: true });
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
