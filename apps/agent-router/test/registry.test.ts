import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
  DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
  ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1,
  ERASURE_JOB_CONTROL_QUARANTINE_V1,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
  PROTOCOL_VERSION,
  PURGE_POLICY_EVALUATOR_V1,
  TENANT_CREDENTIAL_REVOCATION_STORE_V1,
  TENANT_ERASURE_PLATFORM_CONTROL_V1,
  TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
  TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1,
  TENANT_RUNTIME_DRAIN_V1,
  USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
  tenantRuntimeFleetSha256,
  tenantRuntimeTargetSha256,
} from "@agent-service/protocol";
import { RunnerRegistry } from "../src/registry.js";

afterEach(() => vi.unstubAllGlobals());

const JOB_CONTROL_V2 = [
  ERASURE_JOB_CONTROL_QUARANTINE_V1,
  ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1,
] as const;
const DATA_GOVERNANCE_V1 = [
  DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
  DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
] as const;

describe("RunnerRegistry owner address mapping", () => {
  it("maps an exact advertised address when runners share the same port", async () => {
    const registry = new RunnerRegistry({ runners: ["http://runner-a:8787", "http://runner-b:8787/"] });
    expect(registry.toUrl("runner-a:8787")).toBe("http://runner-a:8787");
    expect(registry.toUrl("http://runner-b:8787/")).toBe("http://runner-b:8787");
    await registry.close();
  });

  it("uses the port fallback only when it identifies exactly one runner", async () => {
    const unique = new RunnerRegistry({ runners: ["http://runner-a:8787", "http://runner-b:8788"] });
    expect(unique.toUrl("legacy-name:8787")).toBe("http://runner-a:8787");
    await unique.close();

    const ambiguous = new RunnerRegistry({ runners: ["http://runner-a:8787", "http://runner-b:8787"] });
    expect(ambiguous.toUrl("0.0.0.0:8787")).toBeUndefined();
    await ambiguous.close();
  });

  it("admits only ready runners on the current protocol into routing", async () => {
    const capabilities = (
      protocolVersion: string,
      sessionLifecycle = ["archive", "unarchive", "tombstone"],
      blobAttachments = true,
      dataErasureRequests = true,
      userErasureWorker = ["drain-v1"],
      erasureJobControl: readonly string[] = JOB_CONTROL_V2,
      dataGovernance: readonly string[] = DATA_GOVERNANCE_V1,
      dataGovernanceManagement = true,
      purgePolicyEvaluation: readonly string[] = [PURGE_POLICY_EVALUATOR_V1],
    ) => ({
      protocolVersion,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle,
        blobAttachments,
        dataErasureRequests,
        userErasureWorker,
        erasureJobControl,
        dataGovernance,
        dataGovernanceManagement,
        purgePolicyEvaluation,
        dataPurgeExecution: false,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/readyz")) return new Response("ready");
      if (url.startsWith("http://current/")) return Response.json(capabilities(PROTOCOL_VERSION));
      if (url.startsWith("http://current-basic/")) {
        return Response.json(capabilities(
          PROTOCOL_VERSION,
          ["archive", "unarchive"],
          false,
          false,
          [],
          [],
          [],
          false,
        ));
      }
      if (url.startsWith("http://old/")) return Response.json(capabilities("2026-09-22"));
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://current-basic", "http://old"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();

    expect(registry.list().map(({ url, healthy }) => ({ url, healthy }))).toEqual([
      { url: "http://current", healthy: true },
      { url: "http://current-basic", healthy: true },
      { url: "http://old", healthy: false },
    ]);
    expect(registry.allHealthySupportLifecycle("tombstone")).toBe(false);
    expect(registry.supportsLifecycle("http://current", "tombstone")).toBe(true);
    expect(registry.supportsLifecycle("http://current-basic", "tombstone")).toBe(false);
    expect(registry.supportsLifecycle("http://old", "tombstone")).toBe(false);
    expect(registry.allHealthySupportBlobAttachments()).toBe(false);
    expect(registry.supportsBlobAttachments("http://current")).toBe(true);
    expect(registry.supportsBlobAttachments("http://current-basic")).toBe(false);
    expect(registry.allHealthySupportDataErasureRequests()).toBe(false);
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(false);
    expect(registry.supportsDataErasureRequests("http://current")).toBe(true);
    expect(registry.supportsDataErasureRequests("http://current-basic")).toBe(false);
    expect(registry.allConfiguredSupportDataGovernance()).toBe(false);
    expect(registry.supportsDataGovernance("http://current")).toBe(true);
    expect(registry.supportsDataGovernance("http://current-basic")).toBe(false);
    expect(registry.allConfiguredSupportDataGovernanceManagement()).toBe(false);
    expect(registry.supportsDataGovernanceManagement("http://current")).toBe(true);
    expect(registry.supportsDataGovernanceManagement("http://current-basic")).toBe(false);
    expect(registry.allHealthySupportUserErasureWorker()).toBe(false);
    expect(registry.supportsUserErasureWorker("http://current")).toBe(true);
    expect(registry.supportsUserErasureWorker("http://current-basic")).toBe(false);
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);
    expect(registry.allConfiguredSupportPurgePolicyEvaluation()).toBe(false);
    expect(registry.anyHealthy()).toBe("http://current");
    expect(registry.routeableUrl("current")).toBe("http://current");
    expect(registry.routeableUrl("old")).toBeUndefined();
    await registry.close();
  });

  it("does not ignore an unavailable configured legacy writer when activating erasure", async () => {
    let legacyState: "down" | "legacy" | "quarantine-only" | "compensation-only" | "upgraded" | "wrong-protocol" | "missing-endpoint"
      | "malformed" | "wrong-service" | "capability-transport" = "down";
    const capabilities = (
      dataErasureRequests: boolean,
      erasureJobControl: readonly string[],
      protocolVersion: string = PROTOCOL_VERSION,
      service: string = "agent-runner",
    ) => ({
      protocolVersion,
      service,
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        blobAttachments: true,
        dataErasureRequests,
        userErasureWorker: ["drain-v1"],
        erasureJobControl,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://current/readyz")) return new Response("ready");
      if (url.startsWith("http://current/v1/capabilities")) {
        return Response.json(capabilities(true, JOB_CONTROL_V2));
      }
      if (url.startsWith("http://legacy/readyz")) {
        return legacyState === "down" ? new Response("down", { status: 503 }) : new Response("ready");
      }
      if (url.startsWith("http://legacy/v1/capabilities")) {
        if (legacyState === "capability-transport") throw new Error("capability transport failed");
        if (legacyState === "missing-endpoint") return new Response("not found", { status: 404 });
        if (legacyState === "malformed") return new Response("not-json");
        if (legacyState === "wrong-protocol") {
          return Response.json(capabilities(true, JOB_CONTROL_V2, "2026-09-22"));
        }
        if (legacyState === "wrong-service") {
          return Response.json(capabilities(true, JOB_CONTROL_V2, PROTOCOL_VERSION, "agent-router"));
        }
        return Response.json(capabilities(
          true,
          legacyState === "upgraded"
            ? JOB_CONTROL_V2
            : legacyState === "quarantine-only"
              ? [ERASURE_JOB_CONTROL_QUARANTINE_V1]
              : legacyState === "compensation-only"
                ? [ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1]
                : [],
        ));
      }
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();

    // Status reads retain their healthy-subset rule, but an irreversible POST cannot pretend that
    // the configured, currently unavailable writer has already been drained or upgraded.
    expect(registry.allHealthySupportDataErasureRequests()).toBe(true);
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(false);
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);

    legacyState = "legacy";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.list().find((target) => target.url === "http://legacy")?.healthy).toBe(true);
    expect(registry.allHealthySupportDataErasureRequests()).toBe(true);
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(true);
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);

    legacyState = "compensation-only";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);

    legacyState = "upgraded";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allHealthySupportDataErasureRequests()).toBe(true);
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(true);
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);

    // Admission still closes while a configured writer is unavailable, but an already-activated
    // worker must retain queue authority so it can recover the crashed runner's sessions.
    legacyState = "down";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(false);
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);

    // Rollback after activation is forbidden. If it nevertheless becomes observable, fail closed
    // again rather than treating the earlier capability observation as permanent authorization.
    legacyState = "quarantine-only";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);

    for (const incompatible of [
      "wrong-protocol",
      "missing-endpoint",
      "malformed",
      "wrong-service",
      "capability-transport",
    ] as const) {
      legacyState = "upgraded";
      await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);
      legacyState = incompatible;
      await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
      expect(registry.allConfiguredSupportErasureJobControl(), incompatible).toBe(false);
    }
    await registry.close();
  });

  it("requires every configured stable runner to be healthy and policy-evaluator aware", async () => {
    let legacyState: "legacy" | "upgraded" | "down" = "legacy";
    const capabilities = (aware: boolean) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        purgePolicyEvaluation: aware ? [PURGE_POLICY_EVALUATOR_V1] : [],
        dataPurgeExecution: false,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://current/readyz")) return new Response("ready");
      if (url.startsWith("http://current/v1/capabilities")) {
        return Response.json(capabilities(true));
      }
      if (url.startsWith("http://legacy/readyz")) {
        return legacyState === "down"
          ? new Response("down", { status: 503 })
          : new Response("ready");
      }
      if (url.startsWith("http://legacy/v1/capabilities")) {
        return Response.json(capabilities(legacyState === "upgraded"));
      }
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();
    expect(registry.allConfiguredSupportPurgePolicyEvaluation()).toBe(false);

    legacyState = "upgraded";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allConfiguredSupportPurgePolicyEvaluation()).toBe(true);

    legacyState = "down";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allConfiguredSupportPurgePolicyEvaluation()).toBe(false);

    legacyState = "legacy";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allConfiguredSupportPurgePolicyEvaluation()).toBe(false);
    await registry.close();
  });

  it("requires every configured runner to be freshly healthy, code-aware, and worker-active for credential revocation", async () => {
    let legacyState: "down" | "legacy" | "code-only" | "active" = "down";
    const capabilities = (aware: boolean, worker: boolean) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        tenantCredentialRevocation: aware
          ? [TENANT_CREDENTIAL_REVOCATION_STORE_V1]
          : [],
        tenantCredentialRevocationWorker: worker,
        dataPurgeExecution: false,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://current/readyz")) return new Response("ready");
      if (url.startsWith("http://current/v1/capabilities")) {
        return Response.json(capabilities(true, true));
      }
      if (url.startsWith("http://legacy/readyz")) {
        return legacyState === "down"
          ? new Response("down", { status: 503 })
          : new Response("ready");
      }
      if (url.startsWith("http://legacy/v1/capabilities")) {
        return Response.json(capabilities(
          legacyState === "code-only" || legacyState === "active",
          legacyState === "active",
        ));
      }
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();
    expect(registry.allConfiguredSupportTenantCredentialRevocation()).toBe(false);
    expect(registry.allConfiguredSupportTenantCredentialRevocationWorker()).toBe(false);

    legacyState = "legacy";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialRevocation()).toBe(false);
    expect(registry.allConfiguredSupportTenantCredentialRevocationWorker()).toBe(false);

    legacyState = "code-only";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialRevocation()).toBe(true);
    expect(registry.allConfiguredSupportTenantCredentialRevocationWorker()).toBe(false);

    legacyState = "active";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialRevocation()).toBe(true);
    expect(registry.allConfiguredSupportTenantCredentialRevocationWorker()).toBe(true);

    // This observation is deliberately non-sticky: a fresh outage or downgrade closes it.
    legacyState = "down";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialRevocation()).toBe(false);
    expect(registry.allConfiguredSupportTenantCredentialRevocationWorker()).toBe(false);
    await registry.close();
  });

  it("requires every configured runner to be freshly healthy, T3e-aware, and worker-active", async () => {
    let legacyState: "down" | "legacy" | "code-only" | "active" = "down";
    const capabilities = (aware: boolean, worker: boolean) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        tenantPurgeExecution: aware ? [TENANT_PURGE_EXECUTION_LOCAL_ACK_V1] : [],
        tenantPurgeExecutionWorker: worker,
        dataPurgeExecution: false,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://current/readyz")) return new Response("ready");
      if (url.startsWith("http://current/v1/capabilities")) {
        return Response.json(capabilities(true, true));
      }
      if (url.startsWith("http://legacy/readyz")) {
        return legacyState === "down"
          ? new Response("down", { status: 503 })
          : new Response("ready");
      }
      if (url.startsWith("http://legacy/v1/capabilities")) {
        if (legacyState === "legacy") {
          const document = capabilities(false, false);
          delete (document.features as Partial<typeof document.features>).tenantPurgeExecution;
          delete (document.features as Partial<typeof document.features>).tenantPurgeExecutionWorker;
          return Response.json(document);
        }
        return Response.json(capabilities(
          legacyState === "code-only" || legacyState === "active",
          legacyState === "active",
        ));
      }
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();
    expect(registry.allConfiguredSupportTenantPurgeExecution()).toBe(false);
    expect(registry.allConfiguredSupportTenantPurgeExecutionWorker()).toBe(false);

    legacyState = "legacy";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantPurgeExecution()).toBe(false);
    expect(registry.allConfiguredSupportTenantPurgeExecutionWorker()).toBe(false);

    legacyState = "code-only";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantPurgeExecution()).toBe(true);
    expect(registry.allConfiguredSupportTenantPurgeExecutionWorker()).toBe(false);

    legacyState = "active";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantPurgeExecution()).toBe(true);
    expect(registry.allConfiguredSupportTenantPurgeExecutionWorker()).toBe(true);

    legacyState = "down";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantPurgeExecution()).toBe(false);
    expect(registry.allConfiguredSupportTenantPurgeExecutionWorker()).toBe(false);
    await registry.close();
  });

  it("requires every configured runner to be freshly T3f-aware and database-worker-active", async () => {
    let legacyState: "down" | "legacy" | "new-only" | "code-only" | "active" = "down";
    const capabilities = (aware: boolean, worker: boolean, t3eAware = true) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        tenantPurgeExecution: [
          ...(t3eAware ? [TENANT_PURGE_EXECUTION_LOCAL_ACK_V1] : []),
          ...(aware ? [TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1] : []),
        ],
        tenantPurgeExecutionWorker: true,
        tenantDatabasePurgeWorker: worker,
        dataPurgeExecution: false,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://current/readyz")) return new Response("ready");
      if (url.startsWith("http://current/v1/capabilities")) {
        return Response.json(capabilities(true, true));
      }
      if (url.startsWith("http://legacy/readyz")) {
        return legacyState === "down"
          ? new Response("down", { status: 503 })
          : new Response("ready");
      }
      if (url.startsWith("http://legacy/v1/capabilities")) {
        if (legacyState === "legacy") {
          const document = capabilities(false, false);
          delete (document.features as Partial<typeof document.features>).tenantDatabasePurgeWorker;
          return Response.json(document);
        }
        return Response.json(capabilities(
          legacyState === "new-only" || legacyState === "code-only" || legacyState === "active",
          legacyState === "active",
          legacyState !== "new-only",
        ));
      }
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();
    expect(registry.allConfiguredSupportTenantDatabasePurge()).toBe(false);
    expect(registry.allConfiguredSupportTenantDatabasePurgeWorker()).toBe(false);

    legacyState = "new-only";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantDatabasePurge()).toBe(false);
    expect(registry.allConfiguredSupportTenantDatabasePurgeWorker()).toBe(false);

    legacyState = "legacy";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantDatabasePurge()).toBe(false);
    expect(registry.allConfiguredSupportTenantDatabasePurgeWorker()).toBe(false);

    legacyState = "code-only";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantDatabasePurge()).toBe(true);
    expect(registry.allConfiguredSupportTenantDatabasePurgeWorker()).toBe(false);

    legacyState = "active";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantDatabasePurge()).toBe(true);
    expect(registry.allConfiguredSupportTenantDatabasePurgeWorker()).toBe(true);

    legacyState = "down";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantDatabasePurge()).toBe(false);
    expect(registry.allConfiguredSupportTenantDatabasePurgeWorker()).toBe(false);
    await registry.close();
  });

  it("uses healthy code awareness for export reads but every configured runner for admission", async () => {
    let legacyState: "down" | "legacy" | "code-only" | "upgraded" = "down";
    const capabilities = (aware: boolean, admission: boolean) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        userDataExport: aware ? [USER_DATA_EXPORT_ARTIFACT_NDJSON_V1] : [],
        dataExportRequests: admission,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://current/readyz")) return new Response("ready");
      if (url.startsWith("http://current/v1/capabilities")) {
        return Response.json(capabilities(true, true));
      }
      if (url.startsWith("http://legacy/readyz")) {
        return legacyState === "down"
          ? new Response("down", { status: 503 })
          : new Response("ready");
      }
      if (url.startsWith("http://legacy/v1/capabilities")) {
        return Response.json(capabilities(
          legacyState === "code-only" || legacyState === "upgraded",
          legacyState === "upgraded",
        ));
      }
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();
    expect(registry.allHealthySupportUserDataExport()).toBe(true);
    expect(registry.allConfiguredSupportUserDataExportAdmission()).toBe(false);
    expect(registry.supportsUserDataExport("http://current")).toBe(true);
    expect(registry.supportsUserDataExport("http://legacy")).toBe(false);

    legacyState = "legacy";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allHealthySupportUserDataExport()).toBe(false);
    expect(registry.allConfiguredSupportUserDataExportAdmission()).toBe(false);

    legacyState = "code-only";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allHealthySupportUserDataExport()).toBe(true);
    expect(registry.allConfiguredSupportUserDataExportAdmission()).toBe(false);
    expect(registry.supportsUserDataExport("http://legacy")).toBe(true);

    legacyState = "upgraded";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allHealthySupportUserDataExport()).toBe(true);
    expect(registry.allConfiguredSupportUserDataExportAdmission()).toBe(true);

    legacyState = "down";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allHealthySupportUserDataExport()).toBe(true);
    expect(registry.allConfiguredSupportUserDataExportAdmission()).toBe(false);
    await registry.close();
  });

  it("uses healthy tenant-control readers but every configured runner for irreversible admission", async () => {
    let legacyState: "down" | "legacy" | "control" | "active" = "down";
    const capabilities = (control: boolean, admission: boolean) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        tenantErasureControl: control ? [TENANT_ERASURE_PLATFORM_CONTROL_V1] : [],
        tenantErasureRequests: admission,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://current/readyz")) return new Response("ready");
      if (url.startsWith("http://current/v1/capabilities")) {
        return Response.json(capabilities(true, true));
      }
      if (url.startsWith("http://legacy/readyz")) {
        return legacyState === "down"
          ? new Response("down", { status: 503 })
          : new Response("ready");
      }
      if (url.startsWith("http://legacy/v1/capabilities")) {
        return Response.json(capabilities(
          legacyState === "control" || legacyState === "active",
          legacyState === "active",
        ));
      }
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();
    expect(registry.allHealthySupportTenantErasureControl()).toBe(true);
    expect(registry.allConfiguredSupportTenantErasureControl()).toBe(false);
    expect(registry.allConfiguredSupportTenantErasureAdmission()).toBe(false);
    expect(registry.supportsTenantErasureControl("http://current")).toBe(true);
    expect(registry.supportsTenantErasureAdmission("http://current")).toBe(true);

    legacyState = "legacy";
    await registry.refresh();
    expect(registry.allHealthySupportTenantErasureControl()).toBe(false);
    expect(registry.allConfiguredSupportTenantErasureControl()).toBe(false);

    legacyState = "control";
    await registry.refresh();
    expect(registry.allHealthySupportTenantErasureControl()).toBe(true);
    expect(registry.allConfiguredSupportTenantErasureControl()).toBe(true);
    expect(registry.allConfiguredSupportTenantErasureAdmission()).toBe(false);
    expect(registry.supportsTenantErasureControl("http://legacy")).toBe(true);
    expect(registry.supportsTenantErasureAdmission("http://legacy")).toBe(false);

    legacyState = "active";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantErasureAdmission()).toBe(true);

    legacyState = "down";
    await registry.refresh();
    expect(registry.allHealthySupportTenantErasureControl()).toBe(true);
    expect(registry.allConfiguredSupportTenantErasureControl()).toBe(false);
    expect(registry.allConfiguredSupportTenantErasureAdmission()).toBe(false);
    await registry.close();
  });

  it("serializes overlapping health probes so an older result cannot overwrite a newer one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      await gate;
      return String(input).endsWith("/readyz")
        ? new Response("ready")
        : Response.json({
          protocolVersion: PROTOCOL_VERSION,
          service: "agent-runner",
          features: {
            streaming: true,
            replay: { persistedEvents: true, hotWindowMs: 1 },
            approvals: true,
            sessionLifecycle: ["archive", "unarchive", "tombstone"],
            blobAttachments: true,
            dataErasureRequests: true,
            userErasureWorker: ["drain-v1"],
            erasureJobControl: JOB_CONTROL_V2,
            dynamicTools: true,
            mcp: [],
            skills: false,
            sandbox: ["none"],
            byok: true,
          },
        });
    });
    vi.stubGlobal("fetch", fetchMock);
    const registry = new RunnerRegistry({
      runners: ["http://single-flight"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    const first = (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    const second = (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(first).toBe(second);
    release();
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);
    await registry.close();
  });
});

describe("RunnerRegistry tenant runtime drain fleet snapshot", () => {
  const token = "registry-runtime-drain-token-000001";
  const capability = (endpointEnabled = true) => ({
    protocolVersion: PROTOCOL_VERSION,
    service: "agent-runner",
    features: {
      streaming: true,
      replay: { persistedEvents: true, hotWindowMs: 1 },
      approvals: true,
      sessionLifecycle: ["archive"],
      tenantRuntimeDrain: [TENANT_RUNTIME_DRAIN_V1],
      tenantRuntimeDrainEndpoint: endpointEnabled,
      dynamicTools: true,
      mcp: [],
      skills: false,
      sandbox: ["none"],
      byok: true,
    },
  });

  it("probes every exact configured URL and returns a canonical immutable identity snapshot", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/readyz")) return new Response("ready");
      if (url.endsWith("/v1/capabilities")) return Response.json(capability());
      if (url.endsWith(INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH)) {
        expect(new Headers(init?.headers).get("x-agent-service-internal-token")).toBe(token);
        const host = new URL(url).hostname;
        return Response.json({
          protocolVersion: PROTOCOL_VERSION,
          service: "agent-runner",
          capability: TENANT_RUNTIME_DRAIN_V1,
          endpointEnabled: true,
          runnerId: `runner-${host.at(-1)}`,
          bootId: `boot-${host.at(-1)}`,
        }, {
          headers: {
            [INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER]:
              INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
            "cache-control": "no-store",
          },
        });
      }
      return new Response(null, { status: 404 });
    }));
    const registry = new RunnerRegistry({
      runners: ["http://runner-b:8787", "http://runner-a:8787"],
      internalRouterToken: token,
    });
    const snapshot = await registry.freshTenantRuntimeDrainSnapshot();
    const expectedHashes = [
      tenantRuntimeTargetSha256("http://runner-a:8787"),
      tenantRuntimeTargetSha256("http://runner-b:8787"),
    ].sort();
    expect(snapshot.targets.map((target) => target.targetSha256)).toEqual(expectedHashes);
    expect(snapshot.fleetSha256).toBe(tenantRuntimeFleetSha256(snapshot.targets));
    expect(calls).toHaveLength(6);
    expect(calls).toEqual(expect.arrayContaining([
      `http://runner-a:8787${INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH}`,
      `http://runner-b:8787${INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH}`,
    ]));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.targets)).toBe(true);
    expect(snapshot.targets.every(Object.isFrozen)).toBe(true);
    await registry.close();
  });

  it("fails closed on mixed activation, missing private ACK and duplicate process identity", async () => {
    let mode: "mixed" | "missing-ack" | "missing-no-store" | "duplicate" = "mixed";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const host = new URL(url).hostname;
      if (url.endsWith("/readyz")) return new Response("ready");
      if (url.endsWith("/v1/capabilities")) {
        return Response.json(capability(mode !== "mixed" || host === "runner-a"));
      }
      if (url.endsWith(INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH)) {
        return Response.json({
          protocolVersion: PROTOCOL_VERSION,
          service: "agent-runner",
          capability: TENANT_RUNTIME_DRAIN_V1,
          endpointEnabled: true,
          runnerId: mode === "duplicate" ? "runner-same" : `runner-${host.at(-1)}`,
          bootId: mode === "duplicate" ? "boot-same" : `boot-${host.at(-1)}`,
        }, {
          headers: mode === "missing-ack"
            ? {}
            : {
                [INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER]:
                  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
                ...(mode === "missing-no-store" ? {} : { "cache-control": "no-store" }),
              },
        });
      }
      return new Response(null, { status: 404 });
    }));
    const registry = new RunnerRegistry({
      runners: ["http://runner-a", "http://runner-b"],
      internalRouterToken: token,
    });
    await expect(registry.freshTenantRuntimeDrainSnapshot()).rejects.toThrow(/incompatible/);
    mode = "missing-ack";
    await expect(registry.freshTenantRuntimeDrainSnapshot()).rejects.toThrow(/attest/);
    mode = "missing-no-store";
    await expect(registry.freshTenantRuntimeDrainSnapshot()).rejects.toThrow(/attest/);
    mode = "duplicate";
    await expect(registry.freshTenantRuntimeDrainSnapshot()).rejects.toThrow(/not unique/);
    await registry.close();
  });
});
