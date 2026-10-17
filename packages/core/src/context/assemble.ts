import { createHash } from "node:crypto";
import type { AgentDefinition, ResolvedSkillContext } from "@agent-service/protocol";
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
  id?: string;
  whenToUse?: string | null;
  contentSha256?: string;
  versionSha256?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  dependencies?: { readonly tools: readonly string[] };
}

/** Only a server-resolved snapshot is rendered; replay never dereferences a current skill file. */
export function renderSkillContext(context: ResolvedSkillContext, args?: string): string {
  return `[Static skill ${JSON.stringify(context.name)}; version ${context.versionSha256}; content ${context.contentSha256}]\n`
    + context.body + (args === undefined ? "" : `\n[User-provided skill arguments: ${JSON.stringify(args)}]`);
}

/**
 * The immutable prefix: instructions + skill catalog. Tools are declared separately (engine puts
 * them in the leading system message) but are part of the epoch. Any change here must bump
 * `contextEpoch`; mid-session changes are announced in the transcript tail, not by editing this.
 */
export function buildSystemPrompt(agent: AgentDefinition, skills: readonly SkillSummary[] = [], skillToolAvailable = true): string {
  const parts = [agent.instructions.trim()];
  const visible = skills.filter(skill => skill.disableModelInvocation !== true);
  if (visible.length) {
    parts.push(
      [
        "<available_skills>",
        ...visible.map((s) => `- ${s.name}: ${s.description}${s.whenToUse ? ` (when: ${s.whenToUse})` : ""}`),
        "</available_skills>",
        ...(skillToolAvailable ? ["Use the `skill` tool to load a skill's full instructions when a task matches its description."] : []),
      ].join("\n"),
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Sorted, schema-only view of the tool set so ordering/execute functions never affect the epoch. */
export function toolSetFingerprint(tools: RunnerTool[]): string {
  const view = [...tools]
    .map((t) => ({
      name: t.name, description: t.description, parameters: t.parameters, kind: t.kind,
      ...(t.approvalScope === undefined ? {} : { approvalScope: t.approvalScope }),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256(stableStringify(view));
}

export function computeContextEpoch(input: {
  agentId: string;
  agentVersion: number;
  systemPrompt: string;
  tools: RunnerTool[];
  skills?: readonly SkillSummary[];
}): string {
  return sha256(
    stableStringify({
      agent: `${input.agentId}@${input.agentVersion}`,
      prompt: sha256(input.systemPrompt),
      tools: toolSetFingerprint(input.tools),
      // Keep the original list-only/builtin epoch encoding. Versioned static skills additionally
      // bind the actual file bytes and invocation/dependency metadata, not only their names.
      skills: (input.skills ?? []).map((s) => s.versionSha256 === undefined ? s.name : {
        id: s.id, name: s.name, description: s.description, whenToUse: s.whenToUse ?? null,
        contentSha256: s.contentSha256, versionSha256: s.versionSha256,
        disableModelInvocation: s.disableModelInvocation, userInvocable: s.userInvocable,
        dependencies: s.dependencies,
      }).sort((a, b) => {
        const left = stableStringify(a), right = stableStringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    }),
  ).slice(0, 32);
}

/** Rough token estimate: CJK ~1 token/char, other text ~4 chars/token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[぀-ヿ㐀-鿿豈-﫿]/.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}
