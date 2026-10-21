import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ReadableStreamReadResult } from "node:stream/web";
import { createHash } from "node:crypto";
import {
  ApiError,
  ProviderConfig,
  TRACEPARENT_HEADER,
  createEphemeralStructuredTelemetry,
  outgoingTraceparent,
  telemetryErrorKind,
  type ModelSpec,
  type Principal,
  type ProviderConfigInput,
  type ProviderGatewayObserver,
  type ProviderGatewayIoOutcome,
  type ProviderGatewayMetricScope,
  type ProviderGatewayRejectionReason,
  type StructuredTelemetry,
} from "@agent-service/protocol";
import {
  CredentialSourceConflictError,
  createProviderByokSecretAdmission,
  ProviderQuotaError,
  ProviderPoolError,
  SubjectDeletingError,
  type ProviderPoolCoordinator,
  type ProviderPoolInventory,
  type ProviderPoolLease,
  type ProviderPoolOutcome,
  type ProviderPoolPolicy,
  type ProviderPoolSelection,
  type ProviderQuotaCoordinator,
  type ProviderQuotaLease,
  type ProviderQuotaLimit,
  type ProviderQuotaRequest,
  type SessionStore,
} from "@agent-service/store";
import {
  assertPublicHost,
  type ProviderAdmissionFailure,
  type ProviderModelRequest,
  type ProviderResolver,
  type ResolvedModel,
  type TenantTelemetryApplicationDualWrite,
  type TenantRuntimeCoordinator,
  type TenantRuntimeDrainIdentity,
  type TenantRuntimeLease,
  type TenantRuntimeParticipant,
} from "@agent-service/core";
import type { SecretCipher } from "./secrets.js";
import {
  protectProviderCredentialTargetReference,
  type CredentialTargetReferenceProtector,
  type ProtectedProviderCredentialTargetReference,
  type ProviderCredentialTargetReferenceContext,
  type ProviderCredentialTargetReferenceFactory,
} from "./credential-target-reference.js";
import { PROVIDER_PRESETS } from "./presets.js";

export interface PlatformProvider {
  /** preset id or a full config */
  config: Omit<ProviderConfigInput, "apiKey">;
  apiKey?: string;
  /** Immutable operator slots, mutually exclusive with a single apiKey. Never returned publicly. */
  keyPool?: readonly Readonly<{ id: string; version: string; apiKey: string }>[];
}

export interface ProviderServiceOptions {
  store: ProviderCredentialTargetReferenceStore;
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
  /** Shared runner-local T3b fence. Omitted while the T3b worker is disabled. */
  tenantRuntime?: TenantRuntimeCoordinator;
  /** Trusted server-side locator source. Public provider input never supplies this value. */
  credentialTargetReferenceFactory?: ProviderCredentialTargetReferenceFactory;
  /** Independent from the BYOK secret cipher and required whenever the locator factory is set. */
  credentialTargetReferenceProtector?: CredentialTargetReferenceProtector;
  /** Structured, allowlisted telemetry. Omit to use a process-local opaque-ref key and JSON console sink. */
  telemetry?: StructuredTelemetry;
  /**
   * Optional default-dormant durable application boundary. When present, tenant-scoped provider
   * events use its producer-authenticated owner admission instead of process-only logging.
   */
  tenantTelemetry?: Pick<TenantTelemetryApplicationDualWrite, "warn">;
  /** V2 logs are sourced by the failed-step business transaction, never by this fetch helper. */
  persistedProviderFailureCaptureActive?: boolean;
  /** Server-owned admission policy; the resolved subject, never request headers, owns each slot. */
  quota?: {
    coordinator: ProviderQuotaCoordinator;
    tenant: ProviderQuotaLimit;
    user: ProviderQuotaLimit;
    platformProvider?: ProviderQuotaLimit;
    authorizeFleet?: (signal: AbortSignal) => Promise<void>;
  };
  keyPool?: { coordinator: ProviderPoolCoordinator; policy: ProviderPoolPolicy };
  /** Independent, explicit single-credential health policy for tenant-owned providers. */
  byokBreaker?: { coordinator: ProviderPoolCoordinator; policy: ProviderPoolPolicy };
  /** Optional L0 observation only; failures must never affect admission, I/O or billing. */
  gatewayObserver?: ProviderGatewayObserver;
}

/**
 * Additive provider-store contract. Existing stores are structurally compatible because the new
 * argument is optional; a locator-aware store will consume it atomically with credential-version
 * creation. The service never passes the argument unless both trusted capture components exist.
 */
export interface ProviderCredentialTargetReferenceStore extends SessionStore {
  upsertProviderConfig(
    cfg: ProviderConfig,
    secret?: { ciphertext: Buffer; keyId: string },
    expectedSourceRevision?: number | null,
    targetReference?: ProtectedProviderCredentialTargetReference,
  ): Promise<ProviderConfig>;
}

const PLATFORM_TENANT = "__platform__";

type QuotaPolicy = Readonly<{
  coordinator: ProviderQuotaCoordinator;
  tenant: Readonly<ProviderQuotaLimit>;
  user: Readonly<ProviderQuotaLimit>;
  platformProvider: Readonly<ProviderQuotaLimit>;
  authorizeFleet?: (signal: AbortSignal) => Promise<void>;
}>;
type ProviderSnapshot = Readonly<{ scope: "platform" | "tenant"; config: ProviderConfig;
  credentialSourceRevision?: number; configIdentity: string; pool?: PlatformPool; byokInventory?: ProviderPoolInventory }>;
type PlatformPool = Readonly<{ slots: NonNullable<PlatformProvider["keyPool"]>; inventory: ProviderPoolInventory }>;
type CapturedPlatformProvider = PlatformProvider & { pool?: PlatformPool };
type PoolPolicy = Readonly<{ coordinator: ProviderPoolCoordinator; policy: Readonly<Required<ProviderPoolPolicy>> }>;
type PoolPin = Readonly<{ selection: ProviderPoolSelection; apiKey: string | undefined }>;
type BodyCompletion = "eof" | "cancelled" | "failure";
type CanonicalModelRef = Readonly<{ provider: string; model: string; reasoning?: "off" | "low" | "medium" | "high" }>;
type FallbackPlan = Readonly<{ principal: Principal; generation: number; source: ProviderSnapshot; sourceRef: CanonicalModelRef;
  targets: readonly Readonly<{ provider: string; model: string }>[]; nextIndex: number; grants: readonly FallbackRequestRecord[]; signal?: AbortSignal }>;
interface FallbackRequestRecord {
  principal: Principal; snapshot: ProviderSnapshot; plan?: FallbackPlan; keySignal?: AbortSignal;
  denial?: ProviderPoolError;
  selectionDenied: boolean; keySucceeded: boolean; fetchEntered: boolean; beforeDispatchEntered: boolean;
  cancelled: boolean; dispatched: boolean; consumed: boolean;
}
function fallbackUnavailable(): never { throw new ApiError("draining", "Provider admission is unavailable."); }
function fallbackTargets(config: ProviderConfig, model: string): FallbackPlan["targets"] {
  const parsed = ProviderConfig.safeParse(config);
  if (!parsed.success) fallbackUnavailable();
  const known = new Set(parsed.data.models.map(value => value.id));
  for (const rule of parsed.data.fallbackRules ?? []) {
    if (!known.has(rule.model) || rule.targets.some(target => target.provider === config.id && target.model === rule.model)) fallbackUnavailable();
  }
  return Object.freeze((parsed.data.fallbackRules?.find(rule => rule.model === model)?.targets ?? [])
    .map(target => Object.freeze({ provider: target.provider, model: target.model })));
}

function invalidPool(): never { throw new ApiError("invalid_request", "Invalid provider key pool configuration."); }
function poolObject(value: unknown): Record<string, unknown> {
  try { return quotaObject(value); } catch { return invalidPool(); }
}
function capturePoolPolicy(value: ProviderServiceOptions["keyPool"]): PoolPolicy | undefined {
  if (value === undefined) return undefined;
  const input = poolObject(value), coordinator = value.coordinator;
  if (Object.keys(input).some(key => key !== "coordinator" && key !== "policy")
    || !coordinator || typeof coordinator.namespaceSha256 !== "string" || coordinator.namespaceSha256.length !== 64
    || !/^[a-f0-9]{64}$/.test(coordinator.namespaceSha256)
    || ["assertReady", "select", "acquire", "close"].some(key => typeof coordinator[key as keyof ProviderPoolCoordinator] !== "function")) invalidPool();
  const raw = poolObject(value.policy), defaults = { threshold: 5, windowMs: 60_000, cooldownMs: 30_000, rateLimitCooldownMs: 30_000 };
  if (Object.keys(raw).some(key => !Object.hasOwn(defaults, key))) invalidPool();
  const policy = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const next = raw[key] === undefined ? defaults[key] : raw[key];
    if (typeof next !== "number" || !Number.isSafeInteger(next) || next < (key === "threshold" ? 1 : 100)
      || next > (key === "threshold" ? 100 : 3_600_000)) invalidPool();
    policy[key] = next;
  }
  return Object.freeze({ coordinator, policy: Object.freeze(policy) });
}
/** Private health identities are disjoint across ownership scopes; neither hash contains a key. */
function breakerProviderId(scope: "platform" | "tenant", providerId: string, tenantId?: string): string {
  return createHash("sha256").update(`provider-breaker-${scope}-v1\0`)
    .update(JSON.stringify(scope === "tenant" ? [tenantId, providerId] : [providerId])).digest("hex");
}
function captureByokInventory(tenantId: string, providerId: string, revision: number): ProviderPoolInventory {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new ProviderPoolError("unavailable");
  return Object.freeze({ version: "provider-key-pool-v1", providerId: breakerProviderId("tenant", providerId, tenantId),
    slots: Object.freeze([Object.freeze({ id: "credential", version: `r${revision}` })]) });
}
function capturePlatformPool(providerId: string, value: PlatformProvider["keyPool"]): PlatformPool | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) invalidPool();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.keys(descriptors).length !== value.length + 1
    || Array.from({ length: value.length }, (_, index) => descriptors[index]).some(d => !d || !("value" in d) || !d.enumerable)) invalidPool();
  const ids = new Set<string>();
  const slots = value.map(value => {
    const slot = poolObject(value);
    if (Object.keys(slot).length !== 3 || Object.keys(slot).some(key => !["id", "version", "apiKey"].includes(key))) invalidPool();
    for (const key of ["id", "version"] as const) if (typeof slot[key] !== "string" || slot[key].length < 1 || slot[key].length > 64
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slot[key]) || /[^A-Za-z0-9._-]/.test(slot[key])) invalidPool();
    if (typeof slot.apiKey !== "string" || slot.apiKey.length < 1 || slot.apiKey.length > 4096 || /[^\x21-\x7e]/.test(slot.apiKey)) invalidPool();
    const id = slot.id as string, version = slot.version as string;
    if (ids.has(id)) invalidPool(); ids.add(id);
    return Object.freeze({ id, version, apiKey: slot.apiKey });
  });
  return Object.freeze({ slots: Object.freeze(slots), inventory: Object.freeze({ version: "provider-key-pool-v1", providerId: breakerProviderId("platform", providerId),
    slots: Object.freeze(slots.map(({ id, version }) => Object.freeze({ id, version }))) }) });
}

function responsePoolOutcome(response: Response): ProviderPoolOutcome | undefined {
  if (response.ok) return undefined; // Success requires actual body EOF, not headers.
  if (response.status === 429) {
    const hint = response.headers.get("retry-after");
    if (hint && hint.length <= 16 && /^[0-9]+$/.test(hint)) {
      const seconds = Number(hint);
      if (Number.isSafeInteger(seconds) && seconds >= 0) return { kind: "rate_limited", retryDelayMs: Math.min(3600, seconds) * 1000 };
    }
    if (hint?.length === 29) {
      const at = Date.parse(hint);
      if (Number.isSafeInteger(at) && at >= 0 && new Date(at).toUTCString() === hint) return { kind: "rate_limited", retryAtMs: at };
    }
    return { kind: "rate_limited" };
  }
  if (response.status === 401 || response.status === 403) return { kind: "credential_rejected" };
  return { kind: response.status >= 500 && response.status <= 599 ? "failure" : "neutral" };
}

function invalidQuota(): never { throw new ApiError("invalid_request", "Invalid provider quota configuration."); }
function quotaObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) invalidQuota();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(d => !("value" in d) || !d.enumerable)) invalidQuota();
  return value as Record<string, unknown>;
}
function quotaLimit(value: unknown): Readonly<ProviderQuotaLimit> {
  const input = quotaObject(value), result: { rpm?: number; concurrency?: number } = {};
  if (Object.keys(input).some(key => key !== "rpm" && key !== "concurrency")) invalidQuota();
  for (const key of ["rpm", "concurrency"] as const) {
    const limit = input[key]; if (limit === undefined) continue;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) invalidQuota();
    result[key] = limit;
  }
  return Object.freeze(result);
}
function minimumQuota(a: ProviderQuotaLimit, b: ProviderQuotaLimit): Readonly<ProviderQuotaLimit> {
  const result: { rpm?: number; concurrency?: number } = {};
  for (const key of ["rpm", "concurrency"] as const) {
    const left = a[key], right = b[key];
    if (left !== undefined || right !== undefined) result[key] = left === undefined ? right : right === undefined ? left : Math.min(left, right);
  }
  return Object.freeze(result);
}
function captureQuotaPolicy(value: ProviderServiceOptions["quota"]): QuotaPolicy | undefined {
  if (value === undefined) return undefined;
  const input = quotaObject(value);
  if (Object.keys(input).some(key => !["coordinator", "tenant", "user", "platformProvider", "authorizeFleet"].includes(key))) invalidQuota();
  const coordinator = value.coordinator;
  if (!coordinator || typeof coordinator.namespaceSha256 !== "string" || coordinator.namespaceSha256.length !== 64
    || !/^[a-f0-9]{64}$/.test(coordinator.namespaceSha256)
    || typeof coordinator.assertReady !== "function" || typeof coordinator.enter !== "function" || typeof coordinator.close !== "function"
    || value.authorizeFleet !== undefined && typeof value.authorizeFleet !== "function") invalidQuota();
  return Object.freeze({ coordinator, tenant: quotaLimit(value.tenant), user: quotaLimit(value.user),
    platformProvider: quotaLimit(value.platformProvider ?? {}),
    ...(value.authorizeFleet === undefined ? {} : { authorizeFleet: value.authorizeFleet }) });
}

function credentialFreeBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ApiError("invalid_request", "baseUrl is not a valid URL");
  }
  if (url.username || url.password) {
    throw new ApiError("invalid_request", "baseUrl must not contain credentials");
  }
  return url;
}

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
  const u = credentialFreeBaseUrl(baseUrl);
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

export class ProviderService implements ProviderResolver, TenantRuntimeParticipant {
  readonly name = "tenant-provider-service";
  readonly models: MutableModels;
  private readonly platform = new Map<string, CapturedPlatformProvider>();
  private readonly registered = new Map<string, string>(); // pi provider id -> exact config identity
  private readonly tenantRegistrations = new Map<string, Set<string>>();

  private readonly assertBaseUrl: (baseUrl: string) => Promise<void>;
  private readonly telemetry: StructuredTelemetry;
  private readonly quotaPolicy: QuotaPolicy | undefined;
  private quotaUnavailable = false;
  private readonly poolPolicy: PoolPolicy | undefined;
  private readonly byokPolicy: PoolPolicy | undefined;
  private poolUnavailable = false;
  private readonly fallbackRequests = new WeakMap<ProviderModelRequest, FallbackRequestRecord>();

  constructor(private readonly opts: ProviderServiceOptions) {
    this.quotaPolicy = captureQuotaPolicy(opts.quota);
    this.poolPolicy = capturePoolPolicy(opts.keyPool);
    this.byokPolicy = capturePoolPolicy(opts.byokBreaker);
    this.telemetry = opts.telemetry ?? createEphemeralStructuredTelemetry("provider");
    if ((opts.credentialTargetReferenceFactory === undefined)
      !== (opts.credentialTargetReferenceProtector === undefined)) {
      throw new Error(
        "credential target reference factory and protector must be configured together",
      );
    }
    const validateBaseUrl = opts.assertBaseUrl ?? assertPublicBaseUrl;
    this.assertBaseUrl = async (baseUrl) => {
      // Credential rejection is not injectable: custom DNS guards used by tests/deployments must
      // never make URL userinfo a second plaintext secret channel.
      credentialFreeBaseUrl(baseUrl);
      await validateBaseUrl(baseUrl);
    };
    this.models = opts.models ?? createModels();
    opts.tenantRuntime?.registerParticipant(this);
    for (const p of opts.platform ?? []) {
      credentialFreeBaseUrl(p.config.baseUrl);
      // Zod creates a private copy, so subsequent caller mutations cannot replace the pinned model,
      // endpoint, credentials or quota behind an already resolved platform handle.
      const config = this.platformConfig(p);
      quotaLimit(config.quota);
      const pool = capturePlatformPool(config.id, p.keyPool);
      if (pool && (p.apiKey !== undefined || !this.poolPolicy || Object.keys(config.headers).some(key => key.toLowerCase() === "authorization"))) invalidPool();
      if (this.platform.has(config.id) && (pool || this.platform.get(config.id)?.pool)) invalidPool();
      this.platform.set(config.id, { config, apiKey: p.apiKey, ...(pool ? { pool } : {}) });
    }
  }

  static preset(id: string, apiKey?: string): PlatformProvider {
    const cfg = PROVIDER_PRESETS[id];
    if (!cfg) throw new Error(`unknown provider preset ${id}`);
    return { config: cfg, apiKey };
  }

  // ---------- tenant BYOK CRUD ----------

  async upsertTenantProvider(tenantId: string, input: ProviderConfigInput): Promise<ProviderConfig> {
    this.requireQuotaCoordinator(quotaLimit(input.quota ?? {}));
    return this.withTenantOperation(tenantId, async (runtimeLease) => {
      const generation = await this.requireActiveTenant(tenantId);
      await this.assertBaseUrl(input.baseUrl);
      runtimeLease?.assertOpen();
      await this.assertTenantGeneration(tenantId, generation);
      const { apiKey, ...rest } = input;
      const secret = apiKey ? { ciphertext: await this.opts.cipher.encrypt(apiKey), keyId: this.opts.cipher.keyId } : undefined;
      // A deleted provider has no live row to return from getProviderConfig, but its permanent slot
      // retains a monotonic revision. The first null CAS reveals that tombstone revision; retain it
      // only while the source remains absent so delete/recreate cannot collapse back to null (ABA).
      let absentSourceRevision: number | null = null;
      for (;;) {
        runtimeLease?.assertOpen();
        await this.assertTenantGeneration(tenantId, generation);
        const existing = await this.opts.store.getProviderConfig(tenantId, input.id);
        runtimeLease?.assertOpen();
        // Keep live updates monotonic even when two accepted writes land in the same millisecond.
        const now = Math.max(Date.now(), (existing?.config.updatedAtMs ?? -1) + 1);
        const hasSecret = Boolean(apiKey || existing?.secret || existing?.config.apiKeyRef);
        const config = ProviderConfig.parse({
          ...rest,
          tenantId,
          apiKeyRef: hasSecret ? providerSecretRef(tenantId, input.id) : undefined,
          createdAtMs: existing?.config.createdAtMs ?? now,
          updatedAtMs: now,
        });
        const targetReference = await this.captureCredentialTargetReference({
          tenantId,
          providerId: config.id,
          providerApi: config.api,
          encryptedSecretPresent: hasSecret,
          customHeadersPresent: Object.keys(config.headers).length > 0,
          endpointParametersPresent: (() => {
            const endpoint = new URL(config.baseUrl);
            return endpoint.search.length > 0 || endpoint.hash.length > 0;
          })(),
        });
        runtimeLease?.assertOpen();
        await this.assertTenantGeneration(tenantId, generation);
        try {
          const expectedRevision = existing?.credentialSourceRevision ?? absentSourceRevision;
          // Only a newly accepted API key has server-observed BYOK provenance.
          // Rebuild the original-object admission for each exact CAS attempt;
          // a config-only update must not relabel an inherited legacy secret.
          const secretAdmission = secret === undefined ? undefined
            : createProviderByokSecretAdmission({ tenantId, providerId: config.id,
                expectedSourceRevision: expectedRevision, secret });
          const stored = await this.opts.store.upsertProviderConfigWithResponsibility({
            config,
            expectedSourceRevision: expectedRevision,
            ...(secret === undefined ? {} : { secret, secretAdmission }),
            ...(targetReference === undefined ? {} : { targetReference }),
          });
          runtimeLease?.assertOpen();
          return stored;
        } catch (error) {
          if (
            !(error instanceof CredentialSourceConflictError)
            || error.sourceKind !== "provider"
          ) throw error;
          absentSourceRevision = error.actualSourceRevision;
          // A concurrent update/delete/recreate won. Re-read the live source; if it is absent,
          // retry against the conflict's permanent-slot revision rather than collapsing to null.
        }
      }
    });
  }

  private async captureCredentialTargetReference(
    context: ProviderCredentialTargetReferenceContext,
  ): Promise<ProtectedProviderCredentialTargetReference | undefined> {
    const factory = this.opts.credentialTargetReferenceFactory;
    const protector = this.opts.credentialTargetReferenceProtector;
    if (!factory || !protector) return undefined;
    if (!context.encryptedSecretPresent
      && !context.customHeadersPresent
      && !context.endpointParametersPresent) return undefined;
    try {
      const captured = await factory.capture(Object.freeze({ ...context }));
      return captured === undefined
        ? undefined
        : await protectProviderCredentialTargetReference(captured, protector);
    } catch {
      // Trusted adapters may surface remote responses or locators in their errors. The generic
      // runner error handler logs thrown errors, so this boundary must not retain a cause/message.
      throw new Error("provider credential target reference capture failed");
    }
  }

  async deleteTenantProvider(tenantId: string, providerId: string): Promise<boolean> {
    return this.withTenantOperation(tenantId, async (runtimeLease) => {
      const generation = await this.requireActiveTenant(tenantId);
      runtimeLease?.assertOpen();
      const deleted = await this.opts.store.deleteProviderConfig(tenantId, providerId);
      runtimeLease?.assertOpen();
      await this.assertTenantGeneration(tenantId, generation);
      return deleted;
    });
  }

  async listVisible(tenantId: string): Promise<ProviderConfig[]> {
    return this.withTenantOperation(tenantId, async (runtimeLease) => {
      const generation = await this.requireActiveTenant(tenantId);
      const own = await this.opts.store.listProviderConfigs(tenantId);
      runtimeLease?.assertOpen();
      await this.assertTenantGeneration(tenantId, generation);
      const ownIds = new Set(own.map((c) => c.id));
      const platform = [...this.platform.values()].filter((p) => !ownIds.has(p.config.id)).map((p) => this.platformConfig(p));
      return [...own, ...platform];
    });
  }

  private platformConfig(p: PlatformProvider): ProviderConfig {
    return ProviderConfig.parse({ ...p.config, tenantId: PLATFORM_TENANT, apiKeyRef: p.apiKey || p.keyPool || (p as CapturedPlatformProvider).pool ? "platform" : undefined, createdAtMs: 0, updatedAtMs: 0 });
  }

  // ---------- resolution ----------

  async resolve(principal: Principal, ref: { provider: string; model: string; reasoning?: "off" | "low" | "medium" | "high" }): Promise<ResolvedModel> {
    return this.resolveModel(principal, ref);
  }

  async resolveFallback(principal: Principal, failedRequest: ProviderModelRequest): Promise<ResolvedModel | undefined> {
    principal = Object.freeze({ tenantId: principal.tenantId, userId: principal.userId });
    const record = this.fallbackRequests.get(failedRequest);
    if (!record || !Object.isFrozen(failedRequest) || record.principal.tenantId !== principal.tenantId
      || record.principal.userId !== principal.userId || record.consumed || !this.fallbackEligible(record)) return undefined;
    const plan = record.plan;
    if (!plan || plan.nextIndex >= plan.targets.length) return undefined;
    record.consumed = true;
    const target = plan.targets[plan.nextIndex];
    if (!target) return undefined;
    const next: FallbackPlan = Object.freeze({ ...plan, nextIndex: plan.nextIndex + 1,
      grants: Object.freeze([...plan.grants, record]), signal: combineSignals(plan.signal, record.keySignal) });
    try {
      await this.assertFallbackSource(next);
      const ref = Object.freeze({ ...target, ...(plan.sourceRef.reasoning === undefined ? {} : { reasoning: plan.sourceRef.reasoning }) });
      const resolved = await this.resolveModel(principal, ref, next);
      await this.assertFallbackSource(next);
      return resolved;
    } catch (error) {
      if (error instanceof SubjectDeletingError) throw error;
      return fallbackUnavailable();
    }
  }

  private fallbackEligible(record: FallbackRequestRecord): boolean {
    return record.selectionDenied && !record.keySucceeded && !record.fetchEntered && !record.beforeDispatchEntered
      && !record.cancelled && !record.dispatched && record.keySignal?.aborted !== true;
  }

  private async assertFallbackSource(plan: FallbackPlan): Promise<void> {
    plan.signal?.throwIfAborted();
    if (plan.grants.some(record => !this.fallbackEligible(record))) throw new ProviderPoolError("unavailable");
    await this.assertTenantGeneration(plan.principal.tenantId, plan.generation);
    for (const record of plan.grants) if (record.snapshot !== plan.source) {
      await this.currentQuotaRequest(plan.principal, record.snapshot);
    }
    await this.currentQuotaRequest(plan.principal, plan.source);
    plan.signal?.throwIfAborted();
    if (plan.grants.some(record => !this.fallbackEligible(record))) throw new ProviderPoolError("unavailable");
  }

  private async resolveModel(principal: Principal, ref: CanonicalModelRef, inherited?: FallbackPlan): Promise<ResolvedModel> {
    principal = Object.freeze({ tenantId: principal.tenantId, userId: principal.userId });
    const canonicalRef: CanonicalModelRef = Object.freeze({ provider: ref.provider, model: ref.model,
      ...(ref.reasoning === undefined ? {} : { reasoning: ref.reasoning }) });
    return this.withTenantOperation(principal.tenantId, async (resolveLease) => {
      const generation = await this.requireActiveTenant(principal.tenantId);
      const tenantCfg = await this.opts.store.getProviderConfig(principal.tenantId, ref.provider);
      resolveLease?.assertOpen();
      await this.assertTenantGeneration(principal.tenantId, generation);
      let config: ProviderConfig;
      let apiKey: () => Promise<string | undefined>;
      let piProviderId: string;
      let platformPool: PlatformPool | undefined;
      let byokInventory: ProviderPoolInventory | undefined;
      if (tenantCfg) {
        config = tenantCfg.config;
        if (this.byokPolicy) byokInventory = captureByokInventory(principal.tenantId, config.id, tenantCfg.credentialSourceRevision);
        piProviderId = tenantProviderRegistrationId(principal.tenantId, config.id);
        const secret = tenantCfg.secret;
        apiKey = () => this.withTenantOperation(principal.tenantId, async (secretLease) => {
          await this.assertTenantGeneration(principal.tenantId, generation);
          secretLease?.assertOpen();
          if (!secret) return undefined;
          const decrypted = await this.opts.cipher.decrypt(secret.ciphertext, secret.keyId);
          secretLease?.assertOpen();
          await this.assertTenantGeneration(principal.tenantId, generation);
          return decrypted;
        });
      } else {
        const p = this.platform.get(ref.provider);
        if (!p) throw new ApiError("not_found", `provider ${ref.provider} not configured`);
        config = this.platformConfig(p);
        platformPool = p.pool;
        piProviderId = platformProviderRegistrationId(config.id);
        apiKey = () => this.withTenantOperation(principal.tenantId, async (secretLease) => {
          if (platformPool) throw new ProviderPoolError("unavailable");
          await this.assertTenantGeneration(principal.tenantId, generation);
          secretLease?.assertOpen();
          return p.apiKey;
        });
      }
      this.requireQuotaCoordinator(quotaLimit(config.quota));
      if (!tenantCfg) this.requireQuotaCoordinator(this.quotaPolicy?.platformProvider ?? {});
      const spec = config.models.find((m) => m.id === ref.model);
      if (!spec) throw new ApiError("invalid_request", `model ${ref.model} not offered by provider ${ref.provider}`, { available: config.models.map((m) => m.id) });
      if (inherited && (inherited.source.scope === "platform" && tenantCfg
        || inherited.source.scope === "tenant" && !tenantCfg && inherited.source.config.allowPlatformPaidFallback !== true
        || ref.reasoning !== undefined && ref.reasoning !== "off" && !spec.reasoning)) fallbackUnavailable();

      if (tenantCfg) await this.assertBaseUrl(config.baseUrl);
      resolveLease?.assertOpen();
      await this.assertTenantGeneration(principal.tenantId, generation);
      const configIdentity = JSON.stringify(config);
      this.ensureRegistered(piProviderId, config, configIdentity, tenantCfg ? principal.tenantId : undefined);
      const handle = this.models.getModel(piProviderId, spec.id);
      if (!handle) throw new ApiError("internal_error", `model ${spec.id} not registered`);
      resolveLease?.assertOpen();
      const snapshot: ProviderSnapshot = {
        scope: tenantCfg ? "tenant" : "platform", config,
        ...(tenantCfg ? { credentialSourceRevision: tenantCfg.credentialSourceRevision } : {}),
        configIdentity,
        ...(platformPool ? { pool: platformPool } : {}),
        ...(byokInventory ? { byokInventory } : {}),
      };
      const boundPool = platformPool !== undefined || byokInventory !== undefined;
      const targets = inherited?.targets ?? (boundPool ? fallbackTargets(config, ref.model) : Object.freeze([]));
      const plan: FallbackPlan | undefined = inherited ?? (targets.length ? Object.freeze({ principal, generation, source: snapshot, sourceRef: canonicalRef,
        targets, nextIndex: 0, grants: Object.freeze([]) }) : undefined);
      const sourceGuard = inherited ? () => this.assertFallbackSource(inherited) : undefined;
      const createRequest = (beforeDispatch?: () => Promise<void>): ProviderModelRequest => {
        // The SDK may wrap the thrown error, so keep the fact in this one model request's private
        // lifetime. An old resolved handle and two concurrent streams never share this state.
        let dispatched = false;
        let failure: ProviderAdmissionFailure | undefined;
        let localFailure = false;
        let rejectionObserved = false;
        const record: FallbackRequestRecord = { principal, snapshot, plan, selectionDenied: false, keySucceeded: false,
          fetchEntered: false, beforeDispatchEntered: false, cancelled: false, dispatched: false, consumed: false };
        const reject = (error: unknown, cancelled: boolean) => {
          if (dispatched || rejectionObserved) return;
          rejectionObserved = true; this.observeGatewayRejection(snapshot.scope, error, cancelled);
        };
        let selection: Promise<PoolPin> | undefined;
        const guarded = this.generationGuardedFetch(principal, generation, snapshot, () => {
          dispatched = true; record.dispatched = true; failure = undefined;
        }, beforeDispatch ? async () => { record.beforeDispatchEntered = true; await beforeDispatch(); } : undefined, boundPool ? async () => {
          if (!selection) throw new ProviderPoolError("unavailable");
          return selection;
        } : undefined, () => { if (dispatched) localFailure = true; }, sourceGuard);
        const request: ProviderModelRequest = Object.freeze({
          apiKey: async (signal?: AbortSignal) => {
            try {
              record.keySignal = combineSignals(record.keySignal, signal);
              signal?.throwIfAborted();
              if (sourceGuard) await sourceGuard();
              const key = boundPool
                ? await this.withTenantOperation(principal.tenantId, async lease => {
                  const actualSignal = combineSignals(signal, lease?.signal) ?? new AbortController().signal;
                  actualSignal.throwIfAborted(); lease?.assertOpen(); this.requirePoolPolicy(snapshot);
                  await this.assertTenantGeneration(principal.tenantId, generation); await this.currentQuotaRequest(principal, snapshot);
                  const pin = await (selection ??= this.selectPoolKey(principal, generation, snapshot, apiKey, actualSignal,
                    error => { record.denial = error; }));
                  await this.assertTenantGeneration(principal.tenantId, generation); await this.currentQuotaRequest(principal, snapshot);
                  actualSignal.throwIfAborted(); lease?.assertOpen(); this.requirePoolPolicy(snapshot);
                  return pin.apiKey;
                }) : await apiKey();
              if (sourceGuard) await sourceGuard();
              signal?.throwIfAborted(); record.keySucceeded = true; return key;
            } catch (error) {
              record.selectionDenied = error === record.denial && error instanceof ProviderPoolError
                && (error.reason === "open" || error.reason === "disabled");
              if (signal?.aborted) record.cancelled = true;
              reject(error, signal?.aborted === true);
              if (!dispatched) failure = error instanceof SubjectDeletingError ? "subject_deleting"
                : error instanceof ProviderPoolError ? "draining"
                : error instanceof ProviderQuotaError ? error.reason === "unavailable" ? "draining" : "quota_exceeded" : undefined;
              throw error;
            }
          },
          fetch: (async (...args: Parameters<typeof fetch>) => {
            record.fetchEntered = true;
            if (args[1]?.signal?.aborted || args[0] instanceof Request && args[0].signal.aborted) record.cancelled = true;
            if (!dispatched) failure = undefined;
            try { return await guarded(...args); }
            catch (error) {
              reject(error, args[1]?.signal?.aborted === true || args[0] instanceof Request && args[0].signal.aborted);
              if (!dispatched) failure = error instanceof SubjectDeletingError ? "subject_deleting"
                : error instanceof ProviderPoolError ? "draining"
                : error instanceof ProviderQuotaError ? error.reason === "unavailable" ? "draining" : "quota_exceeded"
                : undefined;
              throw error;
            }
          }) as typeof fetch,
          wasDispatched: () => dispatched,
          hasLocalFailure: () => localFailure,
          admissionFailure: () => dispatched ? undefined : failure,
        });
        this.fallbackRequests.set(request, record);
        return request;
      };
      return {
        handle,
        provider: piProviderId,
        model: spec.id,
        contextWindow: spec.contextWindow,
        input: spec.input,
        priceKnown: spec.price !== undefined,
        canonicalRef,
        maxOutputTokens: spec.maxOutputTokens,
        ...(boundPool && plan && plan.nextIndex < plan.targets.length ? { fallbackEnabled: true } : {}),
        apiKey: boundPool || inherited ? async () => { throw new ProviderPoolError("unavailable"); } : apiKey,
        headers: Object.keys(config.headers).length ? { ...config.headers } : undefined,
        fetch: boundPool || inherited ? (async () => { throw new ProviderPoolError("unavailable"); }) as typeof fetch
          : this.generationGuardedFetch(principal, generation, snapshot),
        createRequest,
        reasoning: ref.reasoning ?? (spec.reasoning ? undefined : "off"),
      };
    });
  }

  private async requireActiveTenant(tenantId: string): Promise<number> {
    const state = await this.opts.store.getTenantRuntimeState(tenantId);
    if (state.state !== "active") throw new SubjectDeletingError(tenantId);
    return state.generation;
  }

  private observeGatewayRejection(scope: ProviderSnapshot["scope"], error: unknown, cancelled: boolean): void {
    try {
      const reason: ProviderGatewayRejectionReason = error instanceof SubjectDeletingError ? "subject_deleting"
        : cancelled ? "cancelled"
        : error instanceof ProviderQuotaError ? error.reason === "rpm" ? "quota_rpm"
          : error.reason === "concurrency" ? "quota_concurrency" : "quota_unavailable"
        : error instanceof ProviderPoolError ? error.reason === "open" ? "breaker_open"
          : error.reason === "disabled" ? "breaker_disabled" : "breaker_unavailable" : "local_unavailable";
      this.opts.gatewayObserver?.rejected(scope === "tenant" ? "byok" : "platform", reason);
    } catch { /* Observation, including property access, is strictly fail-open. */ }
  }

  private beginGatewayAttempt(scope: ProviderSnapshot["scope"]): ((outcome: ProviderGatewayIoOutcome) => void) | undefined {
    try {
      const metricScope: ProviderGatewayMetricScope = scope === "tenant" ? "byok" : "platform";
      const finish = this.opts.gatewayObserver?.beginAttempt(metricScope);
      if (typeof finish !== "function") return undefined;
      let finished = false;
      return outcome => {
        if (finished) return; finished = true;
        try { finish(outcome); } catch { /* Never replace the provider result. */ }
      };
    } catch { return undefined; }
  }

  private async assertTenantGeneration(tenantId: string, generation: number): Promise<void> {
    const state = await this.opts.store.getTenantRuntimeState(tenantId);
    if (state.state !== "active" || state.generation !== generation) {
      throw new SubjectDeletingError(tenantId);
    }
  }

  private requireQuotaCoordinator(limit: ProviderQuotaLimit): void {
    if (this.quotaUnavailable || (limit.rpm !== undefined || limit.concurrency !== undefined) && !this.quotaPolicy) {
      throw new ProviderQuotaError("unavailable");
    }
  }

  private async currentQuotaRequest(principal: Principal, snapshot: ProviderSnapshot): Promise<Readonly<ProviderQuotaRequest> | undefined> {
    const current = await this.opts.store.getProviderConfig(principal.tenantId, snapshot.config.id);
    if (snapshot.scope === "tenant") {
      if (!current || current.credentialSourceRevision !== snapshot.credentialSourceRevision
        || JSON.stringify(current.config) !== snapshot.configIdentity) throw new ProviderQuotaError("unavailable");
    } else if (current) {
      // A newly configured BYOK provider must not be paired with an old platform model/key.
      throw new ProviderQuotaError("unavailable");
    }
    const providerLimit = quotaLimit((current?.config ?? snapshot.config).quota);
    this.requireQuotaCoordinator(providerLimit);
    const policy = this.quotaPolicy;
    if (!policy) return undefined;
    return Object.freeze({ tenantId: principal.tenantId, userId: principal.userId,
      provider: Object.freeze({ scope: snapshot.scope, id: snapshot.config.id }),
      tenant: policy.tenant, user: policy.user,
      providerLimit: snapshot.scope === "platform" ? minimumQuota(providerLimit, policy.platformProvider) : providerLimit });
  }

  private requirePoolPolicy(snapshot: ProviderSnapshot): PoolPolicy {
    const policy = snapshot.scope === "tenant" ? this.byokPolicy : this.poolPolicy;
    if (this.poolUnavailable || !policy) throw new ProviderPoolError("unavailable");
    return policy;
  }

  private async selectPoolKey(principal: Principal, generation: number, snapshot: ProviderSnapshot,
    readKey: () => Promise<string | undefined>, signal?: AbortSignal, denied?: (error: ProviderPoolError) => void): Promise<PoolPin> {
    return this.withTenantOperation(principal.tenantId, async lease => {
      const pool = snapshot.pool, inventory = pool?.inventory ?? snapshot.byokInventory, policy = this.requirePoolPolicy(snapshot);
      if (!inventory) throw new ProviderPoolError("unavailable");
      const actualSignal = combineSignals(signal, lease?.signal) ?? new AbortController().signal;
      actualSignal.throwIfAborted(); lease?.assertOpen();
      await this.assertTenantGeneration(principal.tenantId, generation);
      await this.currentQuotaRequest(principal, snapshot);
      actualSignal.throwIfAborted(); lease?.assertOpen();
      let selection: ProviderPoolSelection;
      try { selection = await policy.coordinator.select(inventory, policy.policy, actualSignal); }
      catch (error) {
        if (actualSignal.aborted) throw new DOMException("Provider request aborted.", "AbortError");
        if (error instanceof ProviderPoolError && (error.reason === "open" || error.reason === "disabled")) denied?.(error);
        throw error instanceof ProviderPoolError ? error : new ProviderPoolError("unavailable");
      }
      const slot = inventory.slots.find(slot => slot.id === selection.slot.id && slot.version === selection.slot.version);
      if (!slot) throw new ProviderPoolError("unavailable");
      // Select the immutable revision before decrypting. Keyless tenant configurations are valid;
      // undefined is never replaced by a platform key.
      const platformSlot = pool?.slots.find(value => value.id === slot.id && value.version === slot.version);
      if (pool && !platformSlot) throw new ProviderPoolError("unavailable");
      const apiKey = platformSlot ? platformSlot.apiKey : await readKey();
      await this.assertTenantGeneration(principal.tenantId, generation);
      await this.currentQuotaRequest(principal, snapshot);
      actualSignal.throwIfAborted(); lease?.assertOpen(); this.requirePoolPolicy(snapshot);
      return Object.freeze({ selection, apiKey });
    });
  }

  private generationGuardedFetch(principal: Principal, generation: number, snapshot: ProviderSnapshot,
    dispatched?: () => void, beforeDispatch?: () => Promise<void>, poolPin?: () => Promise<PoolPin>,
    localFailure?: () => void, sourceGuard?: () => Promise<void>): typeof fetch {
    const tenantId = principal.tenantId;
    const delegate = this.opts.fetch ?? globalThis.fetch;
    return (async (...args: Parameters<typeof fetch>) => {
      const lease = this.opts.tenantRuntime?.enter(tenantId, "provider");
      let quotaLease: ProviderQuotaLease | undefined;
      let poolLease: ProviderPoolLease | undefined;
      let pin: PoolPin | undefined;
      let response: Response | undefined;
      let callerSignal: AbortSignal | undefined;
      let executionSignal: AbortSignal | undefined, signal: AbortSignal | undefined;
      let dispatchEntered = false, delegateFailed = false;
      let locallyAborted = false;
      let finishMetric: ((outcome: ProviderGatewayIoOutcome) => void) | undefined;
      let releaseWork: Promise<void> | undefined;
      const markLocalFailure = () => {
        if (dispatchEntered && !delegateFailed && response?.ok !== false) { locallyAborted = true; localFailure?.(); }
      };
      const release = (completion?: BodyCompletion) => releaseWork ??= (async () => {
        let failed = false;
        try {
          // Original fetch/read/cancel has joined. Record I/O before health/quota release can
          // abort its own signal or fail; those secondary effects cannot rewrite the I/O outcome.
          const ioOutcome: ProviderGatewayIoOutcome = response?.ok === false ? "http_error"
            : delegateFailed || completion === "failure" ? "transport_error"
            : callerSignal?.aborted ? "cancelled"
            : locallyAborted || signal?.aborted || lease?.signal.aborted ? "local_abort"
            : completion === "eof" ? "completed" : "cancelled";
          finishMetric?.(ioOutcome);
          const outcome = response ? responsePoolOutcome(response) : undefined;
          const kind = completion === "eof" ? "success"
            : completion === "cancelled" || !dispatchEntered || signal?.aborted ? "cancelled" : "failure";
          try { await poolLease?.release(outcome ?? { kind }); }
          catch {
            this.poolUnavailable = true; this.quotaUnavailable = true; failed = true;
          }
          // Pool completion must precede quota's expected self-abort of its admission signal.
          try { await quotaLease?.release(); }
          catch {
            this.quotaUnavailable = true; failed = true;
          }
          if (failed) throw new ProviderQuotaError("unavailable");
        } finally { lease?.release(); }
      })();
      try {
        if (sourceGuard) await sourceGuard();
        await this.assertTenantGeneration(tenantId, generation);
        lease?.assertOpen();
        const inputSignal = args[0] instanceof Request ? args[0].signal : undefined;
        callerSignal = combineSignals(args[1]?.signal, inputSignal);
        executionSignal = combineSignals(callerSignal, lease?.signal);
        signal = executionSignal;
        const request = await this.currentQuotaRequest(principal, snapshot);
        await this.assertTenantGeneration(tenantId, generation);
        lease?.assertOpen(); signal?.throwIfAborted();
        if (request) {
          const policy = this.quotaPolicy;
          if (!policy) throw new ProviderQuotaError("unavailable");
          const admissionSignal = signal ?? new AbortController().signal;
          try {
            await policy.authorizeFleet?.(admissionSignal);
            admissionSignal.throwIfAborted(); lease?.assertOpen();
            await this.assertTenantGeneration(tenantId, generation);
            quotaLease = await policy.coordinator.enter(request, admissionSignal);
            const admittedSignal = AbortSignal.any([admissionSignal, quotaLease.signal]);
            signal = admittedSignal;
            admittedSignal.throwIfAborted();
            await quotaLease.assertOpen();
            await policy.authorizeFleet?.(admittedSignal);
            signal?.throwIfAborted(); lease?.assertOpen();
            await quotaLease.assertOpen();
            await this.assertTenantGeneration(tenantId, generation);
            await this.currentQuotaRequest(principal, snapshot);
            signal?.throwIfAborted(); lease?.assertOpen();
          } catch (error) {
            if (error instanceof ProviderQuotaError || error instanceof SubjectDeletingError) throw error;
            if (admissionSignal.aborted) throw new DOMException("Provider request aborted.", "AbortError");
            throw new ProviderQuotaError("unavailable");
          }
        }
        if (snapshot.pool || snapshot.byokInventory) {
          if (!poolPin) throw new ProviderPoolError("unavailable");
          pin = await poolPin();
          const policy = this.requirePoolPolicy(snapshot), admissionSignal = signal ?? new AbortController().signal;
          admissionSignal.throwIfAborted(); lease?.assertOpen();
          try { poolLease = await policy.coordinator.acquire(pin.selection, admissionSignal); }
          catch (error) {
            if (admissionSignal.aborted) throw new DOMException("Provider request aborted.", "AbortError");
            throw error instanceof ProviderPoolError ? error : new ProviderPoolError("unavailable");
          }
          signal = AbortSignal.any([admissionSignal, poolLease.signal]);
          signal.throwIfAborted(); await poolLease.assertOpen();
          if (quotaLease) await quotaLease.assertOpen();
          await this.quotaPolicy?.authorizeFleet?.(signal);
          // Keep source authorization before a real budget callback. Without that callback,
          // the final governed check below replaces this pair after the last fleet await.
          if (beforeDispatch || !quotaLease) {
            await this.assertTenantGeneration(tenantId, generation); await this.currentQuotaRequest(principal, snapshot);
          }
          lease?.assertOpen(); signal.throwIfAborted(); this.requirePoolPolicy(snapshot);
        }
        if (beforeDispatch) {
          if (sourceGuard) await sourceGuard();
          try { await beforeDispatch(); }
          catch (error) {
            if (error instanceof ProviderQuotaError || error instanceof SubjectDeletingError) throw error;
            throw new ProviderQuotaError("unavailable");
          }
          lease?.assertOpen(); signal?.throwIfAborted();
          if (quotaLease) {
            try { await quotaLease.assertOpen(); }
            catch (error) { throw error instanceof ProviderQuotaError ? error : new ProviderQuotaError("unavailable"); }
          }
          if (poolLease) await poolLease.assertOpen();
          // Governed requests perform this same post-budget source check after their final
          // fleet await below. Do not duplicate two snapshot transactions per attempt here.
          if (!quotaLease) {
            await this.assertTenantGeneration(tenantId, generation);
            await this.currentQuotaRequest(principal, snapshot);
          }
          if (sourceGuard) await sourceGuard();
          lease?.assertOpen(); signal?.throwIfAborted();
        }
        const headers = new Headers(
          args[1]?.headers
            ?? (args[0] instanceof Request ? args[0].headers : undefined),
        );
        // Only the strictly generated W3C header crosses the provider boundary. Vendor state and
        // baggage are caller-controlled and may contain owner identifiers or other sensitive text.
        headers.delete("tracestate");
        headers.delete("baggage");
        headers.set(TRACEPARENT_HEADER, outgoingTraceparent());
        if (pin) {
          const configuredHeaders = snapshot.scope === "tenant" ? new Headers(snapshot.config.headers) : undefined;
          const configured = configuredHeaders?.get("authorization") ?? null;
          const expected = configured ?? (pin.apiKey === undefined ? null : `Bearer ${pin.apiKey}`);
          if (headers.get("authorization") !== expected) throw new ProviderPoolError("unavailable");
          // Any configured header may carry credentials. Bind every configured value without
          // guessing secret-bearing names; unconfigured SDK headers remain unconstrained. The
          // three service-owned W3C fields are never credential channels or caller passthrough.
          if (configuredHeaders) for (const [name, value] of configuredHeaders) {
            if ([TRACEPARENT_HEADER, "tracestate", "baggage"].includes(name)) continue;
            if (headers.get(name) !== value) throw new ProviderPoolError("unavailable");
          }
        }
        if (poolLease) await poolLease.assertOpen();
        if (quotaLease) await quotaLease.assertOpen();
        // Family admission and the local final checks may await DB/I/O. Their completion cannot
        // reuse the fleet proof taken before that boundary, even for an already pinned key.
        if (quotaLease) {
          try { await this.quotaPolicy?.authorizeFleet?.(signal!); }
          catch (error) {
            if (error instanceof ProviderQuotaError || error instanceof SubjectDeletingError) throw error;
            if (signal?.aborted) throw new DOMException("Provider request aborted.", "AbortError");
            throw new ProviderQuotaError("unavailable");
          }
        }
        // Every governed request, not just a fallback candidate, must recheck its source after
        // the final fleet await: a concurrent rotation/shadow or T1 must not dispatch an old pin.
        if (quotaLease || sourceGuard) {
          await this.assertTenantGeneration(tenantId, generation);
          await this.currentQuotaRequest(principal, snapshot);
        }
        if (sourceGuard) await sourceGuard();
        lease?.assertOpen(); signal?.throwIfAborted();
        const init = { ...args[1], headers, ...(signal ? { signal } : {}) };
        try {
          dispatchEntered = true; dispatched?.();
          finishMetric = this.beginGatewayAttempt(snapshot.scope);
          response = await delegate(args[0], init);
        } catch (error) {
          delegateFailed = !signal?.aborted;
          // A rejected fetch owns no response body. Its original I/O is already joined, so
          // diagnostic telemetry must not inflate the I/O duration or keep the sample active.
          finishMetric?.(delegateFailed ? "transport_error" : callerSignal?.aborted ? "cancelled" : "local_abort");
          if (!delegateFailed) { markLocalFailure(); throw error; }
          if (this.opts.persistedProviderFailureCaptureActive === true) throw error;
          const fields = { errorKind: telemetryErrorKind(error) } as const;
          try {
            if (this.opts.tenantTelemetry) {
              await this.opts.tenantTelemetry.warn({
                tenantId,
                ownerKind: "tenant",
                ownerId: tenantId,
                ownerUserId: null,
              }, "provider.upstream_request_failed", fields);
            } else {
              // Without the managed owner-scoped capture boundary, retain only a content-free
              // operational signal. An opaque tenant ref is still durable owner data and must not
              // escape into an unmanaged process log.
              this.telemetry.warn("provider.upstream_request_failed", {
                ...fields,
              });
            }
          } catch {
            // Telemetry is diagnostic. A broken sink must not replace the provider failure that
            // controls the caller-visible retry/error semantics.
          }
          throw error;
        }
        try {
          lease?.assertOpen();
          signal?.throwIfAborted();
          if (quotaLease) {
            try { await quotaLease.assertOpen(); }
            catch (error) { throw error instanceof ProviderQuotaError ? error : new ProviderQuotaError("unavailable"); }
            await this.assertTenantGeneration(tenantId, generation);
            signal?.throwIfAborted();
          }
          if (poolLease) await poolLease.assertOpen();
        } catch (error) {
          // A non-cooperative fetch may return headers after the runtime fence won. Its response
          // body can still own a socket, so keep the provider-operation lease until cancellation
          // settles; otherwise the local drain could certify zero I/O while that body remains live.
          throw error;
        }
        if (quotaLease || poolLease || finishMetric) {
          if (!response.body) {
            try { await release("eof"); } catch (error) { if (response.ok) throw error; }
            return response;
          }
          const admission = quotaLease || poolLease ? { signal: combineSignals(quotaLease?.signal, poolLease?.signal)!, assertOpen: async () => {
            if (quotaLease) await quotaLease.assertOpen(); if (poolLease) await poolLease.assertOpen();
          } } : undefined;
          return responseWithQuotaTrackedBody(response, signal ?? new AbortController().signal, admission, release, executionSignal, markLocalFailure);
        }
        if (!lease || !response.body) {
          lease?.release();
          return response;
        }
        return responseWithTrackedBody(response, signal!, lease);
      } catch (error) {
        if (!dispatchEntered && !dispatched) this.observeGatewayRejection(snapshot.scope, error, callerSignal?.aborted === true);
        markLocalFailure();
        // The fetch promise itself has settled. If headers arrived late, its body must also
        // finish cancellation before either admission or the T3b operation is released.
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        await release().catch(() => {});
        throw error;
      }
    }) as typeof fetch;
  }

  private ensureRegistered(piProviderId: string, config: ProviderConfig, configIdentity: string, tenantId?: string) {
    // Deletion/recreation, including writes from another runner, may reuse a wall-clock timestamp.
    // The registered SDK handle must match the configuration used by this request's source guard.
    if (this.registered.get(piProviderId) === configIdentity) return;
    this.models.setProvider(
      createProvider({
        id: piProviderId,
        name: config.name ?? config.id,
        baseUrl: config.baseUrl,
        auth: {
          apiKey: {
            name: `${config.id} API key`,
            // Models.applyAuth takes the real per-request key from options.apiKey. An empty
            // resolution also permits explicit header-only auth, without borrowing SDK-store
            // credentials or consulting ambient env when that per-request key is undefined.
            resolve: async () => ({ auth: {}, source: "request" }),
          },
        },
        models: config.models.map((m) => toPiModel(piProviderId, config, m)),
        api: openAICompletionsApi(),
      }),
    );
    this.registered.set(piProviderId, configIdentity);
    if (tenantId) {
      let registrations = this.tenantRegistrations.get(tenantId);
      if (!registrations) {
        registrations = new Set();
        this.tenantRegistrations.set(tenantId, registrations);
      }
      registrations.add(piProviderId);
    }
  }

  snapshotTenant(tenantId: string) {
    return { providerRegistrations: this.tenantRegistrations.get(tenantId)?.size ?? 0 };
  }

  fenceTenant(_identity: TenantRuntimeDrainIdentity): void {
    // All provider I/O is owned by coordinator leases; abort is delivered there synchronously.
  }

  purgeTenant(identity: TenantRuntimeDrainIdentity): void {
    const registrations = this.tenantRegistrations.get(identity.tenantId);
    if (!registrations) return;
    for (const providerId of registrations) {
      this.models.deleteProvider(providerId);
      this.registered.delete(providerId);
    }
    this.tenantRegistrations.delete(identity.tenantId);
  }

  private async withTenantOperation<T>(tenantId: string, work: (lease?: TenantRuntimeLease) => Promise<T>): Promise<T> {
    const lease = this.opts.tenantRuntime?.enter(tenantId, "provider");
    try {
      const result = await work(lease);
      lease?.assertOpen();
      return result;
    } finally {
      lease?.release();
    }
  }
}

function combineSignals(...signals: (AbortSignal | null | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

/** Keep the provider operation alive until the response body is consumed, cancelled or aborted. */
function responseWithTrackedBody(response: Response, signal: AbortSignal, lease: TenantRuntimeLease): Response {
  const reader = response.body!.getReader();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    lease.release();
  };
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {}).finally(settle);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          settle();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
        settle();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
  const tracked = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // These metadata getters otherwise describe the synthetic Response rather than the actual fetch.
  Object.defineProperties(tracked, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return tracked;
}

/** One reader owns both the quota slot and the existing T3b operation. An abort notification is
 * not a settlement receipt: cancellation and any pending read must settle before release. */
function responseWithQuotaTrackedBody(response: Response, signal: AbortSignal, quota: Pick<ProviderQuotaLease, "signal" | "assertOpen"> | undefined,
  release: (completion: BodyCompletion) => Promise<void>, executionSignal: AbortSignal | undefined, localFailure: () => void): Response {
  const reader = response.body!.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let cancellation: Promise<void> | undefined;
  let settlement: Promise<void> | undefined;
  let releaseFailure: unknown;
  let terminal = false;
  const cancelReader = (reason: unknown) => cancellation ??= Promise.resolve().then(() => reader.cancel(reason));
  const fail = (error: unknown) => {
    if (terminal) return;
    terminal = true; controller?.error(error);
  };
  const settle = (completion: BodyCompletion) => settlement ??= (async () => {
    try {
      await reading?.catch(() => {});
      await cancellation?.catch(() => {});
      // A successful release itself aborts the coordinator's lease signal. Native read/cancel is
      // already settled here; that expected local close must not turn normal EOF into slot loss.
      signal.removeEventListener("abort", onAbort);
      try { await release(completion); }
      catch (error) {
        // A real HTTP failure remains a provider failure. release() already permanently fences
        // later dispatch; do not replace its status/body with a diagnostic admission failure.
        if (response.ok) { releaseFailure = error; throw error; }
      }
    } finally { signal.removeEventListener("abort", onAbort); }
  })();
  const abortError = () => quota?.signal.aborted ? new ProviderQuotaError("unavailable")
    : new DOMException("Provider request aborted.", "AbortError");
  const onAbort = () => {
    if (!terminal) localFailure();
    const reason = abortError();
    const cancelled = cancelReader(reason);
    // Stop buffered output immediately, but keep both leases until the original work settles.
    fail(reason);
    void cancelled.catch(() => {}).then(() => settle("cancelled")).catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull(value) {
      if (terminal) return;
      try {
        reading = reader.read();
        const chunk = await reading; reading = undefined;
        if (signal.aborted || terminal) {
          await cancelReader(abortError()).catch(() => {});
          if (signal.aborted) localFailure();
          await settle("cancelled").catch(() => {}); fail(abortError()); return;
        }
        if (chunk.done) {
          try { await quota?.assertOpen(); }
          catch (error) {
            if (!terminal) localFailure(); await settle("cancelled").catch(() => {});
            throw error instanceof ProviderQuotaError ? error : new ProviderQuotaError("unavailable");
          }
          if (signal.aborted) throw abortError();
          await settle("eof");
          if (executionSignal?.aborted) throw new DOMException("Provider request aborted.", "AbortError");
          if (!terminal) { terminal = true; value.close(); }
        } else { value.enqueue(chunk.value); }
      } catch (error) {
        const abortedAtError = signal.aborted;
        reading = undefined;
        await cancelReader(error).catch(() => {});
        await settle(abortedAtError ? "cancelled" : "failure").catch(() => {});
        if (!terminal && (abortedAtError || error === releaseFailure)) localFailure();
        fail(error);
      }
    },
    async cancel(reason) {
      terminal = true;
      try { await cancelReader(reason); }
      catch (error) { await settle("cancelled").catch(() => {}); throw error; }
      await settle("cancelled");
    },
  });
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const tracked = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperties(tracked, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } });
  return tracked;
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
