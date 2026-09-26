import type { ProviderConfigInput } from "@agent-service/protocol";

/**
 * Platform presets for domestic vendors (OpenAI-compatible chat/completions). Prices are CNY per 1M
 * tokens and MUST be re-verified against vendor pages before billing goes live; they are placeholders
 * that make cost accounting exercise the right code paths.
 */
export const PROVIDER_PRESETS: Record<string, Omit<ProviderConfigInput, "apiKey">> = {
  dashscope: {
    id: "dashscope",
    name: "阿里云百炼 (DashScope compatible mode)",
    api: "openai-completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    headers: {},
    compat: { thinkingFormat: "qwen", supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    models: [
      { id: "qwen3.8-max", contextWindow: 128_000, maxOutputTokens: 8192, input: ["text"], reasoning: true, price: { input: 2.4, output: 9.6, cacheRead: 0.48, cacheWrite: 0 } },
      { id: "qwen-plus", contextWindow: 128_000, maxOutputTokens: 8192, input: ["text"], reasoning: true, price: { input: 0.8, output: 2, cacheRead: 0.16, cacheWrite: 0 } },
      { id: "qwen-turbo", contextWindow: 128_000, maxOutputTokens: 8192, input: ["text"], reasoning: false, price: { input: 0.3, output: 0.6, cacheRead: 0.06, cacheWrite: 0 } },
    ],
    quota: {},
    fallback: [],
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    headers: {},
    compat: { thinkingFormat: "deepseek", supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true },
    models: [
      { id: "deepseek-chat", contextWindow: 128_000, maxOutputTokens: 8192, input: ["text"], reasoning: false, price: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 } },
      { id: "deepseek-reasoner", contextWindow: 128_000, maxOutputTokens: 32_768, input: ["text"], reasoning: true, price: { input: 4, output: 16, cacheRead: 1, cacheWrite: 0 } },
    ],
    quota: {},
    fallback: [],
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    api: "openai-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    headers: {},
    compat: { thinkingFormat: "openai", supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    models: [
      { id: "kimi-k2-0905-preview", contextWindow: 256_000, maxOutputTokens: 16_384, input: ["text"], reasoning: false, price: { input: 4, output: 16, cacheRead: 1, cacheWrite: 0 } },
    ],
    quota: {},
    fallback: [],
  },
  zhipu: {
    id: "zhipu",
    name: "智谱 (Z.ai)",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    headers: {},
    compat: { thinkingFormat: "zai", supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    models: [{ id: "glm-4.6", contextWindow: 200_000, maxOutputTokens: 16_384, input: ["text"], reasoning: true, price: { input: 2, output: 8, cacheRead: 0.4, cacheWrite: 0 } }],
    quota: {},
    fallback: [],
  },
};
