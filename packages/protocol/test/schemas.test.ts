import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  DATA_EXPORT_CONTENT_TYPE,
  DataExportRequest,
  DataExportRequestHeaders,
  DataExportRequestParams,
  ErasureRequest,
  ErasureRequestHeaders,
  ErasureRequestParams,
  DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
  DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
  ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1,
  ERASURE_JOB_CONTROL_QUARANTINE_V1,
  Capabilities,
  EndUserTokenHeaderName,
  Event,
  HTTP_STATUS,
  IntrospectionVerifier,
  Item,
  LegalHoldReleaseRequest,
  LegalHoldSetRequest,
  ModelSpec,
  OPENAPI_DOCUMENT,
  addUsage,
  emptyUsage,
  emptyUsageAccumulator,
  mergeLimits,
  StartTurnRequest,
  UserErasureDrainRequest,
  idSchema,
  PROTOCOL_VERSION,
  PURGE_POLICY_EVALUATOR_V1,
  RetentionPolicyActivateRequest,
  RetentionPolicyParams,
  USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
} from "../src/index.js";

describe("protocol schemas", () => {
  it("validates ids", () => {
    expect(idSchema("sess").safeParse("sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b").success).toBe(true);
    expect(idSchema("sess").safeParse("sess_not-a-uuid").success).toBe(false);
    expect(idSchema("sess").safeParse("turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b").success).toBe(false);
  });

  it("merges limits by min (policy can only tighten)", () => {
    const m = mergeLimits({ maxSteps: 30 }, { maxSteps: 5, maxCostCNY: 1 }, undefined, { maxSteps: 10 });
    expect(m.maxSteps).toBe(5);
    expect(m.maxCostCNY).toBe(1);
    expect(m.maxToolCalls).toBe(50);
  });

  it("keeps a known-empty accumulator as the cost identity and makes an actual unknown cost sticky", () => {
    const priced = { ...emptyUsage(), totalTokens: 1, costCNY: 0.25 };
    expect(addUsage(emptyUsageAccumulator(), priced)).toEqual(priced);

    // Token counters cannot identify the accumulator identity: a real zero-token provider result
    // may still have unknown cost.
    const zeroTokenUnknown = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
    const unknownTotal = addUsage(priced, zeroTokenUnknown);
    expect(unknownTotal).toMatchObject({ totalTokens: 1 });
    expect(unknownTotal).not.toHaveProperty("costCNY");
    expect(addUsage(unknownTotal, emptyUsageAccumulator())).not.toHaveProperty("costCNY");
  });

  it("applies defaults on StartTurnRequest", () => {
    const r = StartTurnRequest.parse({ input: [{ type: "text", text: "hi" }] });
    expect(r.stream).toBe(true);
    expect(r.metadata).toEqual({});
  });

  it("requires every model capability declaration to contain one text entry", () => {
    expect(ModelSpec.parse({ id: "default-text" }).input).toEqual(["text"]);
    for (const input of [["text"], ["text", "image"], ["image", "text"]]) {
      expect(ModelSpec.safeParse({ id: "valid", input }).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [[], ["image"], ["text", "text"], ["image", "image"]]) {
      expect(ModelSpec.safeParse({ id: "invalid", input }).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("distinguishes persisted and live events", () => {
    const sid = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    const tid = "turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    const iid = "item_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    expect(Event.safeParse({ type: "heartbeat", sessionId: sid, emittedAtMs: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "item/agentMessage/delta", sessionId: sid, turnId: tid, itemId: iid, delta: "x", emittedAtMs: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "session/created", sessionId: sid, emittedAtMs: 1 }).success).toBe(false); // needs seq
    expect(Event.safeParse({ type: "session/created", sessionId: sid, emittedAtMs: 1, seq: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "session/deleted", sessionId: sid, emittedAtMs: 2, seq: 2, deletionGeneration: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "session/deleted", sessionId: sid, emittedAtMs: 2, seq: 2, deletionGeneration: 0 }).success).toBe(false);
  });

  it("publishes lifecycle write barriers as stable 409 errors", () => {
    expect(ErrorCode.parse("session_has_children")).toBe("session_has_children");
    expect(HTTP_STATUS.session_has_children).toBe(409);
    expect(ErrorCode.parse("subject_deleting")).toBe("subject_deleting");
    expect(HTTP_STATUS.subject_deleting).toBe(409);
  });

  it("validates public erasure status without exposing internal idempotency or audit material", () => {
    const value = ErasureRequest.parse({
      id: "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
      scope: "user",
      userId: "u_1",
      generation: 1,
      status: "gated",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    expect(value.status).toBe("gated");
    expect(ErasureRequest.safeParse({ ...value, status: "done" }).success).toBe(false);
    expect(ErasureRequest.safeParse({ ...value, generation: 0 }).success).toBe(false);
    expect(ErasureRequestParams.safeParse({ requestId: value.id.toUpperCase() }).success).toBe(false);
  });

  it("requires a bounded non-blank idempotency key for erasure requests", () => {
    expect(ErasureRequestHeaders.parse({
      "x-user-id": "u_1",
      "idempotency-key": " erasure-1 ",
    })["idempotency-key"]).toBe("erasure-1");
    expect(ErasureRequestHeaders.safeParse({ "x-user-id": "u_1" }).success).toBe(false);
    expect(ErasureRequestHeaders.safeParse({ "x-user-id": "u_1", "idempotency-key": "   " }).success).toBe(false);
    expect(ErasureRequestHeaders.safeParse({
      "x-user-id": "u_1",
      "idempotency-key": "x".repeat(257),
    }).success).toBe(false);
  });

  it("keeps data export identity, state and ready artifact metadata strict", () => {
    const base = {
      id: "export_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
      scope: "user" as const,
      userId: "u_1",
      format: "ndjson-v1" as const,
      createdAtMs: 1,
      updatedAtMs: 2,
    };
    const queued = DataExportRequest.parse({ ...base, status: "queued" });
    expect(queued.status).toBe("queued");
    for (const status of ["queued", "building", "failed", "expired", "revoked"] as const) {
      expect(DataExportRequest.safeParse({
        ...base,
        status,
        artifact: { contentType: DATA_EXPORT_CONTENT_TYPE, sizeBytes: 1, sha256: "a".repeat(64) },
      }).success, status).toBe(false);
    }

    const ready = DataExportRequest.parse({
      ...base,
      status: "ready",
      snapshotAtMs: 2,
      readyAtMs: 3,
      expiresAtMs: 4,
      artifact: {
        contentType: DATA_EXPORT_CONTENT_TYPE,
        sizeBytes: 123,
        sha256: "a".repeat(64),
      },
    });
    expect(ready.status).toBe("ready");
    expect(DataExportRequest.safeParse({ ...ready, artifact: undefined }).success).toBe(false);
    expect(DataExportRequest.safeParse({ ...ready, storageKey: "private/object" }).success).toBe(false);
    expect(DataExportRequestParams.safeParse({ requestId: base.id.toUpperCase() }).success).toBe(false);
    expect(DataExportRequestParams.safeParse({
      requestId: "export_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b",
    }).success).toBe(false);
  });

  it("requires a bounded non-blank idempotency key for data export requests", () => {
    expect(DataExportRequestHeaders.parse({
      "x-user-id": "u_1",
      "idempotency-key": " export-1 ",
    })["idempotency-key"]).toBe("export-1");
    expect(DataExportRequestHeaders.safeParse({ "x-user-id": "u_1" }).success).toBe(false);
    expect(DataExportRequestHeaders.safeParse({
      "x-user-id": "u_1",
      "idempotency-key": " ",
    }).success).toBe(false);
  });

  it("declares private response headers for every erasure success and error response", () => {
    const post = OPENAPI_DOCUMENT.paths["/v1/data-erasure-requests"].post.responses;
    const get = OPENAPI_DOCUMENT.paths["/v1/data-erasure-requests/{requestId}"].get.responses;
    for (const response of [post["202"], post.default, get["200"], get.default]) {
      expect(response.headers["Cache-Control"].schema.enum).toEqual(["no-store"]);
      expect(response.headers["X-Content-Type-Options"].schema.enum).toEqual(["nosniff"]);
    }
  });

  it("declares private export status and binary download responses", () => {
    const post = OPENAPI_DOCUMENT.paths["/v1/data-export-requests"].post.responses;
    const get = OPENAPI_DOCUMENT.paths["/v1/data-export-requests/{requestId}"].get.responses;
    const download = OPENAPI_DOCUMENT.paths["/v1/data-export-requests/{requestId}/download"].get.responses;
    for (const response of [post["202"], post.default, get["200"], get.default, download["200"], download.default]) {
      expect(response.headers["Cache-Control"].schema.enum).toEqual(["no-store"]);
      expect(response.headers["X-Content-Type-Options"].schema.enum).toEqual(["nosniff"]);
    }
    expect(download["200"].content).toHaveProperty(DATA_EXPORT_CONTENT_TYPE);
    expect(download["200"].headers).toEqual(expect.objectContaining({
      "Content-Disposition": expect.any(Object),
      "Content-Digest": expect.any(Object),
      "X-Artifact-Size": expect.any(Object),
      "Content-Length": expect.any(Object),
    }));
    expect(download["200"].headers["Content-Length"]).not.toHaveProperty("required");
  });

  it("normalizes missing additive erasure capability to false for mixed fleets", () => {
    const parsed = Capabilities.parse({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive"],
        blobAttachments: false,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    expect(parsed.features.dataErasureRequests).toBe(false);
    expect(parsed.features.userErasureWorker).toEqual([]);
    expect(parsed.features.erasureJobControl).toEqual([]);
    expect(parsed.features.dataGovernance).toEqual([]);
    expect(parsed.features.dataGovernanceManagement).toBe(false);
    expect(parsed.features.purgePolicyEvaluation).toEqual([]);
    expect(parsed.features.dataPurgeExecution).toBe(false);
    expect(parsed.features.userDataExport).toEqual([]);
    expect(parsed.features.dataExportRequests).toBe(false);
  });

  it("accepts only the additive NDJSON export capability", () => {
    const base = Capabilities.parse({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive"],
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    const enabled = Capabilities.parse({
      ...base,
      features: {
        ...base.features,
        userDataExport: [USER_DATA_EXPORT_ARTIFACT_NDJSON_V1],
        dataExportRequests: true,
      },
    });
    expect(enabled.features.userDataExport).toEqual([USER_DATA_EXPORT_ARTIFACT_NDJSON_V1]);
    expect(enabled.features.dataExportRequests).toBe(true);
    expect(Capabilities.safeParse({
      ...base,
      features: { ...base.features, userDataExport: ["artifact-json-v1"] },
    }).success).toBe(false);
  });

  it("separates non-destructive policy evaluation from physical purge execution", () => {
    const base = Capabilities.parse({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive"],
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    const aware = Capabilities.parse({
      ...base,
      features: {
        ...base.features,
        purgePolicyEvaluation: [PURGE_POLICY_EVALUATOR_V1],
      },
    });
    expect(aware.features.purgePolicyEvaluation).toEqual([PURGE_POLICY_EVALUATOR_V1]);
    expect(aware.features.dataPurgeExecution).toBe(false);
    expect(Capabilities.safeParse({
      ...base,
      features: { ...base.features, purgePolicyEvaluation: ["future-evaluator-v2"] },
    }).success).toBe(false);
    expect(Capabilities.safeParse({
      ...base,
      features: { ...base.features, dataPurgeExecution: true },
    }).success).toBe(false);
  });

  it("accepts only the cumulative canonical retention and multi-hold capabilities", () => {
    const base = Capabilities.parse({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive"],
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    const dataGovernance = [
      DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
      DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
    ];
    const enabled = Capabilities.parse({
      ...base,
      features: { ...base.features, dataGovernance, dataGovernanceManagement: true },
    });
    expect(enabled.features.dataGovernance).toEqual(dataGovernance);
    expect(enabled.features.dataGovernanceManagement).toBe(true);
    expect(Capabilities.safeParse({
      ...base,
      features: { ...base.features, dataGovernance: [...dataGovernance, "purge-v1"] },
    }).success).toBe(false);
  });

  it("reserves the fixed active retention-policy path segment", () => {
    expect(RetentionPolicyParams.safeParse({ policyVersion: "policy-v1" }).success).toBe(true);
    expect(RetentionPolicyParams.safeParse({ policyVersion: "active" }).success).toBe(false);
  });

  it("rejects a governance CAS generation that the stores cannot represent", () => {
    const unsupported = Number.MAX_SAFE_INTEGER;
    expect(RetentionPolicyActivateRequest.safeParse({
      expectedControlGeneration: unsupported,
    }).success).toBe(false);
    expect(LegalHoldSetRequest.safeParse({
      holdId: "hold_generation-limit",
      subjectKind: "user",
      subjectId: "u_1",
      reasonCode: "litigation",
      expectedControlGeneration: unsupported,
    }).success).toBe(false);
    expect(LegalHoldReleaseRequest.safeParse({
      expectedControlGeneration: unsupported,
      reasonCode: "matter_closed",
    }).success).toBe(false);
  });

  it("accepts both cumulative erasure job-control capabilities while rejecting unknown control contracts", () => {
    const features = {
      streaming: true as const,
      replay: { persistedEvents: true as const, hotWindowMs: 1 },
      approvals: true as const,
      sessionLifecycle: ["archive" as const],
      blobAttachments: false,
      dataErasureRequests: false,
      userErasureWorker: [],
      dynamicTools: true,
      mcp: [],
      skills: false,
      sandbox: ["none" as const],
      byok: true,
    };
    const controls = [
      ERASURE_JOB_CONTROL_QUARANTINE_V1,
      ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1,
    ];
    const parsed = Capabilities.parse({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: { ...features, erasureJobControl: controls },
    });
    expect(parsed.features.erasureJobControl).toEqual(controls);
    expect(Capabilities.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: { ...features, erasureJobControl: [ERASURE_JOB_CONTROL_QUARANTINE_V1] },
    }).success).toBe(true);
    expect(Capabilities.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: { ...features, erasureJobControl: [...controls, "future-control-v1"] },
    }).success).toBe(false);
  });

  it("keeps the internal erasure drain contract claim-only and strict", () => {
    const authority = {
      tenantId: "tenant-a",
      userId: "user-a",
      requestId: "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
      subjectGeneration: 1,
      claimToken: "worker.claim-1",
      claimAttempt: 2,
    };
    expect(UserErasureDrainRequest.parse(authority)).toEqual(authority);
    expect(UserErasureDrainRequest.safeParse({ ...authority, phase: "tombstoning" }).success).toBe(false);
    expect(UserErasureDrainRequest.safeParse({ ...authority, claimToken: "unsafe token" }).success).toBe(false);
  });

  it("rejects unknown item types", () => {
    expect(Item.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("accepts custom end-user token headers but rejects invalid or reserved HTTP headers", () => {
    for (const valid of ["x-end-user-token", "X-Tenant-Auth", "end.user_token+v2"]) {
      expect(EndUserTokenHeaderName.safeParse(valid).success, valid).toBe(true);
    }
    for (const reserved of [
      "authorization",
      "AUTHORIZATION",
      "x-user-id",
      "Host",
      "content-length",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      expect(EndUserTokenHeaderName.safeParse(reserved).success, reserved).toBe(false);
    }
    for (const invalid of ["", "x token", "x:token", "x-token\nforwarded", "令牌"]) {
      expect(EndUserTokenHeaderName.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it("keeps Authorization valid for the outbound introspection token header", () => {
    expect(IntrospectionVerifier.parse({ kind: "introspection", endpoint: "https://auth.example/introspect" }).tokenHeader).toBe("authorization");
  });
});
