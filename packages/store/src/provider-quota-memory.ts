import { createHash, randomBytes } from "node:crypto";
import { externalId, UserId } from "@agent-service/protocol";
import {
  ProviderQuotaError, providerQuotaNamespaceSha256,
  type ProviderQuotaCoordinator, type ProviderQuotaLease, type ProviderQuotaLimit, type ProviderQuotaRequest,
} from "./provider-quota.js";

function unavailable(): never { throw new ProviderQuotaError("unavailable"); }
function data(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) unavailable();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !keys.includes(key))) unavailable();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || ![...required, ...optional].includes(key)
      || !descriptor || !("value" in descriptor) || !descriptor.enumerable) unavailable();
    copy[key] = descriptor.value;
  }
  return copy;
}
function identity(value: unknown, user = false): string {
  if (typeof value !== "string" || !(user ? UserId : externalId).safeParse(value).success
    || user && (value.length > 128 || /[^A-Za-z0-9._:@|-]/u.test(value))
    || Buffer.from(value).toString("utf8") !== value) unavailable();
  return value;
}
function limit(value: unknown): ProviderQuotaLimit {
  const fields = data(value, [], ["rpm", "concurrency"]);
  for (const number of Object.values(fields)) {
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > 1_000_000) unavailable();
  }
  return Object.freeze(fields as ProviderQuotaLimit);
}
function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(JSON.stringify(value)).digest("hex");
}
export interface CapturedProviderQuotaLayer { readonly identitySha256: string; readonly limit: ProviderQuotaLimit }
/** Internal pure capture shared by both implementations; never carries a credential. */
export function captureProviderQuotaRequest(value: ProviderQuotaRequest): readonly CapturedProviderQuotaLayer[] {
  const request = data(value, ["tenantId", "userId", "provider", "tenant", "user", "providerLimit"]);
  const tenant = identity(request.tenantId), user = identity(request.userId, true);
  const provider = data(request.provider, ["scope", "id"]), id = identity(provider.id);
  if (provider.scope !== "platform" && provider.scope !== "tenant") unavailable();
  return Object.freeze([
    Object.freeze({ identitySha256: hash("provider-quota-tenant-v1", [tenant]), limit: limit(request.tenant) }),
    Object.freeze({ identitySha256: hash("provider-quota-user-v1", [tenant, user]), limit: limit(request.user) }),
    Object.freeze({ identitySha256: hash("provider-quota-provider-v1", [provider.scope, provider.scope === "tenant" ? tenant : null, id]), limit: limit(request.providerLimit) }),
  ]);
}
export function captureProviderQuotaSettings(value: unknown, memory: boolean): {
  prefix: string; namespaceId: string; namespaceSha256: string; leaseMs: number; renewIntervalMs: number;
  commandTimeoutMs: number; url?: string; now?: () => number;
} {
  const input = data(value, memory ? ["store", "prefix", "namespaceId"] : ["url", "prefix", "namespaceId"],
    memory ? ["now", "leaseMs", "renewIntervalMs"] : ["leaseMs", "renewIntervalMs", "commandTimeoutMs"]);
  if (memory && input.store !== "memory") unavailable();
  if (typeof input.prefix !== "string" || typeof input.namespaceId !== "string") unavailable();
  let namespaceSha256: string;
  try { namespaceSha256 = providerQuotaNamespaceSha256({ prefix: input.prefix as string, namespaceId: input.namespaceId as string }); }
  catch { unavailable(); }
  const leaseMs = input.leaseMs ?? 30_000, renewIntervalMs = input.renewIntervalMs ?? Math.floor(Number(leaseMs) / 3);
  const commandTimeoutMs = input.commandTimeoutMs ?? Math.min(2_000, Math.floor(Number(leaseMs) / 4));
  if (![leaseMs, renewIntervalMs, commandTimeoutMs].every(n => typeof n === "number" && Number.isSafeInteger(n))
    || Number(leaseMs) < 300 || Number(leaseMs) > 300_000 || Number(renewIntervalMs) < 10
    || Number(renewIntervalMs) * 3 > Number(leaseMs) || Number(commandTimeoutMs) < 10
    || Number(commandTimeoutMs) * 2 >= Number(leaseMs)) unavailable();
  if (input.now !== undefined && typeof input.now !== "function") unavailable();
  if (!memory) {
    try {
      if (typeof input.url !== "string") unavailable();
      const url = new URL(input.url);
      if (!["redis:", "rediss:"].includes(url.protocol) || !url.hostname || url.search || url.hash
        || url.port !== "" && (!/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535)
        || !/^\/(?:0|[1-9][0-9]*)$/.test(url.pathname) && url.pathname !== "") unavailable();
    } catch { unavailable(); }
  }
  return { prefix: input.prefix as string, namespaceId: input.namespaceId as string, namespaceSha256,
    leaseMs: Number(leaseMs), renewIntervalMs: Number(renewIntervalMs), commandTimeoutMs: Number(commandTimeoutMs),
    ...(memory ? { now: input.now as (() => number) | undefined } : { url: input.url as string }) };
}
export function providerQuotaMember(): string { return hash("provider-quota-member-v1", randomBytes(32).toString("hex")); }

export interface MemoryProviderQuotaOptions {
  store: "memory"; prefix: string; namespaceId: string; now?: () => number; leaseMs?: number; renewIntervalMs?: number;
}
interface Bucket { rpm: Map<string, number>; concurrency: Map<string, number> }
interface MemoryLease {
  member: string; keys: readonly string[]; controller: AbortController; external: AbortSignal; abort: () => void;
  until: number; released: boolean; timer?: ReturnType<typeof setInterval>; done: Promise<void>; finish: () => void;
}
/** Explicit single-process STORE=memory only; never a Redis fallback. */
export class MemoryProviderQuotaCoordinator implements ProviderQuotaCoordinator {
  readonly namespaceSha256: string;
  private readonly settings: ReturnType<typeof captureProviderQuotaSettings>;
  private readonly buckets = new Map<string, Bucket>();
  private readonly leases = new Set<MemoryLease>();
  private lastNow = 0;
  private closed = false;
  private closing?: Promise<void>;
  private readonly sweeper: ReturnType<typeof setInterval>;
  constructor(options: MemoryProviderQuotaOptions) {
    this.settings = captureProviderQuotaSettings(options, true); this.namespaceSha256 = this.settings.namespaceSha256;
    this.sweeper = setInterval(() => { try { this.prune(this.now()); } catch { /* now() already fences consumers. */ } }, 1000);
    this.sweeper.unref();
  }
  private now(): number {
    let value: number;
    try { value = (this.settings.now ?? Date.now)(); }
    catch { for (const lease of this.leases) lease.controller.abort(); unavailable(); }
    if (!Number.isSafeInteger(value) || value < this.lastNow || value > Number.MAX_SAFE_INTEGER - 300_000) {
      for (const lease of this.leases) lease.controller.abort(); unavailable();
    }
    this.lastNow = value; return value;
  }
  async assertReady(): Promise<void> { if (this.closed) unavailable(); }
  private prune(now: number): void {
    for (const lease of this.leases) if (lease.until <= now) lease.controller.abort();
    for (const [key, bucket] of this.buckets) {
      for (const [member, at] of bucket.rpm) if (at <= now - 60_000) bucket.rpm.delete(member);
      for (const [member, until] of bucket.concurrency) if (until <= now) bucket.concurrency.delete(member);
      if (bucket.rpm.size === 0 && bucket.concurrency.size === 0) this.buckets.delete(key);
    }
  }
  async enter(request: ProviderQuotaRequest, signal: AbortSignal): Promise<ProviderQuotaLease> {
    if (this.closed || !(signal instanceof AbortSignal) || signal.aborted) unavailable();
    const layers = captureProviderQuotaRequest(request), now = this.now();
    this.prune(now);
    const buckets = layers.map(layer => {
      let bucket = this.buckets.get(layer.identitySha256);
      if (!bucket) { bucket = { rpm: new Map(), concurrency: new Map() }; this.buckets.set(layer.identitySha256, bucket); }
      return bucket;
    });
    // Check every tier before changing any live count. A rejected attempt consumes no RPM at all.
    for (let index = 0; index < layers.length; index++) {
      const quota = layers[index]!.limit, bucket = buckets[index]!;
      if (quota.rpm !== undefined && bucket.rpm.size >= quota.rpm) {
        let earliest = Infinity; for (const at of bucket.rpm.values()) earliest = Math.min(earliest, at);
        throw new ProviderQuotaError("rpm", Math.max(1, earliest + 60_000 - now));
      }
      if (quota.concurrency !== undefined && bucket.concurrency.size >= quota.concurrency) {
        let earliest = Infinity; for (const until of bucket.concurrency.values()) earliest = Math.min(earliest, until);
        throw new ProviderQuotaError("concurrency", Math.max(1, earliest - now));
      }
    }
    let finish!: () => void;
    const controller = new AbortController(), state: MemoryLease = { member: providerQuotaMember(), keys: layers.map(x => x.identitySha256),
      controller, external: signal, abort: () => controller.abort(), until: now + this.settings.leaseMs,
      released: false, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    for (const bucket of buckets) { bucket.rpm.set(state.member, now); bucket.concurrency.set(state.member, state.until); }
    this.leases.add(state); signal.addEventListener("abort", state.abort, { once: true });
    const renew = () => {
      if (state.released) return;
      try {
        const at = this.now();
        if (state.until <= at) { controller.abort(); return; }
        // Closing/aborted consumers keep the slot until their real I/O calls release().
        state.until = at + this.settings.leaseMs;
        for (const key of state.keys) this.buckets.get(key)!.concurrency.set(state.member, state.until);
      } catch { controller.abort(); }
    };
    state.timer = setInterval(renew, this.settings.renewIntervalMs); state.timer.unref();
    let releasing: Promise<void> | undefined;
    return Object.freeze({ signal: controller.signal,
      assertOpen: async () => {
        if (this.closed || state.released || controller.signal.aborted || signal.aborted) unavailable();
        renew(); if (controller.signal.aborted) unavailable();
      },
      release: () => releasing ??= Promise.resolve().then(() => {
        state.released = true; clearInterval(state.timer); signal.removeEventListener("abort", state.abort); controller.abort();
        for (const key of state.keys) this.buckets.get(key)?.concurrency.delete(state.member);
        this.leases.delete(state); state.finish();
      }),
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.sweeper);
    for (const lease of this.leases) lease.controller.abort();
    return this.closing = Promise.all([...this.leases].map(lease => lease.done)).then(() => { this.buckets.clear(); });
  }
}
