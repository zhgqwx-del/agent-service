import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ApiError, ProviderConfig, type ModelSpec, type Principal, type ProviderConfigInput } from "@agent-service/protocol";
import { SubjectDeletingError, type SessionStore } from "@agent-service/store";
import { assertPublicHost, type ProviderResolver, type ResolvedModel } from "@agent-service/core";
import type { SecretCipher } from "./secrets.js";
import { PROVIDER_PRESETS } from "./presets.js";

export interface PlatformProvider {
  /** preset id or a full config */
  config: Omit<ProviderConfigInput, "apiKey">;
  apiKey?: string;
}

export interface ProviderServiceOptions {
  store: SessionStore;
  cipher: SecretCipher;
  /** platform-level providers usable by every tenant (keys from the runner's own env / KMS) */
  platform?: PlatformProvider[];
  /** outbound fetch wrapper (proxy, audit, timeouts); defaults to global fetch */
  fetch?: typeof fetch;
  /**
   * Validates a tenant-supplied baseUrl. Defaults to "must be http(s) and resolve to a public
   * address"; injectable so tests do not depend on DNS.
   */
  assertBaseUrl?: (baseUrl: string) => Promise<void>;
  models?: MutableModels;
}

const PLATFORM_TENANT = "__platform__";

/** Keep the scope kind and tuple separators structural even when external ids contain them. */
function tenantProviderRegistrationId(tenantId: string, providerId: string): string {
  // Preserve the historical provider identity for every unambiguous tuple because it is persisted
  // in turns/events/usage. Only previously-colliding inputs move to the tagged representation.
  if (tenantId !== "platform" && !tenantId.includes(":") && !providerId.includes(":")) {
    return `${tenantId}:${providerId}`;
  }
  return `tenant:${encodeURIComponent(tenantId)}:${encodeURIComponent(providerId)}`;
}

function platformProviderRegistrationId(providerId: string): string {
  return `platform:${providerId}`;
}

function providerSecretRef(tenantId: string, providerId: string): string {
  return `secret:${tenantProviderRegistrationId(tenantId, providerId)}`;
}

/**
 * Turns a (principal, provider, model) reference into an engine-ready model:
 *  - tenant BYOK configs take precedence over platform presets with the same id;
 *  - API keys are decrypted per request and never cached in the pi provider (pi's provider auth resolves
 *    only the per-call credential we hand it);
 *  - each (tenant, provider) pair is a distinct pi provider registration so base URLs and compat never leak
 *    across tenants.
 */
/**
 * A tenant-supplied baseUrl is an outbound target chosen by an API caller, so it is an SSRF vector:
 * without this check a tenant could point a provider at the cloud metadata service or at another
 * internal service and read the response back through the turn's error text.
 */
export async function assertPublicBaseUrl(baseUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new ApiError("invalid_request", "baseUrl is not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ApiError("invalid_request", "baseUrl must be http(s)");
  try {
    await assertPublicHost(u.hostname);
  } catch (err) {
    throw new ApiError("invalid_request", `baseUrl host is not reachable from this service: ${(err as Error).message}`);
  }
}

/** Header values are credentials as often as not; echo only their names. */
export function redactProviderConfig(c: ProviderConfig): ProviderConfig {
  const headers = Object.fromEntries(Object.keys(c.headers).map((k) => [k, "***"]));
  return { ...c, headers };
}

export class ProviderService implements ProviderResolver {
  readonly models: MutableModels;
  private readonly platform = new Map<string, PlatformProvider>();
  private readonly registered = new Map<string, number>(); // pi provider id -> config updatedAtMs

  private readonly assertBaseUrl: (baseUrl: string) => Promise<void>;

  constructor(private readonly opts: ProviderServiceOptions) {
    this.assertBaseUrl = opts.assertBaseUrl ?? assertPublicBaseUrl;
    this.models = opts.models ?? createModels();
    for (const p of opts.platform ?? []) this.platform.set(p.config.id, p);
  }

  static preset(id: string, apiKey?: string): PlatformProvider {
    const cfg = PROVIDER_PRESETS[id];
    if (!cfg) throw new Error(`unknown provider preset ${id}`);
    return { config: cfg, apiKey };
  }

  // ---------- tenant BYOK CRUD ----------

  async upsertTenantProvider(tenantId: string, input: ProviderConfigInput): Promise<ProviderConfig> {
    const generation = await this.requireActiveTenant(tenantId);
    await this.assertBaseUrl(input.baseUrl);
    await this.assertTenantGeneration(tenantId, generation);
    const existing = await this.opts.store.getProviderConfig(tenantId, input.id);
    const now = Date.now();
    const { apiKey, ...rest } = input;
    const hasSecret = Boolean(apiKey || existing?.secret || existing?.config.apiKeyRef);
    const config = ProviderConfig.parse({
      ...rest,
      tenantId,
      apiKeyRef: hasSecret ? providerSecretRef(tenantId, input.id) : undefined,
      createdAtMs: existing?.config.createdAtMs ?? now,
      updatedAtMs: now,
    });
    const secret = apiKey ? { ciphertext: await this.opts.cipher.encrypt(apiKey), keyId: this.opts.cipher.keyId } : undefined;
    await this.opts.store.upsertProviderConfig(config, secret);
    return config;
  }

  async listVisible(tenantId: string): Promise<ProviderConfig[]> {
    const generation = await this.requireActiveTenant(tenantId);
    const own = await this.opts.store.listProviderConfigs(tenantId);
    await this.assertTenantGeneration(tenantId, generation);
    const ownIds = new Set(own.map((c) => c.id));
    const platform = [...this.platform.values()].filter((p) => !ownIds.has(p.config.id)).map((p) => this.platformConfig(p));
    return [...own, ...platform];
  }

  private platformConfig(p: PlatformProvider): ProviderConfig {
    return ProviderConfig.parse({ ...p.config, tenantId: PLATFORM_TENANT, apiKeyRef: p.apiKey ? "platform" : undefined, createdAtMs: 0, updatedAtMs: 0 });
  }

  // ---------- resolution ----------

  async resolve(principal: Principal, ref: { provider: string; model: string; reasoning?: "off" | "low" | "medium" | "high" }): Promise<ResolvedModel> {
    const generation = await this.requireActiveTenant(principal.tenantId);
    const tenantCfg = await this.opts.store.getProviderConfig(principal.tenantId, ref.provider);
    await this.assertTenantGeneration(principal.tenantId, generation);
    let config: ProviderConfig;
    let apiKey: () => Promise<string | undefined>;
    let piProviderId: string;
    if (tenantCfg) {
      config = tenantCfg.config;
      piProviderId = tenantProviderRegistrationId(principal.tenantId, config.id);
      const secret = tenantCfg.secret;
      apiKey = async () => {
        await this.assertTenantGeneration(principal.tenantId, generation);
        if (!secret) return undefined;
        const decrypted = await this.opts.cipher.decrypt(secret.ciphertext, secret.keyId);
        await this.assertTenantGeneration(principal.tenantId, generation);
        return decrypted;
      };
    } else {
      const p = this.platform.get(ref.provider);
      if (!p) throw new ApiError("not_found", `provider ${ref.provider} not configured`);
      config = this.platformConfig(p);
      piProviderId = platformProviderRegistrationId(config.id);
      apiKey = async () => {
        await this.assertTenantGeneration(principal.tenantId, generation);
        return p.apiKey;
      };
    }
    const spec = config.models.find((m) => m.id === ref.model);
    if (!spec) throw new ApiError("invalid_request", `model ${ref.model} not offered by provider ${ref.provider}`, { available: config.models.map((m) => m.id) });

    if (tenantCfg) await this.assertBaseUrl(config.baseUrl);
    await this.assertTenantGeneration(principal.tenantId, generation);
    this.ensureRegistered(piProviderId, config);
    const handle = this.models.getModel(piProviderId, spec.id);
    if (!handle) throw new ApiError("internal_error", `model ${spec.id} not registered`);
    return {
      handle,
      provider: piProviderId,
      model: spec.id,
      contextWindow: spec.contextWindow,
      input: spec.input,
      priceKnown: spec.price !== undefined,
      apiKey,
      headers: Object.keys(config.headers).length ? config.headers : undefined,
      fetch: this.generationGuardedFetch(principal.tenantId, generation),
      reasoning: ref.reasoning ?? (spec.reasoning ? undefined : "off"),
    };
  }

  private async requireActiveTenant(tenantId: string): Promise<number> {
    const state = await this.opts.store.getTenantRuntimeState(tenantId);
    if (state.state !== "active") throw new SubjectDeletingError(tenantId);
    return state.generation;
  }

  private async assertTenantGeneration(tenantId: string, generation: number): Promise<void> {
    const state = await this.opts.store.getTenantRuntimeState(tenantId);
    if (state.state !== "active" || state.generation !== generation) {
      throw new SubjectDeletingError(tenantId);
    }
  }

  private generationGuardedFetch(tenantId: string, generation: number): typeof fetch {
    const delegate = this.opts.fetch ?? globalThis.fetch;
    return (async (...args: Parameters<typeof fetch>) => {
      await this.assertTenantGeneration(tenantId, generation);
      return delegate(...args);
    }) as typeof fetch;
  }

  private ensureRegistered(piProviderId: string, config: ProviderConfig) {
    if (this.registered.get(piProviderId) === config.updatedAtMs) return;
    this.models.setProvider(
      createProvider({
        id: piProviderId,
        name: config.name ?? config.id,
        baseUrl: config.baseUrl,
        auth: {
          apiKey: {
            name: `${config.id} API key`,
            // Only the per-call credential is honoured. Never env, never a stored credential file.
            resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "request" } : undefined),
          },
        },
        models: config.models.map((m) => toPiModel(piProviderId, config, m)),
        api: openAICompletionsApi(),
      }),
    );
    this.registered.set(piProviderId, config.updatedAtMs);
  }
}

export function toPiModel(providerId: string, config: ProviderConfig, m: ModelSpec): Model<"openai-completions"> {
  const compat = { ...(config.compat ?? {}), ...(m.compat ?? {}) };
  const { supportsJsonSchema: _ignored, ...piCompat } = compat;
  return {
    id: m.id,
    name: m.name ?? m.id,
    api: "openai-completions",
    provider: providerId,
    baseUrl: config.baseUrl,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.price
      ? { input: m.price.input, output: m.price.output, cacheRead: m.price.cacheRead, cacheWrite: m.price.cacheWrite }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutputTokens,
    compat: Object.keys(piCompat).length ? piCompat : undefined,
  };
}
