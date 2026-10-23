import { Redis } from "ioredis";
import { guardRedisDatabaseSelection } from "@agent-service/protocol";
import { captureProviderQuotaSettings } from "../provider-quota-memory.js";
import { captureProviderPoolInventory, captureProviderPoolOutcome, captureProviderPoolPolicy, poolDigest, poolMember,
  providerPoolIdleMs, providerPoolSlotKey } from "../provider-pool-memory.js";
import { ProviderPoolError, type ProviderPoolCoordinator, type ProviderPoolInventory, type ProviderPoolLease,
  type ProviderPoolOutcome, type ProviderPoolPolicy, type ProviderPoolSelection } from "../provider-pool.js";

// Pool state shares the quota namespace's single Cluster slot, but not its key domain.
// Only operator slot/version DISABLED tombstones persist. Every request/cursor/other state expires.
const COMMON = `
local function integer(n,lo,hi) return type(n)=='number' and n==math.floor(n) and n>=lo and n<=hi end
local function hex(s) return type(s)=='string' and #s==64 and string.match(s,'^[a-f0-9]+$') end
local function decode(key,count)
  local t=redis.call('TYPE',key).ok
  if t=='none' then return nil end
  if t~='string' then return false end
  local raw=redis.call('GET',key)
  if #raw>16384 then return false end
  local ok,v=pcall(cjson.decode,raw)
  if not ok or type(v)~='table' or #v~=count then return false end
  local fields=0 for k,_ in pairs(v) do if not integer(k,1,count) then return false end fields=fields+1 end
  if fields~=count then return false end return v
end
local function state(key)
  local s=decode(key,6)
  if s==nil then return {0,0,0,'',0,{}} end
  if s==false or not integer(s[1],0,9007199254740000) or not integer(s[2],0,3)
    or not integer(s[3],0,9007199254740000) or type(s[4])~='string'
    or not integer(s[5],0,9007199254740000) or type(s[6])~='table' or #s[6]>100 then return false end
  if s[2]==2 then if not hex(s[4]) or s[5]<1 then return false end
  elseif s[4]~='' or s[5]~=0 then return false end
  local n=0 for k,v in pairs(s[6]) do
    if not integer(k,1,#s[6]) or not integer(v,0,9007199254740000) then return false end n=n+1
  end
  if n~=#s[6] then return false end return s
end
local time=redis.call('TIME')
local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
`;
const SELECT = COMMON + `
if #ARGV~=3 or #KEYS<2 or #KEYS>33 then return {-2} end
local count=#KEYS-1 local cooldown=tonumber(ARGV[1]) local idle=tonumber(ARGV[2]) local size=tonumber(ARGV[3])
if size~=count or not integer(cooldown,100,3600000) or not integer(idle,1,10000000) then return {-2} end
local cursor=redis.call('TYPE',KEYS[1]).ok
if cursor~='none' and cursor~='string' then return {-2} end
local start=cursor=='none' and 0 or tonumber(redis.call('GET',KEYS[1]))
if not integer(start,0,count-1) then return {-2} end
local states={} for i=1,count do states[i]=state(KEYS[i+1]) if states[i]==false then return {-2} end end
local disabled=0 local retry=10000000
for offset=0,count-1 do
  local index=(start+offset)%count+1 local s=states[index] local ready=0
  if s[2]==3 then disabled=disabled+1
  else
    if s[2]==1 then ready=s[3] elseif s[2]==2 then ready=s[5]+cooldown end
    if ready<=now then redis.call('PSETEX',KEYS[1],idle,tostring(index%count)) return {1,index} end
    retry=math.min(retry,ready-now)
  end
end
return {0,disabled==count and 2 or 1,math.max(1,retry)}
`;
const OPERATION = COMMON + `
if #KEYS~=2 or #ARGV~=13 then return {-2} end
local mode=ARGV[1] local member=ARGV[2] local lease=tonumber(ARGV[3]) local deadline=tonumber(ARGV[4])
local threshold=tonumber(ARGV[5]) local window=tonumber(ARGV[6]) local cooldown=tonumber(ARGV[7])
local rateCooldown=tonumber(ARGV[8]) local digest=ARGV[9] local outcome=ARGV[10]
local delay=tonumber(ARGV[11]) local at=tonumber(ARGV[12]) local idle=tonumber(ARGV[13])
if (mode~='acquire' and mode~='renew' and mode~='release' and mode~='cancel') or not hex(member)
  or not integer(lease,300,300000) or not integer(deadline,1,9007199254440991) or deadline>now+lease
  or not integer(threshold,1,100) or not integer(window,100,3600000) or not integer(cooldown,100,3600000)
  or not integer(rateCooldown,100,3600000) or not integer(idle,1,10000000)
  or not integer(delay,-1,9007199254740991) or not integer(at,-1,9007199254740991) or (delay>=0 and at>=0) then return {-2} end
if mode=='release' then
  if not hex(digest) or (outcome~='success' and outcome~='failure' and outcome~='cancelled'
    and outcome~='credential_rejected' and outcome~='rate_limited' and outcome~='neutral')
    or (outcome~='rate_limited' and (delay~=-1 or at~=-1)) then return {-2} end
elseif digest~='' or outcome~='' or delay~=-1 or at~=-1 then return {-2} end
local s=state(KEYS[1]) if s==false then return {-2} end
local p=decode(KEYS[2],6)
if p==false or p~=nil and (not integer(p[1],0,2) or not integer(p[2],0,9007199254740000)
  or not integer(p[3],0,1) or not integer(p[4],0,9007199254740000) or p[5]~=deadline
  or type(p[6])~='string' or (p[1]==1 and not hex(p[6])) or (p[1]~=1 and p[6]~='')) then return {-2} end
local function epoch() if s[1]>=9007199254740000 then return false end s[1]=s[1]+1 return true end
local function save()
  redis.call('SET',KEYS[1],cjson.encode(s))
  if s[2]~=3 then redis.call('PEXPIRE',KEYS[1],idle) end
end
local function reopen(untilMs)
  if not epoch() then return false end s[2]=1 s[3]=untilMs s[4]='' s[5]=0 s[6]={} return true
end
local function savePermit(value,ttl) redis.call('PSETEX',KEYS[2],math.max(1,ttl),cjson.encode(value)) end
if mode=='cancel' then
  if p~=nil and p[1]==1 then return {1} end
  if p~=nil and p[1]==0 and p[3]==1 and s[1]==p[2] and s[2]==2 and s[4]==member then
    if not reopen(now+cooldown) then return {-2} end save()
  end
  savePermit({2,p and p[2] or 0,p and p[3] or 0,0,deadline,''},math.max(lease,deadline+lease-now)) return {1}
end
if mode=='acquire' then
  if p~=nil or now>=deadline then return {-1} end
  if s[2]==3 then return {0,2,0} end
  if s[2]==2 and s[5]<=now then if not reopen(s[5]+cooldown) then return {-2} end end
  if s[2]==2 or s[2]==1 and s[3]>now then return {0,1,math.max(1,(s[2]==2 and s[5] or s[3])-now)} end
  local probe=s[2]==1 and 1 or 0
  if probe==1 then if not epoch() then return {-2} end s[2]=2 s[4]=member s[5]=now+lease end
  save() savePermit({0,s[1],probe,now+lease,deadline,''},lease*2) return {1,now+lease}
end
if mode=='renew' then
  if p==nil or p[1]~=0 or p[4]<=now then return {-1} end
  if p[3]==1 and (s[1]~=p[2] or s[2]~=2 or s[4]~=member or s[5]<=now) then return {-1} end
  p[4]=now+lease if p[3]==1 then s[5]=p[4] end
  save() savePermit(p,lease*2) return {1,p[4]}
end
if p==nil then return {-1} end
if p[1]==1 then if p[6]==digest then return {1} else return {-1} end end
if p[1]~=0 then return {-1} end
if p[4]>now and outcome=='credential_rejected' then
  if not epoch() then return {-2} end s[2]=3 s[3]=0 s[4]='' s[5]=0 s[6]={} save()
elseif s[1]==p[2] and (p[3]==0 or s[2]==2 and s[4]==member) then
  if p[4]<=now then
    if p[3]==1 then if not reopen(now+cooldown) then return {-2} end end
  elseif outcome=='rate_limited' then
    local untilMs=now+rateCooldown
    if delay>=0 then untilMs=math.max(untilMs,now+math.min(3600000,delay)) end
    if at>=0 then untilMs=math.max(untilMs,math.min(now+3600000,at)) end
    if not reopen(untilMs) then return {-2} end
  elseif outcome=='success' then
    s[6]={} if p[3]==1 then if not epoch() then return {-2} end s[2]=0 s[3]=0 s[4]='' s[5]=0 end
  elseif p[3]==1 then if not reopen(now+cooldown) then return {-2} end
  elseif outcome=='failure' then
    local failures={} for _,v in ipairs(s[6]) do if v>now-window then failures[#failures+1]=v end end
    failures[#failures+1]=now s[6]=failures
    if #failures>=threshold then if not reopen(now+cooldown) then return {-2} end end
  end
  save()
end
p[1]=1 p[6]=digest savePermit(p,lease*2) return {1}
`;
function unavailable(): ProviderPoolError { return new ProviderPoolError("unavailable"); }

/** No reconnect/replay. Settlement includes actual native TCP/TLS close. */
class PoolRedisPort {
  readonly redis: Redis;
  private connecting?: Promise<void>; private stopped = false; private closing?: Promise<void>;
  private readonly tasks = new Set<Promise<unknown>>(); private readonly sockets = new Map<Redis["stream"], Promise<void>>();
  constructor(url: string, timeoutMs: number, failure: () => void) {
    this.redis = guardRedisDatabaseSelection(new Redis(url, { lazyConnect: true, connectTimeout: timeoutMs, commandTimeout: timeoutMs,
      retryStrategy: () => null, reconnectOnError: () => false, maxRetriesPerRequest: 0, enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false, autoResubscribe: false, enableReadyCheck: false, disableClientInfo: true, protocol: 2 }));
    const failed = () => { this.observe(); if (!this.stopped) { failure(); this.stop(); } };
    this.redis.on("connect", () => this.observe()); this.redis.on("error", failed); this.redis.on("close", failed); this.redis.on("end", failed);
  }
  private observe() {
    const socket = this.redis.stream;
    if (socket && !this.sockets.has(socket)) this.sockets.set(socket, socket.closed ? Promise.resolve()
      : new Promise<void>(resolve => socket.once("close", () => resolve())));
    if (this.stopped) for (const owned of this.sockets.keys()) owned.destroy();
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(() => { if (this.stopped) throw unavailable(); return work(); });
    this.tasks.add(task); void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task)); return task;
  }
  async run<T>(work: (redis: Redis) => Promise<T>): Promise<T> {
    this.connecting ??= this.track(() => this.redis.connect()); await this.connecting; this.observe();
    if (this.stopped || this.redis.status !== "ready") throw unavailable(); return this.track(() => work(this.redis));
  }
  stop() { this.stopped = true; this.observe(); try { this.redis.disconnect(false); } catch { /* Always destroy owned native streams. */ } finally { this.observe(); } }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.stop();
    return this.closing = (async () => { while (this.tasks.size) { await Promise.allSettled([...this.tasks]); this.observe(); }
      this.observe(); await Promise.all([...this.sockets.values()]); })();
  }
}
export interface RedisProviderPoolOptions { url: string; prefix: string; namespaceId: string; leaseMs?: number; renewIntervalMs?: number; commandTimeoutMs?: number }
interface Selection { inventory: ProviderPoolInventory; policy: Required<ProviderPoolPolicy>; used: boolean }
interface Permit { controller: AbortController; done: Promise<void>; finish: () => void; timer?: ReturnType<typeof setInterval> }
export class RedisProviderPoolCoordinator implements ProviderPoolCoordinator {
  readonly namespaceSha256: string;
  private readonly settings: ReturnType<typeof captureProviderQuotaSettings>; private readonly port: PoolRedisPort; private readonly url: string;
  private readonly selections = new WeakMap<ProviderPoolSelection, Selection>(); private readonly leases = new Set<Permit>();
  private readonly pending = new Set<Promise<unknown>>(); private closed = false; private faulted = false; private closing?: Promise<void>;
  constructor(options: RedisProviderPoolOptions) {
    try { this.settings = captureProviderQuotaSettings(options, false); } catch { throw unavailable(); }
    this.namespaceSha256 = this.settings.namespaceSha256;
    if (typeof this.settings.url !== "string") throw unavailable(); this.url = this.settings.url;
    try { this.port = new PoolRedisPort(this.url, this.settings.commandTimeoutMs, () => this.fence()); } catch { throw unavailable(); }
  }
  private fence() { this.faulted = true; for (const lease of this.leases) { clearInterval(lease.timer); lease.controller.abort(); } this.port?.stop(); }
  private open() { if (this.closed || this.faulted) throw unavailable(); }
  private track<T>(work: Promise<T>): Promise<T> { this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); return work; }
  private base() { return `provider-pool-v1:{${this.namespaceSha256}}:`; }
  private stateKey(inventory: ProviderPoolInventory, selection: ProviderPoolSelection) { return this.base() + "state:" + providerPoolSlotKey(inventory, selection.slot); }
  private async evaluate(script: string, keys: readonly string[], args: readonly (string | number)[], fresh = false): Promise<number[]> {
    let port: PoolRedisPort | undefined;
    try {
      port = fresh ? new PoolRedisPort(this.url, this.settings.commandTimeoutMs, () => {}) : this.port;
      const value: unknown = await port.run(redis => redis.eval(script, keys.length, ...keys, ...args));
      if (!Array.isArray(value) || value.length < 1 || value.some(n => !Number.isSafeInteger(n))) throw unavailable(); return value as number[];
    } catch { if (!fresh) { this.fence(); await this.port.close(); } throw unavailable(); }
    finally { if (fresh) await port?.close(); }
  }
  async assertReady(): Promise<void> {
    try { this.open(); if (await this.port.run(redis => redis.ping()) !== "PONG") throw unavailable(); this.open(); }
    catch { this.fence(); await this.port.close(); throw unavailable(); }
  }
  select(inventory: ProviderPoolInventory, policy: ProviderPoolPolicy, signal: AbortSignal): Promise<ProviderPoolSelection> {
    return this.track(this.selectActual(inventory, policy, signal));
  }
  private async selectActual(inventory: ProviderPoolInventory, policy: ProviderPoolPolicy, signal: AbortSignal): Promise<ProviderPoolSelection> {
    if (this.faulted) await this.port.close();
    this.open(); if (!(signal instanceof AbortSignal) || signal.aborted) throw unavailable();
    let captured: ProviderPoolInventory, limits: Required<ProviderPoolPolicy>;
    try { captured = captureProviderPoolInventory(inventory); limits = captureProviderPoolPolicy(policy); } catch { throw unavailable(); }
    const keys = [this.base() + "cursor:" + poolDigest("provider-pool-cursor-v1", captured),
      ...captured.slots.map(slot => this.stateKey(captured, { slot }))];
    const result = await this.evaluate(SELECT, keys, [limits.cooldownMs, providerPoolIdleMs(limits, this.settings.leaseMs), captured.slots.length]);
    this.open(); if (signal.aborted) throw unavailable();
    if (result[0] === 0 && result.length === 3 && [1, 2].includes(result[1]!) && result[2]! > 0) throw new ProviderPoolError(result[1] === 2 ? "disabled" : "open", result[2]);
    if (result.length !== 2 || result[0] !== 1 || result[1]! < 1 || result[1]! > captured.slots.length) { this.fence(); await this.port.close(); throw unavailable(); }
    const selection = Object.freeze({ slot: Object.freeze({ ...captured.slots[result[1]! - 1]! }) });
    this.selections.set(selection, { inventory: captured, policy: limits, used: false }); return selection;
  }
  acquire(selection: ProviderPoolSelection, signal: AbortSignal): Promise<ProviderPoolLease> { return this.track(this.acquireActual(selection, signal)); }
  private async acquireActual(selection: ProviderPoolSelection, signal: AbortSignal): Promise<ProviderPoolLease> {
    if (this.faulted) await this.port.close();
    this.open(); if (!(signal instanceof AbortSignal) || signal.aborted) throw unavailable();
    const chosen = this.selections.get(selection); if (!chosen || chosen.used) throw unavailable(); chosen.used = true;
    const policy = chosen.policy, member = poolMember(), keys = [this.stateKey(chosen.inventory, selection), this.base() + "permit:" + member];
    const idle = providerPoolIdleMs(policy, this.settings.leaseMs), started = performance.now(); let deadline: number | undefined;
    const args = (mode: string, outcome?: ProviderPoolOutcome): (string | number)[] => [mode, member, this.settings.leaseMs, deadline!, policy.threshold,
      policy.windowMs, policy.cooldownMs, policy.rateLimitCooldownMs, outcome ? poolDigest("provider-pool-outcome-v1", outcome) : "", outcome?.kind ?? "",
      outcome?.kind === "rate_limited" ? outcome.retryDelayMs ?? -1 : -1, outcome?.kind === "rate_limited" ? outcome.retryAtMs ?? -1 : -1, idle];
    try {
      const time = await this.port.run(redis => redis.time());
      if (!Array.isArray(time) || time.length !== 2 || time.some(v => typeof v !== "string" || !/^[0-9]+$/.test(v))
        || !Number.isSafeInteger(Number(time[0])) || Number(time[1]) > 999_999) throw unavailable();
      const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
      if (!Number.isSafeInteger(now) || now > Number.MAX_SAFE_INTEGER - 600_000) throw unavailable(); deadline = now + this.settings.leaseMs;
      this.open(); if (signal.aborted || performance.now() >= started + this.settings.leaseMs) throw unavailable();
      const result = await this.evaluate(OPERATION, keys, args("acquire"));
      if (result[0] === 0 && result.length === 3 && [1, 2].includes(result[1]!) && result[2]! >= 0) throw new ProviderPoolError(result[1] === 2 ? "disabled" : "open", result[2] || undefined);
      if (result[0] !== 1 || result.length !== 2) throw unavailable();
      this.open(); if (signal.aborted || performance.now() >= started + this.settings.leaseMs) throw unavailable();
    } catch (error) {
      if (error instanceof ProviderPoolError && error.reason !== "unavailable") throw error;
      if (!signal.aborted && !this.closed) this.fence();
      if (deadline !== undefined) await this.evaluate(OPERATION, keys, args("cancel"), true).catch(() => {});
      if (this.faulted) await this.port.close(); throw unavailable();
    }
    let finish!: () => void;
    const controller = new AbortController(), lease: Permit = { controller, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    this.leases.add(lease); const aborted = () => controller.abort(); signal.addEventListener("abort", aborted, { once: true });
    let validUntil = started + this.settings.leaseMs, released = false, renewing: Promise<void> | undefined;
    const renew = (): Promise<void> => {
      if (renewing) return renewing;
      const work = (async () => {
        if (released || this.faulted || performance.now() >= validUntil) throw unavailable();
        const at = performance.now(), result = await this.evaluate(OPERATION, keys, args("renew"));
        if (result[0] !== 1 || result.length !== 2 || performance.now() >= at + this.settings.leaseMs) throw unavailable(); validUntil = at + this.settings.leaseMs;
      })().catch(() => { controller.abort(); clearInterval(lease.timer); throw unavailable(); });
      renewing = work; void work.then(() => { renewing = undefined; }, () => { renewing = undefined; }); return work;
    };
    lease.timer = setInterval(() => { void renew().catch(() => {}); }, this.settings.renewIntervalMs); lease.timer.unref();
    let releasing: Promise<void> | undefined, resultDigest: string | undefined;
    return Object.freeze({ signal: controller.signal,
      assertOpen: async () => { if (this.faulted) await this.port.close(); this.open(); if (released || controller.signal.aborted || signal.aborted) throw unavailable(); await renew(); this.open(); if (controller.signal.aborted) throw unavailable(); },
      release: (outcome: ProviderPoolOutcome) => {
        let captured: ProviderPoolOutcome, digest: string;
        try { captured = captureProviderPoolOutcome(outcome); digest = poolDigest("provider-pool-outcome-v1", captured); } catch { return Promise.reject(unavailable()); }
        if (releasing) return digest === resultDigest ? releasing : Promise.reject(unavailable());
        released = true; resultDigest = digest; clearInterval(lease.timer); signal.removeEventListener("abort", aborted); controller.abort();
        return releasing = this.track((async () => {
          try {
            if (renewing) await renewing.catch(() => {});
            const result = await this.evaluate(OPERATION, keys, args("release", captured), this.faulted);
            if (result[0] !== 1 || result.length !== 1) throw unavailable();
          } finally { this.leases.delete(lease); lease.finish(); }
        })());
      },
    });
  }
  /** Fence new consumers and request cancellation; their real release still owns its Redis I/O. */
  stop(): void { if (this.closed) return; this.closed = true; for (const lease of this.leases) lease.controller.abort(); }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.stop();
    return this.closing = (async () => { while (this.pending.size) await Promise.allSettled([...this.pending]);
      await Promise.all([...this.leases].map(lease => lease.done)); await this.port.close(); })();
  }
}
