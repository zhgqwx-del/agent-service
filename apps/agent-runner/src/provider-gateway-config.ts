import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { externalId, ProviderFallbackRule } from "@agent-service/protocol";
import { providerQuotaNamespaceSha256, type ProviderPoolInventory, type ProviderPoolPolicy, type ProviderQuotaLimit } from "@agent-service/store";
import type { ProviderKeyPoolsInventory } from "./provider-key-pool.js";

export interface PlatformProviderFallback {
  readonly provider: string;
  readonly rules: readonly Readonly<{ model: string; targets: readonly Readonly<{ provider: string; model: string }>[] }>[];
}

export interface ProviderGatewayConfig {
  readonly enabled: boolean;
  readonly tenant: ProviderQuotaLimit;
  readonly user: ProviderQuotaLimit;
  readonly platformProvider: ProviderQuotaLimit;
  readonly policySha256: string | null;
  /** Extended policy is finalized at startup; pool mode additionally requires protected inventory. */
  readonly quotaPolicySha256?: string;
  readonly keyPoolFile?: string;
  readonly breakerPolicy?: Readonly<Required<ProviderPoolPolicy>>;
  readonly byokBreakerPolicy?: Readonly<Required<ProviderPoolPolicy>>;
  readonly platformFallbacks?: readonly PlatformProviderFallback[];
}

export class ProviderGatewayConfigError extends Error {
  readonly code = "provider_gateway_config_invalid";
  constructor() { super("Provider gateway configuration is invalid."); this.name = "ProviderGatewayConfigError"; }
}

const POLICY_KEYS = ["PROVIDER_TENANT_QUOTA_JSON", "PROVIDER_USER_QUOTA_JSON", "PLATFORM_PROVIDER_QUOTA_JSON"] as const;
function invalid(): never { throw new ProviderGatewayConfigError(); }
function input(env: Readonly<NodeJS.ProcessEnv>, name: string): { present: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  if (!descriptor) { if (name in env) invalid(); return { present: false }; }
  if (!("value" in descriptor) || !descriptor.enumerable) invalid();
  return { present: true, value: descriptor.value };
}

function numericObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw, "utf8") > 2048) invalid();
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  // JSON.parse alone accepts duplicate keys. Decode each key token, including escaped spellings,
  // before accepting this flat numeric object. Malformed JSON was already rejected above.
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== '"') continue;
    const start = index;
    for (index++; index < raw.length; index++) {
      if (raw[index] === "\\") index++;
      else if (raw[index] === '"') break;
    }
    let next = index + 1;
    while (next < raw.length && /[\x20\t\r\n]/.test(raw[next]!)) next++;
    if (raw[next] !== ":") continue;
    const key: unknown = JSON.parse(raw.slice(start, index + 1));
    if (typeof key !== "string" || seen.has(key)) invalid();
    seen.add(key);
  }
  return parsed as Record<string, unknown>;
}
function quota(raw: unknown): ProviderQuotaLimit {
  const values: { rpm?: number; concurrency?: number } = {};
  const parsed = numericObject(raw);
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "rpm" && key !== "concurrency" || typeof value !== "number"
      || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) invalid();
    values[key] = value;
  }
  // Canonical insertion order is independent of the JSON member order and numeric spelling.
  return Object.freeze({ ...(values.rpm === undefined ? {} : { rpm: values.rpm }),
    ...(values.concurrency === undefined ? {} : { concurrency: values.concurrency }) });
}

function breaker(raw?: unknown): Readonly<Required<ProviderPoolPolicy>> {
  const parsed = raw === undefined ? {} : numericObject(raw);
  if (Object.keys(parsed).some(key => !["threshold", "windowMs", "cooldownMs", "rateLimitCooldownMs"].includes(key))) invalid();
  const value = (key: keyof ProviderPoolPolicy, fallback: number, minimum: number, maximum: number) => {
    const next = Object.hasOwn(parsed, key) ? parsed[key] : fallback;
    if (typeof next !== "number" || !Number.isSafeInteger(next) || next < minimum || next > maximum) invalid();
    return next;
  };
  return Object.freeze({ threshold: value("threshold", 5, 1, 100), windowMs: value("windowMs", 60_000, 100, 3_600_000),
    cooldownMs: value("cooldownMs", 30_000, 100, 3_600_000), rateLimitCooldownMs: value("rateLimitCooldownMs", 30_000, 100, 3_600_000) });
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || Object.getOwnPropertyNames(value).some(key => !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(entry => !Object.hasOwn(entry, "value") || !entry.enumerable)) invalid();
  return value as Record<string, unknown>;
}
function fallbackMapping(raw: unknown): readonly PlatformProviderFallback[] {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 4 * 1024 * 1024) invalid();
  const value: unknown = JSON.parse(raw);
  // Reject decoded duplicate JSON member names in every object, including escaped aliases.
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === "{") stack.push(new Set()); else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = index;
      for (index++; index < raw.length; index++) { if (raw[index] === "\\") index++; else if (raw[index] === '"') break; }
      let next = index + 1; while (/[\x20\t\r\n]/.test(raw[next] ?? "x")) next++;
      if (raw[next] === ":") { const key: string = JSON.parse(raw.slice(start, index + 1)), keys = stack[stack.length - 1];
        if (!keys || keys.has(key)) invalid(); keys.add(key); }
    }
    if (stack.length > 8) invalid();
  }
  if (!Array.isArray(value) || value.length > 32) invalid();
  const providers = new Set<string>();
  const result = value.map(entry => {
    const input = closed(entry, ["provider", "rules"]), provider = externalId.parse(input.provider);
    if (providers.has(provider)) invalid(); providers.add(provider);
    const parsed = ProviderFallbackRule.array().max(32).parse(input.rules), sources = new Set<string>();
    const rules = parsed.map(rule => {
      if (sources.has(rule.model) || rule.targets.some(target => target.provider === provider && target.model === rule.model)) invalid();
      sources.add(rule.model); return Object.freeze({ model: rule.model,
        targets: Object.freeze(rule.targets.map(target => Object.freeze({ provider: target.provider, model: target.model }))) });
    }).sort((a, b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
    return Object.freeze({ provider, rules: Object.freeze(rules) });
  }).sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0);
  return Object.freeze(result);
}

/** Actual configured platform models only. A preset's existence alone is not a credential grant. */
export function validatePlatformProviderFallbacks(config: ProviderGatewayConfig,
  platform: readonly Readonly<{ id: string; models: readonly Readonly<{ id: string }>[] }>[]): void {
  try {
    if (config.platformFallbacks === undefined) return;
    if (!config.enabled) invalid();
    const actual = new Map(platform.map(provider => [provider.id, new Set(provider.models.map(model => model.id))]));
    if (actual.size !== platform.length) invalid();
    for (const entry of config.platformFallbacks) for (const rule of entry.rules) {
      if (!actual.get(entry.provider)?.has(rule.model)) invalid();
      for (const target of rule.targets) if (!actual.get(target.provider)?.has(target.model)
        || target.provider === entry.provider && target.model === rule.model) invalid();
    }
    for (const entry of config.platformFallbacks) if (!actual.has(entry.provider)) invalid();
  } catch { throw new ProviderGatewayConfigError(); }
}
function publicInventory(value: unknown): ProviderPoolInventory {
  const parsed = closed(value, ["version", "providerId", "slots"]), provider = externalId.safeParse(parsed.providerId);
  if (parsed.version !== "provider-key-pool-v1" || !provider.success || !Array.isArray(parsed.slots)
    || parsed.slots.length < 1 || parsed.slots.length > 32) invalid();
  const slotDescriptors = Object.getOwnPropertyDescriptors(parsed.slots);
  if (Reflect.ownKeys(parsed.slots).length !== parsed.slots.length + 1) invalid();
  const ids = new Set<string>();
  const identity = (value: unknown): string => {
    if (typeof value !== "string" || value.length < 1 || value.length > 64
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || /[^A-Za-z0-9._-]/.test(value)) invalid();
    return value;
  };
  const slots: { id: string; version: string }[] = [];
  for (let index = 0; index < parsed.slots.length; index++) {
    const entry = slotDescriptors[String(index)];
    if (!entry || !Object.hasOwn(entry, "value") || !entry.enumerable) invalid();
    const slot = closed(entry.value, ["id", "version"]), id = identity(slot.id), version = identity(slot.version);
    if (ids.has(id)) invalid(); ids.add(id); slots.push({ id, version });
  }
  return { version: "provider-key-pool-v1", providerId: provider.data, slots };
}

/** Only non-secret, closed inventory may finalize the pool policy. File paths and credentials never enter it. */
export function deriveProviderGatewayPolicySha256(config: ProviderGatewayConfig, inventory?: ProviderPoolInventory | ProviderKeyPoolsInventory): string | null {
  try {
    const version = inventory === undefined ? undefined : Object.getOwnPropertyDescriptor(inventory, "version");
    if (inventory !== undefined && (!version || !Object.hasOwn(version, "value") || !version.enumerable)) invalid();
    if (config.platformFallbacks !== undefined || version?.value === "provider-key-pools-v2") {
      const quotaDigest = config.quotaPolicySha256 ?? config.policySha256;
      if (!config.enabled || !quotaDigest || !/^[a-f0-9]{64}$/.test(quotaDigest) || quotaDigest.length !== 64) invalid();
      let pools: ProviderPoolInventory | ProviderKeyPoolsInventory | null = null;
      if (config.keyPoolFile) {
        if (!inventory || !config.breakerPolicy) invalid();
        if (inventory.version === "provider-key-pools-v2") {
          const input = closed(inventory, ["version", "providers"]);
          if (!Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > 16
            || Reflect.ownKeys(input.providers).length !== input.providers.length + 1) invalid();
          const descriptors = Object.getOwnPropertyDescriptors(input.providers), ids = new Set<string>();
          const providers = Array.from({ length: input.providers.length }, (_, index) => {
            const descriptor = descriptors[String(index)]; if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
            const provider = publicInventory(descriptor.value); if (ids.has(provider.providerId)) invalid(); ids.add(provider.providerId); return provider;
          }).sort((a, b) => a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0);
          pools = { version: "provider-key-pools-v2", providers };
        } else pools = publicInventory(inventory);
      } else if (inventory !== undefined || config.breakerPolicy !== undefined) invalid();
      const mappings = config.platformFallbacks === undefined ? [] : fallbackMapping(JSON.stringify(config.platformFallbacks));
      return createHash("sha256").update("provider-gateway-policy-v4\0").update(JSON.stringify({
        algorithm: "provider-gateway-explicit-fallback-v1", quotaPolicySha256: quotaDigest,
        platformPool: pools === null ? null : { inventory: pools, policy: breaker(JSON.stringify(config.breakerPolicy)) },
        byokBreakerPolicy: config.byokBreakerPolicy ? breaker(JSON.stringify(config.byokBreakerPolicy)) : null,
        platformFallbacks: mappings,
      })).digest("hex");
    }
    if (config.byokBreakerPolicy) {
      if (!config.enabled || config.policySha256 !== null || !config.quotaPolicySha256
        || !/^[a-f0-9]{64}$/.test(config.quotaPolicySha256) || config.quotaPolicySha256.length !== 64) invalid();
      if (config.keyPoolFile ? inventory === undefined || !config.breakerPolicy : inventory !== undefined || config.breakerPolicy !== undefined) invalid();
      return createHash("sha256").update("provider-gateway-policy-v3\0").update(JSON.stringify({
        algorithm: "provider-gateway-byok-breaker-v1", quotaPolicySha256: config.quotaPolicySha256,
        platformPool: config.keyPoolFile ? { inventory: publicInventory(inventory!), policy: breaker(JSON.stringify(config.breakerPolicy)) } : null,
        byokBreakerPolicy: breaker(JSON.stringify(config.byokBreakerPolicy)),
      })).digest("hex");
    }
    if (!config.keyPoolFile) {
      if (inventory !== undefined) invalid();
      return config.policySha256;
    }
    if (!config.enabled || !config.breakerPolicy || config.policySha256 !== null || !config.quotaPolicySha256
      || !/^[a-f0-9]{64}$/.test(config.quotaPolicySha256) || config.quotaPolicySha256.length !== 64 || inventory === undefined) invalid();
    return createHash("sha256").update("provider-gateway-policy-v2\0").update(JSON.stringify({
      algorithm: "provider-gateway-pool-v1", quotaPolicySha256: config.quotaPolicySha256,
      inventory: publicInventory(inventory), breaker: breaker(JSON.stringify(config.breakerPolicy)),
    })).digest("hex");
  } catch { throw new ProviderGatewayConfigError(); }
}

/** Operator policy parsing only: no files, credentials, DNS, sockets or per-process fallback. */
export function loadProviderGatewayConfig(env: Readonly<NodeJS.ProcessEnv>): ProviderGatewayConfig {
  try {
    if (env === null || typeof env !== "object" || Array.isArray(env)) invalid();
    const flag = input(env, "PROVIDER_GATEWAY_ENABLED");
    const enabled = flag.present ? flag.value : "0";
    if (enabled !== "0" && enabled !== "1") invalid();
    const policies = POLICY_KEYS.map(key => input(env, key));
    const fallbackInput = input(env, "PLATFORM_PROVIDER_FALLBACK_JSON");
    const pool = input(env, "PLATFORM_PROVIDER_KEY_POOL_FILE"), breakerInput = input(env, "PLATFORM_PROVIDER_BREAKER_JSON"),
      byokBreakerInput = input(env, "PROVIDER_BYOK_BREAKER_JSON");
    for (const key of new Set([...Object.getOwnPropertyNames(env), ...Object.keys(env)])) {
      if (key.startsWith("PLATFORM_PROVIDER_KEY_POOL_") && key !== "PLATFORM_PROVIDER_KEY_POOL_FILE"
        || key.startsWith("PLATFORM_PROVIDER_BREAKER_") && key !== "PLATFORM_PROVIDER_BREAKER_JSON"
        || key.startsWith("PROVIDER_BYOK_BREAKER_") && key !== "PROVIDER_BYOK_BREAKER_JSON"
        || key.startsWith("PLATFORM_PROVIDER_FALLBACK_") && key !== "PLATFORM_PROVIDER_FALLBACK_JSON") invalid();
    }
    if (enabled === "0" && (policies.some(policy => policy.present) || pool.present || breakerInput.present || byokBreakerInput.present || fallbackInput.present)) invalid();
    if (breakerInput.present && (!pool.present || typeof breakerInput.value !== "string")) invalid();
    if (byokBreakerInput.present && typeof byokBreakerInput.value !== "string") invalid();
    const platformFallbacks = fallbackInput.present ? fallbackMapping(fallbackInput.value) : undefined;
    let keyPoolFile: string | undefined;
    if (pool.present) {
      if (input(env, "API_KEY").present || typeof pool.value !== "string" || !isAbsolute(pool.value)
        || pool.value.length > 4096 || pool.value.includes("\0")) invalid();
      keyPoolFile = pool.value;
    }
    const [tenant, user, platformProvider] = policies.map(policy => policy.present ? quota(policy.value) : Object.freeze({}));
    if (!tenant || !user || !platformProvider) invalid();
    if (enabled === "0") return Object.freeze({ enabled: false, tenant, user, platformProvider, policySha256: null });

    const rawUrl = input(env, "REDIS_URL").value;
    if (typeof rawUrl !== "string" || !rawUrl || /[\u0000-\u0020\u007f]/.test(rawUrl)) invalid();
    const url = new URL(rawUrl);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:" || !url.hostname || url.hash
      || url.port && (!/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535)) invalid();
    const prefixInput = input(env, "REDIS_PREFIX"), prefix = prefixInput.present ? prefixInput.value : "as";
    const namespaceId = input(env, "REDIS_NAMESPACE_ID").value;
    if (typeof prefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(prefix)
      || typeof namespaceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(namespaceId)) invalid();
    const redisNamespaceSha256 = providerQuotaNamespaceSha256({ prefix, namespaceId });
    const policySha256 = createHash("sha256").update("provider-gateway-policy-v1\0")
      .update(JSON.stringify({ algorithm: "provider-quota-v1", redisNamespaceSha256, tenant, user, platformProvider })).digest("hex");
    return Object.freeze({ enabled: true, tenant, user, platformProvider, policySha256: keyPoolFile || byokBreakerInput.present || fallbackInput.present ? null : policySha256,
      ...(keyPoolFile || byokBreakerInput.present || fallbackInput.present ? { quotaPolicySha256: policySha256 } : {}),
      ...(keyPoolFile ? { keyPoolFile, breakerPolicy: breaker(breakerInput.present ? breakerInput.value : undefined) } : {}),
      ...(byokBreakerInput.present ? { byokBreakerPolicy: breaker(byokBreakerInput.value) } : {}),
      ...(platformFallbacks === undefined ? {} : { platformFallbacks }) });
  } catch {
    // Never retain JSON/URL text, an accessor failure, native diagnostics, secrets or a cause.
    throw new ProviderGatewayConfigError();
  }
}
