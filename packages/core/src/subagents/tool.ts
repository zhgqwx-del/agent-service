import type { RunnerTool } from "../tools/types.js";

/** Discovery and execution share one closed schema. A descriptor never confers task authority. */
export function createSubagentTaskDescriptor(): Omit<RunnerTool, "execute"> {
  return {
    name: "task", kind: "builtin", description: "Run a permitted pinned subagent with an explicit task prompt.",
    readOnly: false, needsApproval: true, concurrencySafe: true,
    parameters: {
      type: "object", additionalProperties: false, required: ["target", "prompt"], properties: {
        target: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
        prompt: { type: "string", minLength: 1, maxLength: 32768 },
        description: { type: "string", maxLength: 256 },
        limits: { type: "object", additionalProperties: false, properties: {
          maxSteps: { type: "integer", minimum: 1 }, maxToolCalls: { type: "integer", minimum: 1 },
          maxWallClockMs: { type: "integer", minimum: 1 }, maxCostCNY: { type: "number", exclusiveMinimum: 0 },
          maxOutputTokensPerStep: { type: "integer", minimum: 1 },
        } },
      },
    },
  };
}
