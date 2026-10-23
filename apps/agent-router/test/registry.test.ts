import { createServer, request as nativeHttpRequest, type Server } from "node:http";
import type { Socket } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createRouterApp } from "../src/app.js";
import { INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_ERASURE_JOB_CONTROL_READY_PATH, INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER, INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE } from "@agent-service/protocol";
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
  TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
  TENANT_CREDENTIAL_REVOCATION_STORE_V1,
  TENANT_CREDENTIAL_TARGET_EXECUTION_EXTERNAL_V1,
  TENANT_ERASURE_PLATFORM_CONTROL_V1,
  TENANT_BACKUP_CATALOG_AUTHORITATIVE_V1,
  TENANT_RESTORE_JOURNAL_INDEPENDENT_V1,
  TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
  TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1,
  TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
  TENANT_RUNTIME_DRAIN_V1,
  TRACEPARENT_HEADER,
  USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
  parseTraceparent,
  tenantRuntimeFleetSha256,
  tenantRuntimeTargetSha256,
} from "@agent-service/protocol";
import { RunnerRegistry } from "../src/registry.js";
import type { BlobStorageCapability } from "@agent-service/protocol";

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
  it.each(["mcp", "skills", "hooks"] as const)("intersects %s across every configured runner instead of only the healthy subset", async (feature) => {
    let secondState: "active" | "missing" | "stale" | "unhealthy" | "empty" = "active";
    const supports = (registry: RunnerRegistry) => feature === "mcp" ? registry.allConfiguredSupportMcp()
      : feature === "skills" ? registry.allConfiguredSupportSkills() : registry.allConfiguredSupportHooks();
    const supportedValue = feature === "mcp" ? ["streamable-http"] : true;
    const unsupportedValue = feature === "mcp" ? [] : false;
    const capabilities = (supported: boolean, protocolVersion: string = PROTOCOL_VERSION) => ({
      protocolVersion,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        dynamicTools: true,
        mcp: feature === "mcp" && supported ? ["streamable-http"] : [],
        skills: feature === "skills" && supported,
        hooks: feature === "hooks" && supported,
        sandbox: ["none"],
        byok: true,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "http://current/readyz") return new Response("ready");
      if (url === "http://current/v1/capabilities") return Response.json(capabilities(true));
      if (url === "http://second/readyz") {
        return new Response(secondState === "unhealthy" ? "down" : "ready", {
          status: secondState === "unhealthy" ? 503 : 200,
        });
      }
      if (url === "http://second/v1/capabilities") {
        if (secondState === "missing") return new Response("not found", { status: 404 });
        return Response.json(capabilities(secondState !== "empty",
          secondState === "stale" ? "2026-09-22" : PROTOCOL_VERSION));
      }
      return new Response("not found", { status: 404 });
    }));
    const empty = new RunnerRegistry({ runners: [] });
    expect(supports(empty)).toBe(false);
    await empty.close();
    const registry = new RunnerRegistry({ runners: ["http://current", "http://second"], healthIntervalMs: 60_000 });
    try {
      // Configured but as-yet unobserved targets are not a supporting fleet.
      expect(supports(registry)).toBe(false);
      registry.start();
      await registry.waitForFirstProbe();
      expect(supports(registry)).toBe(true);
      for (const state of ["missing", "stale", "unhealthy", "empty"] as const) {
        secondState = "active";
        await registry.refresh();
        expect(registry.list().every(target => target.healthy)).toBe(true);
        expect(supports(registry)).toBe(true);
        secondState = state;
        await registry.refresh();
        const first = registry.list().find(target => target.url === "http://current");
        const second = registry.list().find(target => target.url === "http://second");
        expect(first?.healthy, state).toBe(true);
        expect(first?.capabilities?.features[feature], state).toEqual(supportedValue);
        expect(second?.healthy, state).toBe(state === "empty");
        // An older successful observation must not survive a failed/missing or
        // stale-protocol probe; explicit []/false remains healthy but unsupported.
        expect(second?.capabilities?.features[feature], state).toEqual(state === "empty" ? unsupportedValue : undefined);
        expect(supports(registry), state).toBe(false);
      }
      secondState = "active";
      await registry.refresh();
      expect(supports(registry)).toBe(true);
    } finally { await registry.close(); }
  });

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

  it("rejects a healthy shared-Blob fleet when any configured runner has another namespace", async () => {
    const expected: BlobStorageCapability = {
      backend: `s3-v1-${"a".repeat(24)}`,
      shared: true,
      namespaceSha256: "a".repeat(64),
      controlGeneration: 1,
    };
    const mismatched: BlobStorageCapability = {
      backend: `s3-v1-${"b".repeat(24)}`,
      shared: true,
      namespaceSha256: "b".repeat(64),
      controlGeneration: 1,
    };
    const document = (blobStorage: BlobStorageCapability) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        blobAttachments: true,
        blobStorage,
        userDataExport: [USER_DATA_EXPORT_ARTIFACT_NDJSON_V1],
        dataExportRequests: true,
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
      if (url.startsWith("http://runner-a/")) return Response.json(document(expected));
      if (url.startsWith("http://runner-b/")) return Response.json(document(mismatched));
      return new Response("not found", { status: 404 });
    }));
    const registry = new RunnerRegistry({
      runners: ["http://runner-a", "http://runner-b"],
      blobStorage: expected,
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();

    expect(registry.supportsBlobAttachments("http://runner-a")).toBe(true);
    expect(registry.supportsBlobAttachments("http://runner-b")).toBe(false);
    expect(registry.allHealthySupportBlobAttachments()).toBe(false);
    expect(registry.allHealthySupportUserDataExport()).toBe(false);
    expect(registry.allConfiguredSupportUserDataExportAdmission()).toBe(false);
    await registry.close();
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
      | "malformed" | "no-body" | "wrong-service" | "capability-transport" = "down";
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
        if (legacyState === "no-body") return new Response(null, { status: 204 });
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

    // Pure transport cannot manufacture an initial sticky observation.
    legacyState = "capability-transport";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
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

    // A reset after readiness but before capability headers is a network outage, not a downgrade.
    legacyState = "capability-transport";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.list().find((target) => target.url === "http://legacy")?.healthy).toBe(false);
    expect(registry.allConfiguredSupportDataErasureRequests()).toBe(false);
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
      "no-body",
      "wrong-service",
    ] as const) {
      legacyState = "upgraded";
      await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);
      legacyState = incompatible;
      await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
      expect(registry.allConfiguredSupportErasureJobControl(), incompatible).toBe(false);
    }
    // Transport failure cannot restore evidence revoked by an explicit incompatible response.
    legacyState = "capability-transport";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);

    // A later readiness outage cannot restore revoked evidence; only a fresh full probe can.
    legacyState = "down";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);
    legacyState = "upgraded";
    await (registry as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);
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
    let legacyState: "down" | "legacy" | "old-ledger" | "tracking-inactive" | "code-only" | "active" = "down";
    const capabilities = (
      aware: boolean,
      worker: boolean,
      lifecycleAware: boolean,
      trackingActive: boolean,
    ) => ({
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
        tenantCredentialLifecycle: lifecycleAware
          ? [TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1]
          : [],
        tenantCredentialLifecycleTrackingActive: trackingActive,
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
        return Response.json(capabilities(true, true, true, true));
      }
      if (url.startsWith("http://legacy/readyz")) {
        return legacyState === "down"
          ? new Response("down", { status: 503 })
          : new Response("ready");
      }
      if (url.startsWith("http://legacy/v1/capabilities")) {
        return Response.json(capabilities(
          legacyState !== "legacy",
          legacyState === "tracking-inactive" || legacyState === "active",
          legacyState !== "legacy" && legacyState !== "old-ledger",
          legacyState === "code-only" || legacyState === "active",
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
    expect(registry.allConfiguredSupportTenantCredentialLifecycle()).toBe(false);
    expect(registry.allConfiguredTenantCredentialLifecycleTrackingActive()).toBe(false);
    expect(registry.allConfiguredSupportTenantCredentialRevocationWorker()).toBe(false);

    legacyState = "legacy";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialRevocation()).toBe(false);
    expect(registry.allConfiguredSupportTenantCredentialRevocationWorker()).toBe(false);

    legacyState = "old-ledger";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialRevocation()).toBe(true);
    expect(registry.allConfiguredSupportTenantCredentialLifecycle()).toBe(false);
    expect(registry.allConfiguredSupportTenantCredentialRevocationWorker()).toBe(false);

    legacyState = "tracking-inactive";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialLifecycle()).toBe(true);
    expect(registry.allConfiguredTenantCredentialLifecycleTrackingActive()).toBe(false);
    expect(registry.allConfiguredSupportTenantCredentialRevocationWorker()).toBe(false);

    legacyState = "code-only";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialRevocation()).toBe(true);
    expect(registry.allConfiguredSupportTenantCredentialLifecycle()).toBe(true);
    expect(registry.allConfiguredTenantCredentialLifecycleTrackingActive()).toBe(true);
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

  it("requires every configured runner for external credential target execution", async () => {
    let legacyState: "down" | "legacy" | "tracking-inactive" | "code-only" | "active" = "down";
    const capabilities = (aware: boolean, worker: boolean, trackingActive: boolean) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        tenantCredentialLifecycle: [TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1],
        tenantCredentialLifecycleTrackingActive: trackingActive,
        tenantCredentialTargetExecution: aware
          ? [TENANT_CREDENTIAL_TARGET_EXECUTION_EXTERNAL_V1]
          : [],
        tenantCredentialTargetExecutionWorker: worker,
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
        return Response.json(capabilities(true, true, true));
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
          legacyState !== "tracking-inactive" && legacyState !== "legacy",
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
    expect(registry.allConfiguredSupportTenantCredentialTargetExecution()).toBe(false);
    expect(registry.allConfiguredSupportTenantCredentialTargetExecutionWorker()).toBe(false);

    for (const state of ["legacy", "tracking-inactive", "code-only"] as const) {
      legacyState = state;
      await registry.refresh();
      expect(registry.allConfiguredSupportTenantCredentialTargetExecution(), state)
        .toBe(state === "code-only");
      expect(registry.allConfiguredSupportTenantCredentialTargetExecutionWorker(), state)
        .toBe(false);
    }
    legacyState = "active";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialTargetExecution()).toBe(true);
    expect(registry.allConfiguredSupportTenantCredentialTargetExecutionWorker()).toBe(true);
    legacyState = "down";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantCredentialTargetExecution()).toBe(false);
    expect(registry.allConfiguredSupportTenantCredentialTargetExecutionWorker()).toBe(false);
    await registry.close();
  });

  it("requires every configured runner to match the restore-journal target identity", async () => {
    const namespaceSha256 = "a".repeat(64);
    const targetRootSha256 = "b".repeat(64);
    const runtimeEpochSha256 = "c".repeat(64);
    let legacyState:
      | "down"
      | "legacy"
      | "namespace-mismatch"
      | "target-mismatch"
      | "epoch-mismatch"
      | "code-only"
      | "active" = "down";
    const capabilities = (
      aware: boolean,
      worker: boolean,
      namespace = namespaceSha256,
      targetRoot = targetRootSha256,
      runtimeEpoch = runtimeEpochSha256,
    ) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        tenantRestoreJournal: aware ? [TENANT_RESTORE_JOURNAL_INDEPENDENT_V1] : [],
        tenantRestoreJournalWorker: worker,
        tenantRestoreJournalNamespaceSha256: aware ? namespace : null,
        tenantRestoreJournalTargetRootSha256: aware ? targetRoot : null,
        tenantRestoreRuntimeEpochSha256: aware ? runtimeEpoch : null,
        dataPurgeExecution: false,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
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
        if (legacyState === "legacy") return Response.json(capabilities(false, false));
        if (legacyState === "namespace-mismatch") {
          return Response.json(capabilities(true, true, "c".repeat(64), targetRootSha256));
        }
        if (legacyState === "target-mismatch") {
          return Response.json(capabilities(
            true,
            true,
            namespaceSha256,
            "d".repeat(64),
          ));
        }
        if (legacyState === "epoch-mismatch") {
          return Response.json(capabilities(
            true,
            true,
            namespaceSha256,
            targetRootSha256,
            "e".repeat(64),
          ));
        }
        return Response.json(capabilities(
          legacyState === "code-only" || legacyState === "active",
          legacyState === "active",
        ));
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      restoreJournalNamespaceSha256: namespaceSha256,
      restoreJournalTargetRootSha256: targetRootSha256,
      restoreRuntimeEpochSha256: runtimeEpochSha256,
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();
    expect(registry.allConfiguredSupportTenantRestoreJournal()).toBe(false);
    expect(registry.allConfiguredSupportTenantRestoreJournalWorker()).toBe(false);

    for (const state of [
      "legacy",
      "namespace-mismatch",
      "target-mismatch",
      "epoch-mismatch",
    ] as const) {
      legacyState = state;
      await registry.refresh();
      expect(registry.allConfiguredSupportTenantRestoreJournal(), state).toBe(false);
      expect(registry.allConfiguredSupportTenantRestoreJournalWorker(), state).toBe(false);
      expect(registry.list().find((target) => target.url === "http://legacy")?.healthy, state)
        .toBe(false);
      expect(registry.routeableUrl("legacy"), state).toBeUndefined();
      expect(registry.anyHealthy(), state).toBe("http://current");
    }
    legacyState = "code-only";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantRestoreJournal()).toBe(true);
    expect(registry.allConfiguredSupportTenantRestoreJournalWorker()).toBe(false);
    legacyState = "active";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantRestoreJournal()).toBe(true);
    expect(registry.allConfiguredSupportTenantRestoreJournalWorker()).toBe(true);
    legacyState = "down";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantRestoreJournal()).toBe(false);
    await registry.close();

    // A router which has not entered this rollout accepts old and new runners for ordinary traffic,
    // but it cannot emit restore-journal authority without an explicit expected fleet identity.
    legacyState = "legacy";
    const unconfigured = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    unconfigured.start();
    await unconfigured.waitForFirstProbe();
    expect(unconfigured.list().every((target) => target.healthy)).toBe(true);
    expect(unconfigured.allConfiguredSupportTenantRestoreJournal()).toBe(false);
    expect(unconfigured.allConfiguredSupportTenantRestoreJournalWorker()).toBe(false);
    await unconfigured.close();

    expect(fetchMock.mock.calls.every((call) => (
      (call[1] as RequestInit | undefined)?.redirect === "manual"
    ))).toBe(true);
  });

  it("requires fresh all-runner backup-catalog awareness and exact active lineage consensus", async () => {
    const namespaceSha256 = "1".repeat(64);
    const targetSha256 = "2".repeat(64);
    const runtimeBindingSha256 = "3".repeat(64);
    let legacyState: "down" | "legacy" | "inactive" | "mismatch" | "active" = "down";
    const capabilities = (
      aware: boolean,
      active: boolean,
      namespace = namespaceSha256,
    ) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive"],
        tenantBackupCatalog: aware ? [TENANT_BACKUP_CATALOG_AUTHORITATIVE_V1] : [],
        tenantBackupCatalogActive: aware && active,
        tenantBackupCatalogNamespaceSha256: aware && active ? namespace : null,
        tenantBackupCatalogTargetSha256: aware && active ? targetSha256 : null,
        tenantBackupCatalogRuntimeBindingSha256: aware && active
          ? runtimeBindingSha256
          : null,
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
        if (legacyState === "legacy") return Response.json(capabilities(false, false));
        if (legacyState === "inactive") return Response.json(capabilities(true, false));
        if (legacyState === "mismatch") {
          return Response.json(capabilities(true, true, "4".repeat(64)));
        }
        return Response.json(capabilities(true, true));
      }
      return new Response("not found", { status: 404 });
    }));
    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();
    expect(registry.allConfiguredSupportTenantBackupCatalog()).toBe(false);
    expect(registry.tenantBackupCatalogConsensus().active).toBe(false);

    legacyState = "legacy";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantBackupCatalog()).toBe(false);
    legacyState = "inactive";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantBackupCatalog()).toBe(true);
    expect(registry.tenantBackupCatalogConsensus()).toEqual({
      active: false,
      namespaceSha256: null,
      targetSha256: null,
      runtimeBindingSha256: null,
    });
    legacyState = "mismatch";
    await registry.refresh();
    expect(registry.tenantBackupCatalogConsensus().active).toBe(false);
    legacyState = "active";
    await registry.refresh();
    expect(registry.tenantBackupCatalogConsensus()).toEqual({
      active: true,
      namespaceSha256,
      targetSha256,
      runtimeBindingSha256,
    });
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

  it("requires every configured runner to target the exact Redis namespace and run T3g", async () => {
    const expectedNamespace = "a".repeat(64);
    let legacyState: "down" | "legacy" | "wrong-namespace" | "code-only" | "active" = "down";
    const capabilities = (aware: boolean, worker: boolean, namespace = expectedNamespace) => ({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        tenantRedisPurge: aware ? [TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1] : [],
        tenantRedisPurgeWorker: worker,
        tenantRedisPurgeNamespaceSha256: aware ? namespace : null,
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
          delete (document.features as Partial<typeof document.features>).tenantRedisPurge;
          delete (document.features as Partial<typeof document.features>).tenantRedisPurgeWorker;
          delete (document.features as Partial<typeof document.features>)
            .tenantRedisPurgeNamespaceSha256;
          return Response.json(document);
        }
        if (legacyState === "wrong-namespace") {
          return Response.json(capabilities(true, true, "b".repeat(64)));
        }
        return Response.json(capabilities(true, legacyState === "active"));
      }
      return new Response("not found", { status: 404 });
    }));

    const registry = new RunnerRegistry({
      runners: ["http://current", "http://legacy"],
      redisNamespaceSha256: expectedNamespace,
      healthIntervalMs: 60_000,
    });
    registry.start();
    await registry.waitForFirstProbe();
    expect(registry.allConfiguredSupportTenantRedisPurge()).toBe(false);
    expect(registry.allConfiguredSupportTenantRedisPurgeWorker()).toBe(false);

    for (const state of ["legacy", "wrong-namespace", "code-only"] as const) {
      legacyState = state;
      await registry.refresh();
      expect(registry.allConfiguredSupportTenantRedisPurge()).toBe(state === "code-only");
      expect(registry.allConfiguredSupportTenantRedisPurgeWorker()).toBe(false);
    }

    legacyState = "active";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantRedisPurge()).toBe(true);
    expect(registry.allConfiguredSupportTenantRedisPurgeWorker()).toBe(true);
    legacyState = "down";
    await registry.refresh();
    expect(registry.allConfiguredSupportTenantRedisPurge()).toBe(false);
    expect(registry.allConfiguredSupportTenantRedisPurgeWorker()).toBe(false);
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
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
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
    expect(fetchMock.mock.calls.every((call) => (
      parseTraceparent(new Headers(call[1]?.headers).get(TRACEPARENT_HEADER)) !== undefined
    ))).toBe(true);
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
      expect(parseTraceparent(new Headers(init?.headers).get(TRACEPARENT_HEADER))).toBeDefined();
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


describe("RunnerRegistry real HTTP queue-gate transport classification", () => {
  it("retains only seeded queue authority across a real capability socket reset and never revives an explicit 404", async ({ signal }) => {
    const token = "queue-gate-native-private-test-token-0001";
    const sockets = new Map<Socket, Promise<void>>();
    const servers: Server[] = [];
    const registries: RunnerRegistry[] = [];
    const nativeWork: Promise<unknown>[] = [];
    const bodyReads: Promise<unknown>[] = [], releaseBodies: (() => void)[] = [], restoreReaders: (() => void)[] = [];
    type CapabilityReader = { readProbeCapabilityBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> };
    let pendingBody: { release(): void } | undefined;
    let bodyReadEntries = 0, bodyReadFailures = 0, bodyReadCompletions = 0;
    const observeCapabilityReader = (registry: RunnerRegistry) => {
      const port = registry as unknown as CapabilityReader, original = port.readProbeCapabilityBody;
      const spy = vi.spyOn(port, "readProbeCapabilityBody").mockImplementation(function (this: CapabilityReader, body, readerSignal) {
        const raw = original.call(this, body, readerSignal);
        bodyReads.push(raw, raw.then(() => { bodyReadCompletions++; }, () => { bodyReadFailures++; }));
        if (pendingBody) {
          bodyReadEntries++; const pending = pendingBody; pendingBody = undefined; pending.release();
        }
        return raw; // Exact original reader Promise; reset starts only after this real Response has a reader.
      });
      restoreReaders.push(() => spy.mockRestore());
    };
    let hasError = false, firstError: unknown;
    const remember = (error: unknown) => { if (!hasError) { hasError = true; firstError = error; } };
    const observe = (socket: Socket) => {
      if (!sockets.has(socket)) sockets.set(socket, socket.closed ? Promise.resolve()
        : new Promise<void>(resolve => socket.once("close", () => resolve())));
    };
    const ownServer = (server: Server) => {
      servers.push(server); server.on("connection", observe); server.on("error", remember); return server;
    };
    const listen = (server: Server): Promise<string> => {
      const work = new Promise<string>((resolve, reject) => {
        const failed = (error: Error) => { server.off("listening", ready); reject(error); };
        const ready = () => {
          server.off("error", failed);
          const address = server.address();
          if (!address || typeof address === "string") return reject(new Error("native queue fixture address unavailable"));
          resolve("http://127.0.0.1:" + address.port);
        };
        server.once("error", failed); server.once("listening", ready);
        server.listen(0, "127.0.0.1");
      });
      nativeWork.push(work); void work.catch(() => {}); return work;
    };
    const request = (origin: string, method: "GET" | "POST", pathname: string) => {
      signal.throwIfAborted();
      const work = new Promise<{ status: number; ack: string | undefined }>((resolve, reject) => {
        const outgoing = nativeHttpRequest(new URL(pathname, origin), {
          method, agent: false, signal, headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token },
        }, response => {
          response.once("error", reject);
          response.once("aborted", () => reject(new Error("native queue response aborted")));
          response.once("end", () => resolve({ status: response.statusCode ?? 0,
            ack: typeof response.headers[INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER.toLowerCase()] === "string"
              ? response.headers[INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER.toLowerCase()] as string : undefined }));
          response.resume();
        });
        outgoing.on("socket", observe); outgoing.once("error", reject);
        nativeWork.push(new Promise<void>(resolve => outgoing.once("close", () => resolve())));
        outgoing.end();
      });
      nativeWork.push(work); void work.catch(() => {}); return work;
    };
    const abort = () => {
      for (const release of releaseBodies) release();
      for (const socket of sockets.keys()) { try { socket.destroy(); } catch (error) { remember(error); } }
    };
    signal.addEventListener("abort", abort, { once: true });
    let mode: "valid" | "capability-reset" | "body-reset" | "malformed" | "missing" | "down" = "valid";
    let readyResponses = 0, capabilityResets = 0, forwardedMutations = 0;
    const capabilities = { protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
      streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true,
      sessionLifecycle: ["archive", "unarchive", "tombstone"], blobAttachments: true,
      dataErasureRequests: true, dataGovernance: DATA_GOVERNANCE_V1,
      userErasureWorker: ["drain-v1"], erasureJobControl: JOB_CONTROL_V2,
      dynamicTools: true, mcp: [], skills: false, sandbox: ["none"], byok: true,
    } };
    try {
      signal.throwIfAborted();
      const runner = ownServer(createServer((incoming, response) => {
        response.setHeader("connection", "close");
        if (incoming.url === "/readyz") {
          if (mode === "down") { response.writeHead(503).end(); return; }
          readyResponses++; response.writeHead(200).end(); return;
        }
        if (incoming.url === "/v1/capabilities") {
          if (mode === "capability-reset") { capabilityResets++; incoming.socket.destroy(); return; }
          if (mode === "missing") { response.writeHead(404).end(); return; }
          response.setHeader("content-type", "application/json");
          if (mode === "body-reset") {
            if (pendingBody) { remember(new Error("native queue fixture body overlap")); response.destroy(); return; }
            let release!: () => void;
            const released = new Promise<void>(resolve => { release = resolve; });
            releaseBodies.push(release); pendingBody = { release };
            response.writeHead(200); response.flushHeaders(); response.write('{"protocolVersion":');
            const resetting = released.then(() => incoming.socket.destroy());
            nativeWork.push(resetting); void resetting.catch(remember); return;
          }
          if (mode === "malformed") { response.end('{"protocolVersion":'); return; }
          response.end(JSON.stringify(capabilities)); return;
        }
        if (incoming.method === "POST") forwardedMutations++;
        response.writeHead(404).end();
      }));
      const runnerOrigin = await listen(runner);
      const registry = new RunnerRegistry({ runners: [runnerOrigin], internalRouterToken: token });
      registries.push(registry); observeCapabilityReader(registry);
      const routerListener = getRequestListener(createRouterApp({ registry,
        internalRunnerToken: token, erasureRequestsEnabled: () => true }).fetch);
      const router = ownServer(createServer((incoming, response) => {
        const raw = routerListener(incoming, response); nativeWork.push(raw);
        void raw.catch(error => { remember(error); response.destroy(); });
      }));
      const routerOrigin = await listen(router);
      await registry.refresh(); signal.throwIfAborted();
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);
      expect(registry.allConfiguredSupportDataErasureRequests()).toBe(true);
      expect(await request(routerOrigin, "GET", INTERNAL_ERASURE_JOB_CONTROL_READY_PATH))
        .toEqual({ status: 204, ack: INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE });
      const readyBefore = readyResponses;
      mode = "capability-reset";
      await registry.refresh(); signal.throwIfAborted();
      expect(readyResponses).toBe(readyBefore + 1);
      expect(capabilityResets).toBe(1);
      expect(registry.list()[0]?.healthy).toBe(false);
      expect(registry.list()[0]?.capabilities).toBeUndefined();
      expect(registry.allConfiguredSupportDataErasureRequests()).toBe(false);
      // Retain only the earlier fully validated queue observation on this pure transport failure.
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);
      expect(await request(routerOrigin, "GET", INTERNAL_ERASURE_JOB_CONTROL_READY_PATH))
        .toEqual({ status: 204, ack: INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE });
      expect((await request(routerOrigin, "POST", "/v1/data-erasure-requests")).status).toBe(503);
      expect(forwardedMutations).toBe(0);
      const unknown = new RunnerRegistry({ runners: [runnerOrigin], internalRouterToken: token });
      registries.push(unknown); observeCapabilityReader(unknown);
      await unknown.refresh(); signal.throwIfAborted();
      expect(unknown.allConfiguredSupportErasureJobControl()).toBe(false);
      mode = "body-reset";
      const entriesBefore = bodyReadEntries, failuresBefore = bodyReadFailures;
      await registry.refresh(); signal.throwIfAborted();
      expect(bodyReadEntries).toBe(entriesBefore + 1);
      expect(bodyReadFailures).toBe(failuresBefore + 1);
      expect(registry.list()[0]?.healthy).toBe(false);
      expect(registry.list()[0]?.capabilities).toBeUndefined();
      expect(registry.allConfiguredSupportDataErasureRequests()).toBe(false);
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);
      expect(await request(routerOrigin, "GET", INTERNAL_ERASURE_JOB_CONTROL_READY_PATH))
        .toEqual({ status: 204, ack: INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE });
      expect((await request(routerOrigin, "POST", "/v1/data-erasure-requests")).status).toBe(503);
      expect(forwardedMutations).toBe(0);
      await unknown.refresh(); signal.throwIfAborted();
      expect(bodyReadEntries).toBe(entriesBefore + 2);
      expect(unknown.allConfiguredSupportErasureJobControl()).toBe(false);
      mode = "malformed";
      const completedBefore = bodyReadCompletions;
      await registry.refresh(); signal.throwIfAborted();
      expect(bodyReadCompletions).toBe(completedBefore + 1);
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);
      expect((await request(routerOrigin, "GET", INTERNAL_ERASURE_JOB_CONTROL_READY_PATH)).status).toBe(503);
      mode = "body-reset";
      await registry.refresh(); signal.throwIfAborted();
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);
      mode = "valid";
      await registry.refresh(); signal.throwIfAborted();
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(true);
      mode = "missing";
      await registry.refresh(); signal.throwIfAborted();
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);
      expect((await request(routerOrigin, "GET", INTERNAL_ERASURE_JOB_CONTROL_READY_PATH)).status).toBe(503);
      mode = "body-reset";
      await registry.refresh(); signal.throwIfAborted();
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);
      expect((await request(routerOrigin, "GET", INTERNAL_ERASURE_JOB_CONTROL_READY_PATH)).status).toBe(503);
      mode = "capability-reset";
      await registry.refresh(); signal.throwIfAborted();
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);
      expect((await request(routerOrigin, "GET", INTERNAL_ERASURE_JOB_CONTROL_READY_PATH)).status).toBe(503);
      mode = "down";
      await registry.refresh(); signal.throwIfAborted();
      expect(registry.allConfiguredSupportErasureJobControl()).toBe(false);
      expect((await request(routerOrigin, "GET", INTERNAL_ERASURE_JOB_CONTROL_READY_PATH)).status).toBe(503);
    } catch (error) { remember(error); }
    finally {
      for (const release of releaseBodies) release();
      const registryCloses = await Promise.allSettled(registries.map(registry => registry.close()));
      for (const result of registryCloses) if (result.status === "rejected") remember(result.reason);
      for (const server of servers) {
        try {
          const closing = server.listening ? new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
          }) : Promise.resolve();
          server.closeAllConnections(); await closing;
        } catch (error) { remember(error); }
      }
      abort();
      const settled = await Promise.allSettled(nativeWork);
      for (const result of settled) if (result.status === "rejected") remember(result.reason);
      await Promise.all(sockets.values());
      await Promise.allSettled(bodyReads); // Expected transport failures were consumed by the actual registry probe.
      for (const restore of restoreReaders) { try { restore(); } catch (error) { remember(error); } }
      signal.removeEventListener("abort", abort);
    }
    if (hasError) throw firstError;
  });
});
