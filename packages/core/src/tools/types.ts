import type { McpToolProgress, Principal, ToolContentPart, ToolKind } from "@agent-service/protocol";

export interface ToolExecutionContext {
  principal: Principal;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  signal: AbortSignal;
  /** stream partial progress to the client (not persisted) */
  onProgress?: (text: string) => void;
  /** Owner/call-bound MCP observation, separate from tool-result text and never persisted. */
  onMcpProgress?: (progress: McpToolProgress) => void;
}

export interface ToolResult {
  content: ToolContentPart[];
  details?: unknown;
  isError?: boolean;
}

/**
 * Engine-neutral tool definition. Parameters are plain JSON Schema (draft 2020-12 subset);
 * engines wrap them as needed.
 */
export interface RunnerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  kind: ToolKind;
  /** true = ask under `on-request` policy; read-only tools stay auto-allowed under `untrusted` when `readOnly` */
  needsApproval?: boolean;
  /** Untrusted remote tools cannot opt out through the agent's `never` policy. */
  mandatoryApproval?: boolean;
  /** Server-owned grant identity; binds a remote catalog/configuration and the exact owner. */
  approvalScope?: string;
  readOnly?: boolean;
  /** may run concurrently with other tool calls in the same batch (default true for readOnly tools) */
  concurrencySafe?: boolean;
  execute: (args: unknown, ctx: ToolExecutionContext) => Promise<ToolResult>;
}

export interface ToolRegistry {
  /** tools visible to a given session; resolved per request, never cached process-wide across principals */
  resolve(names: string[]): RunnerTool[];
  list(): RunnerTool[];
}

export class StaticToolRegistry implements ToolRegistry {
  private readonly byName = new Map<string, RunnerTool>();
  constructor(tools: RunnerTool[] = []) {
    for (const t of tools) this.register(t);
  }
  register(tool: RunnerTool) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) throw new Error(`invalid tool name: ${tool.name}`);
    this.byName.set(tool.name, tool);
  }
  resolve(names: string[]) {
    return names.map((n) => this.byName.get(n)).filter((t): t is RunnerTool => !!t);
  }
  list() {
    return [...this.byName.values()];
  }
}
