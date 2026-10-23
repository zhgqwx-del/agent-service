import { randomUUID } from "node:crypto";
import type { Session } from "@agent-service/protocol";
import { SessionAuthorityError, attachSessionWriteAdmission, type CommitBatch, type SessionStore } from "@agent-service/store";
import { acquireSessionAuthority } from "../../../../packages/core/src/session/authority.js";

/** Explicit current-fixture ownership, never proof-by-number or a numeric fallback. The real
 * production helper fixes one command and on an unknown response only confirms that same command.
 * expectedFence and TTL are mandatory; this adapter never reads/refreshes the durable floor. */
export async function acquireFixedFixtureAuthority(store: SessionStore,
  session: Pick<Session, "id" | "tenantId" | "userId">, expectedFence: number,
  options: { label: string; ttlMs: number }) {
  const acquired = await acquireSessionAuthority(store.sessionAuthority, { sessionId: session.id,
    principal: { tenantId: session.tenantId, userId: session.userId }, expectedFence,
    runnerId: options.label, runnerAddr: "127.0.0.1:1", bootId: randomUUID(), ttlMs: options.ttlMs });
  if (!acquired.ok || acquired.fence !== expectedFence + 1) throw new SessionAuthorityError();
  let releasing: Promise<void> | undefined;
  return Object.freeze({ fence: acquired.fence, proof: acquired.proof,
    admit<T extends CommitBatch>(batch: T): T { return attachSessionWriteAdmission(batch, acquired.proof); },
    release(): Promise<void> { return releasing ??= store.sessionAuthority.release(acquired.proof); },
  });
}
