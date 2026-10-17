import { createHash, randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { mcpCoordinationNamespaceSha256 } from "@agent-service/protocol";
import { validateMcpCredentialSubject, type McpCredentialSubject } from "../mcp-registry.js";
export { mcpCoordinationNamespaceSha256 } from "@agent-service/protocol";

export interface McpCoordinationInvalidation { readonly registrationId: string | null; readonly subjectSha256: string | null }
export interface McpCoordinationLease {
  readonly signal: AbortSignal;
  assertOpen(): Promise<void>;
  release(outcome: "success" | "failure" | "outcome_unknown"): Promise<void>;
}
export interface McpCoordination {
  readonly namespaceSha256: string;
  enter(input: { subject: McpCredentialSubject; operationId: string; timeoutMs: number; maxConcurrent: number }, signal: AbortSignal): Promise<McpCoordinationLease>;
  publishInvalidation(input: { registrationId: string; subject: McpCredentialSubject | null }): Promise<void>;
  onInvalidation(listener: (message: McpCoordinationInvalidation) => void): () => void;
  close(): Promise<void>;
}
export interface RedisMcpCoordinationOptions {
  redis: Redis; prefix: string; namespaceId: string; leaseMs?: number;
  breakerFailureThreshold?: number; breakerCooldownMs?: number;
}
export function mcpCoordinationSubjectSha256(namespaceSha256: string, subject: McpCredentialSubject): string {
  if (!/^[a-f0-9]{64}$/.test(namespaceSha256)) bad(); validateMcpCredentialSubject(subject);
  return createHash("sha256").update("mcp-coordination-subject-v1\0").update(JSON.stringify({ namespaceSha256, subject: { tenantId: subject.tenantId, userId: subject.userId } })).digest("hex");
}
function bad(): never { throw new Error("MCP coordination is unavailable"); }
const ENTER = `local t=redis.call('TIME');local n=t[1]*1000+math.floor(t[2]/1000);redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',n);local b=tonumber(redis.call('HGET',KEYS[2],'until') or '0');if b>n then return 0 end;if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end;redis.call('ZADD',KEYS[1],n+tonumber(ARGV[3]),ARGV[1]);redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[3])*2);return 1`;
const CHECK = `local t=redis.call('TIME');local n=t[1]*1000+math.floor(t[2]/1000);local x=tonumber(redis.call('ZSCORE',KEYS[1],ARGV[1]) or '0');if x<=n then return 0 end;if tonumber(ARGV[2])>0 then redis.call('ZADD',KEYS[1],n+tonumber(ARGV[2]),ARGV[1]);redis.call('PEXPIRE',KEYS[1],tonumber(ARGV[2])*2) end;return 1`;
const RELEASE = `if redis.call('ZREM',KEYS[1],ARGV[1])~=1 then return 0 end;if ARGV[2]=='success' then redis.call('DEL',KEYS[2]);return 1 end;local f=redis.call('HINCRBY',KEYS[2],'failures',1);if f>=tonumber(ARGV[3]) then local t=redis.call('TIME');local n=t[1]*1000+math.floor(t[2]/1000);redis.call('HSET',KEYS[2],'until',n+tonumber(ARGV[4]));end;redis.call('PEXPIRE',KEYS[2],tonumber(ARGV[4])*2);return 1`;
type Active = { abort: AbortController; done: Promise<void>; release: McpCoordinationLease["release"] };

/** Redis supplies only bounded coordination/hints. SQL remains OAuth and refresh authority. */
export class RedisMcpCoordination implements McpCoordination {
  readonly namespaceSha256: string;
  private readonly subscriber: Redis;
  private readonly channel: string;
  private readonly listeners = new Set<(message: McpCoordinationInvalidation) => void>();
  private readonly active = new Set<Active>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly leaseMs: number; private readonly threshold: number; private readonly cooldown: number;
  private readonly ready: Promise<void>;
  private closed = false; private subscriptionReady = false; private closing: Promise<void> | undefined;
  constructor(private readonly options: RedisMcpCoordinationOptions) {
    this.namespaceSha256 = mcpCoordinationNamespaceSha256({ prefix: options.prefix, namespaceId: options.namespaceId });
    const bound = (v: number | undefined, d: number, lo: number, hi: number) => { const n = v ?? d; if (!Number.isSafeInteger(n) || n < lo || n > hi) bad(); return n; };
    this.leaseMs = bound(options.leaseMs, 30000, 1000, 120000); this.threshold = bound(options.breakerFailureThreshold, 3, 1, 10); this.cooldown = bound(options.breakerCooldownMs, 5000, 100, 30000);
    this.channel = `${options.prefix}:mcp:invalidate:${this.namespaceSha256}`;
    this.subscriber = options.redis.duplicate({ lazyConnect: true, enableOfflineQueue: false });
    const lost = () => { this.subscriptionReady = false; this.emit({ registrationId: null, subjectSha256: null }); };
    this.subscriber.on("error", lost); this.subscriber.on("close", lost); this.subscriber.on("reconnecting", lost);
    this.subscriber.on("message", (channel, body) => {
      if (channel !== this.channel || this.closed) return;
      try {
        if (Buffer.byteLength(body) > 512) bad(); const message: unknown = JSON.parse(body);
        if (!message || typeof message !== "object" || Array.isArray(message)) bad();
        const m = message as Record<string, unknown>;
        if (Object.keys(m).sort().join(",") !== "registrationId,scope,subjectSha256" || m.scope !== "mcp-invalidation-v1" || typeof m.registrationId !== "string" || !/^[a-f0-9]{64}$/.test(m.registrationId) || m.subjectSha256 !== null && (typeof m.subjectSha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.subjectSha256))) bad();
        this.emit({ registrationId: m.registrationId, subjectSha256: m.subjectSha256 as string | null });
      } catch { lost(); }
    });
    const subscribe = async () => { await this.subscriber.connect(); await this.subscriber.subscribe(this.channel); if (this.closed) return; this.subscriptionReady = true; };
    this.ready = this.track(subscribe()).catch(() => { lost(); bad(); }); this.ready.catch(() => {});
    // Auto-resubscribe may miss messages: fence every local pool before accepting
    // fresh checkouts again. Their SQL checks, not a reconnect event, authorize use.
    this.subscriber.on("ready", () => { if (this.closed) return; lost(); void this.track(this.subscriber.subscribe(this.channel)).then(() => { if (!this.closed) this.subscriptionReady = true; }, () => lost()); });
  }
  private emit(message: McpCoordinationInvalidation) { for (const listener of this.listeners) { try { listener(Object.freeze({ ...message })); } catch { /* A hint never grants authority or leaks consumer errors. */ } } }
  private track<T>(work: Promise<T>): Promise<T> { this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => {}); return work; }
  onInvalidation(listener: (message: McpCoordinationInvalidation) => void) {
    if (this.closed) bad(); this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  async publishInvalidation(input: { registrationId: string; subject: McpCredentialSubject | null }) {
    if (this.closed || !/^[a-f0-9]{64}$/.test(input.registrationId)) bad();
    const subjectSha256 = input.subject === null ? null : mcpCoordinationSubjectSha256(this.namespaceSha256, input.subject);
    const message = { scope: "mcp-invalidation-v1", registrationId: input.registrationId, subjectSha256 };
    try { await this.ready; if (this.closed || !this.subscriptionReady) bad(); await this.track(this.options.redis.publish(this.channel, JSON.stringify(message))); this.emit(message); }
    catch { this.emit({ registrationId: null, subjectSha256: null }); bad(); }
  }
  async enter(input: { subject: McpCredentialSubject; operationId: string; timeoutMs: number; maxConcurrent: number }, signal: AbortSignal): Promise<McpCoordinationLease> {
    if (this.closed || signal.aborted || !/^[a-f0-9-]{36}$/.test(input.operationId) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120000 || !Number.isSafeInteger(input.maxConcurrent) || input.maxConcurrent < 1 || input.maxConcurrent > 16) bad();
    const subject = mcpCoordinationSubjectSha256(this.namespaceSha256, input.subject), root = `${this.options.prefix}:mcp:{${subject}}`, leases = `${root}:leases`, breaker = `${root}:breaker`;
    const member = `${input.operationId}:${randomBytes(16).toString("hex")}`, abort = new AbortController();
    let resolveDone!: () => void; const done = new Promise<void>(r => { resolveDone = r; });
    let released = false, releasing: Promise<void> | undefined, renewal: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
    const deadlineTimer = setTimeout(() => abort.abort(), input.timeoutMs); deadlineTimer.unref();
    const cancel = () => abort.abort(); signal.addEventListener("abort", cancel, { once: true });
    let active!: Active;
    const release: McpCoordinationLease["release"] = outcome => {
      if (releasing) return releasing;
      if (!["success", "failure", "outcome_unknown"].includes(outcome)) return Promise.reject(new Error("MCP coordination is unavailable"));
      releasing = (async () => {
        released = true; if (timer) clearInterval(timer); clearTimeout(deadlineTimer); signal.removeEventListener("abort", cancel);
        try { await renewal; await this.track(this.options.redis.eval(RELEASE, 2, leases, breaker, member, outcome, this.threshold, this.cooldown)); }
        catch { abort.abort(); bad(); }
        finally { this.active.delete(active); resolveDone(); }
      })(); return releasing;
    };
    active = { abort, done, release }; this.active.add(active);
    try {
      await this.ready; if (this.closed || signal.aborted || !this.subscriptionReady) bad();
      if (Number(await this.track(this.options.redis.eval(ENTER, 2, leases, breaker, member, input.maxConcurrent, this.leaseMs))) !== 1) bad();
      if (this.closed || signal.aborted) { await release("outcome_unknown"); bad(); }
      const renew = async () => { if (released || renewal) return; renewal = (async () => {
        try { if (Number(await this.track(this.options.redis.eval(CHECK, 1, leases, member, this.leaseMs))) !== 1) abort.abort(); }
        catch { abort.abort(); } finally { renewal = undefined; }
      })(); await renewal; };
      timer = setInterval(() => { void renew(); }, Math.floor(this.leaseMs / 3)); timer.unref();
      return { signal: abort.signal, release, assertOpen: async () => {
        if (this.closed || released || abort.signal.aborted || !this.subscriptionReady) bad();
        try { if (Number(await this.track(this.options.redis.eval(CHECK, 1, leases, member, 0))) !== 1 || abort.signal.aborted || this.closed) { abort.abort(); bad(); } }
        catch { abort.abort(); bad(); }
      } };
    } catch { if (!released) await release("outcome_unknown").catch(() => {}); bad(); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true; this.subscriptionReady = false;
    this.emit({ registrationId: null, subjectSha256: null }); for (const lease of this.active) lease.abort.abort();
    this.closing = (async () => {
      // Consumers release only after their actual product I/O settles. Do not
      // delete live slots here and pretend an abort has rolled back a tool call.
      while (this.active.size) await Promise.all([...this.active].map(a => a.done));
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      if (this.subscriber.status !== "end") {
        const ended = new Promise<void>(resolve => this.subscriber.once("end", resolve));
        try { await this.subscriber.quit(); } catch { this.subscriber.disconnect(); }
        await ended;
      }
      this.listeners.clear();
    })(); return this.closing;
  }
}
