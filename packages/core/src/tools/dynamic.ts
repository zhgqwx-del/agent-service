import type { DynamicToolDeclaration } from "@agent-service/protocol";
import type { RunnerTool, ToolResult } from "./types.js";

/**
 * Client-executed tools (reverse delegation). The engine sees a normal tool; execution parks until the
 * client posts the result to `POST /sessions/{id}/turns/{turnId}/tool-results` or the timeout fires.
 */
export class DynamicToolBridge {
  /**
   * Keyed by `${sessionId}:${toolCallId}`. Tool call ids come from the model and repeat across
   * sessions (`call_1`, `call_2`, ...), so a bare id would let one session's result land in another.
   */
  private readonly pending = new Map<string, { resolve: (r: ToolResult) => void; timer: NodeJS.Timeout }>();

  private key(sessionId: string, toolCallId: string) {
    return `${sessionId}:${toolCallId}`;
  }

  asTool(decl: DynamicToolDeclaration, timeoutMs: number): RunnerTool {
    return {
      name: decl.name,
      description: decl.description,
      parameters: decl.parameters,
      kind: "dynamic",
      needsApproval: false,
      readOnly: false,
      execute: (_args, ctx) =>
        new Promise<ToolResult>((resolve) => {
          const key = this.key(ctx.sessionId, ctx.toolCallId);
          const timer = setTimeout(() => {
            this.pending.delete(key);
            resolve({ content: [{ type: "text", text: "dynamic tool timed out: the client did not return a result" }], isError: true });
          }, timeoutMs);
          const onAbort = () => {
            clearTimeout(timer);
            this.pending.delete(key);
            resolve({ content: [{ type: "text", text: "aborted" }], isError: true });
          };
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          this.pending.set(key, {
            timer,
            resolve: (r) => {
              ctx.signal.removeEventListener("abort", onAbort);
              resolve(r);
            },
          });
        }),
    };
  }

  resolve(sessionId: string, toolCallId: string, result: { content: { type: "text"; text: string }[]; isError: boolean }): boolean {
    const key = this.key(sessionId, toolCallId);
    const p = this.pending.get(key);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(key);
    p.resolve({ content: result.content, isError: result.isError });
    return true;
  }
}
