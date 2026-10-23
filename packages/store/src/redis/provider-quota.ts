import { Redis } from "ioredis";
import { guardRedisDatabaseSelection } from "@agent-service/protocol";
import { ProviderQuotaError, type ProviderQuotaCoordinator, type ProviderQuotaLease, type ProviderQuotaRequest } from "../provider-quota.js";
import { captureProviderQuotaRequest, captureProviderQuotaSettings, providerQuotaMember, type CapturedProviderQuotaLayer } from "../provider-quota-memory.js";

// One namespace-wide Redis Cluster slot is intentional: all three scopes must commit together.
// Neither an identity nor a credential appears in a key, member or Lua argument.
const OPERATION = `
if #KEYS~=7 or #ARGV~=10 then return {-2} end
local mode=ARGV[1]
local member=ARGV[2]
local lease=tonumber(ARGV[3])
local admitBefore=tonumber(ARGV[10])
if (mode~='enter' and mode~='renew' and mode~='release' and mode~='cancel')
  or #member~=64 or not string.match(member,'^[a-f0-9]+$')
  or not lease or lease~=math.floor(lease) or lease<300 or lease>300000
  or not admitBefore or admitBefore~=math.floor(admitBefore) or admitBefore<1 or admitBefore>9007199254440991 then return {-2} end
for i=4,9 do
  local n=tonumber(ARGV[i])
  if not n or n~=math.floor(n) or n<0 or n>1000000 then return {-2} end
end
for i=1,6 do
  local t=redis.call('TYPE',KEYS[i]).ok
  if t~='none' and t~='zset' then return {-2} end
end
local cancelled=redis.call('TYPE',KEYS[7]).ok
if cancelled~='none' and cancelled~='string' then return {-2} end
local time=redis.call('TIME')
local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
if admitBefore>now+lease then return {-2} end
if mode=='cancel' then
  redis.call('PSETEX',KEYS[7],math.max(1,admitBefore+lease-now),'cancelled')
  for i=2,6,2 do redis.call('ZREM',KEYS[i],member) end
  return {1}
end
if mode=='release' then
  for i=2,6,2 do redis.call('ZREM',KEYS[i],member) end
  return {1}
end
if cancelled~='none' then return {-1} end
local untilMs=now+lease
if mode=='renew' then
  for i=2,6,2 do
    local score=redis.call('ZSCORE',KEYS[i],member)
    if not score or tonumber(score)<=now then return {-1} end
  end
elseif mode=='enter' then
  if now>=admitBefore then return {-1} end
  for i=1,6,2 do
    redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now-60000)
    redis.call('ZREMRANGEBYSCORE',KEYS[i+1],'-inf',now)
  end
  for scope=1,3 do
    local i=(scope-1)*2+1
    local rpm=tonumber(ARGV[scope*2+2])
    local concurrency=tonumber(ARGV[scope*2+3])
    if rpm>0 and redis.call('ZCARD',KEYS[i])>=rpm then
      local first=redis.call('ZRANGE',KEYS[i],0,0,'WITHSCORES')
      return {0,1,math.max(1,tonumber(first[2])+60000-now)}
    end
    if concurrency>0 and redis.call('ZCARD',KEYS[i+1])>=concurrency then
      local first=redis.call('ZRANGE',KEYS[i+1],0,0,'WITHSCORES')
      return {0,2,math.max(1,tonumber(first[2])-now)}
    end
  end
else return {-2} end
for i=1,6,2 do
  if mode=='enter' then
    redis.call('ZADD',KEYS[i],now,member)
    redis.call('PEXPIRE',KEYS[i],60000)
  end
  redis.call('ZADD',KEYS[i+1],untilMs,member)
  local last=redis.call('ZRANGE',KEYS[i+1],-1,-1,'WITHSCORES')
  redis.call('PEXPIRE',KEYS[i+1],math.max(1,tonumber(last[2])-now+1000))
end
return {1,untilMs}
`;
function unavailable(): ProviderQuotaError { return new ProviderQuotaError("unavailable"); }

/** An owned, no-reconnect transport. close means native TCP/TLS close, not ioredis status. */
class QuotaRedisPort {
  readonly redis: Redis;
  private connecting?: Promise<void>;
  private stopped = false;
  private closing?: Promise<void>;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly sockets = new Map<Redis["stream"], Promise<void>>();
  constructor(url: string, timeoutMs: number, failure: () => void) {
    this.redis = guardRedisDatabaseSelection(new Redis(url, { lazyConnect: true, connectTimeout: timeoutMs,
      commandTimeout: timeoutMs, retryStrategy: () => null, reconnectOnError: () => false,
      maxRetriesPerRequest: 0, enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
      autoResubscribe: false, enableReadyCheck: false, disableClientInfo: true, protocol: 2 }));
    const failed = () => { this.observe(); if (!this.stopped) { failure(); this.stop(); } };
    this.redis.on("connect", () => this.observe());
    this.redis.on("error", failed); this.redis.on("close", failed); this.redis.on("end", failed);
  }
  private observe(): void {
    const socket = this.redis.stream;
    if (socket && !this.sockets.has(socket)) {
      this.sockets.set(socket, socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve())));
    }
    if (this.stopped) for (const owned of this.sockets.keys()) owned.destroy();
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(() => { if (this.stopped) throw unavailable(); return work(); });
    this.tasks.add(task); void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task)); return task;
  }
  async run<T>(work: (redis: Redis) => Promise<T>): Promise<T> {
    this.connecting ??= this.track(() => this.redis.connect());
    await this.connecting; this.observe();
    if (this.stopped || this.redis.status !== "ready") throw unavailable();
    return this.track(() => work(this.redis));
  }
  stop(): void {
    this.stopped = true; this.observe();
    try { this.redis.disconnect(false); } catch { /* Still destroy the owned stream. */ }
    finally { this.observe(); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop();
    return this.closing = (async () => {
      while (this.tasks.size) { await Promise.allSettled([...this.tasks]); this.observe(); }
      this.observe(); await Promise.all([...this.sockets.values()]);
    })();
  }
}
export interface RedisProviderQuotaOptions {
  url: string; prefix: string; namespaceId: string; leaseMs?: number; renewIntervalMs?: number; commandTimeoutMs?: number;
}
interface RedisQuotaState {
  member: string; keys: readonly string[]; controller: AbortController; signal: AbortSignal; abort: () => void;
  validUntil: number; released: boolean; timer?: ReturnType<typeof setInterval>; renewing?: Promise<void>;
  done: Promise<void>; finish: () => void;
}
export class RedisProviderQuotaCoordinator implements ProviderQuotaCoordinator {
  readonly namespaceSha256: string;
  private readonly settings: ReturnType<typeof captureProviderQuotaSettings>;
  private readonly port: QuotaRedisPort;
  private readonly url: string;
  private readonly leases = new Set<RedisQuotaState>();
  private readonly pending = new Set<Promise<unknown>>();
  private faulted = false;
  private closed = false;
  private closing?: Promise<void>;
  constructor(options: RedisProviderQuotaOptions) {
    this.settings = captureProviderQuotaSettings(options, false); this.namespaceSha256 = this.settings.namespaceSha256;
    if (typeof this.settings.url !== "string") throw unavailable(); this.url = this.settings.url;
    try { this.port = new QuotaRedisPort(this.url, this.settings.commandTimeoutMs, () => this.fence()); }
    catch { throw unavailable(); }
  }
  private fence(): void {
    this.faulted = true;
    for (const lease of this.leases) { clearInterval(lease.timer); lease.controller.abort(); }
    this.port?.stop();
  }
  private open(): void { if (this.closed || this.faulted) throw unavailable(); }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task); void task.then(() => this.pending.delete(task), () => this.pending.delete(task)); return task;
  }
  private keys(layers: readonly CapturedProviderQuotaLayer[], member: string): readonly string[] {
    const base = `provider-quota-v1:{${this.namespaceSha256}}:`;
    return [...layers.flatMap(layer => [base + layer.identitySha256 + ":rpm", base + layer.identitySha256 + ":concurrency"]), base + "cancel:" + member];
  }
  private async operation(mode: "enter" | "renew" | "release" | "cancel", keys: readonly string[], member: string,
    admitBefore: number, layers: readonly CapturedProviderQuotaLayer[] = [], fresh = false): Promise<unknown[]> {
    let port: QuotaRedisPort | undefined;
    try {
      port = fresh ? new QuotaRedisPort(this.url, this.settings.commandTimeoutMs, () => {}) : this.port;
      const result: unknown = await port.run(redis => redis.eval(OPERATION, keys.length, ...keys, mode, member, this.settings.leaseMs,
        ...[0, 1, 2].flatMap(index => [layers[index]?.limit.rpm ?? 0, layers[index]?.limit.concurrency ?? 0]), admitBefore));
      if (!Array.isArray(result) || result.length < 1 || result.some(n => !Number.isSafeInteger(n))) throw unavailable();
      return result as number[];
    } catch { if (!fresh) { this.fence(); await this.port.close(); } throw unavailable(); }
    finally { if (fresh) await port?.close(); }
  }
  async assertReady(): Promise<void> {
    this.open();
    try { if (await this.port.run(redis => redis.ping()) !== "PONG") throw unavailable(); this.open(); }
    catch { this.fence(); await this.port.close(); throw unavailable(); }
  }
  enter(request: ProviderQuotaRequest, signal: AbortSignal): Promise<ProviderQuotaLease> {
    return this.track(this.enterActual(request, signal));
  }
  private async enterActual(request: ProviderQuotaRequest, signal: AbortSignal): Promise<ProviderQuotaLease> {
    this.open(); if (!(signal instanceof AbortSignal) || signal.aborted) throw unavailable();
    const layers = captureProviderQuotaRequest(request), member = providerQuotaMember(), keys = this.keys(layers, member);
    const started = performance.now(); let entered = false, result: unknown[], admitBefore: number | undefined;
    try {
      const time = await this.port.run(redis => redis.time());
      if (!Array.isArray(time) || time.length !== 2 || time.some(x => typeof x !== "string" || !/^[0-9]+$/.test(x))
        || !Number.isSafeInteger(Number(time[0])) || Number(time[1]) > 999_999) throw unavailable();
      const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
      if (!Number.isSafeInteger(now) || now > Number.MAX_SAFE_INTEGER - 600_000) throw unavailable();
      admitBefore = now + this.settings.leaseMs;
      this.open(); if (signal.aborted || performance.now() >= started + this.settings.leaseMs) throw unavailable();
      result = await this.operation("enter", keys, member, admitBefore, layers);
      if (result[0] === 0 && result.length === 3 && (result[1] === 1 || result[1] === 2)
        && typeof result[2] === "number" && result[2] > 0) {
        throw new ProviderQuotaError(result[1] === 1 ? "rpm" : "concurrency", result[2]);
      }
      if (result.length !== 2 || result[0] !== 1) throw unavailable(); entered = true;
      this.open(); if (signal.aborted || performance.now() >= started + this.settings.leaseMs) throw unavailable();
    } catch (error) {
      if (error instanceof ProviderQuotaError && error.reason !== "unavailable") throw error;
      if (!signal.aborted && !this.closed) this.fence();
      // Unknown response may have committed. Cancel only this random member, never refund RPM.
      // Bound cancellation through the immutable server-time admission deadline plus one lease.
      // Even after this marker expires, that original command can never enter past its deadline.
      if (admitBefore !== undefined) await this.operation("cancel", keys, member, admitBefore, [], true).catch(() => {});
      if (this.faulted) await this.port.close();
      throw unavailable();
    }
    if (!entered || admitBefore === undefined) throw unavailable();
    const admissionDeadline = admitBefore;
    let finish!: () => void;
    const controller = new AbortController(), state: RedisQuotaState = { member, keys, controller, signal,
      abort: () => controller.abort(), validUntil: started + this.settings.leaseMs, released: false,
      done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    this.leases.add(state); signal.addEventListener("abort", state.abort, { once: true });
    const renew = (): Promise<void> => {
      if (state.renewing) return state.renewing;
      const work = (async () => {
        if (state.released || this.faulted || performance.now() >= state.validUntil) throw unavailable();
        const at = performance.now(), response = await this.operation("renew", keys, member, admissionDeadline);
        if (response[0] !== 1 || response.length !== 2 || performance.now() >= at + this.settings.leaseMs) throw unavailable();
        state.validUntil = at + this.settings.leaseMs;
      })().catch(() => { controller.abort(); clearInterval(state.timer); throw unavailable(); });
      state.renewing = work; void work.then(() => { state.renewing = undefined; }, () => { state.renewing = undefined; }); return work;
    };
    state.timer = setInterval(() => { void renew().catch(() => {}); }, this.settings.renewIntervalMs); state.timer.unref();
    let releasing: Promise<void> | undefined;
    return Object.freeze({ signal: controller.signal,
      assertOpen: async () => { this.open(); if (state.released || controller.signal.aborted || signal.aborted) throw unavailable(); await renew(); this.open(); if (controller.signal.aborted) throw unavailable(); },
      release: () => releasing ??= this.track((async () => {
        state.released = true; clearInterval(state.timer); signal.removeEventListener("abort", state.abort); controller.abort();
        try {
          if (state.renewing) await state.renewing.catch(() => {});
          const response = await this.operation("release", keys, member, admissionDeadline, [], this.faulted);
          if (response.length !== 1 || response[0] !== 1) throw unavailable();
        } finally { this.leases.delete(state); state.finish(); }
      })()),
    });
  }
  /** Fence new consumers and request cancellation; their real release still owns its Redis I/O. */
  stop(): void { if (this.closed) return; this.closed = true; for (const lease of this.leases) lease.controller.abort(); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop();
    return this.closing = (async () => {
      // No slot is released by close: the actual consumer must first settle and release it.
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      await Promise.all([...this.leases].map(lease => lease.done));
      await this.port.close();
    })();
  }
}
