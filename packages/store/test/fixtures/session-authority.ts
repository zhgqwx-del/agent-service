import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { Session } from "@agent-service/protocol";
import { attachSessionWriteAdmission, createSessionAcquireCommand, type CommitBatch, type SessionStore } from "../../src/index.js";
import { MemorySessionAuthority } from "../../src/memory-session-authority.js";
import { MysqlSessionAuthority } from "../../src/mysql/session-authority.js";

/** Current-schema tests only. The predecessor is mandatory; no floor refresh or proof-by-number map. */
export async function acquireFixtureSessionAuthority(store: SessionStore,
  session: Pick<Session, "id" | "tenantId" | "userId">, expectedFence: number,
  options: { runnerId?: string; runnerAddr?: string; bootId?: string; ttlMs?: number } = {}) {
  const command = createSessionAcquireCommand({ sessionId: session.id,
    principal: { tenantId: session.tenantId, userId: session.userId }, expectedFence,
    runnerId: options.runnerId ?? "store-conformance", runnerAddr: options.runnerAddr ?? "127.0.0.1:1",
    bootId: options.bootId ?? randomUUID(), acquisitionId: randomUUID(), ttlMs: options.ttlMs ?? 30_000 });
  const result = await store.sessionAuthority.acquire(command);
  if (!result.ok || result.fence !== expectedFence + 1) throw Error("fixture_session_authority_not_acquired");
  let releasing: Promise<void> | undefined;
  return Object.freeze({ command, proof: result.proof, fence: result.fence,
    admit<T extends CommitBatch>(batch: T): T { return attachSessionWriteAdmission(batch, result.proof); },
    release(): Promise<void> { return releasing ??= store.sessionAuthority.release(result.proof); },
  });
}

/**
 * Fault injection only on this owning backend instance. Both native authorization calls still run
 * completely, against the original valid admission. Ordinary current-schema commit passes the same
 * batch through the subagent facade then the business kernel; the second validation is immediately
 * before that kernel. A changed call graph must fail the exact counters/getter/error assertions.
 */
export function injectGetterAfterFixtureAuthorization(store: SessionStore, batch: CommitBatch,
  target: object, key: string, message: string) {
  let validated = 0, getterReads = 0, installed = false;
  const originalDescriptor = Object.getOwnPropertyDescriptor(target, key);
  const afterValidation = (observed: object) => {
    if (observed !== batch) return;
    validated++;
    if (validated === 2) {
      Object.defineProperty(target, key, { configurable: true, enumerable: true,
        get() { getterReads++; throw Error(message); } });
      installed = true;
    }
  };
  const authority = store.sessionAuthority;
  let restore: () => void;
  if (authority instanceof MemorySessionAuthority) {
    const original = authority.assertWrite.bind(authority);
    const spy = vi.spyOn(authority, "assertWrite").mockImplementation((value, scope, explicitProof) => {
      const result = original(value, scope, explicitProof); afterValidation(value); return result;
    });
    restore = () => spy.mockRestore();
  } else if (authority instanceof MysqlSessionAuthority) {
    const original = authority.assertWrite.bind(authority);
    const spy = vi.spyOn(authority, "assertWrite").mockImplementation(async (connection, value, scope, explicit) => {
      const result = await original(connection, value, scope, explicit); afterValidation(value); return result;
    });
    restore = () => spy.mockRestore();
  } else throw Error("fixture_session_authority_backend_unsupported");
  return { stats: () => ({ validated, getterReads, installed }), restore() {
    restore(); if (installed) {
      if (originalDescriptor) Object.defineProperty(target, key, originalDescriptor);
      else Reflect.deleteProperty(target, key);
    }
  } };
}

/** Explicit current-fixture ownership scope. The caller supplies the predecessor before any batch.
 * No fence lookup, fallback, automatic re-acquire, mutation, or implicit admission occurs here. */
export async function withFixtureSessionAuthority<T>(store: SessionStore,
  session: Pick<Session, "id" | "tenantId" | "userId">, expectedFence: number,
  work: (writer: Awaited<ReturnType<typeof acquireFixtureSessionAuthority>>) => Promise<T>): Promise<T> {
  const writer = await acquireFixtureSessionAuthority(store, session, expectedFence);
  let failed = false;
  try { return await work(writer); }
  catch (reason) { failed = true; throw reason; }
  finally { try { await writer.release(); } catch (reason) { if (!failed) throw reason; } }
}

/** Full durable Memory containers plus the canonical authority/family image, after real acquisition.
 * Opaque process-local WeakMap admissions are not durable state and are intentionally excluded. */
export function fixtureMemoryDurableSnapshot(store: import("../../src/memory.js").MemorySessionStore) {
  const state = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(store))
    .flatMap(([key, descriptor]): Array<[string, unknown]> => {
      if (!("value" in descriptor)) return [];
      const value: unknown = descriptor.value;
      return value instanceof Map || value instanceof Set || Array.isArray(value)
        || value === null || ["number", "string", "boolean", "bigint"].includes(typeof value)
        ? [[key, value]] : [];
    }));
  const family = Reflect.get(store, "subagents") as { images: Map<string, unknown> };
  return structuredClone({ state, authority: store.sessionAuthority.snapshot(), family: family.images });
}
