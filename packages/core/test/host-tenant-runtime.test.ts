import { describe, expect, it } from "vitest";
import type { AgentDefinition, Principal } from "@agent-service/protocol";
import {
  MemoryEventBus,
  MemoryLeaseStore,
  MemorySessionStore,
  SubjectDeletingError,
  type CommitBatch,
} from "@agent-service/store";
import {
  SessionHost,
  StaticToolRegistry,
  TenantRuntimeCoordinator,
  newId,
  type AgentEngine,
  type ProviderResolver,
  type ResolvedModel,
} from "../src/index.js";
import { ScriptedEngine } from "./fake-engine.js";

const principal: Principal = { tenantId: "t_runtime", userId: "u" };
const model: ResolvedModel = {
  handle: {},
  provider: "fake",
  model: "fake-1",
  contextWindow: 32_000,
  input: ["text"],
  apiKey: async () => "unused",
};

const identity = {
  requestId: "ter_host_runtime",
  tenantId: principal.tenantId,
  subjectGeneration: 1,
  t3aReceiptSha256: "34".repeat(32),
};

async function setup(runtime: TenantRuntimeCoordinator, providers: ProviderResolver, engine: AgentEngine, store = new MemorySessionStore()) {
  const agent: AgentDefinition = {
    id: newId("agt"), tenantId: principal.tenantId, version: 1, name: "runtime", instructions: "test",
    model: { provider: "fake", model: "fake-1" }, tools: [], mcpServers: [], skills: [], limits: {},
    approvalPolicy: "on-request", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now(),
  };
  await store.createAgent(agent);
  const host = new SessionHost({
    store,
    lease: new MemoryLeaseStore(),
    bus: new MemoryEventBus(),
    providers,
    engine,
    tools: new StaticToolRegistry([]),
    tenantRuntime: runtime,
    config: { runnerId: "runtime-runner", runnerAddr: "127.0.0.1:4010", leaseTtlMs: 2_000, leaseHoldMs: 10 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const session = await host.createSession(principal, { agentId: agent.id, metadata: {} });
  return { host, session };
}

class BlockingTurnStartStore extends MemorySessionStore {
  blockTurnStart = false;
  private releaseCommit!: () => void;
  private readonly blocked = new Promise<void>((resolve) => { this.releaseCommit = resolve; });
  private markStarted!: () => void;
  readonly commitStarted = new Promise<void>((resolve) => { this.markStarted = resolve; });

  release(): void {
    this.releaseCommit();
  }

  override async commit(batch: CommitBatch) {
    if (this.blockTurnStart && batch.turn?.status === "inProgress") {
      this.markStarted();
      await this.blocked;
    }
    return super.commit(batch);
  }
}

describe("SessionHost tenant runtime fence", () => {
  it("counts queued/preflight work and waits for non-cancellable preflight before proving zero", async () => {
    const runtime = new TenantRuntimeCoordinator();
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    let releaseProvider!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providers: ProviderResolver = {
      resolve: async () => { providerStarted(); await blocked; return model; },
    };
    const { host, session } = await setup(runtime, providers, new ScriptedEngine([]));
    runtime.sealParticipants();
    const beginning = host.beginTurn(principal, session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await started;
    expect(runtime.snapshot(principal.tenantId).activeTurns).toBe(1);
    const draining = runtime.drain(identity, 1_000);
    releaseProvider();
    await expect(beginning).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(draining).resolves.toMatchObject({ activeTurnCountBefore: 1, activeTurnCountAfter: 0 });
    await host.drain(100);
  });

  it("aborts an active engine turn and waits until local finish releases the turn lease", async () => {
    const runtime = new TenantRuntimeCoordinator();
    let engineStarted!: () => void;
    const started = new Promise<void>((resolve) => { engineStarted = resolve; });
    const engine: AgentEngine = {
      name: "abort-aware",
      start: (params) => {
        engineStarted();
        return {
          steer: () => {},
          interrupt: () => {},
          done: new Promise((resolve) => {
            const finish = () => resolve({ steps: 0, aborted: true });
            params.signal.addEventListener("abort", finish, { once: true });
            if (params.signal.aborted) finish();
          }),
        };
      },
    };
    const { host, session } = await setup(runtime, { resolve: async () => model }, engine);
    runtime.sealParticipants();
    const begun = await host.beginTurn(principal, session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    begun.run();
    await started;
    const result = await runtime.drain(identity, 1_000);
    expect(result).toMatchObject({ activeTurnCountBefore: 1, activeTurnCountAfter: 0 });
    expect(runtime.snapshot(principal.tenantId).activeTurns).toBe(0);
    await host.drain(100);
  });

  it("does not prove zero while the atomic turn-start commit is still in flight", async () => {
    const runtime = new TenantRuntimeCoordinator();
    const store = new BlockingTurnStartStore();
    const { host, session } = await setup(runtime, { resolve: async () => model }, new ScriptedEngine([]), store);
    runtime.sealParticipants();
    store.blockTurnStart = true;
    const beginning = host.beginTurn(principal, session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await store.commitStarted;
    const draining = runtime.drain(identity, 1_000);
    let completed = false;
    void draining.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    store.release();
    await expect(beginning).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(draining).resolves.toMatchObject({ activeTurnCountBefore: 1, activeTurnCountAfter: 0 });
    await host.drain(100);
  });
});
