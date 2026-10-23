import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi, type TestContext } from "vitest";
import {
  Capabilities, PROTOCOL_VERSION, PROVIDER_GATEWAY_QUOTA_V1, ProviderGatewayFleetRequest,
  ProviderGatewayFleetResponse, type ProviderGatewayIdentity, INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_PROVIDER_GATEWAY_READY_PATH, INTERNAL_PROVIDER_GATEWAY_ACK_HEADER, INTERNAL_PROVIDER_GATEWAY_ACK_VALUE,
  ERASURE_JOB_CONTROL_QUARANTINE_V1, ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1,
} from "@agent-service/protocol";
import { RunnerRegistry, type ProviderGatewayProof } from "../src/registry.js";

const token = "gateway-isolation-private-router-token-0001";
const identity: ProviderGatewayIdentity = Object.freeze({ namespaceSha256: "a".repeat(64), policySha256: "b".repeat(64) });
const origins = ["http://gateway-isolation-a", "http://gateway-isolation-b"] as const;
const unavailable = () => new Error("Gateway isolation fixture is unproven.");
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Probe = { origin: string; path: string; signal: AbortSignal; nonce?: string; authenticated?: boolean };
type Job = { controller: AbortController; signal: AbortSignal; settled: boolean; outcome?: "fulfilled" | "rejected"; done: Promise<void> };

/** These are real protocol Responses, but no native HTTP/Redis or capacity claim is made. */
async function fixture(context: TestContext, work: (f: {
  start(): Job; close(): Promise<void>; probes: Probe[];
  held: { entered: ReturnType<typeof barrier>; cancelEntered: ReturnType<typeof barrier>;
    release(): void; acknowledgeCancel(): void; cancelStarted(): boolean; cancelSettled(): boolean };
}) => Promise<void>): Promise<void> {
  const entered = barrier(), delivery = barrier(), cancelEntered = barrier(), cancelAcknowledged = barrier(), finished = barrier();
  const probes: Probe[] = [], jobs: Job[] = [], fetches = new Set<Promise<Response>>();
  let heldCreated = false, cancelled = false, cancellationSettled = false, closeWork: Promise<void> | undefined;
  let fixtureFinished = false, primary: unknown, cleanupError: unknown;
  const capabilities = Capabilities.parse({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
    streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: [],
    dynamicTools: true, mcp: [], skills: false, hooks: false, sandbox: ["none"], byok: true,
    providerGateway: [PROVIDER_GATEWAY_QUOTA_V1], providerGatewayIdentity: identity,
  } });
  const response = (request: { nonce: string; identity: ProviderGatewayIdentity }, hold: boolean) => {
    const headers = { "content-type": "application/json", "cache-control": "no-store",
      [INTERNAL_PROVIDER_GATEWAY_ACK_HEADER]: INTERNAL_PROVIDER_GATEWAY_ACK_VALUE };
    const encoded = new TextEncoder().encode(JSON.stringify(ProviderGatewayFleetResponse.parse(request)));
    if (!hold) return new Response(encoded, { headers });
    let emitted = false;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (emitted) return; emitted = true; entered.resolve();
        await delivery.promise;
        if (cancelled) return;
        controller.enqueue(encoded); controller.close();
      },
      async cancel() {
        cancelled = true; cancelEntered.resolve(); delivery.resolve();
        await cancelAcknowledged.promise; cancellationSettled = true;
      },
    }, { highWaterMark: 0 }), { headers });
  };
  const fetchImpl: typeof fetch = (input, init) => {
    const pending = (async () => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (!origins.includes(url.origin as typeof origins[number]) || !(signal instanceof AbortSignal)) throw unavailable();
      signal.throwIfAborted();
      const probe: Probe = { origin: url.origin, path: url.pathname, signal }; probes.push(probe);
      if (url.pathname === "/readyz") return new Response(null, { status: 200 });
      if (url.pathname === "/v1/capabilities") return Response.json(capabilities);
      if (url.pathname !== INTERNAL_PROVIDER_GATEWAY_READY_PATH || init?.method !== "POST" || init.redirect !== "manual"
        || typeof init.body !== "string") throw unavailable();
      const request = ProviderGatewayFleetRequest.parse(JSON.parse(init.body));
      probe.nonce = request.nonce; probe.authenticated = new Headers(init.headers).get(INTERNAL_ROUTER_TOKEN_HEADER) === token;
      if (!probe.authenticated || JSON.stringify(request.identity) !== JSON.stringify(identity)) throw unavailable();
      const hold = !heldCreated && url.origin === origins[0];
      if (hold) heldCreated = true;
      return response(request, hold);
    })();
    fetches.add(pending); void pending.then(() => fetches.delete(pending), () => fetches.delete(pending));
    return pending;
  };
  vi.stubGlobal("fetch", fetchImpl);
  const registry = new RunnerRegistry({ runners: [...origins], internalRouterToken: token, providerGatewayIdentity: identity });
  const close = () => closeWork ??= registry.close();
  const start = (): Job => {
    const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
    const job: Job = { controller, signal, settled: false, done: Promise.resolve() };
    jobs.push(job);
    job.done = registry.refreshProviderGateway(signal).then(
      () => { job.outcome = "fulfilled"; job.settled = true; },
      () => { job.outcome = "rejected"; job.settled = true; },
    );
    return job;
  };
  const releaseEverything = () => {
    for (const job of jobs) job.controller.abort();
    delivery.resolve(); cancelAcknowledged.resolve();
  };
  context.signal.addEventListener("abort", releaseEverything, { once: true });
  context.onTestFinished(async () => {
    if (!fixtureFinished) releaseEverything();
    await finished.promise;
    if (cleanupError !== undefined) throw cleanupError;
  });
  try {
    context.signal.throwIfAborted();
    await work({ start, close, probes, held: { entered, cancelEntered, release: delivery.resolve,
      acknowledgeCancel: cancelAcknowledged.resolve, cancelStarted: () => cancelled, cancelSettled: () => cancellationSettled } });
    context.signal.throwIfAborted();
  } catch (error) { primary = error; }
  finally {
    releaseEverything();
    try {
      await Promise.all(jobs.map(job => job.done));
      const closed = await Promise.allSettled([close()]);
      await Promise.allSettled([...fetches]);
      if (closed[0]?.status === "rejected") throw closed[0].reason;
      if (jobs.some(job => !job.settled) || fetches.size || cancelled && !cancellationSettled) throw unavailable();
    } catch (error) { cleanupError = error; }
    finally {
      context.signal.removeEventListener("abort", releaseEverything);
      vi.unstubAllGlobals(); fixtureFinished = true; finished.resolve();
    }
  }
  if (primary !== undefined) throw primary;
  if (cleanupError !== undefined) throw cleanupError;
}

function privateProbes(probes: Probe[]) { return probes.filter(probe => probe.path === INTERNAL_PROVIDER_GATEWAY_READY_PATH); }
function expectOneFreshFullCall(before: Probe[], after: Probe[]) {
  for (const origin of origins) for (const path of ["/readyz", "/v1/capabilities", INTERNAL_PROVIDER_GATEWAY_READY_PATH]) {
    const count = (probes: Probe[]) => probes.filter(probe => probe.origin === origin && probe.path === path).length;
    expect(count(after)).toBe(count(before) + 1);
  }
  const priorNonces = new Set(privateProbes(before).map(probe => probe.nonce));
  const current = privateProbes(after.slice(before.length));
  expect(current).toHaveLength(2); expect(current.every(probe => probe.authenticated && !priorNonces.has(probe.nonce))).toBe(true);
  expect(new Set(current.map(probe => probe.nonce)).size).toBe(2);
}
function expectTwoFreshFullCalls(probes: Probe[]) {
  for (const origin of origins) for (const path of ["/readyz", "/v1/capabilities", INTERNAL_PROVIDER_GATEWAY_READY_PATH]) {
    expect(probes.filter(probe => probe.origin === origin && probe.path === path)).toHaveLength(2);
  }
  const privateCalls = privateProbes(probes);
  expect(privateCalls).toHaveLength(4); expect(privateCalls.every(probe => probe.authenticated)).toBe(true);
  expect(new Set(privateCalls.map(probe => probe.nonce)).size).toBe(4);
}

// Every non-held fetch/body is synchronous or a resolved Promise. A setImmediate boundary drains
// those runnable microtasks; it is not a millisecond latency SLO or a native concurrency proof.
describe("Provider Gateway per-caller full-fleet probe isolation", () => {
  it("completes a second fresh full-fleet proof while the first caller's private body remains held", async context => fixture(context, async f => {
    const first = f.start(); await f.held.entered.promise; await setImmediate();
    const before = [...f.probes];
    const second = f.start(); await setImmediate();
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(true); expect(second.outcome).toBe("fulfilled");
    expectOneFreshFullCall(before, f.probes);
    const peerCalls = privateProbes(f.probes).filter(probe => probe.origin === origins[0]);
    expect(peerCalls[0]!.signal).not.toBe(peerCalls[1]!.signal);
    expect(peerCalls[0]!.signal.aborted || peerCalls[1]!.signal.aborted).toBe(false);
    f.held.release(); await first.done; await second.done;
    expect(first.outcome).toBe("fulfilled"); expect(f.held.cancelStarted()).toBe(false); expectTwoFreshFullCalls(f.probes);
  }));

  it.for(["caller", "deadline"] as const)("joins the %s-aborted reader cancellation without aborting an independent caller", async (kind, context) => fixture(context, async f => {
    const first = f.start(); await f.held.entered.promise;
    // Expire a real AbortSignal deterministically. This proves cancellation ownership, not elapsed
    // deadline timing; production timeout values and the default test budget are untouched.
    first.controller.abort(new DOMException("Fixture cancellation.", kind === "deadline" ? "TimeoutError" : "AbortError"));
    await f.held.cancelEntered.promise; await setImmediate();
    expect(first.settled).toBe(false); expect(f.held.cancelSettled()).toBe(false);
    const before = [...f.probes];
    const second = f.start(); await setImmediate();
    expect(second.settled).toBe(true); expect(second.outcome).toBe("fulfilled");
    expectOneFreshFullCall(before, f.probes);
    const peerCalls = privateProbes(f.probes).filter(probe => probe.origin === origins[0]);
    expect(peerCalls[0]!.signal.aborted).toBe(true); expect(peerCalls[1]!.signal.aborted).toBe(false);
    f.held.acknowledgeCancel(); await first.done; await second.done;
    expect(first.outcome).toBe("rejected"); expect(f.held.cancelSettled()).toBe(true);
  }));

  it("cancels active peer work on registry.close, joins its acknowledgement and rejects new work before any fetch", async context => fixture(context, async f => {
    const first = f.start(); await f.held.entered.promise;
    let closed = false;
    const closing = f.close().then(() => { closed = true; });
    void closing.catch(() => {});
    try {
      await setImmediate();
      expect(f.held.cancelStarted()).toBe(true);
      expect(f.held.cancelSettled()).toBe(false); expect(first.settled).toBe(false); expect(closed).toBe(false);
      const count = f.probes.length, late = f.start(); await setImmediate();
      expect(late.settled).toBe(true); expect(late.outcome).toBe("rejected"); expect(f.probes).toHaveLength(count);
      f.held.acknowledgeCancel(); await first.done; await closing;
      expect(first.outcome).toBe("rejected"); expect(f.held.cancelSettled()).toBe(true); expect(closed).toBe(true);
    } finally { first.controller.abort(); f.held.acknowledgeCancel(); await first.done; await closing; }
  }));
});

type ProofStage = "ready" | "capabilities" | "private";
type ProofPlan = {
  pause?: { stage: ProofStage; entered: ReturnType<typeof barrier>; release: ReturnType<typeof barrier> };
  capabilityFailure?: "transport" | "http" | "malformed" | "service";
  erasureJobControl?: readonly (typeof ERASURE_JOB_CONTROL_QUARANTINE_V1 | typeof ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1)[];
  privateDenied?: boolean;
};
type ProofJob = {
  controller: AbortController; signal: AbortSignal; done: Promise<void>; settled: boolean;
  proof?: ProviderGatewayProof; error?: unknown;
};

/** Deterministic Response-only probe scheduling; these are not native HTTP or throughput proofs. */
async function proofFixture(context: TestContext, work: (f: {
  registry: RunnerRegistry; registrySibling(): RunnerRegistry;
  start(registry?: RunnerRegistry): ProofJob; pause(origin: string, stage: ProofStage, plan?: Omit<ProofPlan, "pause">): {
    entered: ReturnType<typeof barrier>; release(): void;
  };
  enqueue(origin: string, plan: ProofPlan): void; probes: Probe[];
}) => Promise<void>): Promise<void> {
  const registries: RunnerRegistry[] = [], jobs: ProofJob[] = [], fetches = new Set<Promise<Response>>();
  const plans = new Map<string, ProofPlan[]>(), observations = new Map<string, WeakMap<AbortSignal, ProofPlan>>();
  const releases: (() => void)[] = [], probes: Probe[] = [], finished = barrier();
  let fixtureFinished = false, primary: unknown, cleanupError: unknown;
  const capabilities = Capabilities.parse({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
    streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: [],
    dynamicTools: true, mcp: [], skills: false, hooks: false, sandbox: ["none"], byok: true,
    providerGateway: [PROVIDER_GATEWAY_QUOTA_V1], providerGatewayIdentity: identity,
    erasureJobControl: [ERASURE_JOB_CONTROL_QUARANTINE_V1, ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1],
  } });
  const wait = async (plan: ProofPlan, stage: ProofStage, signal: AbortSignal) => {
    if (plan.pause?.stage !== stage) return;
    const pause = plan.pause, abort = () => pause.release.resolve();
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted(); pause.entered.resolve(); await pause.release.promise; signal.throwIfAborted();
    } finally { signal.removeEventListener("abort", abort); }
  };
  const fetchImpl: typeof fetch = (input, init) => {
    const pending = (async () => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (!origins.includes(url.origin as typeof origins[number]) || !(signal instanceof AbortSignal)) throw unavailable();
      signal.throwIfAborted();
      const probe: Probe = { origin: url.origin, path: url.pathname, signal }; probes.push(probe);
      let perOrigin = observations.get(url.origin);
      if (!perOrigin) { perOrigin = new WeakMap(); observations.set(url.origin, perOrigin); }
      if (url.pathname === "/readyz") {
        const plan = plans.get(url.origin)?.shift() ?? {}; perOrigin.set(signal, plan);
        await wait(plan, "ready", signal); return new Response(null, { status: 200 });
      }
      const plan = perOrigin.get(signal); if (!plan) throw unavailable();
      if (url.pathname === "/v1/capabilities") {
        await wait(plan, "capabilities", signal);
        if (plan.capabilityFailure === "transport") throw unavailable();
        if (plan.capabilityFailure === "http") return new Response(null, { status: 503 });
        if (plan.capabilityFailure === "malformed") return new Response("{", { headers: { "content-type": "application/json" } });
        const observed = plan.erasureJobControl === undefined ? capabilities : Capabilities.parse({ ...capabilities,
          features: { ...capabilities.features, erasureJobControl: [...plan.erasureJobControl] } });
        return Response.json(plan.capabilityFailure === "service" ? { ...observed, service: "agent-router" } : observed);
      }
      if (url.pathname !== INTERNAL_PROVIDER_GATEWAY_READY_PATH || init?.method !== "POST"
        || init.redirect !== "manual" || typeof init.body !== "string") throw unavailable();
      const request = ProviderGatewayFleetRequest.parse(JSON.parse(init.body));
      probe.nonce = request.nonce; probe.authenticated = new Headers(init.headers).get(INTERNAL_ROUTER_TOKEN_HEADER) === token;
      if (!probe.authenticated || JSON.stringify(request.identity) !== JSON.stringify(identity)) throw unavailable();
      await wait(plan, "private", signal);
      if (plan.privateDenied) return new Response(null, { status: 503 });
      return Response.json(ProviderGatewayFleetResponse.parse(request), { headers: { "cache-control": "no-store",
        [INTERNAL_PROVIDER_GATEWAY_ACK_HEADER]: INTERNAL_PROVIDER_GATEWAY_ACK_VALUE } });
    })();
    fetches.add(pending); void pending.then(() => fetches.delete(pending), () => fetches.delete(pending));
    return pending;
  };
  vi.stubGlobal("fetch", fetchImpl);
  const registrySibling = () => {
    const registry = new RunnerRegistry({ runners: [...origins], internalRouterToken: token, providerGatewayIdentity: identity });
    registries.push(registry); return registry;
  };
  const registry = registrySibling();
  const start = (target = registry): ProofJob => {
    const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
    const job: ProofJob = { controller, signal, done: Promise.resolve(), settled: false }; jobs.push(job);
    job.done = target.refreshProviderGateway(signal).then(proof => { job.proof = proof; job.settled = true; }, error => {
      job.error = error; job.settled = true;
    });
    return job;
  };
  const enqueue = (origin: string, plan: ProofPlan) => {
    if (!origins.includes(origin as typeof origins[number])) throw unavailable();
    const queue = plans.get(origin) ?? []; queue.push(plan); plans.set(origin, queue);
  };
  const releaseEverything = () => { for (const job of jobs) job.controller.abort(); for (const release of releases) release(); };
  context.signal.addEventListener("abort", releaseEverything, { once: true });
  context.onTestFinished(async () => {
    if (!fixtureFinished) releaseEverything(); await finished.promise;
    if (cleanupError !== undefined) throw cleanupError;
  });
  try {
    context.signal.throwIfAborted();
    await work({ registry, registrySibling, start, enqueue, probes, pause(origin, stage, plan = {}) {
      const entered = barrier(), release = barrier(); releases.push(() => { entered.resolve(); release.resolve(); });
      enqueue(origin, { ...plan, pause: { stage, entered, release } }); return { entered, release: release.resolve };
    } });
    context.signal.throwIfAborted();
  } catch (error) { primary = error; }
  finally {
    releaseEverything();
    try {
      await Promise.all(jobs.map(job => job.done));
      for (const job of jobs) if (job.proof) for (const target of registries) target.releaseProviderGatewayProof(job.proof);
      const closed = await Promise.allSettled(registries.map(target => target.close()));
      await Promise.allSettled([...fetches]);
      const rejected = closed.find(result => result.status === "rejected"); if (rejected?.status === "rejected") throw rejected.reason;
      if (jobs.some(job => !job.settled) || fetches.size) throw unavailable();
    } catch (error) { cleanupError = error; }
    finally { context.signal.removeEventListener("abort", releaseEverything); vi.unstubAllGlobals(); fixtureFinished = true; finished.resolve(); }
  }
  if (primary !== undefined) throw primary;
  if (cleanupError !== undefined) throw cleanupError;
}

function issued(job: ProofJob): ProviderGatewayProof {
  expect(job.settled).toBe(true); expect(job.error).toBeUndefined(); expect(job.proof).toBeDefined();
  if (!job.proof) throw unavailable(); return job.proof;
}

describe("Provider Gateway original request-local proof capabilities", () => {
  it("accepts only the original frozen proof, its exact registry, caller signal and configured destination", async context => proofFixture(context, async f => {
    const job = f.start(); await job.done; const proof = issued(job), sibling = f.registrySibling();
    expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.identity)).toBe(true); expect(Object.isFrozen(proof.targets)).toBe(true);
    expect(proof.identity).toEqual(identity); expect(proof.targets).toEqual([...origins]);
    expect(() => f.registry.assertProviderGatewayProof(proof, job.signal)).not.toThrow();
    for (const origin of origins) expect(() => f.registry.assertProviderGatewayProof(proof, job.signal, origin)).not.toThrow();
    const cloned = structuredClone(proof); Object.freeze(cloned.identity); Object.freeze(cloned.targets); Object.freeze(cloned);
    for (const copied of [{ ...proof }, cloned, Object.freeze({ identity, targets: Object.freeze([...origins]) })]) {
      expect(() => f.registry.assertProviderGatewayProof(copied, job.signal)).toThrow();
    }
    expect(() => sibling.assertProviderGatewayProof(proof, job.signal)).toThrow();
    expect(() => f.registry.assertProviderGatewayProof(proof, new AbortController().signal)).toThrow();
    for (const target of ["http://not-configured", `${origins[0]}/`, `${origins[0]}/private`, "http://gateway-isolation-a:80"]) {
      expect(() => f.registry.assertProviderGatewayProof(proof, job.signal, target)).toThrow();
    }
    f.registry.releaseProviderGatewayProof(proof); f.registry.releaseProviderGatewayProof(proof);
    expect(() => f.registry.assertProviderGatewayProof(proof, job.signal)).toThrow();
  }));

  it("rejects an original proof after its caller aborts and after registry closing begins", async context => proofFixture(context, async f => {
    const aborted = f.start(); await aborted.done; const abortedProof = issued(aborted);
    aborted.controller.abort(); expect(() => f.registry.assertProviderGatewayProof(abortedProof, aborted.signal)).toThrow();
    const live = f.start(); await live.done; const liveProof = issued(live);
    const pause = f.pause(origins[0], "private"), held = f.start(); await pause.entered.promise;
    const closing = f.registry.close(); void closing.catch(() => {});
    try { expect(() => f.registry.assertProviderGatewayProof(liveProof, live.signal)).toThrow(); }
    finally { pause.release(); await held.done; await closing; }
    expect(held.error).toBeDefined(); expect(() => f.registry.assertProviderGatewayProof(liveProof, live.signal)).toThrow();
  }));

  it("does not let an older held success overwrite a newer real negative or revive a prior proof", async context => proofFixture(context, async f => {
    const seeded = f.start(); await seeded.done; const seedProof = issued(seeded);
    const pause = f.pause(origins[0], "private"), older = f.start(); await pause.entered.promise;
    f.enqueue(origins[0], { privateDenied: true }); const denied = f.start(); await denied.done;
    expect(denied.error).toBeDefined(); expect(denied.proof).toBeUndefined();
    expect(f.registry.list().find(target => target.url === origins[0])?.healthy).toBe(false);
    expect(() => f.registry.assertProviderGatewayProof(seedProof, seeded.signal)).toThrow();
    pause.release(); await older.done;
    expect(older.error).toBeDefined(); expect(older.proof).toBeUndefined();
    expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false);
    const current = f.start(); await current.done; const currentProof = issued(current);
    expect(() => f.registry.assertProviderGatewayProof(currentProof, current.signal)).not.toThrow();
    expect(() => f.registry.assertProviderGatewayProof(seedProof, seeded.signal)).toThrow();
  }));

  it.for(["transport", "http", "malformed", "service"] as const)("ignores older late %s capability failure before sticky deletion when newer success already published", async (failure, context) => proofFixture(context, async f => {
    const seeded = f.start(); await seeded.done; issued(seeded);
    expect(f.registry.allConfiguredSupportErasureJobControl()).toBe(true);
    const pause = f.pause(origins[0], "capabilities", { capabilityFailure: failure }), older = f.start(); await pause.entered.promise;
    const newer = f.start(); await newer.done; const proof = issued(newer);
    expect(f.registry.allConfiguredSupportErasureJobControl()).toBe(true);
    pause.release(); await older.done; expect(older.error).toBeDefined();
    expect(f.registry.list().every(target => target.healthy)).toBe(true);
    expect(f.registry.allConfiguredSupportProviderGateway()).toBe(true);
    expect(f.registry.allConfiguredSupportErasureJobControl()).toBe(true);
    expect(() => f.registry.assertProviderGatewayProof(proof, newer.signal)).not.toThrow();
  }));

  it.for([
    [ERASURE_JOB_CONTROL_QUARANTINE_V1],
    [ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1],
  ] as const)("revokes an explicit partial erasure contract %j even when an independent Gateway attestation fails", async (jobControl, context) => proofFixture(context, async f => {
    const seeded = f.start(); await seeded.done; const seedProof = issued(seeded);
    expect(f.registry.allConfiguredSupportErasureJobControl()).toBe(true);
    const before = f.probes.length;
    f.enqueue(origins[0], { erasureJobControl: jobControl, privateDenied: true });
    const denied = f.start(); await denied.done;
    expect(f.probes.slice(before).some(probe => probe.origin === origins[0]
      && probe.path === INTERNAL_PROVIDER_GATEWAY_READY_PATH && probe.authenticated)).toBe(true);
    expect(denied.error).toBeDefined(); expect(denied.proof).toBeUndefined();
    const target = f.registry.list().find(target => target.url === origins[0]);
    expect(target?.healthy).toBe(false); expect(target?.capabilities).toBeUndefined();
    expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false);
    expect(f.registry.allConfiguredSupportErasureJobControl()).toBe(false);
    expect(() => f.registry.assertProviderGatewayProof(seedProof, seeded.signal)).toThrow();
  }));

  it("ignores an older explicit erasure downgrade before independent attestation when a newer success already published", async context => proofFixture(context, async f => {
    const seeded = f.start(); await seeded.done; issued(seeded);
    const pause = f.pause(origins[0], "capabilities", {
      erasureJobControl: [ERASURE_JOB_CONTROL_QUARANTINE_V1], privateDenied: true,
    }), older = f.start();
    await pause.entered.promise;
    const newer = f.start(); await newer.done; const proof = issued(newer);
    expect(f.registry.allConfiguredSupportErasureJobControl()).toBe(true);
    pause.release(); await older.done;
    expect(older.error).toBeDefined(); expect(older.proof).toBeUndefined();
    expect(f.registry.list().every(target => target.healthy)).toBe(true);
    expect(f.registry.allConfiguredSupportProviderGateway()).toBe(true);
    expect(f.registry.allConfiguredSupportErasureJobControl()).toBe(true);
    expect(() => f.registry.assertProviderGatewayProof(proof, newer.signal)).not.toThrow();
  }));

  it("does not publish a caller cancellation as a peer downgrade or invalidate another caller's proof", async context => proofFixture(context, async f => {
    const seeded = f.start(); await seeded.done; const proof = issued(seeded);
    const before = f.registry.list().map(target => ({ url: target.url, healthy: target.healthy,
      consecutiveFailures: target.consecutiveFailures, capabilities: target.capabilities }));
    const pause = f.pause(origins[0], "capabilities"), cancelled = f.start(); await pause.entered.promise;
    cancelled.controller.abort(); await cancelled.done;
    expect(cancelled.error).toBeDefined(); expect(cancelled.proof).toBeUndefined();
    expect(f.registry.list().map(target => ({ url: target.url, healthy: target.healthy,
      consecutiveFailures: target.consecutiveFailures, capabilities: target.capabilities }))).toEqual(before);
    expect(f.registry.allConfiguredSupportErasureJobControl()).toBe(true);
    expect(() => f.registry.assertProviderGatewayProof(proof, seeded.signal)).not.toThrow();
    const current = f.start(); await current.done; expect(() => f.registry.assertProviderGatewayProof(issued(current), current.signal)).not.toThrow();
  }));

  it("preserves the two-failure markFailure threshold but later recovery cannot revive the invalidated proof", async context => proofFixture(context, async f => {
    const seeded = f.start(); await seeded.done; const proof = issued(seeded);
    f.registry.markFailure(origins[0]);
    expect(f.registry.list().find(target => target.url === origins[0])?.healthy).toBe(true);
    expect(() => f.registry.assertProviderGatewayProof(proof, seeded.signal)).not.toThrow();
    f.registry.markFailure(origins[0]);
    expect(f.registry.list().find(target => target.url === origins[0])?.healthy).toBe(false);
    expect(() => f.registry.assertProviderGatewayProof(proof, seeded.signal)).toThrow();
    const current = f.start(); await current.done; expect(() => f.registry.assertProviderGatewayProof(issued(current), current.signal)).not.toThrow();
    expect(() => f.registry.assertProviderGatewayProof(proof, seeded.signal)).toThrow();
  }));
});

type BoundedBody = {
  entered: ReturnType<typeof barrier>; cancelEntered: ReturnType<typeof barrier>;
  complete(): void; acknowledgeCancel(): void; cancelled: boolean; cancellationSettled: boolean;
  pullStarted: boolean; pullSettled: boolean;
};
type BoundedJob = ProofJob & { deadline?: AbortController };
type BoundedFixture = {
  registry: RunnerRegistry; start(): BoundedJob; close(): Promise<void>; holdBodies(): void;
  waitBodies(count: number): Promise<void>; bodies: BoundedBody[]; probes: Probe[];
  deadlines: { milliseconds: number; controller: AbortController }[];
};

/** The real timeout factory is replaced only for deterministic deadline ordering, not a latency SLO. */
async function boundedFixture(context: TestContext, work: (f: BoundedFixture) => Promise<void>): Promise<void> {
  const origin = "http://gateway-bounded-peer", bodies: BoundedBody[] = [], probes: Probe[] = [], jobs: BoundedJob[] = [];
  const deadlines: BoundedFixture["deadlines"] = [], fetches = new Set<Promise<Response>>();
  const waiters = new Set<{ count: number; resolve(): void }>(), finished = barrier();
  const nativeTimeout = AbortSignal.timeout;
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    if (milliseconds !== 2_000) return nativeTimeout.call(AbortSignal, milliseconds);
    const controller = new AbortController(); deadlines.push({ milliseconds, controller }); return controller.signal;
  });
  const capabilities = Capabilities.parse({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
    streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: [],
    dynamicTools: true, mcp: [], skills: false, hooks: false, sandbox: ["none"], byok: true,
    providerGateway: [PROVIDER_GATEWAY_QUOTA_V1], providerGatewayIdentity: identity,
  } });
  let hold = false, registry: RunnerRegistry | undefined, closing: Promise<void> | undefined;
  let primary: unknown, cleanupError: unknown, fixtureFinished = false;
  const fetchImpl: typeof fetch = (input, init) => {
    const pending = (async () => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (url.origin !== origin || !(signal instanceof AbortSignal)) throw unavailable();
      signal.throwIfAborted(); const probe: Probe = { origin, path: url.pathname, signal }; probes.push(probe);
      if (url.pathname === "/readyz") return new Response(null, { status: 200 });
      if (url.pathname === "/v1/capabilities") return Response.json(capabilities);
      if (url.pathname !== INTERNAL_PROVIDER_GATEWAY_READY_PATH || init?.method !== "POST"
        || init.redirect !== "manual" || typeof init.body !== "string") throw unavailable();
      const request = ProviderGatewayFleetRequest.parse(JSON.parse(init.body));
      probe.nonce = request.nonce; probe.authenticated = new Headers(init.headers).get(INTERNAL_ROUTER_TOKEN_HEADER) === token;
      if (!probe.authenticated || JSON.stringify(request.identity) !== JSON.stringify(identity)) throw unavailable();
      const encoded = new TextEncoder().encode(JSON.stringify(ProviderGatewayFleetResponse.parse(request)));
      const headers = { "content-type": "application/json", "cache-control": "no-store",
        [INTERNAL_PROVIDER_GATEWAY_ACK_HEADER]: INTERNAL_PROVIDER_GATEWAY_ACK_VALUE };
      if (!hold) return new Response(encoded, { headers });
      const delivery = barrier(), acknowledged = barrier();
      const body: BoundedBody = { entered: barrier(), cancelEntered: barrier(), complete: delivery.resolve,
        acknowledgeCancel: acknowledged.resolve, cancelled: false, cancellationSettled: false, pullStarted: false, pullSettled: false };
      bodies.push(body);
      for (const waiter of waiters) if (bodies.length >= waiter.count) { waiters.delete(waiter); waiter.resolve(); }
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (body.pullStarted) return;
          body.pullStarted = true; body.entered.resolve();
          try { await delivery.promise; if (!body.cancelled) { controller.enqueue(encoded); controller.close(); } }
          finally { body.pullSettled = true; }
        },
        async cancel() {
          body.cancelled = true; body.cancelEntered.resolve(); delivery.resolve();
          await acknowledged.promise; body.cancellationSettled = true;
        },
      }, { highWaterMark: 0 }), { headers });
    })();
    fetches.add(pending); void pending.then(() => fetches.delete(pending), () => fetches.delete(pending)); return pending;
  };
  const close = () => closing ??= registry?.close() ?? Promise.resolve();
  const releaseEverything = () => {
    for (const job of jobs) job.controller.abort();
    for (const deadline of deadlines) deadline.controller.abort();
    for (const body of bodies) { body.entered.resolve(); body.cancelEntered.resolve(); body.complete(); body.acknowledgeCancel(); }
    for (const waiter of waiters) waiter.resolve(); waiters.clear();
  };
  context.signal.addEventListener("abort", releaseEverything, { once: true });
  context.onTestFinished(async () => {
    if (!fixtureFinished) releaseEverything(); await finished.promise;
    if (cleanupError !== undefined) throw cleanupError;
  });
  try {
    context.signal.throwIfAborted(); vi.stubGlobal("fetch", fetchImpl);
    registry = new RunnerRegistry({ runners: [origin], internalRouterToken: token, providerGatewayIdentity: identity });
    const activeRegistry = registry;
    await work({ registry: activeRegistry, close, bodies, probes, deadlines, holdBodies() { hold = true; },
      start() {
        const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
        const index = deadlines.length, job: BoundedJob = { controller, signal, settled: false, done: Promise.resolve() };
        jobs.push(job);
        const pending = activeRegistry.refreshProviderGateway(signal), deadline = deadlines[index]?.controller;
        if (deadline) job.deadline = deadline;
        job.done = pending.then(proof => { job.proof = proof; job.settled = true; }, error => { job.error = error; job.settled = true; });
        return job;
      },
      async waitBodies(count) {
        if (bodies.length < count) await new Promise<void>(resolve => { waiters.add({ count, resolve }); });
        await Promise.all(bodies.slice(0, count).map(body => body.entered.promise)); context.signal.throwIfAborted();
      },
    });
    context.signal.throwIfAborted();
  } catch (error) { primary = error; }
  finally {
    releaseEverything();
    try {
      await Promise.all(jobs.map(job => job.done));
      for (const job of jobs) if (job.proof) registry?.releaseProviderGatewayProof(job.proof);
      await close(); await Promise.allSettled([...fetches]);
      if (jobs.some(job => !job.settled) || fetches.size || bodies.some(body => body.pullStarted && !body.pullSettled
        || body.cancelled && !body.cancellationSettled)) throw unavailable();
    } catch (error) { cleanupError = error; }
    finally {
      context.signal.removeEventListener("abort", releaseEverything); timeoutSpy.mockRestore(); vi.unstubAllGlobals();
      fixtureFinished = true; finished.resolve();
    }
  }
  if (primary !== undefined) throw primary;
  if (cleanupError !== undefined) throw cleanupError;
}

async function occupyBoundedProbes(f: BoundedFixture): Promise<BoundedJob[]> {
  f.holdBodies(); const jobs: BoundedJob[] = [];
  // Sequential entry makes each held reader's ownership exact without depending on CPU timing.
  for (let index = 0; index < 32; index++) { jobs.push(f.start()); await f.waitBodies(index + 1); }
  expect(jobs.every(job => !job.settled)).toBe(true); expect(f.bodies).toHaveLength(32); return jobs;
}
function expireBoundedJob(job: BoundedJob) {
  expect(job.deadline).toBeDefined();
  if (!job.deadline) throw unavailable(); job.deadline.abort(new DOMException("Fixture peer deadline.", "TimeoutError"));
}

describe("Provider Gateway bounded full-fleet probe admission", () => {
  it("keeps the 33rd call fetch-free until an aborted active reader's real cancellation acknowledgement settles", async context => boundedFixture(context, async f => {
    const warm = f.start(); await warm.done; const warmProof = issued(warm), active = await occupyBoundedProbes(f);
    const before = [...f.probes], queued = f.start(); await setImmediate();
    expect(queued.settled).toBe(false); expect(f.probes).toEqual(before);
    active[0]!.controller.abort(); await f.bodies[0]!.cancelEntered.promise; await setImmediate();
    expect(active[0]!.settled).toBe(false); expect(f.bodies[0]!.cancellationSettled).toBe(false);
    expect(queued.settled).toBe(false); expect(f.probes).toEqual(before);
    expect(() => f.registry.assertProviderGatewayProof(warmProof, warm.signal)).not.toThrow();
    f.bodies[0]!.acknowledgeCancel(); await active[0]!.done; await f.waitBodies(33);
    expect(active[0]!.error).toBeDefined(); expect(f.bodies[0]!.cancellationSettled).toBe(true);
    expect(f.probes.slice(before.length).map(probe => probe.path)).toEqual(["/readyz", "/v1/capabilities", INTERNAL_PROVIDER_GATEWAY_READY_PATH]);
    const prior = new Set(privateProbes(before).map(probe => probe.nonce));
    expect(privateProbes(f.probes).at(-1)?.authenticated).toBe(true); expect(prior.has(privateProbes(f.probes).at(-1)?.nonce)).toBe(false);
    f.bodies[32]!.complete(); await queued.done;
    expect(() => f.registry.assertProviderGatewayProof(issued(queued), queued.signal)).not.toThrow();
  }));

  it("removes queued caller cancellation and deadline without peer evidence, then preserves FIFO with a fresh nonce", async context => boundedFixture(context, async f => {
    const warm = f.start(); await warm.done; const proof = issued(warm), active = await occupyBoundedProbes(f);
    const before = [...f.probes], caller = f.start(), expired = f.start(), next = f.start(), last = f.start();
    await setImmediate(); expect(f.probes).toEqual(before);
    caller.controller.abort(); expireBoundedJob(expired); await caller.done; await expired.done;
    expect(caller.error).toBeDefined(); expect(expired.error).toBeDefined();
    expect(caller.proof).toBeUndefined(); expect(expired.proof).toBeUndefined(); expect(f.probes).toEqual(before);
    expect(f.registry.allConfiguredSupportProviderGateway()).toBe(true);
    expect(() => f.registry.assertProviderGatewayProof(proof, warm.signal)).not.toThrow();
    f.bodies[0]!.complete(); await active[0]!.done; await f.waitBodies(33); f.bodies[32]!.complete();
    await setImmediate(); expect(next.settled).toBe(true); expect(next.error).toBeUndefined(); expect(last.settled).toBe(false);
    await f.waitBodies(34); f.bodies[33]!.complete(); await last.done;
    expect(() => f.registry.assertProviderGatewayProof(issued(next), next.signal)).not.toThrow(); issued(last);
    const nonces = privateProbes(f.probes).map(probe => probe.nonce);
    expect(new Set(nonces).size).toBe(nonces.length); expect(nonces).toHaveLength(privateProbes(before).length + 2);
  }));

  it("keeps the entry 2s deadline through permit handoff and publishes a real active peer timeout rather than caller cancellation", async context => boundedFixture(context, async f => {
    const warm = f.start(); await warm.done; const proof = issued(warm), active = await occupyBoundedProbes(f);
    const queued = f.start(), count = f.deadlines.length, originalDeadline = queued.deadline;
    expect(count).toBe(34); expect(f.deadlines.every(deadline => deadline.milliseconds === 2_000)).toBe(true);
    f.bodies[0]!.complete(); await active[0]!.done; await f.waitBodies(33);
    expect(f.deadlines).toHaveLength(count); expect(queued.deadline).toBe(originalDeadline);
    expireBoundedJob(queued); await f.bodies[32]!.cancelEntered.promise;
    expect(queued.signal.aborted).toBe(false); expect(queued.settled).toBe(false); expect(f.bodies[32]!.cancellationSettled).toBe(false);
    f.bodies[32]!.acknowledgeCancel(); await queued.done;
    expect(queued.error).toBeDefined(); expect(queued.proof).toBeUndefined(); expect(f.bodies[32]!.cancellationSettled).toBe(true);
    expect(f.registry.list()[0]!.healthy).toBe(false); expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false);
    expect(() => f.registry.assertProviderGatewayProof(proof, warm.signal)).toThrow();
  }));

  it("accepts exactly 32 active plus 1024 queued calls and rejects overflow without any peer fetch, nonce or denial", async context => boundedFixture(context, async f => {
    const warm = f.start(); await warm.done; const proof = issued(warm); await occupyBoundedProbes(f);
    const before = [...f.probes], queued = Array.from({ length: 1_024 }, () => f.start()); await setImmediate();
    expect(queued.every(job => !job.settled)).toBe(true); expect(f.probes).toEqual(before);
    const overflow = f.start(); await overflow.done;
    expect(overflow.error).toBeDefined(); expect(overflow.proof).toBeUndefined(); expect(f.probes).toEqual(before);
    expect(f.bodies).toHaveLength(32); expect(f.registry.allConfiguredSupportProviderGateway()).toBe(true);
    expect(() => f.registry.assertProviderGatewayProof(proof, warm.signal)).not.toThrow();
    queued[0]!.controller.abort(); await queued[0]!.done;
    const replacement = f.start(); await setImmediate();
    expect(replacement.settled).toBe(false); expect(f.probes).toEqual(before);
    expireBoundedJob(queued[1]!); await queued[1]!.done;
    const afterExpiry = f.start(); await setImmediate();
    expect(afterExpiry.settled).toBe(false); expect(f.probes).toEqual(before);
    expect(() => f.registry.assertProviderGatewayProof(proof, warm.signal)).not.toThrow();
  }));

  it("closes admission before cancelling queued work and joins all active reader acknowledgements before close completes", async context => boundedFixture(context, async f => {
    const active = await occupyBoundedProbes(f), queued = [f.start(), f.start(), f.start()], before = [...f.probes];
    let closed = false; const closing = f.close().then(() => { closed = true; }); void closing.catch(() => {});
    try {
      await Promise.all(f.bodies.map(body => body.cancelEntered.promise)); await Promise.all(queued.map(job => job.done));
      expect(queued.every(job => job.error !== undefined && job.proof === undefined)).toBe(true);
      expect(active.every(job => !job.settled)).toBe(true); expect(closed).toBe(false); expect(f.probes).toEqual(before);
      const late = f.start(); await late.done;
      expect(late.error).toBeDefined(); expect(late.proof).toBeUndefined(); expect(f.probes).toEqual(before);
      for (const body of f.bodies) body.acknowledgeCancel(); await closing; await Promise.all(active.map(job => job.done));
      expect(closed).toBe(true); expect(active.every(job => job.settled && job.error !== undefined)).toBe(true);
      expect(f.bodies.every(body => body.cancellationSettled && body.pullSettled)).toBe(true);
    } finally { for (const body of f.bodies) { body.complete(); body.acknowledgeCancel(); } await closing; }
  }));
});
