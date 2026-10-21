import { createHash, randomBytes } from "node:crypto";
import { externalId } from "@agent-service/protocol";
import { captureProviderQuotaSettings } from "./provider-quota-memory.js";
import { ProviderPoolError, type ProviderPoolCoordinator, type ProviderPoolInventory, type ProviderPoolLease,
  type ProviderPoolOutcome, type ProviderPoolPolicy, type ProviderPoolSelection } from "./provider-pool.js";

export function poolUnavailable(): never { throw new ProviderPoolError("unavailable"); }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) poolUnavailable();
  const keys = Reflect.ownKeys(value), result: Record<string, unknown> = {};
  if (required.some(key => !keys.includes(key))) poolUnavailable();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || ![...required, ...optional].includes(key) || !descriptor || !("value" in descriptor) || !descriptor.enumerable) poolUnavailable();
    result[key] = descriptor.value;
  }
  return result;
  } catch { poolUnavailable(); }
}
export function poolDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(JSON.stringify(value)).digest("hex");
}
export function poolMember(): string { return poolDigest("provider-pool-member-v1", randomBytes(32).toString("hex")); }
export function captureProviderPoolInventory(value: ProviderPoolInventory): ProviderPoolInventory {
  try {
  const input = object(value, ["version", "providerId", "slots"]);
  if (input.version !== "provider-key-pool-v1" || !externalId.safeParse(input.providerId).success || typeof input.providerId !== "string"
    || Buffer.from(input.providerId).toString("utf8") !== input.providerId || !Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > 32) poolUnavailable();
  const ids = new Set<string>(), inputSlots = input.slots;
  if (Object.getPrototypeOf(inputSlots) !== Array.prototype || Reflect.ownKeys(inputSlots).some(key => key !== "length"
    && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= inputSlots.length))) poolUnavailable();
  const slots = Array.from({ length: inputSlots.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(inputSlots, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) poolUnavailable();
    const value = descriptor.value;
    const slot = object(value, ["id", "version"]);
    for (const word of [slot.id, slot.version]) if (typeof word !== "string" || word.length < 1 || word.length > 64
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(word) || /[^A-Za-z0-9._-]/.test(word)) poolUnavailable();
    const id = slot.id as string, version = slot.version as string;
    if (ids.has(id)) poolUnavailable(); ids.add(id); return Object.freeze({ id, version });
  });
  return Object.freeze({ version: "provider-key-pool-v1", providerId: input.providerId, slots: Object.freeze(slots) });
  } catch { poolUnavailable(); }
}
export function captureProviderPoolPolicy(value: ProviderPoolPolicy): Required<ProviderPoolPolicy> {
  const input = object(value, [], ["threshold", "windowMs", "cooldownMs", "rateLimitCooldownMs"]);
  const result = { threshold: 5, windowMs: 60_000, cooldownMs: 30_000, rateLimitCooldownMs: 30_000 };
  for (const key of Object.keys(input) as (keyof typeof result)[]) {
    const number = input[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < (key === "threshold" ? 1 : 100)
      || number > (key === "threshold" ? 100 : 3_600_000)) poolUnavailable();
    result[key] = number;
  }
  return Object.freeze(result);
}
export function captureProviderPoolOutcome(value: ProviderPoolOutcome): ProviderPoolOutcome {
  const input = object(value, ["kind"], ["retryDelayMs", "retryAtMs"]);
  if (typeof input.kind !== "string" || !["success", "failure", "cancelled", "credential_rejected", "rate_limited", "neutral"].includes(input.kind)) poolUnavailable();
  const hints = ["retryDelayMs", "retryAtMs"].filter(key => Object.hasOwn(input, key));
  if (hints.length > 1 || input.kind !== "rate_limited" && hints.length) poolUnavailable();
  for (const key of hints) if (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || Number(input[key]) < 0) poolUnavailable();
  return Object.freeze({ kind: input.kind, ...(hints[0] === "retryDelayMs" ? { retryDelayMs: input.retryDelayMs }
    : hints[0] === "retryAtMs" ? { retryAtMs: input.retryAtMs } : {}) }) as unknown as ProviderPoolOutcome;
}
export function providerPoolSlotKey(inventory: ProviderPoolInventory, slot: { id: string; version: string }): string {
  return poolDigest("provider-pool-slot-v1", [inventory.providerId, slot.id, slot.version]);
}
export function providerPoolIdleMs(policy: Required<ProviderPoolPolicy>, leaseMs: number): number {
  return policy.windowMs + Math.max(policy.cooldownMs, policy.rateLimitCooldownMs, 3_600_000) + leaseMs * 2;
}
interface Selection { inventory: ProviderPoolInventory; policy: Required<ProviderPoolPolicy>; index: number; used: boolean }
interface SlotState { epoch: number; kind: "closed" | "open" | "half_open" | "disabled"; failures: number[];
  openUntil: number; probe: string; probeUntil: number; expires: number }
interface Permit { slot: string; epoch: number; probe: boolean; member: string; until: number; controller: AbortController;
  signal: AbortSignal; abort: () => void; released: boolean; timer?: ReturnType<typeof setInterval>; done: Promise<void>; finish: () => void }
export interface MemoryProviderPoolOptions { store: "memory"; prefix: string; namespaceId: string; now?: () => number; leaseMs?: number; renewIntervalMs?: number }

/** Explicit STORE=memory only. Never a Redis authority fallback. */
export class MemoryProviderPoolCoordinator implements ProviderPoolCoordinator {
  readonly namespaceSha256: string;
  private readonly settings: ReturnType<typeof captureProviderQuotaSettings>;
  private readonly selections = new WeakMap<ProviderPoolSelection, Selection>();
  private readonly cursors = new Map<string, { next: number; expires: number }>();
  private readonly states = new Map<string, SlotState>();
  private readonly permits = new Set<Permit>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private lastNow = 0; private closed = false; private faulted = false; private closing?: Promise<void>;
  constructor(options: MemoryProviderPoolOptions) {
    try { this.settings = captureProviderQuotaSettings(options, true); } catch { poolUnavailable(); }
    this.namespaceSha256 = this.settings.namespaceSha256;
    this.sweeper = setInterval(() => { try { this.prune(this.now()); } catch { /* now() fences consumers. */ } }, 1000); this.sweeper.unref();
  }
  private now(): number {
    try {
      const value = (this.settings.now ?? Date.now)();
      if (!Number.isSafeInteger(value) || value < this.lastNow || value > Number.MAX_SAFE_INTEGER - 10_000_000) poolUnavailable();
      this.lastNow = value; return value;
    } catch { this.faulted = true; for (const permit of this.permits) permit.controller.abort(); poolUnavailable(); }
  }
  private open() { if (this.closed || this.faulted) poolUnavailable(); }
  private prune(now: number) {
    for (const [key, value] of this.cursors) if (value.expires <= now) this.cursors.delete(key);
    for (const [key, value] of this.states) if (value.kind !== "disabled" && value.expires <= now) this.states.delete(key);
    for (const permit of this.permits) if (permit.until <= now) permit.controller.abort();
  }
  async assertReady(): Promise<void> { this.open(); }
  async select(inventory: ProviderPoolInventory, policy: ProviderPoolPolicy, signal: AbortSignal): Promise<ProviderPoolSelection> {
    this.open(); if (!(signal instanceof AbortSignal) || signal.aborted) poolUnavailable();
    const captured = captureProviderPoolInventory(inventory), limits = captureProviderPoolPolicy(policy), now = this.now(); this.prune(now);
    const cursorKey = poolDigest("provider-pool-cursor-v1", captured), start = this.cursors.get(cursorKey)?.next ?? 0;
    let index = -1, retry = Infinity, disabled = 0;
    for (let offset = 0; offset < captured.slots.length; offset++) {
      const candidate = (start + offset) % captured.slots.length, state = this.states.get(providerPoolSlotKey(captured, captured.slots[candidate]!));
      if (state?.kind === "disabled") { disabled++; continue; }
      const readyAt = state?.kind === "open" ? state.openUntil : state?.kind === "half_open" ? state.probeUntil + limits.cooldownMs : 0;
      if (readyAt > now) { retry = Math.min(retry, readyAt - now); continue; } index = candidate; break;
    }
    if (index < 0) throw new ProviderPoolError(disabled === captured.slots.length ? "disabled" : "open", Number.isFinite(retry) ? Math.max(1, retry) : undefined);
    this.cursors.set(cursorKey, { next: (index + 1) % captured.slots.length, expires: now + providerPoolIdleMs(limits, this.settings.leaseMs) });
    const selection = Object.freeze({ slot: Object.freeze({ ...captured.slots[index]! }) });
    this.selections.set(selection, { inventory: captured, policy: limits, index, used: false }); return selection;
  }
  async acquire(selection: ProviderPoolSelection, signal: AbortSignal): Promise<ProviderPoolLease> {
    this.open(); if (!(signal instanceof AbortSignal) || signal.aborted) poolUnavailable();
    const selected = this.selections.get(selection); if (!selected || selected.used) poolUnavailable(); selected.used = true;
    const now = this.now(), policy = selected.policy, key = providerPoolSlotKey(selected.inventory, selection.slot); this.prune(now);
    let state = this.states.get(key);
    if (!state) { state = { epoch: 0, kind: "closed", failures: [], openUntil: 0, probe: "", probeUntil: 0, expires: 0 }; this.states.set(key, state); }
    if (state.kind === "disabled") throw new ProviderPoolError("disabled");
    if (state.kind === "half_open" && state.probeUntil <= now) {
      state.epoch++; state.kind = "open"; state.openUntil = state.probeUntil + policy.cooldownMs; state.probe = ""; state.probeUntil = 0;
    }
    if (state.kind === "half_open" || state.kind === "open" && state.openUntil > now) throw new ProviderPoolError("open", Math.max(1, (state.kind === "half_open" ? state.probeUntil : state.openUntil) - now));
    const member = poolMember(), probe = state.kind === "open";
    if (probe) { state.epoch++; state.kind = "half_open"; state.probe = member; state.probeUntil = now + this.settings.leaseMs; }
    state.expires = now + providerPoolIdleMs(policy, this.settings.leaseMs);
    let finish!: () => void;
    const controller = new AbortController(), permit: Permit = { slot: key, epoch: state.epoch, probe, member, until: now + this.settings.leaseMs,
      controller, signal, abort: () => controller.abort(), released: false, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    this.permits.add(permit); signal.addEventListener("abort", permit.abort, { once: true });
    const renew = () => {
      if (permit.released) return;
      try {
        const at = this.now(), current = this.states.get(key);
        if (this.faulted || permit.until <= at || !current || probe && (current.epoch !== permit.epoch || current.kind !== "half_open" || current.probe !== member || current.probeUntil <= at)) poolUnavailable();
        permit.until = at + this.settings.leaseMs;
        if (probe) current.probeUntil = permit.until;
        if (current.kind !== "disabled") current.expires = at + providerPoolIdleMs(policy, this.settings.leaseMs);
      } catch { clearInterval(permit.timer); controller.abort(); }
    };
    permit.timer = setInterval(renew, this.settings.renewIntervalMs); permit.timer.unref();
    let releasing: Promise<void> | undefined, releasedDigest: string | undefined;
    return Object.freeze({ signal: controller.signal,
      assertOpen: async () => { this.open(); if (permit.released || controller.signal.aborted || signal.aborted) poolUnavailable(); renew(); if (controller.signal.aborted) poolUnavailable(); },
      release: (outcome: ProviderPoolOutcome) => {
        let captured: ProviderPoolOutcome, digest: string;
        try { captured = captureProviderPoolOutcome(outcome); digest = poolDigest("provider-pool-outcome-v1", captured); } catch { return Promise.reject(new ProviderPoolError("unavailable")); }
        if (releasing) return digest === releasedDigest ? releasing : Promise.reject(new ProviderPoolError("unavailable"));
        releasedDigest = digest; permit.released = true; clearInterval(permit.timer); signal.removeEventListener("abort", permit.abort); controller.abort();
        return releasing = Promise.resolve().then(() => {
          try {
            const at = this.now(), current = this.states.get(key); if (!current) return;
            if (permit.until <= at) {
              if (current.epoch === permit.epoch && probe && current.kind === "half_open" && current.probe === member) this.reopen(current, at, policy.cooldownMs);
              return;
            }
            // A still-valid rejection of this exact version dominates unrelated health epochs.
            if (captured.kind === "credential_rejected") { current.epoch++; current.kind = "disabled"; current.probe = ""; current.probeUntil = 0; current.failures = []; current.expires = Infinity; return; }
            if (current.epoch !== permit.epoch) return;
            if (probe && (current.kind !== "half_open" || current.probe !== member)) return;
            if (captured.kind === "rate_limited") {
              let until = at + policy.rateLimitCooldownMs;
              if (captured.retryDelayMs !== undefined) until = Math.max(until, at + Math.min(3_600_000, captured.retryDelayMs));
              if (captured.retryAtMs !== undefined) until = Math.max(until, Math.min(at + 3_600_000, captured.retryAtMs));
              this.reopen(current, at, until - at);
            } else if (captured.kind === "success") {
              current.failures = []; if (probe) { current.epoch++; current.kind = "closed"; current.probe = ""; current.probeUntil = 0; current.openUntil = 0; }
            } else if (probe) this.reopen(current, at, policy.cooldownMs);
            else if (captured.kind === "failure") {
              current.failures = current.failures.filter(time => time > at - policy.windowMs); current.failures.push(at);
              if (current.failures.length >= policy.threshold) this.reopen(current, at, policy.cooldownMs);
            }
            if (current.kind !== "disabled") current.expires = at + providerPoolIdleMs(policy, this.settings.leaseMs);
          } finally { this.permits.delete(permit); permit.finish(); }
        });
      },
    });
  }
  private reopen(state: SlotState, now: number, cooldownMs: number) {
    if (state.epoch >= Number.MAX_SAFE_INTEGER - 1) poolUnavailable();
    state.epoch++; state.kind = "open"; state.openUntil = now + cooldownMs; state.probe = ""; state.probeUntil = 0; state.failures = [];
  }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true; clearInterval(this.sweeper);
    for (const permit of this.permits) permit.controller.abort();
    return this.closing = Promise.all([...this.permits].map(permit => permit.done)).then(() => { this.states.clear(); this.cursors.clear(); });
  }
}
