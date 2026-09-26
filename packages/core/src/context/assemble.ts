import { createHash } from "node:crypto";
import type { AgentDefinition } from "@agent-service/protocol";
import type { RunnerTool } from "../tools/types.js";

/** Deterministic JSON: sorted keys at every level, so equal inputs give byte-identical prefixes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * The immutable prefix: instructions + skill catalog. Tools are declared separately (engine puts
 * them in the leading system message) but are part of the epoch. Any change here must bump
 * `contextEpoch`; mid-session changes are announced in the transcript tail, not by editing this.
 */
export function buildSystemPrompt(agent: AgentDefinition, skills: SkillSummary[] = []): string {
  const parts = [agent.instructions.trim()];
  if (skills.length) {
    parts.push(
      [
        "<available_skills>",
        ...skills.map((s) => `- ${s.name}: ${s.description}`),
        "</available_skills>",
        "Use the `skill` tool to load a skill's full instructions when a task matches its description.",
      ].join("\n"),
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Sorted, schema-only view of the tool set so ordering/execute functions never affect the epoch. */
export function toolSetFingerprint(tools: RunnerTool[]): string {
  const view = [...tools]
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, kind: t.kind }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256(stableStringify(view));
}

export function computeContextEpoch(input: {
  agentId: string;
  agentVersion: number;
  systemPrompt: string;
  tools: RunnerTool[];
  skills?: SkillSummary[];
}): string {
  return sha256(
    stableStringify({
      agent: `${input.agentId}@${input.agentVersion}`,
      prompt: sha256(input.systemPrompt),
      tools: toolSetFingerprint(input.tools),
      skills: (input.skills ?? []).map((s) => s.name).sort(),
    }),
  ).slice(0, 32);
}

/** Rough token estimate: CJK ~1 token/char, other text ~4 chars/token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[぀-ヿ㐀-鿿豈-﫿]/.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}
