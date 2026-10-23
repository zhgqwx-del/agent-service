import { MemorySessionStore } from "@agent-service/store";
import { mkSession } from "../../store/test/conformance.js";
import { withFixtureSessionAuthority, type acquireFixtureSessionAuthority } from "../../store/test/fixtures/session-authority.js";
import { describe, expect, it, vi } from "vitest";
import { assertTrustedStructuredTelemetryRecord, assertTrustedStructuredTelemetryRecordOwnerBinding } from "@agent-service/protocol";
import type { CommitBatch, CommitPersistedProviderStepFailureInput, CommitPersistedProviderStepFailureResult, TenantTelemetryPersistedProviderCaptureProof } from "@agent-service/store";
import { createPersistedProviderFailureCapture } from "../src/index.js";

const key = new Uint8Array(32).fill(41);
const proof: TenantTelemetryPersistedProviderCaptureProof = {
  protocol: "persisted-provider-capture-fleet-v2", configuredFleetRootSha256: "0".repeat(64),
  captureControlEvidenceSha256: "1".repeat(64), refKeyIdSha256: "2".repeat(64), logsTargetSha256: "3".repeat(64),
  logsTargetReceiptSha256: "4".repeat(64), runtimeEpochSha256: "5".repeat(64), runtimeBindingSha256: "6".repeat(64),
};
const source = { tenantId: "private-tenant", userId: "private-user", turnId: "private-turn", itemId: "private-item", stepIndex: 1, failureKind: "provider_step_error" as const };
const batch: CommitBatch = { sessionId: "sess_00000000-0000-7000-8000-000000000053", fence: 3, items: [{ id: source.itemId, sessionId: "sess_00000000-0000-7000-8000-000000000053", turnId: source.turnId, seq: 0, step: 1,
  type: "agentMessage", status: "failed", text: "private model body and upstream secret", phase: "finalAnswer", createdAtMs: 1000, completedAtMs: 1001 }] };

async function withCaptureBatch<T>(work: (admitted: CommitBatch,
  writer: Awaited<ReturnType<typeof acquireFixtureSessionAuthority>>) => Promise<T>): Promise<T> {
  const store = new MemorySessionStore();
  const session = { ...mkSession(source.tenantId, source.userId), id: batch.sessionId };
  let failed = false;
  try {
    await store.createSession(session);
    // Preserve the original fence3 example with three genuine fixed commands, never a forged floor.
    await withFixtureSessionAuthority(store, session, 0, async () => {});
    await withFixtureSessionAuthority(store, session, 1, async () => {});
    return await withFixtureSessionAuthority(store, session, 2, writer => work(writer.admit({ ...batch }), writer));
  } catch (reason) { failed = true; throw reason; }
  finally { try { await store.close(); } catch (reason) { if (!failed) throw reason; } }
}

describe("product persisted provider failure committer assembly", () => {
  it("makes only a trusted content-free allowlist record after current binding and immediate fresh fleet", async () => {
    await withCaptureBatch(async (batch) => {
    const order: string[] = [];
    const commit = vi.fn(async (input: CommitPersistedProviderStepFailureInput) => {
      order.push("business-transaction");
      expect(input.batch).toBe(batch);
      expect(input.source).toBe(source);
      expect(input.freshProof).toBe(proof);
      assertTrustedStructuredTelemetryRecord(input.record);
      assertTrustedStructuredTelemetryRecordOwnerBinding(input.record, source.tenantId, "session", batch.sessionId, key);
      expect(input.record).toMatchObject({ level: "warn", component: "provider", code: "provider.upstream_request_failed", timestampMs: 1001 });
      expect(Object.keys(input.record.fields).sort()).toEqual(["errorKind", "ownerRef", "subjectRef"]);
      expect(input.record.fields.errorKind).toBe("unknown");
      const payload = JSON.stringify(input.record);
      for (const privateValue of [source.tenantId, source.userId, source.turnId, source.itemId, batch.sessionId, "private model body", "upstream secret"]) expect(payload).not.toContain(privateValue);
      return {} as CommitPersistedProviderStepFailureResult;
    });
    const product = createPersistedProviderFailureCapture({ opaqueRefKey: key,
      store: { getTenantTelemetryPersistedProviderCaptureBinding: async () => { order.push("current-binding"); return proof; }, commitPersistedProviderStepFailure: commit },
      requireFreshFleet: async (expected, boundary) => { order.push("fresh-fleet"); expect(expected).toBe(proof); expect(boundary).toBe("capture"); return proof; },
    });
    await product.commit(batch, source);
    expect(order).toEqual(["current-binding", "fresh-fleet", "business-transaction"]);
    expect(commit).toHaveBeenCalledTimes(1);

    });
  });

  it("refuses inactive binding, invalid original item or a failed fresh gate without a write", async () => {
    await withCaptureBatch(async (batch, writer) => {
    const commit = vi.fn();
    for (const mode of ["inactive", "invalid-item", "fleet"] as const) {
      const product = createPersistedProviderFailureCapture({ opaqueRefKey: key,
        store: { getTenantTelemetryPersistedProviderCaptureBinding: async () => mode === "inactive" ? null : proof, commitPersistedProviderStepFailure: commit },
        requireFreshFleet: async () => { throw new Error("fresh configured fleet unavailable"); },
      });
      await expect(product.commit(mode === "invalid-item" ? writer.admit({ ...batch, items: [] }) : batch, source)).rejects.toThrow();
    }
    expect(commit).not.toHaveBeenCalled();
    expect(() => createPersistedProviderFailureCapture({ opaqueRefKey: key.slice(1), store: {} as never, requireFreshFleet: vi.fn() })).toThrow(/32-byte/);

    });
  });
});
