import { z } from "zod";
import { externalId } from "./common.js";

/** OpenAI-compatible dialect switches. Mirrors pi-ai's OpenAICompletionsCompat subset we support. */
export const ProviderCompat = z.object({
  thinkingFormat: z.enum(["openai", "deepseek", "qwen", "zai", "openrouter"]).optional(),
  supportsStore: z.boolean().optional(),
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
  supportsUsageInStreaming: z.boolean().optional(),
  maxTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  requiresToolResultName: z.boolean().optional(),
  requiresAssistantAfterToolResult: z.boolean().optional(),
  requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
  supportsJsonSchema: z.boolean().optional(),
});
export type ProviderCompat = z.infer<typeof ProviderCompat>;

/** Price per 1M tokens in CNY. */
export const ModelPrice = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().default(0),
  cacheWrite: z.number().nonnegative().default(0),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

export type ModelInputCapability = "text" | "image";

/**
 * This runtime always sends a textual system prompt and may replay textual history. Consequently a
 * configured model must accept text; image is an optional, non-duplicated additive capability.
 * Enumerating the three valid tuples keeps the same invariant visible in OpenAPI instead of relying
 * on a refinement that a schema generator would discard.
 */
export const ModelInputCapabilities = z.union([
  z.tuple([z.literal("text")]),
  z.tuple([z.literal("text"), z.literal("image")]),
  z.tuple([z.literal("image"), z.literal("text")]),
]) as z.ZodType<ModelInputCapability[]>;

export const ModelSpec = z.object({
  id: externalId,
  name: z.string().optional(),
  contextWindow: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().default(8192),
  input: ModelInputCapabilities.default(["text"]),
  reasoning: z.boolean().default(false),
  price: ModelPrice.optional(),
  compat: ProviderCompat.optional(),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

/**
 * Tenant-level provider configuration (BYOK). The API key is write-only: it is encrypted at rest and
 * never returned; `apiKeyRef` identifies the stored secret.
 */
export const ProviderConfig = z.object({
  id: externalId,
  tenantId: externalId,
  name: z.string().max(128).optional(),
  api: z.enum(["openai-completions"]).default("openai-completions"),
  baseUrl: z.string().url().describe(
    "Public HTTP(S) provider endpoint. The runner resolves and rejects loopback, private, link-local, and otherwise non-public hosts before storing it.",
  ),
  /** opaque reference to the encrypted secret; absent for keyless endpoints */
  apiKeyRef: z.string().optional(),
  headers: z.record(z.string()).default({}),
  models: z.array(ModelSpec).min(1),
  /** default compat applied to every model unless overridden per model */
  compat: ProviderCompat.optional(),
  quota: z.object({ rpm: z.number().int().positive().optional(), concurrency: z.number().int().positive().optional() }).default({}),
  /** provider ids to try in order when this one fails (turn-local; does not change the session's model) */
  fallback: z.array(externalId).default([]),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const ProviderConfigInput = ProviderConfig.omit({ tenantId: true, apiKeyRef: true, createdAtMs: true, updatedAtMs: true }).extend({
  /** plaintext key, accepted on create/update only */
  apiKey: z.string().min(1).max(4096).optional(),
});
export type ProviderConfigInput = z.infer<typeof ProviderConfigInput>;
