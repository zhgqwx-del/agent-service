import { createHash, randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import {
  Capabilities,
  guardRedisDatabaseSelection,
  DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
  DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
  ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1,
  ERASURE_JOB_CONTROL_QUARANTINE_V1,
  INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
  PURGE_POLICY_EVALUATOR_V1,
  ORDINARY_SESSION_USAGE_RETENTION_LOCAL_V1,
  TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
  TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1,
  TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
  TENANT_RUNTIME_DRAIN_V1,
  TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
  TENANT_CREDENTIAL_REVOCATION_STORE_V1,
  TENANT_CREDENTIAL_TARGET_EXECUTION_EXTERNAL_V1,
  TENANT_ERASURE_PLATFORM_CONTROL_V1,
  TENANT_BACKUP_CATALOG_AUTHORITATIVE_V1,
  TENANT_RESTORE_JOURNAL_INDEPENDENT_V1,
  TRACEPARENT_HEADER,
  TenantRuntimeDrainReady,
  USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
  outgoingTraceparent,
  tenantRuntimeFleetSha256,
  tenantRuntimeTargetSha256,
  type BlobStorageCapability,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER,
  PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL,
  PersistedProviderCaptureRunnerReady,
  awaitPersistedProviderCaptureResponse,
  persistedProviderCaptureBindingsEqual,
  persistedProviderCaptureConfiguredFleetRootSha256,
  persistedProviderCaptureFleetObservationSha256,
  readPersistedProviderCaptureJson,
  type PersistedProviderCaptureFleetRequest,
  type PersistedProviderCaptureFleetProof,
  MANAGED_MCP_REGISTRY_V1, MANAGED_MCP_DCR_V1, mcpRegistryIdentitiesEqual, type McpRegistryIdentityCapability,
  MANAGED_TENANT_HOOKS_V1, tenantHooksIdentitiesEqual, type ManagedTenantHooksIdentityCapability,
  RUNTIME_EXTENSIONS_V1, runtimeExtensionsIdentitiesEqual, runtimeExtensionsActivationMatches,
  INTERNAL_RUNTIME_EXTENSIONS_READY_PATH, INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER, INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE,
  RuntimeExtensionsFleetResponse,
  type RuntimeExtensionsActivation, type RuntimeExtensionsIdentity,
  PROVIDER_GATEWAY_QUOTA_V1, ProviderGatewayIdentity, ProviderGatewayFleetResponse,
  INTERNAL_PROVIDER_GATEWAY_READY_PATH, INTERNAL_PROVIDER_GATEWAY_ACK_HEADER, INTERNAL_PROVIDER_GATEWAY_ACK_VALUE,
  providerGatewayIdentitiesEqual, readProviderGatewayJson,
} from "@agent-service/protocol";

/**
 * Where a session should go. Two sources, in priority order:
 *  1. the ownership directory (`lease:{sid}` in Redis, written by whichever runner holds the lease) —
 *     authoritative about who is running the session right now;
 *  2. consistent hashing over the healthy runner pool — only a first guess for a session nobody owns.
 *
 * Routing is an optimisation, never a correctness mechanism: a wrong guess costs one extra hop,
 * because the runner rejects a session it does not own with 409 + `X-Owner`.
 */

export interface RunnerTarget {
  /** base url, e.g. http://10.0.0.7:8787 */
  url: string;
  healthy: boolean;
  lastCheckMs: number;
  consecutiveFailures: number;
  /** Last capability document from the same probe that marked this target healthy. */
  capabilities?: Capabilities;
}

/** Process-local evidence for one fresh, all-configured Gateway boundary. */
export interface ProviderGatewayProof {
  readonly identity: Readonly<ProviderGatewayIdentity>;
  readonly targets: readonly string[];
}

export interface RunnerRegistryOptions {
  providerGatewayIdentity?: ProviderGatewayIdentity;
  runtimeExtensions?: RuntimeExtensionsActivation;
  tenantHooksMasterKeyId?: string;
  mcpRegistryCredentialKeyId?: string;
  mcpRegistryCallbackUrlSha256?: string;
  mcpRegistryCoordinationNamespaceSha256?: string;
  skillRegistryStorage?: Capabilities["features"]["skillRegistryStorage"];
  runners: string[];
  /** Shared only with runners; required for fresh private runtime-drain identity probes. */
  internalRouterToken?: string;
  redisUrl?: string;
  redisPrefix?: string;
  /** Exact namespace identity required from every runner before T3g can execute. */
  redisNamespaceSha256?: string;
  /** Exact shared object namespace required before cross-runner Blob/export traffic is admitted. */
  blobStorage?: BlobStorageCapability;
  /** Exact independent restore-journal identities required before publication may execute. */
  restoreJournalNamespaceSha256?: string;
  restoreJournalTargetRootSha256?: string;
  restoreRuntimeEpochSha256?: string;
  /** how often to poll readiness and protocol compatibility */
  healthIntervalMs?: number;
  /** virtual nodes per runner on the hash ring */
  virtualNodes?: number;
  healthTimeoutMs?: number;
  redisCommandTimeoutMs?: number;
  /** Test seam for direct private capture probes; never a routing/healthy-pool shortcut. */
  captureFetchImpl?: typeof globalThis.fetch;
}

export interface TenantRuntimeDrainTarget {
  /** Exact configured instance-stable origin. No owner or port-fallback resolution is permitted. */
  readonly url: string;
  readonly targetSha256: string;
  readonly runnerId: string;
  readonly bootId: string;
}

export interface TenantRuntimeDrainFleetSnapshot {
  readonly fleetSha256: string;
  readonly targets: readonly TenantRuntimeDrainTarget[];
}

const TENANT_RUNTIME_READY_MAX_BYTES = 2_048;
const OWNER_IF_NOT_PURGED = `
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
return redis.call('HGET', KEYS[1], 'addr')
`;
const HAS_OWNER_IF_NOT_PURGED = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
return redis.call('EXISTS', KEYS[1])
`;

async function readJsonCapped(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("runner identity response has no body");
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error("runner identity response is too large");
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("runner identity response is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("runner identity response is malformed");
  }
}

const hash = (s: string) => {
  // 32-bit unsigned from the first 4 bytes of sha1: enough spread for a ring
  const d = createHash("sha1").update(s).digest();
  return d.readUInt32BE(0);
};

export class RunnerRegistry {
  private readonly targets = new Map<string, RunnerTarget>();
  private readonly ring: { point: number; url: string }[] = [];
  /**
   * Sticky only across transient health loss inside this router process. A target enters the set
   * after one successful probe containing both the quarantine and legacy-compensation contracts,
   * and leaves it after any later successful downgrade. This distinguishes an unobserved rollout
   * target from a known-compatible runner that crashed: the former must block activation, while
   * the latter must not deadlock erasure recovery.
   */
  private readonly erasureJobControlCompatible = new Set<string>();
  private readonly redis?: Redis;
  private timer?: NodeJS.Timeout;
  private checkInFlight?: Promise<void>;
  /** Serialized retention requests are separate from the tracker of an actual fleet probe. */
  private ordinarySessionUsageRetentionQueue: Promise<void> = Promise.resolve();
  private ordinarySessionUsageRetentionClosing = false;
  private persistedProviderCaptureClosing = false;
  private mcpRegistryClosing = false;
  private readonly mcpRegistryWork = new Set<{ abort: AbortController; done: Promise<unknown> }>();
  private readonly providerGatewayIdentity: ProviderGatewayIdentity | undefined;
  private observationSerial = 0;
  private readonly peerObservations = new Map<string, { published: number; denied: number }>();
  private readonly providerGatewayProofs = new WeakMap<ProviderGatewayProof, {
    signal: AbortSignal; observations: ReadonlyMap<string, number>;
  }>();
  private providerGatewayActiveProbes = 0;
  private readonly providerGatewayProbeQueue: {
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    onAbort: () => void;
  }[] = [];

  constructor(private readonly opts: RunnerRegistryOptions) {
    this.providerGatewayIdentity = opts.providerGatewayIdentity === undefined ? undefined
      : Object.freeze(ProviderGatewayIdentity.parse(opts.providerGatewayIdentity));
    for (const url of opts.runners) {
      const normalized = url.replace(/\/+$/, "");
      // Unknown until the first probe: reporting ready before any check makes /readyz lie during rollout.
      this.targets.set(normalized, { url: normalized, healthy: false, lastCheckMs: 0, consecutiveFailures: 0 });
      this.peerObservations.set(normalized, { published: 0, denied: 0 });
      for (let i = 0; i < (opts.virtualNodes ?? 64); i++) this.ring.push({ point: hash(`${normalized}#${i}`), url: normalized });
    }
    this.ring.sort((a, b) => a.point - b.point);
    if (opts.redisUrl) {
      // The directory is a cache. During a Redis failover every request would otherwise queue on it, so
      // commands fail fast and are never buffered offline.
      this.redis = guardRedisDatabaseSelection(new Redis(opts.redisUrl, {
        maxRetriesPerRequest: 1,
        commandTimeout: opts.redisCommandTimeoutMs ?? 300,
        enableOfflineQueue: false,
        lazyConnect: false,
      }));
      this.redis.on("error", () => {}); // handled per-command; an unhandled 'error' would crash the process
    }
  }

  private firstProbe?: Promise<void>;

  start(): void {
    const every = this.opts.healthIntervalMs ?? 5_000;
    this.firstProbe = this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), every);
    this.timer.unref?.();
  }

  /** Targets start unhealthy; wait for one probe so the first request is not answered with 503. */
  async waitForFirstProbe(timeoutMs = 5_000): Promise<void> {
    await Promise.race([this.firstProbe ?? Promise.resolve(), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.ordinarySessionUsageRetentionClosing = true;
    this.persistedProviderCaptureClosing = true;
    this.mcpRegistryClosing = true;
    for (const work of this.mcpRegistryWork) work.abort.abort();
    await Promise.allSettled([...this.mcpRegistryWork].map(work => work.done));
    await this.ordinarySessionUsageRetentionQueue;
    await this.checkInFlight?.catch(() => {});
    await this.redis?.quit().catch(() => {});
  }

  list(): RunnerTarget[] {
    return [...this.targets.values()];
  }

  /** The runner that currently holds this session's lease, if the directory knows one. */
  async owner(sessionId: string): Promise<string | undefined> {
    if (!this.redis) return undefined;
    try {
      const prefix = this.opts.redisPrefix ?? "as";
      const addr = await this.redis.eval(
        OWNER_IF_NOT_PURGED,
        2,
        `${prefix}:lease:{${sessionId}}`,
        `${prefix}:purge:{${sessionId}}`,
      );
      return typeof addr === "string" && addr.length > 0
        ? this.routeableUrl(addr)
        : undefined;
    } catch {
      return undefined; // the directory is a cache; losing it only costs an extra hop
    }
  }

  /**
   * Tri-state authoritative lease presence for destructive retry coordination. `false` is returned
   * only after Redis confirms the key is absent; an unavailable directory is `undefined`, never a
   * license to overlap a possibly-live provider/tool call.
   */
  async hasLeaseOwner(sessionId: string): Promise<boolean | undefined> {
    if (!this.redis) return undefined;
    try {
      const prefix = this.opts.redisPrefix ?? "as";
      return Number(await this.redis.eval(
        HAS_OWNER_IF_NOT_PURGED,
        2,
        `${prefix}:lease:{${sessionId}}`,
        `${prefix}:purge:{${sessionId}}`,
      )) === 1;
    } catch {
      return undefined;
    }
  }

  /** Ring position for a session nobody owns yet, skipping unhealthy runners. */
  candidate(sessionId: string): string | undefined {
    if (!this.ring.length) return undefined;
    const h = hash(sessionId);
    const start = this.ring.findIndex((p) => p.point >= h);
    const from = start === -1 ? 0 : start;
    for (let i = 0; i < this.ring.length; i++) {
      const url = this.ring[(from + i) % this.ring.length]!.url;
      if (this.targets.get(url)?.healthy) return url;
    }
    return undefined;
  }

  private rr = 0;

  /**
   * Any healthy runner, round-robin. Hashing the path instead would pin every `POST /v1/sessions` — the
   * single hottest route — onto one runner for the life of the process.
   */
  anyHealthy(): string | undefined {
    const healthy = this.list().filter((t) => t.healthy);
    if (!healthy.length) return undefined;
    return healthy[this.rr++ % healthy.length]!.url;
  }

  /**
   * Lifecycle writes are fleet semantics, not a per-request experiment. During a rolling upgrade
   * the router activates one only after every healthy runner advertises it; otherwise consistent
   * hashing or an existing owner could select an old implementation.
   */
  allHealthySupportLifecycle(feature: Capabilities["features"]["sessionLifecycle"][number]): boolean {
    const healthy = this.list().filter((target) => target.healthy);
    return healthy.length > 0 && healthy.every((target) => target.capabilities?.features.sessionLifecycle.includes(feature));
  }

  /** This slice is offline-cutover only; never advertise a randomly selected runner's MCP alone. */
  allConfiguredSupportMcp(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => target.healthy
      && target.capabilities?.features.mcp.includes("streamable-http"));
  }

  allConfiguredSupportSkills(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => target.healthy
      && target.capabilities?.features.skills === true);
  }

  allConfiguredSupportSkillRegistry(): boolean {
    const expected = this.opts.skillRegistryStorage, configured = this.list();
    return !!expected && configured.length > 0 && (expected.shared || configured.length === 1)
      && configured.every(target => {
        const actual = target.capabilities?.features.skillRegistryStorage;
        return target.healthy && target.capabilities?.features.skillRegistry.includes("managed-skill-registry-v1")
          && !!actual && actual.backend === expected.backend && actual.shared === expected.shared
          && actual.namespaceSha256 === expected.namespaceSha256 && this.matchesConfiguredBlobStorage(target);
      });
  }

  /** No healthy subset, stale downgrade or independently configured namespace can authorize MCP. */
  mcpRegistryConsensus(): McpRegistryIdentityCapability | null {
    const expectedKey = this.opts.mcpRegistryCredentialKeyId;
    const callback = this.opts.mcpRegistryCallbackUrlSha256, namespace = this.opts.mcpRegistryCoordinationNamespaceSha256;
    const configured = this.list();
    if (!expectedKey || !callback || !namespace || !configured.length) return null;
    let identity: McpRegistryIdentityCapability | null = null;
    for (const target of configured) {
      const actual = target.capabilities?.features.mcpRegistryIdentity;
      if (!target.healthy || !target.capabilities?.features.mcpRegistry.includes(MANAGED_MCP_REGISTRY_V1) || !actual
        || actual.credentialKeyId !== expectedKey || actual.callbackUrlSha256 !== callback
        || actual.coordinationNamespaceSha256 !== namespace || identity && !mcpRegistryIdentitiesEqual(actual, identity)) return null;
      identity = actual;
    }
    return identity ? { ...identity } : null;
  }

  allConfiguredSupportMcpRegistry(): boolean { return this.mcpRegistryConsensus() !== null; }

  allConfiguredSupportMcpDcr(): boolean {
    return this.allConfiguredSupportMcpRegistry() && this.list().every(target =>
      target.capabilities?.features.mcpDynamicRegistration.includes(MANAGED_MCP_DCR_V1));
  }

  /** The v1 operator-hook bit is deliberately irrelevant to managed tenant disclosure. */
  tenantHooksConsensus(): ManagedTenantHooksIdentityCapability | null {
    const configured = this.list(), expectedKeyId = this.opts.tenantHooksMasterKeyId;
    if (!expectedKeyId || !configured.length) return null;
    let identity: ManagedTenantHooksIdentityCapability | null = null;
    for (const target of configured) {
      const actual = target.capabilities?.features.tenantHooksIdentity;
      if (!target.healthy || !target.capabilities?.features.tenantHooks.includes(MANAGED_TENANT_HOOKS_V1)
        || !actual || actual.keyId !== expectedKeyId || identity && !tenantHooksIdentitiesEqual(identity, actual)) return null;
      identity = actual;
    }
    return identity ? { ...identity } : null;
  }
  allConfiguredSupportTenantHooks(): boolean { return this.tenantHooksConsensus() !== null; }

  runtimeExtensionsConsensus(): RuntimeExtensionsIdentity | null {
    const configured = this.list(), flags = this.opts.runtimeExtensions;
    if (!configured.length || !flags || !this.opts.internalRouterToken) return null;
    let identity: RuntimeExtensionsIdentity | null = null;
    for (const target of configured) {
      const actual = target.capabilities?.features.runtimeExtensionsIdentity;
      if (!target.healthy || !target.capabilities?.features.runtimeExtensions?.includes(RUNTIME_EXTENSIONS_V1)
        || !actual || !runtimeExtensionsActivationMatches(actual, flags)
        || identity && !runtimeExtensionsIdentitiesEqual(identity, actual)) return null;
      identity = actual;
    }
    return identity;
  }

  allConfiguredSupportRuntimeExtensions(): boolean { return this.runtimeExtensionsConsensus() !== null; }

  providerGatewayConsensus(): ProviderGatewayIdentity | null {
    const expected = this.providerGatewayIdentity, configured = this.list();
    if (!expected || !this.opts.internalRouterToken || !configured.length || this.ordinarySessionUsageRetentionClosing) return null;
    for (const target of configured) {
      const actual = target.capabilities?.features.providerGatewayIdentity;
      if (!target.healthy || !target.capabilities?.features.providerGateway.includes(PROVIDER_GATEWAY_QUOTA_V1)
        || !actual || !providerGatewayIdentitiesEqual(expected, actual)) return null;
    }
    return { ...expected };
  }
  allConfiguredSupportProviderGateway(): boolean { return this.providerGatewayConsensus() !== null; }

  private async attestProviderGateway(url: string, capabilities: Capabilities, signal: AbortSignal): Promise<void> {
    const expected = this.providerGatewayIdentity;
    if (!expected) return;
    if (!this.opts.internalRouterToken || this.ordinarySessionUsageRetentionClosing
      || !capabilities.features.providerGateway.includes(PROVIDER_GATEWAY_QUOTA_V1)
      || !capabilities.features.providerGatewayIdentity
      || !providerGatewayIdentitiesEqual(expected, capabilities.features.providerGatewayIdentity)) throw new Error("Provider gateway fleet is unavailable.");
    const nonce = randomBytes(32).toString("hex");
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await fetch(`${url}${INTERNAL_PROVIDER_GATEWAY_READY_PATH}`, {
        method: "POST", redirect: "manual", signal,
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: this.opts.internalRouterToken, "content-type": "application/json", [TRACEPARENT_HEADER]: outgoingTraceparent() },
        body: JSON.stringify({ nonce, identity: expected }),
      });
      signal.throwIfAborted();
      if (response.status !== 200 || response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER) !== INTERNAL_PROVIDER_GATEWAY_ACK_VALUE
        || !response.headers.get("cache-control")?.split(",").some(value => value.trim().toLowerCase() === "no-store")
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) throw new Error("Provider gateway fleet is unavailable.");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) throw new Error("Provider gateway fleet is unavailable.");
      const receipt = ProviderGatewayFleetResponse.parse(await readProviderGatewayJson(response.body, signal));
      signal.throwIfAborted();
      if (this.ordinarySessionUsageRetentionClosing || receipt.nonce !== nonce || !providerGatewayIdentitiesEqual(expected, receipt.identity)) throw new Error("Provider gateway fleet is unavailable.");
    } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }

  private async attestRuntimeExtensions(url: string, capabilities: Capabilities, signal: AbortSignal): Promise<void> {
    const flags = this.opts.runtimeExtensions;
    if (!flags?.lifecycleHooks && !flags?.subagents) return; // Old/off probes acquire no new authority.
    const identity = capabilities.features.runtimeExtensionsIdentity;
    if (this.ordinarySessionUsageRetentionClosing || !this.opts.internalRouterToken || !identity
      || !capabilities.features.runtimeExtensions?.includes(RUNTIME_EXTENSIONS_V1)
      || !runtimeExtensionsActivationMatches(identity, flags)) throw new Error("Runtime identity attestation unavailable");
    const nonce = randomBytes(32).toString("hex");
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, cancellation: Promise<void> | undefined;
    const cancel = () => { if (reader) cancellation ??= reader.cancel().catch(() => {}); };
    try {
      signal.throwIfAborted();
      response = await fetch(`${url}${INTERNAL_RUNTIME_EXTENSIONS_READY_PATH}`, { method: "POST", redirect: "manual", signal,
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: this.opts.internalRouterToken, "content-type": "application/json", [TRACEPARENT_HEADER]: outgoingTraceparent() },
        body: JSON.stringify({ nonce, identity }) });
      signal.throwIfAborted();
      if (response.status !== 200 || response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER) !== INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE
        || !response.headers.get("cache-control")?.split(",").some(value => value.trim().toLowerCase() === "no-store")
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "") || !response.body) throw new Error("Runtime identity attestation unavailable");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) throw new Error("Runtime identity attestation unavailable");
      reader = response.body.getReader(); signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
        size += next.value.byteLength; if (size > 2048) throw new Error("Runtime identity attestation unavailable"); chunks.push(next.value);
      }
      const receipt = RuntimeExtensionsFleetResponse.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      if (receipt.nonce !== nonce || !runtimeExtensionsIdentitiesEqual(receipt.identity, identity)) throw new Error("Runtime identity attestation unavailable");
      signal.throwIfAborted();
      if (this.ordinarySessionUsageRetentionClosing) throw new Error("Runtime identity attestation unavailable");
    } finally {
      signal.removeEventListener("abort", cancel);
      if (reader) { cancel(); try { await cancellation; } finally { reader.releaseLock(); } }
      else if (response) await response.body?.cancel().catch(() => {});
    }
  }

  /** New MCP HTTP work owns cancellation through response-body settlement and router shutdown. */
  async runMcpRegistryWork<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted(); if (this.mcpRegistryClosing) throw new Error("runner registry is closing");
    const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal]);
    const entry = { abort, done: Promise.resolve() as Promise<unknown> };
    this.mcpRegistryWork.add(entry);
    const done = Promise.resolve().then(() => { combined.throwIfAborted(); return work(combined); })
      .finally(() => this.mcpRegistryWork.delete(entry));
    entry.done = done; return done;
  }

  allConfiguredSupportHooks(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => target.healthy
      && target.capabilities?.features.hooks === true);
  }

  /** Revalidate the concrete destination immediately before a capability-gated write is sent. */
  supportsLifecycle(url: string, feature: Capabilities["features"]["sessionLifecycle"][number]): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy && !!target.capabilities?.features.sessionLifecycle.includes(feature);
  }

  private matchesConfiguredBlobStorage(target: RunnerTarget): boolean {
    const expected = this.opts.blobStorage;
    if (!expected) return true;
    const actual = target.capabilities?.features.blobStorage;
    return actual !== null
      && actual !== undefined
      && actual.backend === expected.backend
      && actual.shared === expected.shared
      && actual.namespaceSha256 === expected.namespaceSha256
      && actual.controlGeneration === expected.controlGeneration;
  }

  /** A configured restore epoch is a routing invariant, not only a destructive-worker feature. */
  private matchesConfiguredRestoreRuntime(capabilities: Capabilities): boolean {
    const expectedNamespace = this.opts.restoreJournalNamespaceSha256;
    const expectedTargetRoot = this.opts.restoreJournalTargetRootSha256;
    const expectedRuntimeEpoch = this.opts.restoreRuntimeEpochSha256;
    if (expectedNamespace === undefined
      && expectedTargetRoot === undefined
      && expectedRuntimeEpoch === undefined) return true;
    return expectedNamespace !== undefined
      && expectedTargetRoot !== undefined
      && expectedRuntimeEpoch !== undefined
      && capabilities.features.tenantRestoreJournal.includes(
        TENANT_RESTORE_JOURNAL_INDEPENDENT_V1,
      )
      && capabilities.features.tenantRestoreJournalNamespaceSha256 === expectedNamespace
      && capabilities.features.tenantRestoreJournalTargetRootSha256 === expectedTargetRoot
      && capabilities.features.tenantRestoreRuntimeEpochSha256 === expectedRuntimeEpoch;
  }

  allHealthySupportBlobAttachments(): boolean {
    const targets = this.opts.blobStorage?.shared
      // A shared namespace is a fleet invariant. An unavailable configured runner could recover
      // with a different namespace, so it may not be ignored while durable writes are admitted.
      ? this.list()
      : this.list().filter((target) => target.healthy);
    return targets.length > 0 && targets.every((target) => (
      target.healthy
      && target.capabilities?.features.blobAttachments === true
      && this.matchesConfiguredBlobStorage(target)
    ));
  }

  supportsBlobAttachments(url: string): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy
      && target.capabilities?.features.blobAttachments === true
      && this.matchesConfiguredBlobStorage(target);
  }

  allHealthySupportDataErasureRequests(): boolean {
    const healthy = this.list().filter((target) => target.healthy);
    return healthy.length > 0 && healthy.every((target) => target.capabilities?.features.dataErasureRequests === true);
  }

  /**
   * Erasure admission is irreversible: an unavailable legacy writer cannot be ignored merely
   * because it is absent from the currently healthy subset. Require every configured destination
   * to have completed a healthy capability probe before the router may accept the first gate.
   */
  allConfiguredSupportDataErasureRequests(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy && target.capabilities?.features.dataErasureRequests === true
    ));
  }

  /** Irreversible admission is fail-closed across every configured stable runner. */
  allConfiguredSupportTenantErasureControl(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantErasureControl.includes(
        TENANT_ERASURE_PLATFORM_CONTROL_V1,
      ) === true
    ));
  }

  /** Status is reversible: require every currently healthy target to understand the control read. */
  allHealthySupportTenantErasureControl(): boolean {
    const healthy = this.list().filter((target) => target.healthy);
    return healthy.length > 0 && healthy.every((target) => (
      target.capabilities?.features.tenantErasureControl.includes(
        TENANT_ERASURE_PLATFORM_CONTROL_V1,
      ) === true
    ));
  }

  /** New admissions additionally require every configured runner's independent activation gate. */
  allConfiguredSupportTenantErasureAdmission(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      this.supportsTenantErasureControl(target.url)
      && target.capabilities?.features.tenantErasureRequests === true
    ));
  }

  supportsTenantErasureControl(url: string): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy && target.capabilities?.features.tenantErasureControl.includes(
      TENANT_ERASURE_PLATFORM_CONTROL_V1,
    ) === true;
  }

  supportsTenantErasureAdmission(url: string): boolean {
    const normalized = url.replace(/\/+$/, "");
    const target = this.targets.get(normalized);
    return this.supportsTenantErasureControl(normalized)
      && target?.capabilities?.features.tenantErasureRequests === true;
  }

  supportsDataErasureRequests(url: string): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy && target.capabilities?.features.dataErasureRequests === true;
  }

  /** Policy activation changes how every new erasure request is bound, so unavailable writers count. */
  allConfiguredSupportDataGovernance(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.dataGovernance.includes(
        DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
      ) === true
      && target.capabilities.features.dataGovernance.includes(
        DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
      )
    ));
  }

  supportsDataGovernance(url: string): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy
      && target.capabilities?.features.dataGovernance.includes(
        DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
      ) === true
      && target.capabilities.features.dataGovernance.includes(
        DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
      );
  }

  /** Endpoint activation is separate from writer awareness and must also be homogeneous. */
  allConfiguredSupportDataGovernanceManagement(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      this.supportsDataGovernance(target.url)
      && target.capabilities?.features.dataGovernanceManagement === true
    ));
  }

  supportsDataGovernanceManagement(url: string): boolean {
    const normalized = url.replace(/\/+$/, "");
    const target = this.targets.get(normalized);
    return this.supportsDataGovernance(normalized)
      && target?.capabilities?.features.dataGovernanceManagement === true;
  }

  allHealthySupportUserDataExport(): boolean {
    const healthy = this.opts.blobStorage?.shared
      ? this.list()
      : this.list().filter((target) => target.healthy);
    return healthy.length > 0 && healthy.every((target) => (
      target.healthy
      && this.matchesConfiguredBlobStorage(target)
      && target.capabilities?.features.userDataExport.includes(
        USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
      ) === true
    ));
  }

  allConfiguredSupportUserDataExportAdmission(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && this.matchesConfiguredBlobStorage(target)
      && target.capabilities?.features.userDataExport.includes(
        USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
      ) === true
      && target.capabilities.features.dataExportRequests === true
    ));
  }

  supportsUserDataExport(url: string): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy && this.matchesConfiguredBlobStorage(target) && target.capabilities?.features.userDataExport.includes(
      USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
    ) === true;
  }

  /**
   * Evaluation writes a durable sealed decision, so every configured stable destination must be
   * healthy and code-aware before any evaluator may claim work. An unavailable runner is not
   * silently removed from this rollout boundary.
   */
  allConfiguredSupportPurgePolicyEvaluation(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.purgePolicyEvaluation.includes(
        PURGE_POLICY_EVALUATOR_V1,
      ) === true
    ));
  }

  /**
   * Credential cleanup is irreversible even though it is narrower than content purge. Never use
   * the healthy subset or the sticky erasure-control observation: every configured stable address
   * must prove the current code contract in the same fleet snapshot.
   */
  allConfiguredSupportTenantCredentialRevocation(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantCredentialRevocation.includes(
        TENANT_CREDENTIAL_REVOCATION_STORE_V1,
      ) === true
    ));
  }

  /** Every configured writer must understand the same versioned credential-ledger protocol. */
  allConfiguredSupportTenantCredentialLifecycle(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantCredentialLifecycle.includes(
        TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
      ) === true
    ));
  }

  /** The irreversible T3a boundary additionally requires the shared cutover to be observed active. */
  allConfiguredTenantCredentialLifecycleTrackingActive(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantCredentialLifecycle.includes(
        TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
      ) === true
      && target.capabilities.features.tenantCredentialLifecycleTrackingActive === true
    ));
  }

  /** Every configured code-aware runner must also have its local worker explicitly active. */
  allConfiguredSupportTenantCredentialRevocationWorker(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantCredentialRevocation.includes(
        TENANT_CREDENTIAL_REVOCATION_STORE_V1,
      ) === true
      && target.capabilities.features.tenantCredentialLifecycle.includes(
        TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
      )
      && target.capabilities.features.tenantCredentialLifecycleTrackingActive === true
      && target.capabilities.features.tenantCredentialRevocationWorker === true
    ));
  }

  /** External mutation is irreversible, so unavailable configured runners cannot be omitted. */
  allConfiguredSupportTenantCredentialTargetExecution(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantCredentialLifecycle.includes(
        TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
      ) === true
      && target.capabilities.features.tenantCredentialLifecycleTrackingActive === true
      && target.capabilities.features.tenantCredentialTargetExecution.includes(
        TENANT_CREDENTIAL_TARGET_EXECUTION_EXTERNAL_V1,
      )
    ));
  }

  /** Fresh worker authority additionally requires an active executor on every configured runner. */
  allConfiguredSupportTenantCredentialTargetExecutionWorker(): boolean {
    return this.allConfiguredSupportTenantCredentialTargetExecution()
      && this.list().every((target) => (
        target.capabilities?.features.tenantCredentialTargetExecutionWorker === true
      ));
  }

  /** Every configured runner must prove the same independent journal and target-set identity. */
  allConfiguredSupportTenantRestoreJournal(): boolean {
    const configured = this.list();
    const expectedNamespace = this.opts.restoreJournalNamespaceSha256;
    const expectedTargetRoot = this.opts.restoreJournalTargetRootSha256;
    const expectedRuntimeEpoch = this.opts.restoreRuntimeEpochSha256;
    return expectedNamespace !== undefined
      && expectedTargetRoot !== undefined
      && expectedRuntimeEpoch !== undefined
      && configured.length > 0
      && configured.every((target) => (
        target.healthy
        && target.capabilities?.features.tenantRestoreJournal.includes(
          TENANT_RESTORE_JOURNAL_INDEPENDENT_V1,
        ) === true
        && target.capabilities.features.tenantRestoreJournalNamespaceSha256
          === expectedNamespace
        && target.capabilities.features.tenantRestoreJournalTargetRootSha256
          === expectedTargetRoot
        && target.capabilities.features.tenantRestoreRuntimeEpochSha256
          === expectedRuntimeEpoch
      ));
  }

  /** Publication authority additionally requires an active worker on every configured runner. */
  allConfiguredSupportTenantRestoreJournalWorker(): boolean {
    return this.allConfiguredSupportTenantRestoreJournal()
      && this.list().every((target) => (
        target.capabilities?.features.tenantRestoreJournalWorker === true
      ));
  }

  /** 0031 code awareness requires every configured runner; activation additionally needs consensus. */
  allConfiguredSupportTenantBackupCatalog(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantBackupCatalog.includes(
        TENANT_BACKUP_CATALOG_AUTHORITATIVE_V1,
      ) === true
    ));
  }

  tenantBackupCatalogConsensus(): {
    active: boolean;
    namespaceSha256: string | null;
    targetSha256: string | null;
    runtimeBindingSha256: string | null;
  } {
    if (!this.allConfiguredSupportTenantBackupCatalog()) {
      return {
        active: false,
        namespaceSha256: null,
        targetSha256: null,
        runtimeBindingSha256: null,
      };
    }
    const features = this.list().map((target) => target.capabilities!.features);
    if (!features.every((value) => value.tenantBackupCatalogActive === true)) {
      return {
        active: false,
        namespaceSha256: null,
        targetSha256: null,
        runtimeBindingSha256: null,
      };
    }
    const first = features[0]!;
    const namespaceSha256 = first.tenantBackupCatalogNamespaceSha256;
    const targetSha256 = first.tenantBackupCatalogTargetSha256;
    const runtimeBindingSha256 = first.tenantBackupCatalogRuntimeBindingSha256;
    if (namespaceSha256 === null || targetSha256 === null || runtimeBindingSha256 === null
      || !features.every((value) => (
        value.tenantBackupCatalogNamespaceSha256 === namespaceSha256
        && value.tenantBackupCatalogTargetSha256 === targetSha256
        && value.tenantBackupCatalogRuntimeBindingSha256 === runtimeBindingSha256
      ))) {
      return {
        active: false,
        namespaceSha256: null,
        targetSha256: null,
        runtimeBindingSha256: null,
      };
    }
    return { active: true, namespaceSha256, targetSha256, runtimeBindingSha256 };
  }

  /** Every configured runner must freshly prove the exact local T3e execution/ACK contract. */
  allConfiguredSupportTenantPurgeExecution(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantPurgeExecution.includes(
        TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
      ) === true
    ));
  }

  /** Destructive authority additionally requires every code-aware runner's worker to be active. */
  allConfiguredSupportTenantPurgeExecutionWorker(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantPurgeExecution.includes(
        TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
      ) === true
      && target.capabilities.features.tenantPurgeExecutionWorker === true
    ));
  }

  /** Every configured runner must understand the distinct T3f database-content contract. */
  allConfiguredSupportTenantDatabasePurge(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantPurgeExecution.includes(
        TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
      ) === true
      && target.capabilities?.features.tenantPurgeExecution.includes(
        TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1,
      ) === true
    ));
  }

  /** T3f authority requires the exact capability and an active worker on every configured runner. */
  allConfiguredSupportTenantDatabasePurgeWorker(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantPurgeExecution.includes(
        TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
      ) === true
      && target.capabilities?.features.tenantPurgeExecution.includes(
        TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1,
      ) === true
      && target.capabilities.features.tenantDatabasePurgeWorker === true
    ));
  }

  /** Code-awareness alone conveys no ordinary usage deletion authority. */
  allConfiguredSupportOrdinarySessionUsageRetention(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.ordinarySessionUsageRetention.includes(
        ORDINARY_SESSION_USAGE_RETENTION_LOCAL_V1,
      ) === true
    ));
  }

  allConfiguredSupportOrdinarySessionUsageRetentionWorker(): boolean {
    return this.allConfiguredSupportOrdinarySessionUsageRetention()
      && this.list().every((target) => target.capabilities?.features.ordinarySessionUsageRetentionWorker === true);
  }

  /** Every configured runner must understand T3g and target this exact Redis namespace. */
  allConfiguredSupportTenantRedisPurge(): boolean {
    const expectedNamespace = this.opts.redisNamespaceSha256;
    const configured = this.list();
    return expectedNamespace !== undefined && configured.length > 0 && configured.every((target) => (
      target.healthy
      && target.capabilities?.features.tenantRedisPurge.includes(
        TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
      ) === true
      && target.capabilities.features.tenantRedisPurgeNamespaceSha256 === expectedNamespace
    ));
  }

  /** Destructive authority additionally requires the T3g worker active on every configured runner. */
  allConfiguredSupportTenantRedisPurgeWorker(): boolean {
    return this.allConfiguredSupportTenantRedisPurge()
      && this.list().every((target) => (
        target.capabilities?.features.tenantRedisPurgeWorker === true
      ));
  }

  /** Existing durable erasure jobs keep running even when admission of new requests is disabled. */
  allHealthySupportUserErasureWorker(): boolean {
    const healthy = this.list().filter((target) => target.healthy);
    return healthy.length > 0 && healthy.every((target) => (
      target.capabilities?.features.userErasureWorker.includes("drain-v1") === true
    ));
  }

  supportsUserErasureWorker(url: string): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy
      && target.capabilities?.features.userErasureWorker.includes("drain-v1") === true;
  }

  /**
   * Publishing a quarantine or compensating a generation-zero tombstone changes durable state.
   * Every configured target must first have been observed on both additive contracts. Once
   * observed, a transient crash does not close the worker barrier: otherwise the surviving worker
   * could never recover that runner's live session lease. A later successful downgrade removes the
   * target from this set and closes the V2 barrier.
   */
  allConfiguredSupportErasureJobControl(): boolean {
    const configured = this.list();
    return configured.length > 0
      && configured.every((target) => this.erasureJobControlCompatible.has(target.url));
  }

  /**
   * Build a new all-configured T3b fleet snapshot from direct, private per-instance probes. This
   * deliberately does not consume the periodically cached health state, sticky rollout state,
   * owner directory or port fallback. A caller gets either one identity for every exact configured
   * URL or no snapshot at all.
   */
  async freshTenantRuntimeDrainSnapshot(): Promise<TenantRuntimeDrainFleetSnapshot> {
    const token = this.opts.internalRouterToken;
    if (!token) throw new Error("tenant runtime drain identity probe is disabled");
    const configured = [...this.targets.values()];
    if (!configured.length || configured.length > 100) {
      throw new Error("tenant runtime drain fleet size is invalid");
    }

    const targets = await Promise.all(configured.map(async (target) => {
      const signal = AbortSignal.timeout(this.opts.healthTimeoutMs ?? 2_000);
      const request = () => ({
        signal,
        redirect: "manual" as const,
        headers: { [TRACEPARENT_HEADER]: outgoingTraceparent() },
      });
      const ready = await fetch(`${target.url}/readyz`, request());
      if (!ready.ok) {
        await ready.body?.cancel().catch(() => {});
        throw new Error("configured tenant runtime target is not ready");
      }
      await ready.body?.cancel().catch(() => {});

      const capabilitiesResponse = await fetch(`${target.url}/v1/capabilities`, request());
      if (!capabilitiesResponse.ok) {
        await capabilitiesResponse.body?.cancel().catch(() => {});
        throw new Error("configured tenant runtime target has no capability document");
      }
      const capabilitiesPayload = await readJsonCapped(
        capabilitiesResponse,
        TENANT_RUNTIME_READY_MAX_BYTES,
      );
      const capabilities = Capabilities.safeParse(capabilitiesPayload);
      if (
        !capabilities.success
        || capabilities.data.service !== "agent-runner"
        || !capabilities.data.features.tenantRuntimeDrain.includes(TENANT_RUNTIME_DRAIN_V1)
        || capabilities.data.features.tenantRuntimeDrainEndpoint !== true
      ) throw new Error("configured tenant runtime target is incompatible");

      const identityResponse = await fetch(
        `${target.url}${INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH}`,
        {
          signal,
          redirect: "manual" as const,
          headers: {
            [INTERNAL_ROUTER_TOKEN_HEADER]: token,
            [TRACEPARENT_HEADER]: outgoingTraceparent(),
          },
        },
      );
      if (
        identityResponse.status !== 200
        || identityResponse.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)
          !== INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE
        || !identityResponse.headers.get("cache-control")?.split(",").some((value) => (
          value.trim().toLowerCase() === "no-store"
        ))
      ) {
        await identityResponse.body?.cancel().catch(() => {});
        throw new Error("configured tenant runtime target did not attest its identity");
      }
      const identityPayload = await readJsonCapped(
        identityResponse,
        TENANT_RUNTIME_READY_MAX_BYTES,
      );
      const identity = TenantRuntimeDrainReady.safeParse(identityPayload);
      if (!identity.success) {
        throw new Error("configured tenant runtime target returned an invalid identity");
      }
      return Object.freeze({
        url: target.url,
        targetSha256: tenantRuntimeTargetSha256(target.url),
        runnerId: identity.data.runnerId,
        bootId: identity.data.bootId,
      });
    }));

    const sorted = targets.sort((left, right) => (
      left.targetSha256 < right.targetSha256
        ? -1
        : left.targetSha256 > right.targetSha256
          ? 1
          : 0
    ));
    if (
      new Set(sorted.map((target) => target.targetSha256)).size !== sorted.length
      || new Set(sorted.map((target) => target.runnerId)).size !== sorted.length
      || new Set(sorted.map((target) => target.bootId)).size !== sorted.length
    ) throw new Error("configured tenant runtime target identities are not unique");

    return Object.freeze({
      fleetSha256: tenantRuntimeFleetSha256(sorted),
      targets: Object.freeze(sorted),
    });
  }

  /** Independent, nonce-bound all-configured probes. No health cache, sticky state or port fallback. */
  async freshPersistedProviderCaptureSnapshot(request: PersistedProviderCaptureFleetRequest, signal: AbortSignal): Promise<{
    proof: PersistedProviderCaptureFleetProof; fleetObservationSha256: string;
  }> {
    signal.throwIfAborted();
    if (this.persistedProviderCaptureClosing || !this.opts.internalRouterToken) throw new Error("capture fleet is closed");
    const configured = [...this.targets.values()];
    if (!configured.length || configured.length > 100) throw new Error("capture fleet size is invalid");
    const fetchImpl = this.opts.captureFetchImpl ?? globalThis.fetch;
    const targets = await Promise.all(configured.map(async (target) => {
      const boundarySignal = AbortSignal.any([signal, AbortSignal.timeout(this.opts.healthTimeoutMs ?? 2_000)]);
      const nonce = randomBytes(32).toString("hex");
      const response = await awaitPersistedProviderCaptureResponse(fetchImpl(
        `${target.url}${INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH}`, {
          method: "GET", redirect: "manual", signal: boundarySignal,
          headers: {
            [INTERNAL_ROUTER_TOKEN_HEADER]: this.opts.internalRouterToken!,
            [INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER]: nonce,
            [TRACEPARENT_HEADER]: outgoingTraceparent(),
          },
        },
      ), boundarySignal);
      if (response.status !== 200
        || response.headers.get(INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER) !== INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE
        || !response.headers.get("cache-control")?.split(",").some((value) => value.trim().toLowerCase() === "no-store")) {
        void response.body?.cancel().catch(() => {});
        throw new Error("configured capture target did not attest");
      }
      const ready = PersistedProviderCaptureRunnerReady.parse(await readPersistedProviderCaptureJson(response, boundarySignal));
      if (ready.nonce !== nonce || ready.configuredFleetRootSha256 !== request.configuredFleetRootSha256
        || !persistedProviderCaptureBindingsEqual(ready.binding, request.binding)) throw new Error("configured capture target identity drifted");
      return { url: target.url, runnerId: ready.runnerId, bootId: ready.bootId };
    }));
    signal.throwIfAborted();
    if (this.persistedProviderCaptureClosing
      || new Set(targets.map((target) => target.runnerId)).size !== targets.length
      || new Set(targets.map((target) => target.bootId)).size !== targets.length
      || targets.filter((target) => target.runnerId === request.runnerId && target.bootId === request.bootId).length !== 1
      || persistedProviderCaptureConfiguredFleetRootSha256(targets) !== request.configuredFleetRootSha256) {
      throw new Error("configured capture fleet or requester identity is invalid");
    }
    return {
      proof: { ...request.binding, protocol: PERSISTED_PROVIDER_CAPTURE_FLEET_PROTOCOL, configuredFleetRootSha256: request.configuredFleetRootSha256 },
      fleetObservationSha256: persistedProviderCaptureFleetObservationSha256(targets),
    };
  }

  /**
   * A runner address as reported by `X-Owner` (host:port) mapped back onto a configured target.
   * Matching on the port alone as a fallback covers the common misconfiguration where a runner advertises
   * a wildcard or container-internal host (`0.0.0.0:8787`) that never string-matches the configured URL.
   */
  toUrl(addr: string): string | undefined {
    const bare = addr.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    for (const t of this.targets.keys()) if (t.replace(/^https?:\/\//, "") === bare) return t;
    const port = bare.split(":").at(-1);
    if (!port || !/^\d+$/.test(port)) return undefined;
    const byPort = [...this.targets.keys()].filter((t) => t.endsWith(`:${port}`));
    return byPort.length === 1 ? byPort[0] : undefined;
  }

  /** Resolve an advertised owner only when it passed both readiness and protocol probes. */
  routeableUrl(addr: string): string | undefined {
    const url = this.toUrl(addr);
    return url && this.targets.get(url)?.healthy ? url : undefined;
  }

  markFailure(url: string): void {
    const t = this.targets.get(url);
    if (!t) return;
    const observation = ++this.observationSerial;
    const peer = this.peerObservations.get(url)!;
    peer.published = observation;
    t.consecutiveFailures += 1;
    if (t.consecutiveFailures >= 2) {
      t.healthy = false;
      peer.denied = observation;
    }
  }

  /** Force one serialized current-fleet probe for irreversible control-plane decisions. */
  async refresh(): Promise<void> {
    await this.checkAll();
  }

  /** A retention boundary cannot inherit a probe that started before its own request. */
  async refreshOrdinarySessionUsageRetention(signal = AbortSignal.timeout(5_000)): Promise<void> {
    return this.refreshFeatureBoundary(signal);
  }

  async refreshSkillRegistry(signal = AbortSignal.timeout(5_000)): Promise<void> {
    return this.refreshFeatureBoundary(signal);
  }

  async refreshMcpRegistry(signal = AbortSignal.timeout(5_000)): Promise<void> {
    return this.refreshFeatureBoundary(signal);
  }
  async refreshTenantHooks(signal = AbortSignal.timeout(5_000)): Promise<void> {
    return this.refreshFeatureBoundary(signal);
  }
  async refreshRuntimeExtensions(signal = AbortSignal.timeout(5_000)): Promise<void> {
    return this.refreshFeatureBoundary(signal);
  }
  async refreshProviderGateway(signal = AbortSignal.timeout(5_000)): Promise<ProviderGatewayProof> {
    signal.throwIfAborted();
    if (!this.providerGatewayIdentity || !this.opts.internalRouterToken || !this.targets.size
      || this.ordinarySessionUsageRetentionClosing) throw new Error("Provider gateway fleet is unavailable.");
    // The original peer budget includes admission wait; acquiring a permit never restarts it.
    const deadline = AbortSignal.timeout(this.opts.healthTimeoutMs ?? 2_000);
    // Unlike the other feature boundaries this call owns its probes, not a shared queue tail.
    // Shutdown/caller cancellation retains ownership until every actual body has settled.
    return this.runMcpRegistryWork(signal, async workSignal => {
      const release = await this.acquireProviderGatewayProbe(AbortSignal.any([workSignal, deadline]));
      try {
        workSignal.throwIfAborted(); deadline.throwIfAborted();
        const abort = new AbortController(), probeSignal = AbortSignal.any([workSignal, abort.signal]);
        const observations = new Map<string, number>();
        const results = await Promise.allSettled([...this.targets].map(([url, target]) => {
          const observation = ++this.observationSerial;
          observations.set(url, observation);
          return this.probeRunner(target, observation, probeSignal, true, () => abort.abort(), deadline).then(
            result => { if (!result) abort.abort(); return result; },
            error => { abort.abort(); throw error; },
          );
        }));
        workSignal.throwIfAborted(); deadline.throwIfAborted();
        if (results.some(result => result.status !== "fulfilled" || !result.value)) throw new Error("Provider gateway fleet is unavailable.");
        const proof: ProviderGatewayProof = Object.freeze({
          identity: Object.freeze({ ...this.providerGatewayIdentity! }),
          targets: Object.freeze([...observations.keys()]),
        });
        this.providerGatewayProofs.set(proof, { signal, observations });
        try { this.assertProviderGatewayProof(proof, signal); }
        catch (error) { this.releaseProviderGatewayProof(proof); throw error; }
        return proof;
      } finally { release(); }
    });
  }

  private acquireProviderGatewayProbe(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.mcpRegistryClosing || this.ordinarySessionUsageRetentionClosing) throw new Error("Provider gateway fleet is unavailable.");
    if (this.providerGatewayActiveProbes < 32 && !this.providerGatewayProbeQueue.length) {
      return Promise.resolve(this.ownProviderGatewayProbe());
    }
    if (this.providerGatewayProbeQueue.length >= 1_024) throw new Error("Provider gateway fleet is unavailable.");
    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, onAbort: () => {} };
      waiter.onAbort = () => {
        const index = this.providerGatewayProbeQueue.indexOf(waiter);
        if (index === -1) return; // A handed-off permit belongs to the active call's finally.
        this.providerGatewayProbeQueue.splice(index, 1);
        signal.removeEventListener("abort", waiter.onAbort);
        reject(signal.reason);
      };
      this.providerGatewayProbeQueue.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
  }

  private ownProviderGatewayProbe(): () => void {
    this.providerGatewayActiveProbes += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.providerGatewayActiveProbes -= 1;
      this.pumpProviderGatewayProbes();
    };
  }

  private pumpProviderGatewayProbes(): void {
    while (this.providerGatewayProbeQueue.length) {
      const waiter = this.providerGatewayProbeQueue[0]!;
      if (this.mcpRegistryClosing || this.ordinarySessionUsageRetentionClosing || waiter.signal.aborted) {
        this.providerGatewayProbeQueue.shift();
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(new Error("Provider gateway fleet is unavailable."));
        continue;
      }
      if (this.providerGatewayActiveProbes >= 32) return;
      this.providerGatewayProbeQueue.shift();
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      // No await between the final liveness check and transferring an active permit.
      waiter.resolve(this.ownProviderGatewayProbe());
    }
  }

  assertProviderGatewayProof(proof: ProviderGatewayProof, signal: AbortSignal, target?: string): void {
    const state = this.providerGatewayProofs.get(proof);
    if (!state || state.signal !== signal || signal.aborted || this.ordinarySessionUsageRetentionClosing
      || this.mcpRegistryClosing || target !== undefined && !state.observations.has(target)) {
      throw new Error("Provider gateway fleet is unavailable.");
    }
    for (const [url, observation] of state.observations) {
      // Success never erases a denial: an older proof cannot be revived by a later recovery.
      if ((this.peerObservations.get(url)?.denied ?? Infinity) > observation) {
        throw new Error("Provider gateway fleet is unavailable.");
      }
    }
  }

  releaseProviderGatewayProof(proof: ProviderGatewayProof): void {
    this.providerGatewayProofs.delete(proof);
  }

  private async refreshFeatureBoundary(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.ordinarySessionUsageRetentionClosing) throw new Error("runner registry is closing");
    };
    assertCurrent();
    const check = this.ordinarySessionUsageRetentionQueue.then(async () => {
      assertCurrent(); // Expired queued requests never start or occupy an actual fleet probe.
      while (this.checkInFlight) {
        await this.checkInFlight.catch(() => {});
        assertCurrent();
      }
      // No await between the empty tracker check and installing our own actual probe.
      await this.beginActualProbe(signal);
      assertCurrent();
    });
    this.ordinarySessionUsageRetentionQueue = check.catch(() => {});
    // Only the independent queue tail swallows rejection; shared old refresh/periodic callers
    // always begin or inherit a real checkAllOnce, never an expired request which did not probe.
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([check, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]);
      signal.throwIfAborted();
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private checkAll(): Promise<void> {
    if (this.checkInFlight) return this.checkInFlight;
    return this.beginActualProbe();
  }

  private beginActualProbe(boundarySignal?: AbortSignal): Promise<void> {
    const check = this.checkAllOnce(boundarySignal);
    const tracked = check.finally(() => {
      if (this.checkInFlight === tracked) this.checkInFlight = undefined;
    });
    this.checkInFlight = tracked;
    return tracked;
  }

  private async checkAllOnce(boundarySignal?: AbortSignal): Promise<void> {
    await Promise.all([...this.targets.values()].map(target => (
      this.probeRunner(target, ++this.observationSerial, boundarySignal)
    )));
  }

  /** A newer-started observation owns publication, including eager sticky revocation. */
  private publishObservation(target: RunnerTarget, observation: number, update: () => void, denied = false): void {
    const peer = this.peerObservations.get(target.url)!;
    if (observation < peer.published) return;
    peer.published = observation;
    if (denied) peer.denied = Math.max(peer.denied, observation);
    update();
  }

  private async probeRunner(target: RunnerTarget, observation: number, boundarySignal?: AbortSignal,
    preserveOnBoundaryAbort = false, onFailure?: () => void, deadline?: AbortSignal): Promise<boolean> {
    const timeout = deadline ?? AbortSignal.timeout(this.opts.healthTimeoutMs ?? 2_000);
    const signal = boundarySignal ? AbortSignal.any([boundarySignal, timeout]) : timeout;
    const publish = (update: () => void, denied = false) => {
      // Caller cancellation is not evidence that this peer became incompatible.
      if (preserveOnBoundaryAbort && (boundarySignal?.aborted || this.mcpRegistryClosing)) return;
      this.publishObservation(target, observation, update, denied);
    };
    const revokeSticky = () => publish(() => this.erasureJobControlCompatible.delete(target.url), true);
    const request = () => ({ signal, redirect: "manual" as const,
      headers: { [TRACEPARENT_HEADER]: outgoingTraceparent() } });
    let ready: Response | undefined, capabilities: Response | undefined;
    try {
      signal.throwIfAborted();
      ready = await fetch(`${target.url}/readyz`, request());
      signal.throwIfAborted();
      if (!ready.ok) throw new Error("runner readiness probe failed");
      await ready.body?.cancel().catch(() => {});
      signal.throwIfAborted();
      try { capabilities = await fetch(`${target.url}/v1/capabilities`, request()); }
      catch { revokeSticky(); throw new Error("runner capability probe transport failed"); }
      signal.throwIfAborted();
      if (!capabilities.ok) { revokeSticky(); throw new Error("runner capability endpoint failed"); }
      let payload: unknown;
      try { payload = await this.readProbeCapabilities(capabilities, signal); }
      catch { revokeSticky(); throw new Error("runner capability document is malformed"); }
      const parsed = Capabilities.safeParse(payload);
      if (!parsed.success || parsed.data.service !== "agent-runner") {
        revokeSticky(); throw new Error("runner protocol is incompatible");
      }
      if (!this.matchesConfiguredRestoreRuntime(parsed.data)) throw new Error("runner restore runtime identity is incompatible");
      // All feature boundaries share these exact predicates, but Gateway owns a fresh nonce per call.
      await this.attestRuntimeExtensions(target.url, parsed.data, signal);
      await this.attestProviderGateway(target.url, parsed.data, signal);
      signal.throwIfAborted();
      publish(() => {
        const jobControl = parsed.data.features.erasureJobControl;
        if (jobControl.includes(ERASURE_JOB_CONTROL_QUARANTINE_V1)
          && jobControl.includes(ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1)) this.erasureJobControlCompatible.add(target.url);
        else this.erasureJobControlCompatible.delete(target.url);
        target.capabilities = parsed.data;
        target.healthy = true;
        target.consecutiveFailures = 0;
        target.lastCheckMs = Date.now();
      });
      return true;
    } catch {
      publish(() => {
        target.capabilities = undefined;
        target.consecutiveFailures += 1;
        target.healthy = false;
        target.lastCheckMs = Date.now();
      }, true);
      onFailure?.(); // The failed peer publishes first; only this call's sibling work is cancelled.
      return false;
    } finally {
      if (ready?.body && !ready.body.locked) await ready.body.cancel().catch(() => {});
      if (capabilities?.body && !capabilities.body.locked) await capabilities.body.cancel().catch(() => {});
    }
  }

  /** Same capability JSON semantics, with ownership of an aborted reader's actual cancellation. */
  private async readProbeCapabilities(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) throw new Error("runner capability document is malformed");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let cancellation: Promise<void> | undefined;
    const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      for (;;) {
        signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
        if (next.done) break;
        chunks.push(next.value);
      }
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    } finally {
      signal.removeEventListener("abort", cancel); cancel();
      try { await cancellation; } finally { reader.releaseLock(); }
    }
  }
}
