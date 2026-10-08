import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  erasureJobControlOutcomeSha256,
  erasureJobInterventionEvidenceSha256,
  erasureJobTerminalInterventionEvidenceSha256,
  erasureJobUnsafeQuarantineEnvelopeEvidenceSha256,
  newErasureRequestId,
  publicErasureRequestStatus,
  subjectLifecycleKey,
  userErasureRequestHash,
  validateErasureAuditChain,
  validateErasureJobControlAudit,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureJobControlEvent,
  type ErasureJobMaintenanceIdentity,
  type ErasureJobQuarantineReasonCode,
} from "../src/index.js";

function requestInput(tenantId: string, userId: string, atMs = 100) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "admin-key",
    idempotencyKey: `erase-${userId}`,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs,
  };
}

function authorization(claim: ErasureJobClaim): ErasureJobAuthorization {
  return {
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function maintenanceIdentity(input: ReturnType<typeof requestInput>): ErasureJobMaintenanceIdentity {
  return {
    tenantId: input.tenantId,
    subjectKind: "user",
    subjectId: input.userId,
    requestId: input.requestId,
    subjectGeneration: 1,
  };
}

type PoisonCase = {
  reasonCode: ErasureJobQuarantineReasonCode;
  corrupt: (store: MemorySessionStore, input: ReturnType<typeof requestInput>) => void;
};

const POISON_CASES: PoisonCase[] = [
  {
    reasonCode: "request_invalid",
    corrupt: (store, input) => {
      store.erasureRequests.get(input.requestId)!.requestedByKeyId = "private\nactor";
    },
  },
  {
    reasonCode: "subject_binding_invalid",
    corrupt: (store, input) => {
      const key = subjectLifecycleKey(input.tenantId, "user", input.userId);
      store.subjectLifecycles.get(key)!.activeRequestId = newErasureRequestId();
    },
  },
  {
    reasonCode: "audit_chain_invalid",
    corrupt: (store, input) => {
      store.erasureAuditEvents.get(input.requestId)![0]!.payload.privatePrompt = "user@example.invalid";
    },
  },
  {
    reasonCode: "idempotency_binding_invalid",
    corrupt: (store, input) => {
      const internals = store as unknown as { erasureIdempotency: Map<string, string> };
      internals.erasureIdempotency.delete(JSON.stringify([
        input.tenantId,
        "user",
        input.userId,
        input.idempotencyKey,
      ]));
    },
  },
  {
    reasonCode: "queue_control_invalid",
    corrupt: (store, input) => {
      store.erasureRequests.get(input.requestId)!.quarantinedAtMs = 100;
    },
  },
  {
    reasonCode: "policy_identity_invalid",
    corrupt: (store, input) => {
      store.erasureRequests.get(input.requestId)!.policyVersion = "policy-v1";
    },
  },
  {
    reasonCode: "control_audit_invalid",
    corrupt: (store, input) => {
      store.erasureRequests.get(input.requestId)!.controlGeneration = 1;
    },
  },
];

describe("MemorySessionStore erasure quarantine and maintenance", () => {
  it.each(POISON_CASES)(
    "durably quarantines $reasonCode without starving the next job or leaking poison",
    async ({ reasonCode, corrupt }) => {
      const store = new MemorySessionStore();
      const poison = requestInput(`tenant-${reasonCode}`, `user-${reasonCode}`, 100);
      const neighbour = requestInput(`tenant-${reasonCode}`, `neighbor-${reasonCode}`, 101);
      await store.requestUserErasure(poison);
      await store.requestUserErasure(neighbour);
      corrupt(store, poison);

      // The poisoned row consumes this bounded scan. Its durable overlay removes it from the next.
      expect(await store.claimErasureJobs({
        nowMs: 101,
        limit: 1,
        leaseMs: 20,
        claimToken: `worker-${reasonCode}`,
      })).toEqual([]);

      const quarantined = await store.getUserErasureRequest(
        poison.tenantId,
        poison.userId,
        poison.requestId,
      );
      expect(quarantined).toMatchObject({
        status: "gated",
        attempts: 0,
        controlGeneration: reasonCode === "control_audit_invalid" ? 2 : 1,
        quarantineReasonCode: reasonCode,
      });
      expect(quarantined).not.toHaveProperty("availableAtMs");
      expect(quarantined).not.toHaveProperty("claimToken");
      expect(publicErasureRequestStatus(quarantined!)).toBe("blocked");

      const inspection = await store.inspectErasureJobIntervention(maintenanceIdentity(poison));
      expect(inspection).toMatchObject({
        requestId: poison.requestId,
        phase: "gated",
        kind: "quarantine",
        reasonCode,
      });
      expect(await store.inspectErasureJobIntervention({
        ...maintenanceIdentity(poison),
        subjectId: `other-${poison.userId}`,
      })).toBeNull();

      const control = store.erasureJobControlEvents.get(poison.requestId)!.at(-1)!;
      expect(control).toMatchObject({
        eventType: "erasure_job/quarantined",
        phase: "gated",
        reasonCode,
      });
      const serializedControl = JSON.stringify(control);
      expect(serializedControl).not.toContain(poison.idempotencyKey);
      expect(serializedControl).not.toContain("private");
      expect(serializedControl).not.toContain("user@example.invalid");

      const next = await store.claimErasureJobs({
        nowMs: 101,
        limit: 1,
        leaseMs: 20,
        claimToken: `neighbor-${reasonCode}`,
      });
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({ requestId: neighbour.requestId, attempts: 1 });
    },
  );

  it("rolls back the quarantine row when the append-only control audit publication fails", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-control-rollback", "user-control-rollback");
    await store.requestUserErasure(input);
    delete store.erasureRequests.get(input.requestId)!.availableAtMs;

    const controls = store.erasureJobControlEvents;
    const originalSet = controls.set.bind(controls);
    let fail = true;
    Object.defineProperty(controls, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof controls.set>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected control audit write failure");
        }
        return originalSet(key, value);
      },
    });

    await expect(store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-control-rollback",
    })).rejects.toThrow("injected control audit write failure");
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      status: "gated",
      attempts: 0,
      controlGeneration: 0,
    });
    expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("quarantinedAtMs");
    expect(store.erasureJobControlEvents.get(input.requestId)).toBeUndefined();

    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-control-retry",
    })).toEqual([]);
    expect(store.erasureJobControlEvents.get(input.requestId)![0]).toMatchObject({
      controlEventId: 1,
      eventType: "erasure_job/quarantined",
    });
  });

  it("terminally quarantines a saturated fence once while a concurrent poll claims its neighbour", async () => {
    const store = new MemorySessionStore();
    const poison = requestInput("a-tenant-terminal-fence", "user-terminal-fence", 100);
    await store.requestUserErasure(poison);
    const staleClaim = (await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 50,
      claimToken: "worker-before-terminal-fence",
    }))[0]!;
    const neighbour = requestInput("z-tenant-terminal-fence", "user-terminal-neighbour", 101);
    await store.requestUserErasure(neighbour);
    Object.assign(store.erasureRequests.get(poison.requestId)!, {
      controlGeneration: Number.MAX_SAFE_INTEGER,
      availableAtMs: 10_000,
    });

    let terminalWrites = 0;
    const originalSet = store.erasureRequests.set.bind(store.erasureRequests);
    Object.defineProperty(store.erasureRequests, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof store.erasureRequests.set>[1]) => {
        if (key === poison.requestId && value.quarantineReasonCode === "control_audit_invalid") {
          terminalWrites += 1;
        }
        return originalSet(key, value);
      },
    });

    const results = await Promise.all([
      store.claimErasureJobs({
        nowMs: 101,
        limit: 1,
        leaseMs: 50,
        claimToken: "worker-terminal-a",
      }),
      store.claimErasureJobs({
        nowMs: 101,
        limit: 1,
        leaseMs: 50,
        claimToken: "worker-terminal-b",
      }),
    ]);
    expect(results.flat()).toEqual([expect.objectContaining({ requestId: neighbour.requestId })]);
    expect(terminalWrites).toBe(1);

    const expectedEvidence = erasureJobTerminalInterventionEvidenceSha256({
      requestId: poison.requestId,
      rawControlGeneration: String(Number.MAX_SAFE_INTEGER),
      phase: "gated",
      reasonCode: "control_audit_invalid",
    });
    const terminal = store.erasureRequests.get(poison.requestId)!;
    expect(terminal).toMatchObject({
      status: "gated",
      attempts: 1,
      controlGeneration: Number.MAX_SAFE_INTEGER,
      quarantinedAtMs: 101,
      quarantineReasonCode: "control_audit_invalid",
      quarantineEvidenceSha256: expectedEvidence,
    });
    expect(terminal).not.toHaveProperty("availableAtMs");
    expect(terminal).not.toHaveProperty("claimToken");
    expect(terminal).not.toHaveProperty("leaseUntilMs");
    expect(store.erasureJobControlEvents.get(poison.requestId)).toEqual([]);

    const ownerRead = await store.getUserErasureRequest(
      poison.tenantId,
      poison.userId,
      poison.requestId,
    );
    expect(publicErasureRequestStatus(ownerRead!)).toBe("blocked");
    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(poison)))!;
    expect(inspection).toMatchObject({
      controlGeneration: Number.MAX_SAFE_INTEGER,
      kind: "quarantine",
      reasonCode: "control_audit_invalid",
      evidenceSha256: expectedEvidence,
      allowedActions: [],
    });
    expect(await store.repairAndResumeErasureJob({
      ...maintenanceIdentity(poison),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId: "admin-terminal-fence",
      actionCode: "resume_verified",
      atMs: 102,
    })).toBe(false);
    await expect(store.transitionErasureJob(authorization(staleClaim), {
      fromStatus: "gated",
      toStatus: "draining",
      atMs: 102,
      availableAtMs: 102,
    })).rejects.toMatchObject({
      name: "ErasureJobIntegrityFault",
      reasonCode: "control_audit_invalid",
    });
  });

  it("rolls back a failed terminal quarantine publication without lowering the saturated fence", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-terminal-rollback", "user-terminal-rollback", 110);
    await store.requestUserErasure(input);
    Object.assign(store.erasureRequests.get(input.requestId)!, {
      controlGeneration: Number.MAX_SAFE_INTEGER,
      availableAtMs: 20_000,
    });

    const controls = store.erasureJobControlEvents;
    const originalSet = controls.set.bind(controls);
    let fail = true;
    Object.defineProperty(controls, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof controls.set>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected terminal publication failure");
        }
        return originalSet(key, value);
      },
    });

    await expect(store.claimErasureJobs({
      nowMs: 110,
      limit: 1,
      leaseMs: 50,
      claimToken: "worker-terminal-rollback",
    })).rejects.toThrow("injected terminal publication failure");
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      attempts: 0,
      controlGeneration: Number.MAX_SAFE_INTEGER,
      availableAtMs: 20_000,
    });
    expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("quarantinedAtMs");
    expect(store.erasureJobControlEvents.get(input.requestId)).toBeUndefined();

    expect(await store.claimErasureJobs({
      nowMs: 110,
      limit: 1,
      leaseMs: 50,
      claimToken: "worker-terminal-retry",
    })).toEqual([]);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      controlGeneration: Number.MAX_SAFE_INTEGER,
      quarantineReasonCode: "control_audit_invalid",
    });
    expect(store.erasureJobControlEvents.get(input.requestId)).toEqual([]);
  });

  it.each([
    {
      name: "reversed request timestamps",
      corrupt: (
        record: NonNullable<ReturnType<MemorySessionStore["erasureRequests"]["get"]>>,
      ) => {
        record.updatedAtMs = record.gatedAtMs - 1;
      },
      expected: { updatedAtMs: 99 },
    },
    {
      name: "an invalid subject identity",
      corrupt: (
        record: NonNullable<ReturnType<MemorySessionStore["erasureRequests"]["get"]>>,
      ) => {
        record.subjectId = "unsafe subject identity";
      },
      expected: { subjectId: "unsafe subject identity" },
    },
    {
      name: "an unsafe subject generation",
      corrupt: (
        record: NonNullable<ReturnType<MemorySessionStore["erasureRequests"]["get"]>>,
      ) => {
        record.generation = Number.MAX_SAFE_INTEGER + 1;
      },
      expected: { generation: Number.MAX_SAFE_INTEGER + 1 },
    },
  ])(
    "terminally isolates $name once while concurrent polls reach its neighbour",
    async ({ corrupt, expected }) => {
      const store = new MemorySessionStore();
      const poison = requestInput("tenant-unsafe-envelope", "user-unsafe-envelope", 100);
      const neighbour = requestInput("tenant-unsafe-envelope", "user-safe-neighbour", 101);
      await store.requestUserErasure(poison);
      await store.requestUserErasure(neighbour);
      corrupt(store.erasureRequests.get(poison.requestId)!);

      const results = await Promise.all([
        store.claimErasureJobs({
          nowMs: 101,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-unsafe-envelope-a",
        }),
        store.claimErasureJobs({
          nowMs: 101,
          limit: 1,
          leaseMs: 50,
          claimToken: "worker-unsafe-envelope-b",
        }),
      ]);
      expect(results.flat()).toEqual([
        expect.objectContaining({ requestId: neighbour.requestId, attempts: 1 }),
      ]);

      const incident = store.erasureJobTerminalIncidents.get(poison.requestId);
      expect(incident).toMatchObject({
        terminalIncidentId: 1,
        requestId: poison.requestId,
        rawControlGeneration: "0",
        reasonCode: "unsafe_quarantine_envelope",
        emittedAtMs: 101,
      });
      expect(incident?.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(store.erasureJobTerminalIncidents.size).toBe(1);

      const isolated = store.erasureRequests.get(poison.requestId)!;
      const expectedEvidenceSha256 = erasureJobUnsafeQuarantineEnvelopeEvidenceSha256({
        locatorRequestId: poison.requestId,
        requestId: String(isolated.requestId),
        tenantId: String(isolated.tenantId),
        subjectKind: String(isolated.subjectKind),
        subjectId: String(isolated.subjectId),
        rawGeneration: String(isolated.generation),
        status: String(isolated.status),
        rawCreatedAtMs: String(isolated.createdAtMs),
        rawGatedAtMs: String(isolated.gatedAtMs),
        rawUpdatedAtMs: String(isolated.updatedAtMs),
        rawControlGeneration: String(isolated.controlGeneration),
      });
      expect(incident?.evidenceSha256).toBe(expectedEvidenceSha256);
      expect(isolated).toMatchObject({
        ...expected,
        controlGeneration: 0,
        quarantinedAtMs: 101,
        quarantineReasonCode: "control_audit_invalid",
        quarantineEvidenceSha256: incident?.evidenceSha256,
      });
      expect(isolated).not.toHaveProperty("availableAtMs");
      expect(isolated).not.toHaveProperty("claimToken");
      expect(isolated).not.toHaveProperty("leaseUntilMs");
      expect(isolated).not.toHaveProperty("terminalIncidentId");
      expect(store.erasureJobControlEvents.get(poison.requestId)).toBeUndefined();

      const committedIncident = structuredClone(incident);
      expect((await Promise.all([
        store.claimErasureJobs({
          nowMs: 101,
          limit: 2,
          leaseMs: 50,
          claimToken: "worker-unsafe-envelope-repeat-a",
        }),
        store.claimErasureJobs({
          nowMs: 101,
          limit: 2,
          leaseMs: 50,
          claimToken: "worker-unsafe-envelope-repeat-b",
        }),
      ])).flat()).toEqual([]);
      expect(store.erasureJobTerminalIncidents.get(poison.requestId)).toEqual(committedIncident);
      expect(store.erasureRequests.get(neighbour.requestId)).toMatchObject({ attempts: 1 });
    },
  );

  it("rolls an unsafe-envelope row back when terminal incident publication fails", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-unsafe-rollback", "user-unsafe-rollback", 105);
    await store.requestUserErasure(input);
    const poisoned = store.erasureRequests.get(input.requestId)!;
    poisoned.updatedAtMs = poisoned.gatedAtMs - 1;
    const before = structuredClone(poisoned);

    const incidents = store.erasureJobTerminalIncidents;
    const originalSet = incidents.set.bind(incidents);
    let fail = true;
    Object.defineProperty(incidents, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof incidents.set>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected terminal incident publication failure");
        }
        return originalSet(key, value);
      },
    });

    await expect(store.claimErasureJobs({
      nowMs: 105,
      limit: 1,
      leaseMs: 50,
      claimToken: "worker-unsafe-publication-failure",
    })).rejects.toThrow("injected terminal incident publication failure");
    expect(store.erasureRequests.get(input.requestId)).toEqual(before);
    expect(store.erasureJobTerminalIncidents.get(input.requestId)).toBeUndefined();

    expect(await store.claimErasureJobs({
      nowMs: 105,
      limit: 1,
      leaseMs: 50,
      claimToken: "worker-unsafe-publication-retry",
    })).toEqual([]);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      updatedAtMs: before.updatedAtMs,
      controlGeneration: before.controlGeneration,
      quarantineReasonCode: "control_audit_invalid",
    });
    expect(store.erasureJobTerminalIncidents.get(input.requestId)).toMatchObject({
      terminalIncidentId: 1,
      reasonCode: "unsafe_quarantine_envelope",
    });
  });

  it("does not quarantine an unknown program failure", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-unknown", "user-unknown");
    await store.requestUserErasure(input);
    const internal = store as unknown as {
      assertErasureJobIntegrity: (record: unknown) => unknown;
    };
    internal.assertErasureJobIntegrity = () => {
      throw new TypeError("injected unknown failure");
    };

    await expect(store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-unknown",
    })).rejects.toThrow("injected unknown failure");
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      attempts: 0,
      controlGeneration: 0,
      availableAtMs: 100,
    });
    expect(store.erasureJobControlEvents.get(input.requestId)).toBeUndefined();
  });

  it.each([
    {
      name: "partial-quarantine-markers",
      corrupt: (record: NonNullable<ReturnType<MemorySessionStore["erasureRequests"]["get"]>>) => {
        record.quarantinedAtMs = 100;
      },
    },
    {
      name: "partial-claim-authority",
      corrupt: (record: NonNullable<ReturnType<MemorySessionStore["erasureRequests"]["get"]>>) => {
        record.claimToken = "worker-torn-future";
      },
    },
  ])("quarantines future-scheduled $name immediately", async ({ name, corrupt }) => {
    const store = new MemorySessionStore();
    const input = requestInput(`tenant-future-${name}`, `user-future-${name}`);
    await store.requestUserErasure(input);
    const record = store.erasureRequests.get(input.requestId)!;
    record.availableAtMs = 10_000;
    corrupt(record);

    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-future-isolation",
    })).toEqual([]);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      status: "gated",
      attempts: 0,
      controlGeneration: 1,
      quarantineReasonCode: "queue_control_invalid",
    });
    expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("availableAtMs");
    expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("claimToken");
  });

  it("normalizes queue control with generation/evidence CAS and prevents claim ABA", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-queue-repair", "user-queue-repair");
    await store.requestUserErasure(input);
    const oldClaim = (await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-before-quarantine",
    }))[0]!;
    delete store.erasureRequests.get(input.requestId)!.leaseUntilMs;

    expect(await store.claimErasureJobs({
      nowMs: 101,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-detect-partial",
    })).toEqual([]);
    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
    expect(inspection).toMatchObject({
      kind: "quarantine",
      reasonCode: "queue_control_invalid",
      controlGeneration: 1,
      allowedActions: ["normalize_queue_control"],
    });

    expect(await store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: "0".repeat(64),
      actorKeyId: "admin-stale-evidence",
      actionCode: "normalize_queue_control",
      atMs: 102,
    })).toBe(false);

    const attempt = (actorKeyId: string) => store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId,
      actionCode: "normalize_queue_control",
      atMs: 102,
    });
    expect((await Promise.all([attempt("admin-a"), attempt("admin-b")])).sort()).toEqual([false, true]);

    const repaired = store.erasureRequests.get(input.requestId)!;
    expect(repaired).toMatchObject({
      status: "gated",
      attempts: 1,
      controlGeneration: 2,
      availableAtMs: 102,
    });
    expect(repaired).not.toHaveProperty("quarantinedAtMs");
    expect(store.erasureJobControlEvents.get(input.requestId)).toHaveLength(2);
    expect(store.erasureJobControlEvents.get(input.requestId)!.at(-1)).toMatchObject({
      eventType: "erasure_job/quarantine_repaired",
      actionCode: "normalize_queue_control",
      reasonCode: "queue_control_invalid",
    });

    expect(await store.transitionErasureJob(authorization(oldClaim), {
      fromStatus: "gated",
      toStatus: "draining",
      atMs: 102,
      availableAtMs: 102,
    })).toBe(false);
    const replacement = (await store.claimErasureJobs({
      nowMs: 102,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-after-repair",
    }))[0]!;
    expect(replacement.attempts).toBe(2);
    expect(await store.transitionErasureJob(authorization(oldClaim), {
      fromStatus: "gated",
      toStatus: "draining",
      atMs: 103,
      availableAtMs: 103,
    })).toBe(false);
  });

  it("keeps a full quarantine overlay inspectable while worker authority stays fail-closed", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-residual-overlay", "user-residual-overlay");
    await store.requestUserErasure(input);
    const staleClaim = (await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-residual-overlay",
    }))[0]!;
    delete store.erasureRequests.get(input.requestId)!.leaseUntilMs;
    expect(await store.claimErasureJobs({
      nowMs: 101,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-isolate-residual",
    })).toEqual([]);

    // Simulate a legacy/torn writer leaving even malformed private queue fields after all markers.
    Object.assign(store.erasureRequests.get(input.requestId)!, {
      availableAtMs: -1,
      claimToken: "invalid\nresidual-token",
      leaseUntilMs: -2,
    });
    expect(await store.getUserErasureRequest(input.tenantId, input.userId, input.requestId))
      .toMatchObject({
        quarantineReasonCode: "queue_control_invalid",
        availableAtMs: -1,
        claimToken: "invalid\nresidual-token",
        leaseUntilMs: -2,
      });
    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
    expect(inspection.allowedActions).toEqual(["normalize_queue_control"]);
    await expect(store.renewErasureJobClaim(authorization(staleClaim), {
      nowMs: 101,
      leaseMs: 20,
    })).rejects.toMatchObject({
      name: "ErasureJobIntegrityFault",
      reasonCode: "request_invalid",
    });

    expect(await store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId: "admin-residual-overlay",
      actionCode: "normalize_queue_control",
      atMs: 102,
    })).toBe(true);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      availableAtMs: 102,
      controlGeneration: 2,
    });
    expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("claimToken");
    expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("leaseUntilMs");
    expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("quarantinedAtMs");
  });

  it("rejects a forged quarantine evidence pair before repair mutates state", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-forged-evidence", "user-forged-evidence");
    await store.requestUserErasure(input);
    delete store.erasureRequests.get(input.requestId)!.availableAtMs;
    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-forged-evidence",
    })).toEqual([]);

    const forgedEvidence = "f".repeat(64);
    store.erasureRequests.get(input.requestId)!.quarantineEvidenceSha256 = forgedEvidence;
    store.erasureJobControlEvents.get(input.requestId)![0]!.beforeSha256 = forgedEvidence;

    await expect(store.inspectErasureJobIntervention(maintenanceIdentity(input)))
      .rejects.toThrow("erasure quarantine control evidence is not canonical");
    expect(await store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: 1,
      expectedEvidenceSha256: forgedEvidence,
      actorKeyId: "admin-forged-evidence",
      actionCode: "normalize_queue_control",
      atMs: 101,
    })).toBe(false);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      controlGeneration: 1,
      quarantineEvidenceSha256: forgedEvidence,
      quarantineReasonCode: "queue_control_invalid",
    });
    expect(store.erasureJobControlEvents.get(input.requestId)).toHaveLength(1);
  });

  it.each(["deleting", "erased"] as const)(
    "rejects user quarantine repair when the parent tenant is %s",
    async (tenantState) => {
      const store = new MemorySessionStore();
      const input = requestInput(`tenant-repair-${tenantState}`, `user-repair-${tenantState}`);
      await store.requestUserErasure(input);
      delete store.erasureRequests.get(input.requestId)!.availableAtMs;
      expect(await store.claimErasureJobs({
        nowMs: 100,
        limit: 1,
        leaseMs: 20,
        claimToken: `worker-repair-${tenantState}`,
      })).toEqual([]);
      const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
      const tenantKey = subjectLifecycleKey(input.tenantId, "tenant", input.tenantId);
      const tenant = store.subjectLifecycles.get(tenantKey)!;
      store.subjectLifecycles.set(tenantKey, {
        ...tenant,
        state: tenantState,
        generation: 1,
        ...(tenantState === "deleting" ? { activeRequestId: newErasureRequestId() } : {}),
        updatedAtMs: 101,
      });

      await expect(store.repairAndResumeErasureJob({
        ...maintenanceIdentity(input),
        expectedControlGeneration: inspection.controlGeneration,
        expectedEvidenceSha256: inspection.evidenceSha256,
        actorKeyId: `admin-repair-${tenantState}`,
        actionCode: "normalize_queue_control",
        atMs: 101,
      })).rejects.toThrow("does not match its subject lifecycle");
      expect(store.erasureRequests.get(input.requestId)).toMatchObject({
        controlGeneration: 1,
        quarantineReasonCode: "queue_control_invalid",
      });
      expect(store.erasureJobControlEvents.get(input.requestId)).toHaveLength(1);
    },
  );

  it("validates the safe quarantine envelope before returning an inspection", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-inspection-envelope", "user-inspection-envelope");
    await store.requestUserErasure(input);
    delete store.erasureRequests.get(input.requestId)!.availableAtMs;
    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-inspection-envelope",
    })).toEqual([]);

    store.erasureRequests.get(input.requestId)!.updatedAtMs = 99;
    await expect(store.inspectErasureJobIntervention(maintenanceIdentity(input)))
      .rejects.toThrow("stored erasure request timestamps are invalid");
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      controlGeneration: 1,
      quarantineReasonCode: "queue_control_invalid",
      updatedAtMs: 99,
    });
  });

  it("restores only an entirely missing initial gate audit and fully revalidates before resume", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-gate-repair", "user-gate-repair");
    await store.requestUserErasure(input);
    store.erasureAuditEvents.set(input.requestId, []);

    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-gate-poison",
    })).toEqual([]);
    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
    expect(inspection.allowedActions).toEqual(["restore_initial_gate_audit"]);

    const base = {
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId: "admin-gate-repair",
      atMs: 105,
    };
    expect(await store.repairAndResumeErasureJob({
      ...base,
      actionCode: "resume_verified",
    })).toBe(false);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      controlGeneration: 1,
      quarantineReasonCode: "audit_chain_invalid",
    });

    expect(await store.repairAndResumeErasureJob({
      ...base,
      actionCode: "restore_initial_gate_audit",
    })).toBe(true);
    expect(await store.listErasureAuditEvents(input.requestId)).toEqual([{
      requestId: input.requestId,
      seq: 1,
      type: "erasure/gated",
      payload: { status: "gated", subjectKind: "user", generation: 1 },
      emittedAtMs: 100,
    }]);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      controlGeneration: 2,
      availableAtMs: 105,
      attempts: 0,
    });
  });

  it("keeps a corrupt append-only control audit permanently fail-closed", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-control-corrupt", "user-control-corrupt");
    await store.requestUserErasure(input);
    store.erasureRequests.get(input.requestId)!.controlGeneration = 1;

    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-control-corrupt",
    })).toEqual([]);
    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
    expect(inspection).toMatchObject({
      controlGeneration: 2,
      reasonCode: "control_audit_invalid",
      allowedActions: [],
    });
    expect(await store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId: "admin-control-corrupt",
      actionCode: "resume_verified",
      atMs: 101,
    })).toBe(false);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      controlGeneration: 2,
      quarantineReasonCode: "control_audit_invalid",
    });
  });

  it("rejects a forged repaired control history that predates the durable gate", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-control-before-gate", "user-control-before-gate", 100);
    await store.requestUserErasure(input);
    const evidenceSha256 = erasureJobInterventionEvidenceSha256({
      requestId: input.requestId,
      controlGeneration: 1,
      phase: "gated",
      kind: "quarantine",
      reasonCode: "audit_chain_invalid",
    });
    const repairedWithoutAfter = {
      controlEventId: 2,
      requestId: input.requestId,
      controlGeneration: 2,
      eventType: "erasure_job/quarantine_repaired" as const,
      phase: "gated" as const,
      reasonCode: "audit_chain_invalid" as const,
      actionCode: "restore_initial_gate_audit" as const,
      actorKeyId: "admin-forged-history",
      beforeSha256: evidenceSha256,
      emittedAtMs: 99,
    };
    store.erasureRequests.get(input.requestId)!.controlGeneration = 2;
    store.erasureJobControlEvents.set(input.requestId, [{
      controlEventId: 1,
      requestId: input.requestId,
      controlGeneration: 1,
      eventType: "erasure_job/quarantined",
      phase: "gated",
      reasonCode: "audit_chain_invalid",
      beforeSha256: evidenceSha256,
      emittedAtMs: 99,
    }, {
      ...repairedWithoutAfter,
      afterSha256: erasureJobControlOutcomeSha256(repairedWithoutAfter),
    }]);

    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-forged-history",
    })).toEqual([]);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      attempts: 0,
      controlGeneration: 3,
      quarantineReasonCode: "control_audit_invalid",
    });
    expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("availableAtMs");
  });

  it("uses a safe generation hole when an unsafe control event poisons the audit", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-unsafe-control", "user-unsafe-control", 100);
    const neighbour = requestInput("tenant-unsafe-control", "neighbor-unsafe-control", 101);
    await store.requestUserErasure(input);
    await store.requestUserErasure(neighbour);
    store.erasureJobControlEvents.set(input.requestId, [{
      controlEventId: 99,
      requestId: input.requestId,
      controlGeneration: Number.MAX_SAFE_INTEGER + 1,
      eventType: "erasure_job/quarantined",
      phase: "gated",
      reasonCode: "queue_control_invalid",
      beforeSha256: "f".repeat(64),
      emittedAtMs: 100,
    }]);

    expect(await store.claimErasureJobs({
      nowMs: 101,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-unsafe-control",
    })).toEqual([]);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      controlGeneration: 1,
      quarantineReasonCode: "control_audit_invalid",
    });
    expect(store.erasureJobControlEvents.get(input.requestId)!.at(-1)).toMatchObject({
      controlGeneration: 1,
      eventType: "erasure_job/quarantined",
      reasonCode: "control_audit_invalid",
    });

    expect(await store.claimErasureJobs({
      nowMs: 101,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-after-unsafe-control",
    })).toEqual([expect.objectContaining({ requestId: neighbour.requestId })]);
  });

  it("immediately isolates complete invalid queue controls and still claims a valid neighbour", async () => {
    const store = new MemorySessionStore();
    const badLease = requestInput("a-tenant-queue-control", "user-bad-lease", 100);
    const badAvailability = requestInput("b-tenant-queue-control", "user-bad-availability", 100);
    const neighbour = requestInput("z-tenant-queue-control", "user-neighbour", 100);
    await store.requestUserErasure(badLease);
    await store.requestUserErasure(badAvailability);
    await store.requestUserErasure(neighbour);
    Object.assign(store.erasureRequests.get(badLease.requestId)!, {
      claimToken: "invalid token",
      leaseUntilMs: Number.MAX_SAFE_INTEGER + 1,
    });
    store.erasureRequests.get(badAvailability.requestId)!.availableAtMs = Number.MAX_SAFE_INTEGER + 1;

    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 3,
      leaseMs: 20,
      claimToken: "worker-after-invalid-queue-control",
    })).toEqual([expect.objectContaining({ requestId: neighbour.requestId })]);
    for (const input of [badLease, badAvailability]) {
      expect(store.erasureRequests.get(input.requestId)).toMatchObject({
        attempts: 0,
        controlGeneration: 1,
        quarantineReasonCode: "queue_control_invalid",
      });
      expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("availableAtMs");
      expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("claimToken");
      expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("leaseUntilMs");
    }
  });

  it("resume_verified clears only a quarantine whose external binding now passes every strict check", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-verified-resume", "user-verified-resume");
    await store.requestUserErasure(input);
    const internals = store as unknown as { erasureIdempotency: Map<string, string> };
    const key = JSON.stringify([input.tenantId, "user", input.userId, input.idempotencyKey]);
    internals.erasureIdempotency.delete(key);

    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-verified-poison",
    })).toEqual([]);
    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
    expect(inspection.allowedActions).toEqual(["resume_verified"]);

    // Simulate a distinct, privileged binding repair. resume_verified itself remains patch-free.
    internals.erasureIdempotency.set(key, input.requestId);
    expect(await store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId: "admin-verified-resume",
      actionCode: "resume_verified",
      atMs: 104,
    })).toBe(true);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      status: "gated",
      controlGeneration: 2,
      availableAtMs: 104,
      attempts: 0,
    });
    expect(store.erasureJobControlEvents.get(input.requestId)!.at(-1)).toMatchObject({
      eventType: "erasure_job/quarantine_repaired",
      actionCode: "resume_verified",
      reasonCode: "idempotency_binding_invalid",
    });
  });

  it("resumes a safe blocked phase from its strict audit and fences concurrent administrators", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-blocked-resume", "user-blocked-resume");
    await store.requestUserErasure(input);
    const claim = (await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-blocked",
    }))[0]!;
    expect(await store.transitionErasureJob(authorization(claim), {
      fromStatus: "gated",
      toStatus: "blocked",
      atMs: 101,
      errorCode: "integrity_conflict",
    })).toBe(true);

    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
    expect(inspection).toMatchObject({
      kind: "blocked",
      reasonCode: "integrity_conflict",
      resumePhase: "gated",
      allowedActions: ["resume_blocked"],
    });
    const repair = (actorKeyId: string) => store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId,
      actionCode: "resume_blocked",
      atMs: 102,
    });
    expect((await Promise.all([repair("admin-block-a"), repair("admin-block-b")])).sort())
      .toEqual([false, true]);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      status: "gated",
      controlGeneration: 1,
      availableAtMs: 102,
      attempts: 1,
    });
    expect(store.erasureRequests.get(input.requestId)).not.toHaveProperty("lastErrorCode");
    expect((await store.listErasureAuditEvents(input.requestId)).at(-1)).toMatchObject({
      type: "erasure/resumed",
      payload: { fromStatus: "blocked", status: "gated", generation: 1 },
    });
    expect(store.erasureJobControlEvents.get(input.requestId)!.at(-1)).toMatchObject({
      eventType: "erasure_job/blocked_resumed",
      phase: "gated",
      reasonCode: "integrity_conflict",
      actionCode: "resume_blocked",
    });
  });

  it("rejects forged blocked-resume semantics and replayably verifies the outcome commitment", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-control-semantics", "user-control-semantics");
    await store.requestUserErasure(input);
    const claim = (await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-control-semantics",
    }))[0]!;
    expect(await store.transitionErasureJob(authorization(claim), {
      fromStatus: "gated",
      toStatus: "blocked",
      atMs: 101,
      errorCode: "integrity_conflict",
    })).toBe(true);
    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
    expect(await store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId: "admin-control-semantics",
      actionCode: "resume_blocked",
      atMs: 102,
    })).toBe(true);

    const record = structuredClone(store.erasureRequests.get(input.requestId)!);
    const audits = structuredClone(store.erasureAuditEvents.get(input.requestId)!);
    const event = structuredClone(store.erasureJobControlEvents.get(input.requestId)![0]!);
    expect(() => validateErasureJobControlAudit(record, audits, [event])).not.toThrow();

    const canonicalOutcome = (candidate: ErasureJobControlEvent) => {
      candidate.afterSha256 = erasureJobControlOutcomeSha256(candidate);
      return candidate;
    };
    const wrongPhase = canonicalOutcome({ ...event, phase: "draining" });
    const wrongReason = canonicalOutcome({
      ...event,
      reasonCode: "temporary_failure",
      beforeSha256: erasureJobInterventionEvidenceSha256({
        requestId: input.requestId,
        controlGeneration: 0,
        phase: "blocked",
        kind: "blocked",
        reasonCode: "temporary_failure",
      }),
    });
    const futureTimestamp = canonicalOutcome({ ...event, emittedAtMs: record.updatedAtMs + 1 });
    const wrongBefore = canonicalOutcome({ ...event, beforeSha256: "f".repeat(64) });
    const wrongAfter = { ...event, afterSha256: "f".repeat(64) };
    for (const forged of [wrongPhase, wrongReason, futureTimestamp, wrongBefore, wrongAfter]) {
      expect(() => validateErasureJobControlAudit(record, audits, [forged])).toThrow();
    }
    expect(() => validateErasureJobControlAudit(record, audits.slice(0, -1), [event]))
      .toThrow("does not match its main audit pair");

    // The authority path uses the same combined validator and durably isolates the poison.
    store.erasureJobControlEvents.get(input.requestId)![0]!.afterSha256 = "f".repeat(64);
    expect(await store.claimErasureJobs({
      nowMs: 102,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-control-poison",
    })).toEqual([]);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      controlGeneration: 2,
      quarantineReasonCode: "control_audit_invalid",
    });
  });

  it("binds each quarantine reason to exactly one repair action", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-control-action", "user-control-action");
    await store.requestUserErasure(input);
    delete store.erasureRequests.get(input.requestId)!.availableAtMs;
    expect(await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-control-action",
    })).toEqual([]);
    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
    expect(await store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId: "admin-control-action",
      actionCode: "normalize_queue_control",
      atMs: 101,
    })).toBe(true);
    const record = store.erasureRequests.get(input.requestId)!;
    const audits = store.erasureAuditEvents.get(input.requestId)!;
    const controls = structuredClone(store.erasureJobControlEvents.get(input.requestId)!);
    controls[1]!.actionCode = "resume_verified";
    controls[1]!.afterSha256 = erasureJobControlOutcomeSha256(controls[1]!);
    expect(() => validateErasureJobControlAudit(record, audits, controls))
      .toThrow("action does not match its reason");
  });

  it.each(["legal_hold", "policy_unavailable"] as const)(
    "refuses to resume blocked %s work",
    async (errorCode) => {
      const store = new MemorySessionStore();
      const input = requestInput(`tenant-${errorCode}`, `user-${errorCode}`);
      await store.requestUserErasure(input);
      const claim = (await store.claimErasureJobs({
        nowMs: 100,
        limit: 1,
        leaseMs: 20,
        claimToken: `worker-${errorCode}`,
      }))[0]!;
      await store.transitionErasureJob(authorization(claim), {
        fromStatus: "gated",
        toStatus: "blocked",
        atMs: 101,
        errorCode,
      });
      const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
      expect(inspection.allowedActions).toEqual([]);
      expect(inspection).not.toHaveProperty("resumePhase");
      expect(await store.repairAndResumeErasureJob({
        ...maintenanceIdentity(input),
        expectedControlGeneration: inspection.controlGeneration,
        expectedEvidenceSha256: inspection.evidenceSha256,
        actorKeyId: "admin-policy-refused",
        actionCode: "resume_blocked",
        atMs: 102,
      })).toBe(false);
      expect(store.erasureRequests.get(input.requestId)).toMatchObject({
        status: "blocked",
        lastErrorCode: errorCode,
      });
    },
  );

  it("strictly rejects a resumed target derived from purging", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-purge-blocked", "user-purge-blocked");
    await store.requestUserErasure(input);
    const record = store.erasureRequests.get(input.requestId)!;
    const audits = store.erasureAuditEvents.get(input.requestId)!;
    const chain = [
      ["gated", "draining"],
      ["draining", "tombstoning"],
      ["tombstoning", "reconciling_usage"],
      ["reconciling_usage", "awaiting_purge_policy"],
      ["awaiting_purge_policy", "purging"],
    ] as const;
    chain.forEach(([fromStatus, status], index) => audits.push({
      requestId: input.requestId,
      seq: audits.length + 1,
      type: "erasure/status_changed",
      payload: { fromStatus, status, generation: 1 },
      emittedAtMs: 101 + index,
    }));
    audits.push({
      requestId: input.requestId,
      seq: audits.length + 1,
      type: "erasure/blocked",
      payload: {
        fromStatus: "purging",
        status: "blocked",
        generation: 1,
        errorCode: "integrity_conflict",
      },
      emittedAtMs: 106,
    });
    Object.assign(record, {
      status: "blocked",
      updatedAtMs: 106,
      lastErrorCode: "integrity_conflict",
    });
    delete record.availableAtMs;
    const inspection = (await store.inspectErasureJobIntervention(maintenanceIdentity(input)))!;
    expect(inspection.allowedActions).toEqual([]);
    expect(await store.repairAndResumeErasureJob({
      ...maintenanceIdentity(input),
      expectedControlGeneration: inspection.controlGeneration,
      expectedEvidenceSha256: inspection.evidenceSha256,
      actorKeyId: "admin-purge-refused",
      actionCode: "resume_blocked",
      atMs: 107,
    })).toBe(false);
  });

  it("keeps immutable policy identity strict across the main audit chain", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-policy-audit", "user-policy-audit");
    await store.requestUserErasure(input);
    const claim = (await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-policy-audit",
    }))[0]!;
    await store.transitionErasureJob(authorization(claim), {
      fromStatus: "gated",
      toStatus: "draining",
      atMs: 101,
      availableAtMs: 101,
      policyVersion: "policy-v1",
      policyHash: "a".repeat(64),
    });
    const record = store.erasureRequests.get(input.requestId)!;
    const audits = store.erasureAuditEvents.get(input.requestId)!;
    audits.push({
      requestId: input.requestId,
      seq: 3,
      type: "erasure/status_changed",
      payload: {
        fromStatus: "draining",
        status: "tombstoning",
        generation: 1,
      },
      emittedAtMs: 102,
    });
    Object.assign(record, { status: "tombstoning", updatedAtMs: 102, availableAtMs: 102 });
    expect(() => validateErasureAuditChain(record, audits)).toThrow("not carried forward");
  });
});
