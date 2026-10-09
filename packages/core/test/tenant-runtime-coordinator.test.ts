import { describe, expect, it } from "vitest";
import { SubjectDeletingError } from "@agent-service/store";
import {
  TenantRuntimeCoordinator,
  TenantRuntimeDrainTimeoutError,
  type TenantRuntimeDrainIdentity,
  type TenantRuntimeParticipant,
} from "../src/index.js";

const identity = (tenantId = "tenant-a"): TenantRuntimeDrainIdentity => ({
  requestId: "ter_req_1",
  tenantId,
  subjectGeneration: 3,
  t3aReceiptSha256: "ab".repeat(32),
});

describe("TenantRuntimeCoordinator", () => {
  it("fences admission, aborts and waits for every operation, then proves all aggregate classes are zero", async () => {
    const coordinator = new TenantRuntimeCoordinator();
    let policyEntries = 1;
    let verifiers = 2;
    let registrations = 3;
    let fenced = false;
    const participant: TenantRuntimeParticipant = {
      name: "fixture",
      snapshotTenant: () => ({ policyEntries, authVerifiers: verifiers, providerRegistrations: registrations }),
      fenceTenant: () => { fenced = true; },
      purgeTenant: () => { policyEntries = 0; verifiers = 0; registrations = 0; },
    };
    coordinator.registerParticipant(participant);
    coordinator.sealParticipants();
    const auth = coordinator.enter("tenant-a", "auth");
    const provider = coordinator.enter("tenant-a", "provider");
    const turn = coordinator.enter("tenant-a", "turn");

    const draining = coordinator.drain(identity(), 1_000);
    expect(fenced).toBe(true);
    expect(auth.signal.aborted).toBe(true);
    expect(provider.signal.aborted).toBe(true);
    expect(turn.signal.aborted).toBe(true);
    expect(() => coordinator.enter("tenant-a", "auth")).toThrow(SubjectDeletingError);

    let completed = false;
    void draining.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    auth.release();
    provider.release();
    turn.release();

    const result = await draining;
    expect(result).toMatchObject({
      cacheEntryCountBefore: 6,
      cacheEntryCountAfter: 0,
      activeOperationCountBefore: 2,
      activeOperationCountAfter: 0,
      activeTurnCountBefore: 1,
      activeTurnCountAfter: 0,
    });
    expect(result.detail?.before).toMatchObject({
      policyEntries: 1,
      authVerifiers: 2,
      providerRegistrations: 3,
      authOperations: 1,
      providerOperations: 1,
      activeTurns: 1,
    });
  });

  it("single-flights concurrent exact drains, replays the completed result, and rejects a conflicting identity", async () => {
    const coordinator = new TenantRuntimeCoordinator();
    coordinator.sealParticipants();
    const lease = coordinator.enter("tenant-a", "auth");
    const first = coordinator.drain(identity(), 1_000);
    const concurrent = coordinator.drain(identity(), 1_000);
    expect(concurrent).toBe(first);
    lease.release();
    const result = await first;
    expect(await coordinator.drain(identity(), 1_000)).toBe(result);
    expect(() => coordinator.drain({ ...identity(), requestId: "ter_req_other" }, 1_000))
      .toThrow("identity conflicts");
  });

  it("keeps a timed-out tenant fenced and lets the exact identity retry after the operation settles", async () => {
    const coordinator = new TenantRuntimeCoordinator();
    coordinator.sealParticipants();
    const lease = coordinator.enter("tenant-a", "provider");
    await expect(coordinator.drain(identity(), 5)).rejects.toBeInstanceOf(TenantRuntimeDrainTimeoutError);
    expect(coordinator.isFenced("tenant-a")).toBe(true);
    expect(() => coordinator.enter("tenant-a", "turn")).toThrow(SubjectDeletingError);
    lease.release();
    const result = await coordinator.drain(identity(), 1_000);
    expect(result.activeOperationCountBefore).toBe(1);
    expect(result.activeOperationCountAfter).toBe(0);
  });

  it("requires a sealed participant set and rejects late registration", async () => {
    const coordinator = new TenantRuntimeCoordinator();
    await expect(coordinator.drain(identity(), 1_000)).rejects.toThrow("must be sealed");
    coordinator.sealParticipants();
    expect(() => coordinator.registerParticipant({
      name: "late",
      snapshotTenant: () => ({}),
      fenceTenant: () => {},
      purgeTenant: () => {},
    })).toThrow("participants are sealed");
  });

  it("aborts operations and fences every participant even when the initial snapshot fails", async () => {
    const coordinator = new TenantRuntimeCoordinator();
    let laterFenced = false;
    coordinator.registerParticipant({
      name: "broken-snapshot",
      snapshotTenant: () => { throw new Error("snapshot failed"); },
      fenceTenant: () => {},
      purgeTenant: () => {},
    });
    coordinator.registerParticipant({
      name: "later-participant",
      snapshotTenant: () => ({}),
      fenceTenant: () => { laterFenced = true; },
      purgeTenant: () => {},
    });
    coordinator.sealParticipants();
    const lease = coordinator.enter("tenant-a", "provider");

    await expect(coordinator.drain(identity(), 1_000)).rejects.toThrow("snapshot failed");
    expect(laterFenced).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(coordinator.isFenced("tenant-a")).toBe(true);
    lease.release();
  });

  it("continues fencing and aborting after a participant fence hook throws", async () => {
    const coordinator = new TenantRuntimeCoordinator();
    let laterFenced = false;
    coordinator.registerParticipant({
      name: "broken-fence",
      snapshotTenant: () => ({}),
      fenceTenant: () => { throw new Error("fence failed"); },
      purgeTenant: () => {},
    });
    coordinator.registerParticipant({
      name: "later-participant",
      snapshotTenant: () => ({}),
      fenceTenant: () => { laterFenced = true; },
      purgeTenant: () => {},
    });
    coordinator.sealParticipants();
    const lease = coordinator.enter("tenant-a", "turn");

    await expect(coordinator.drain(identity(), 1_000)).rejects.toThrow("fence failed");
    expect(laterFenced).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(coordinator.isFenced("tenant-a")).toBe(true);
    lease.release();
  });
});
