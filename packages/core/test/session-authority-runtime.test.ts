import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySessionStore, MemoryEventBus, type SessionAuthority } from "@agent-service/store";
import { captureSessionAcquireCommand } from "../../store/src/session-authority.js";
import { mkSession } from "../../store/test/conformance.js";
import { acquireSessionAuthority, createSessionAuthorityGuard } from "../src/session/authority.js";
import { SessionHost } from "../src/session/host.js";
import { StaticToolRegistry } from "../src/tools/types.js";
import { ScriptedEngine } from "./fake-engine.js";
import { newId } from "../src/ids.js";
import type { AgentDefinition } from "@agent-service/protocol";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());
async function fixture() {
  const store = new MemorySessionStore(), session = mkSession(); await store.createSession(session);
  const authority = store.sessionAuthority, input = { sessionId: session.id,
    principal: { tenantId: session.tenantId, userId: session.userId }, runnerId: "r1", runnerAddr: "127.0.0.1:1",
    bootId: randomUUID(), expectedFence: 0, ttlMs: 3000 };
  return { store, session, authority, input };
}
function facade(source: SessionAuthority, patch: Partial<SessionAuthority>): SessionAuthority {
  return { identity: () => source.identity(), acquire: command => source.acquire(command), confirm: command => source.confirm(command),
    acquireForErasure: (command, authorization, predecessor) => source.acquireForErasure(command, authorization, predecessor),
    confirmForErasure: (command, authorization, predecessor) => source.confirmForErasure(command, authorization, predecessor),
    renew: (proof, ttl) => source.renew(proof, ttl), release: proof => source.release(proof),
    getOwner: id => source.getOwner(id), close: () => source.close(), ...patch };
}
describe("single live authority runtime wiring", () => {
  it("confirms the identical fixed command after a committed response loss without a second acquire", async () => {
    const f = await fixture(); let command: Parameters<SessionAuthority["acquire"]>[0] | undefined, acquisitions = 0, confirmations = 0;
    try {
      const authority = facade(f.authority, { async acquire(value) { acquisitions++; command = value; await f.authority.acquire(value); throw Error("response_lost"); },
        async confirm(value) { confirmations++; expect(value).toBe(command); return f.authority.confirm(value); } });
      const result = await acquireSessionAuthority(authority, f.input);
      expect(result.ok).toBe(true); expect(acquisitions).toBe(1); expect(confirmations).toBe(1);
      expect(captureSessionAcquireCommand(command!)).toMatchObject({ expectedFence: 0, bootId: f.input.bootId });
      if (result.ok) await f.authority.release(result.proof);
    } finally { await f.store.close(); }
  });
  it("preserves an unknown acquire failure when exact confirmation is also unavailable", async () => {
    const f = await fixture(), failure = Error("unknown_acquire"); let calls = 0;
    try { await expect(acquireSessionAuthority(facade(f.authority, {
      async acquire() { calls++; throw failure; }, async confirm() { calls++; throw Error("unavailable"); },
    }), f.input)).rejects.toBe(failure); expect(calls).toBe(2); expect(await f.authority.getOwner(f.session.id)).toBeNull(); }
    finally { await f.store.close(); }
  });
  it("never revives observed loss when a timed-out original renew eventually succeeds and joins it", async () => {
    const f = await fixture(), result = await acquireSessionAuthority(f.authority, f.input);
    if (!result.ok) throw Error("fixture_acquire");
    const late = deferred<boolean>(); vi.useFakeTimers();
    const guard = createSessionAuthorityGuard(facade(f.authority, { renew: () => late.promise }), result.proof, 3000);
    try {
      await vi.advanceTimersByTimeAsync(2000); await guard.loss; expect(guard.abort.signal.aborted).toBe(true);
      let settled = false; const settlement = guard.settle().then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
      late.resolve(true); await settlement; expect(guard.lost?.code).toBe("session_lease_conflict"); expect(() => guard.assertOwned()).toThrow("session lease was lost");
    } finally { late.resolve(true); await guard.settle(); vi.useRealTimers(); await f.authority.release(result.proof); await f.store.close(); }
  });
  it("joins a read hidden by observed loss before the caller can exact-release its guard", async () => {
    const f = await fixture(), result = await acquireSessionAuthority(f.authority, f.input);
    if (!result.ok) throw Error("fixture_acquire");
    const read = deferred<string>(); vi.useFakeTimers();
    const guard = createSessionAuthorityGuard(facade(f.authority, { renew: async () => false }), result.proof, 3000);
    const logical = guard.wait(read.promise).catch(failure => failure);
    try {
      await vi.advanceTimersByTimeAsync(1000); expect((await logical).code).toBe("session_lease_conflict");
      let settled = false; const actual = guard.settle().then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
      read.resolve("late"); await actual; expect(settled).toBe(true);
    } finally { read.resolve("late"); await guard.settle(); vi.useRealTimers(); await f.authority.release(result.proof); await f.store.close(); }
  });
  it("gives each same-boot acquisition a new nonce and a late exact old release cannot retire its successor", async () => {
    const f = await fixture(), commands: ReturnType<typeof captureSessionAcquireCommand>[] = [];
    const source = facade(f.authority, { acquire(command) { commands.push(captureSessionAcquireCommand(command)); return f.authority.acquire(command); } });
    try {
      const first = await acquireSessionAuthority(source, f.input); if (!first.ok) throw Error("fixture_acquire");
      await source.release(first.proof);
      const second = await acquireSessionAuthority(source, { ...f.input, expectedFence: first.fence }); if (!second.ok) throw Error("fixture_acquire");
      expect(commands).toHaveLength(2); expect(commands[1]!.bootId).toBe(commands[0]!.bootId);
      expect(commands[1]!.acquisitionId).not.toBe(commands[0]!.acquisitionId); expect(second.fence).toBe(first.fence + 1);
      await source.release(first.proof); expect((await source.getOwner(f.session.id))?.fence).toBe(second.fence); await source.release(second.proof);
    } finally { await f.store.close(); }
  });
  it("uses the store authority for two complete Host turns and retains content while rotating ownership", async () => {
    const store = new MemorySessionStore(), bus = new MemoryEventBus(), engine = new ScriptedEngine([{ text: "synthetic answer" }]);
    const agent: AgentDefinition = { id: newId("agt"), tenantId: "t_a", version: 1, name: "authority-test", instructions: "synthetic",
      model: { provider: "fake", model: "fake-1" }, tools: [], mcpServers: [], skills: [], limits: {}, approvalPolicy: "on-request",
      busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
    await store.createAgent(agent);
    const host = new SessionHost({ store, lease: store.sessionAuthority, bus, engine, tools: new StaticToolRegistry([]),
      providers: { resolve: async () => ({ handle: {}, provider: "fake", model: "fake-1", contextWindow: 32000, input: ["text"], apiKey: async () => "fixture" }) },
      config: { runnerId: "r1", runnerAddr: "127.0.0.1:1", leaseTtlMs: 3000, leaseHoldMs: 60000, approvalTtlMs: 5000 },
      logger: { info() {}, warn() {}, error() {} } });
    try {
      const principal = { tenantId: "t_a", userId: "u_1" }, session = await host.createSession(principal, { agentId: agent.id, metadata: {} });
      for (const text of ["first synthetic input", "same session followup"]) {
        await host.startTurn(principal, session.id, { input: [{ type: "text", text }], metadata: {}, stream: false });
        await vi.waitFor(async () => { expect(await store.sessionAuthority.getOwner(session.id)).toBeNull();
          expect((await store.listTurns(session.id, { limit: 10 })).data.every(turn => turn.status !== "inProgress")).toBe(true); });
      }
      expect((await store.getSession(principal.tenantId, session.id))?.fenceToken).toBe(2);
      expect((await store.listTurns(session.id, { limit: 10 })).data).toHaveLength(2);
      expect(engine.received[1]!.history.length).toBeGreaterThan(0);
    } finally { await host.drain(1000); await bus.close(); await store.close(); }
  });
});
