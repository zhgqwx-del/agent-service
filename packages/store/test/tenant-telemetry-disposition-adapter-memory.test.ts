import { describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
  TenantTelemetryDispositionConflictError,
  type TenantTelemetryDispositionExternalEvent,
} from "../src/tenant-telemetry-disposition.js";
import {
  MemoryTenantTelemetryDispositionAdapter,
} from "../src/tenant-telemetry-disposition-adapter/memory.js";
import { dispositionDigest, dispositionEvidence, tombstoneAck } from "./tenant-telemetry-disposition.fixture.js";

function fixture(overrides: Partial<ConstructorParameters<
  typeof MemoryTenantTelemetryDispositionAdapter
>[0]> = {}): MemoryTenantTelemetryDispositionAdapter {
  return new MemoryTenantTelemetryDispositionAdapter({
    nonProductionFixture: true,
    namespaceId: "memory-disposition",
    targetId: "memory-disposition-target",
    failureDomainId: "memory-process",
    logicalDatabaseNamespaceSha256: dispositionDigest("logical-database"),
    ...overrides,
  });
}

describe("MemoryTenantTelemetryDispositionAdapter", () => {
  it("commits authorization before terminal ACK and replays both exactly", async () => {
    const adapter = fixture();
    const evidence = dispositionEvidence(1);
    const authorization = await adapter.authorizeDeletion(evidence);
    expect(authorization.journalSequence).toBe(1);
    const replay = await adapter.authorizeDeletion(evidence);
    expect(replay).toEqual(authorization);
    const ack = tombstoneAck(authorization);
    const terminal = await adapter.recordTombstone(ack);
    expect(terminal.journalSequence).toBe(2);
    expect(await adapter.recordTombstone(ack)).toEqual(terminal);
    await expect(adapter.readHead()).resolves.toMatchObject({
      journalSequence: 2,
      journalEventRootSha256: terminal.journalEventRootSha256,
    });
  });

  it("persists a committed event across simulated response loss", async () => {
    let loseOnce = true;
    const adapter = fixture({
      afterEventCommit: () => {
        if (loseOnce) {
          loseOnce = false;
          throw new Error("simulated response loss");
        }
      },
    });
    const evidence = dispositionEvidence(2);
    await expect(adapter.authorizeDeletion(evidence)).rejects.toThrow("response loss");
    await expect(adapter.authorizeDeletion(evidence)).resolves.toMatchObject({
      dispositionOperationSha256: evidence.dispositionOperationSha256,
      journalSequence: 1,
    });
  });

  it("serializes concurrent operations and prevents a second operation for one artifact fence", async () => {
    const adapter = fixture();
    const first = dispositionEvidence(3);
    const second = dispositionEvidence(4);
    const results = await Promise.all([
      adapter.authorizeDeletion(first),
      adapter.authorizeDeletion(second),
    ]);
    expect(new Set(results.map((result) => result.journalSequence)).size).toBe(2);

    const conflicting = {
      ...first,
      t3dPlanReceiptSha256: dispositionDigest("changed-plan"),
    };
    // The operation hash is deliberately from the old evidence: strict validation rejects it.
    await expect(adapter.authorizeDeletion(conflicting)).rejects.toThrow("does not match");
    await expect(adapter.recordTombstone(tombstoneAck(results[0]!, {
      suffix: "wrong",
    }))).resolves.toMatchObject({ journalSequence: 3 });
    await expect(adapter.recordTombstone(tombstoneAck(results[0]!, {
      suffix: "different-terminal",
    }))).rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
  });

  it("rejects a tombstone without exact external authorization", async () => {
    const source = fixture();
    const authorization = await source.authorizeDeletion(dispositionEvidence(5));
    const ack = tombstoneAck(authorization);
    const empty = fixture({ targetId: "other-target" });
    await expect(empty.recordTombstone(ack)).rejects.toBeInstanceOf(
      TenantTelemetryDispositionConflictError,
    );
  });

  it("scans a sealed exact chain and excludes later events", async () => {
    const adapter = fixture();
    await adapter.authorizeDeletion(dispositionEvidence(6));
    const sealedHead = await adapter.readHead();
    await adapter.authorizeDeletion(dispositionEvidence(7));
    const page = await adapter.scanEvents({
      afterJournalSequence: 0,
      afterJournalEventRootSha256:
        EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
      sealedHead,
      limit: 10,
    });
    expect(page.events).toHaveLength(1);
    expect(page.complete).toBe(true);
    expect(page.nextJournalEventRootSha256).toBe(sealedHead.journalEventRootSha256);
    await expect(adapter.scanEvents({
      afterJournalSequence: 0,
      afterJournalEventRootSha256: dispositionDigest("wrong-root"),
      sealedHead,
      limit: 10,
    })).rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
  });

  it("keeps every external event content-free and reconstructable after local loss", async () => {
    const events: TenantTelemetryDispositionExternalEvent[] = [];
    const adapter = fixture({ afterEventCommit: (event) => { events.push(event); } });
    const authorization = await adapter.authorizeDeletion(dispositionEvidence(8));
    await adapter.recordTombstone(tombstoneAck(authorization));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/tenantId|requestId|ownerRef|https?:\/\/|secret|header/i);
    expect(events[1]?.eventType).toBe("delete_tombstoned");
    if (events[1]?.eventType !== "delete_tombstoned") throw new Error("missing terminal event");
    expect(events[1].result.authorization).toMatchObject({
      targetSha256: authorization.targetSha256,
      artifactIdSha256: authorization.artifactIdSha256,
      artifactGeneration: authorization.artifactGeneration,
    });
  });

  it("requires explicit non-production acknowledgement and closes deterministically", async () => {
    expect(() => new MemoryTenantTelemetryDispositionAdapter({
      nonProductionFixture: false,
      namespaceId: "memory-disposition",
      targetId: "memory-target",
      failureDomainId: "memory-process",
      logicalDatabaseNamespaceSha256: dispositionDigest("logical-database"),
    } as never)).toThrow("non-production fixture");
    const adapter = fixture();
    expect((await adapter.readHead()).journalEventRootSha256).toBe(
      EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
    );
    await adapter.close();
    await expect(adapter.readHead()).rejects.toThrow("closed");
  });
});
