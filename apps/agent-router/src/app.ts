import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  Capabilities,
  DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
  DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
  INTERNAL_ERASURE_DRAIN_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_ACK_VALUE,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE,
  INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX,
  INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX,
  INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER,
  INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE,
  INTERNAL_ERASURE_JOB_CONTROL_READY_PATH,
  INTERNAL_ERASURE_JOB_CONTROL_V1_READY_PATH,
  INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER,
  INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE,
  INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH,
  INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ADMISSION_ACK_VALUE,
  INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH,
  INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER,
  INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_HEADER,
  INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_VALUE,
  INTERNAL_TENANT_CREDENTIAL_REVOCATION_READY_PATH,
  INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_VALUE,
  INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_READY_PATH,
  INTERNAL_TENANT_RESTORE_JOURNAL_ACK_HEADER,
  INTERNAL_TENANT_RESTORE_JOURNAL_ACK_VALUE,
  INTERNAL_TENANT_RESTORE_JOURNAL_READY_PATH,
  INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER,
  INTERNAL_TENANT_DATABASE_PURGE_ACK_VALUE,
  INTERNAL_TENANT_DATABASE_PURGE_READY_PATH,
  INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER,
  INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE,
  INTERNAL_TENANT_REDIS_PURGE_READY_PATH,
  INTERNAL_TENANT_PURGE_EXECUTION_ACK_HEADER,
  INTERNAL_TENANT_PURGE_EXECUTION_ACK_VALUE,
  INTERNAL_TENANT_PURGE_EXECUTION_READY_PATH,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
  INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH,
  INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH,
  INTERNAL_TENANT_ERASURE_ACTOR_HEADER,
  INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX,
  INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_REPLAY_ACK_VALUE,
  INTERNAL_TENANT_ERASURE_REPLAY_PATH,
  INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE,
  INTERNAL_TOMBSTONE_ACK_HEADER,
  INTERNAL_TOMBSTONE_ACK_VALUE,
  INTERNAL_TOMBSTONE_PATH_PREFIX,
  INTERNAL_ROUTER_TOKEN_HEADER,
  OPENAPI_DOCUMENT,
  PROTOCOL_VERSION,
  PURGE_POLICY_EVALUATOR_V1,
  TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
  TENANT_CREDENTIAL_REVOCATION_STORE_V1,
  TENANT_CREDENTIAL_TARGET_EXECUTION_EXTERNAL_V1,
  TENANT_ERASURE_PLATFORM_CONTROL_V1,
  TENANT_RESTORE_JOURNAL_INDEPENDENT_V1,
  TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
  TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1,
  TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
  TenantErasureCreateRequest,
  TenantErasureRequest,
  TenantErasureRequestHeaders,
  TenantErasureRequestParams,
  TenantErasureRequestQuery,
  TenantRuntimeDrainRequest,
  TenantRuntimeDrainRunnerRequest,
  TenantRuntimeRevocationFleetProof,
  TenantRuntimeRevocationLocalReceipt,
  USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
  UserErasureDrainRequest,
  isCanonicalId,
  tenantRuntimeFleetSha256,
  tenantRuntimeTargetReceiptsSha256,
} from "@agent-service/protocol";
import type { RunnerRegistry } from "./registry.js";

export interface RouterAppDeps {
  registry: RunnerRegistry;
  /** total attempts per request, including the first (2 = one re-route on 409) */
  maxAttempts?: number;
  /** cap on waiting for the upstream RESPONSE HEADERS; never applied to the body (SSE runs for minutes) */
  upstreamHeaderTimeoutMs?: number;
  /** reject a request body larger than this before forwarding anything */
  maxBodyBytes?: number;
  /** separate raw-binary ceiling for the blob upload route */
  maxBlobBytes?: number;
  /** when set, `/_router/*` requires `Authorization: Bearer <token>`; when unset those routes are off */
  adminToken?: string;
  /** false once draining, so the load balancer stops sending new work */
  ready?: () => boolean;
  /** Explicit deployment activation gate, in addition to the observed fleet capability. */
  tombstoneEnabled?: () => boolean;
  /** Explicit deployment activation gate for new blob writes. Blob reads remain available. */
  blobAttachmentsEnabled?: () => boolean;
  /** Explicit deployment activation gate for the subject-level durable write barrier. */
  erasureRequestsEnabled?: () => boolean;
  /** Router-only platform credential. It is consumed here and never forwarded to a runner. */
  tenantErasureOperatorToken?: string;
  /** Stable non-secret platform principal injected only beside the runner-internal credential. */
  tenantErasureOperatorId?: string;
  /** Independent admission gate; status/replay remain readable while it is closed. */
  tenantErasureRequestsEnabled?: () => boolean;
  /** Explicit fleet activation gate for canonical policy/legal-hold administration. */
  dataGovernanceManagementEnabled?: () => boolean;
  /** Independent activation gate for non-destructive policy evaluation queue claims. */
  purgePolicyEvaluatorEnabled?: () => boolean;
  /** Independent activation gate for tenant credential-store revocation queue claims. */
  tenantCredentialRevocationExecutionEnabled?: () => boolean;
  /** Independent deployment acknowledgement for the durable credential tracking cutover. */
  credentialLifecycleTrackingEnabled?: () => boolean;
  /** Independent fleet gate for external credential target execution. */
  tenantCredentialTargetExecutionEnabled?: () => boolean;
  /** Independent fleet gate for publishing the pre-destructive restore journal. */
  tenantRestoreJournalExecutionEnabled?: () => boolean;
  /** Independent activation gate for local T3e execution/physical-ACK queue claims. */
  tenantPurgeExecutionEnabled?: () => boolean;
  /** Independent activation gate for T3f local database-content deletion queue claims. */
  tenantDatabasePurgeEnabled?: () => boolean;
  /** Independent activation gate for T3g Redis session-state deletion queue claims. */
  tenantRedisPurgeEnabled?: () => boolean;
  /** Expected content-free namespace identity projected only after all runners match it. */
  tenantRedisPurgeNamespaceSha256?: string;
  /** Independent all-configured broadcast gate for T3b runtime drain. */
  tenantRuntimeDrainExecutionEnabled?: () => boolean;
  /** Read/download surface for the configured artifact backend. Filesystem stays local-only. */
  dataExportArtifactsEnabled?: () => boolean;
  /** Additive fleet admission gate; status/download remain available while it is closed. */
  dataExportRequestsEnabled?: () => boolean;
  /** Shared runner-internal credential. Omission keeps destructive routing disabled. */
  internalRunnerToken?: string;
  /** Injectable transport for the all-configured T3b broadcast. */
  fetchImpl?: typeof globalThis.fetch;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * `/v1/sessions/{id}/...` — the session id decides the target runner.
 *
 * The segment is captured loosely and then checked for the canonical shape. A case-sensitive pattern
 * here would let `SESS_…` fall through to "no session id", scattering requests for one session across
 * runners while the runner still resolved them to the same row.
 */
const SESSION_PATH = /^\/v1\/sessions\/([^/]+)(\/|$)/;

function sessionIdFrom(pathname: string): string | undefined {
  const raw = SESSION_PATH.exec(pathname)?.[1];
  if (!raw) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return isCanonicalId("sess", id) ? id : undefined;
}

/** Hop-by-hop headers must not be forwarded, and the upstream sets its own content headers. */
const STRIP_REQUEST = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "te", "content-length", INTERNAL_ROUTER_TOKEN_HEADER]);
/** `x-owner` is internal topology: the runner needs it, an external client must not see it. */
const STRIP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "x-owner",
  INTERNAL_TOMBSTONE_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER,
  INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER,
  INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER,
  INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER,
  INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_HEADER,
  INTERNAL_TENANT_RESTORE_JOURNAL_ACK_HEADER,
  INTERNAL_TENANT_PURGE_EXECUTION_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER,
]);

/** Methods that are safe to send again after a transport failure, with no risk of doing the work twice. */
const REPLAYABLE = new Set(["GET", "HEAD", "OPTIONS"]);
/** The runner currently implements Idempotency-Key only for this collection POST. */
const IDEMPOTENT_TURN_POST = /^\/v1\/sessions\/[^/]+\/turns\/?$/;
/** Fenced tombstoning is idempotent even when the first 204 was lost in transit. */
const IDEMPOTENT_SESSION_DELETE = /^\/v1\/sessions\/[^/]+\/?$/;
const SESSION_BLOB_UPLOAD = /^\/v1\/sessions\/[^/]+\/blobs\/?$/;
const USER_ERASURE_REQUEST = /^\/v1\/data-erasure-requests\/?$/;
const USER_ERASURE_STATUS = /^\/v1\/data-erasure-requests\/[^/]+\/?$/;
const USER_DATA_EXPORT_REQUEST = /^\/v1\/data-export-requests\/?$/;
const USER_DATA_EXPORT_STATUS = /^\/v1\/data-export-requests\/[^/]+\/?$/;
const USER_DATA_EXPORT_DOWNLOAD = /^\/v1\/data-export-requests\/[^/]+\/download\/?$/;
const TENANT_ERASURE_PUBLIC_COLLECTION = "/v1/tenant-erasure-requests";
const DATA_GOVERNANCE_MANAGEMENT = /^\/v1\/(?:retention-policies|legal-holds)(?:\/|$)/;
const USER_SCOPED_RUNTIME = /^\/v1\/(?:sessions(?:\/|$)|usage\/?$|data-erasure-requests(?:\/|$)|data-export-requests(?:\/|$))/;
const INTERNAL_ERASURE_BODY_MAX_BYTES = 4_096;
const TENANT_ERASURE_RESPONSE_MAX_BYTES = 4_096;
const TENANT_RUNTIME_DRAIN_BODY_MAX_BYTES = 4_096;
const TENANT_RUNTIME_DRAIN_RESPONSE_MAX_BYTES = 8_192;

function internalTokenMatches(received: string | undefined, expected: string | undefined): boolean {
  const left = createHash("sha256").update(received ?? "").digest();
  const right = createHash("sha256").update(expected ?? "").digest();
  return received !== undefined && expected !== undefined && timingSafeEqual(left, right);
}

function bearerTokenMatches(authorization: string | undefined, expected: string | undefined): boolean {
  // RFC 7235 authentication schemes are case-insensitive. Parse the scheme that way so a real
  // platform secret cannot evade the generic-proxy guard merely by spelling `bearer` differently.
  // SP is canonical for HTTP auth, but downstream tenant auth deliberately accepts horizontal
  // whitespace. Match HTAB too so a real platform secret can never escape through that wider parser.
  const received = authorization?.match(/^Bearer[ \t]+([A-Za-z0-9._~-]{32,256})$/i)?.[1];
  if (!received) return false;
  return internalTokenMatches(received, expected);
}

function authorizationContainsBearerToken(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  // Fetch/Node can combine duplicate Authorization fields with commas. Public platform auth stays
  // strict (one credential only), while the generic proxy must detect the protected credential in
  // every combined challenge so it can never reach a runner in a malformed header.
  return authorization?.split(",").some((value) => (
    bearerTokenMatches(value.trim(), expected)
  )) ?? false;
}

/**
 * Reserve the whole tenant-erasure path family even when an HTTP stack preserves percent escapes.
 * Decode ASCII escapes a few layers so encoded letters, separators and double-encoding cannot
 * fall through to the generic tenant proxy. The independent platform-token check below remains the
 * final credential boundary even for deliberately excessive or malformed encoding.
 */
function isTenantErasurePathFamily(pathname: string): boolean {
  let candidate = pathname;
  for (let depth = 0; depth < 8; depth++) {
    if (candidate.startsWith(TENANT_ERASURE_PUBLIC_COLLECTION)) return true;
    const decoded = candidate.replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) => (
      String.fromCharCode(Number.parseInt(hex, 16))
    ));
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  return candidate.startsWith(TENANT_ERASURE_PUBLIC_COLLECTION);
}

function privateInternalHeaders(c: { header: (name: string, value: string) => void }): void {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
}

function internalNotFound(c: { json: (body: object, status: 404) => Response }): Response {
  return c.json({ error: { code: "not_found", message: "not found" } }, 404);
}

/**
 * agent-router is stateless. Tenant service-key authentication remains runner-owned; the one exception
 * is the independent platform bearer for tenant-erasure control, which must be consumed at this edge
 * and replaced with the private runner credential. The router holds no business state.
 */
export function createRouterApp(deps: RouterAppDeps) {
  const app = new Hono();
  const log = deps.logger ?? console;
  const maxAttempts = deps.maxAttempts ?? 2;
  const fetchRuntimeTarget = deps.fetchImpl ?? globalThis.fetch;
  const maxBodyBytes = deps.maxBodyBytes ?? 1_000_000;
  const maxBlobBytes = deps.maxBlobBytes ?? 1_000_000;
  const tombstoneAvailable = () => (
    !!deps.internalRunnerToken
    && (deps.tombstoneEnabled?.() ?? false)
    && deps.registry.allHealthySupportLifecycle("tombstone")
  );
  const blobAttachmentsAvailable = () => (
    (deps.blobAttachmentsEnabled?.() ?? false)
    && deps.registry.allHealthySupportBlobAttachments()
  );
  const erasureWriterGateEnabled = () => deps.erasureRequestsEnabled?.() ?? false;
  const erasureJobControlAvailable = () => (
    !!deps.internalRunnerToken
    && deps.registry.allConfiguredSupportErasureJobControl()
  );
  const erasureRequestsAvailable = () => (
    erasureWriterGateEnabled()
    // Unlike a reversible read, this durable gate must account for unavailable configured writers:
    // an old runner that recovers later could otherwise ignore the already-accepted subject gate.
    && deps.registry.allConfiguredSupportDataErasureRequests()
    // Once a tenant can activate a canonical policy, every possible admission writer must bind it.
    // Old runners may still advertise the earlier erasure bool, so require the additive contract.
    && deps.registry.allConfiguredSupportDataGovernance()
    && erasureJobControlAvailable()
  );
  const dataGovernanceWritersAvailable = () => (
    deps.registry.allConfiguredSupportDataGovernance()
  );
  const dataGovernanceAvailable = () => (
    (deps.dataGovernanceManagementEnabled?.() ?? false)
    && dataGovernanceWritersAvailable()
    && deps.registry.allConfiguredSupportDataGovernanceManagement()
  );
  const purgePolicyEvaluationAvailable = () => (
    !!deps.internalRunnerToken
    && (deps.purgePolicyEvaluatorEnabled?.() ?? false)
    && deps.registry.allConfiguredSupportPurgePolicyEvaluation()
  );
  const tenantCredentialRevocationExecutionAvailable = () => (
    !!deps.internalRunnerToken
    && (deps.tenantCredentialRevocationExecutionEnabled?.() ?? false)
    && (deps.credentialLifecycleTrackingEnabled?.() ?? false)
    && deps.registry.allConfiguredSupportTenantCredentialRevocationWorker()
  );
  const tenantCredentialTargetExecutionAvailable = () => (
    !!deps.internalRunnerToken
    && (deps.tenantCredentialTargetExecutionEnabled?.() ?? false)
    && (deps.credentialLifecycleTrackingEnabled?.() ?? false)
    && deps.registry.allConfiguredSupportTenantCredentialTargetExecutionWorker()
  );
  const tenantRestoreJournalExecutionAvailable = () => (
    !!deps.internalRunnerToken
    && (deps.tenantRestoreJournalExecutionEnabled?.() ?? false)
    && deps.registry.allConfiguredSupportTenantRestoreJournalWorker()
  );
  const tenantPurgeExecutionAvailable = () => (
    !!deps.internalRunnerToken
    && (deps.tenantPurgeExecutionEnabled?.() ?? false)
    && deps.registry.allConfiguredSupportTenantPurgeExecutionWorker()
  );
  const tenantDatabasePurgeAvailable = () => (
    !!deps.internalRunnerToken
    && (deps.tenantDatabasePurgeEnabled?.() ?? false)
    && deps.registry.allConfiguredSupportTenantDatabasePurgeWorker()
  );
  const tenantRedisPurgeAvailable = () => (
    !!deps.internalRunnerToken
    && (deps.tenantRedisPurgeEnabled?.() ?? false)
    && deps.registry.allConfiguredSupportTenantRedisPurgeWorker()
  );
  const userDataExportReadable = () => (
    (deps.dataExportArtifactsEnabled?.() ?? false)
    && deps.registry.allHealthySupportUserDataExport()
  );
  const dataExportRequestsAvailable = () => (
    userDataExportReadable()
    && (deps.dataExportRequestsEnabled?.() ?? false)
    && deps.registry.allConfiguredSupportUserDataExportAdmission()
  );
  const tenantErasureControlAvailable = () => (
    !!deps.internalRunnerToken
    && !!deps.tenantErasureOperatorToken
    && !!deps.tenantErasureOperatorId
    && deps.registry.allHealthySupportTenantErasureControl()
  );
  const tenantErasureAdmissionAvailable = () => (
    tenantErasureControlAvailable()
    && (deps.tenantErasureRequestsEnabled?.() ?? false)
    && deps.registry.allConfiguredSupportTenantErasureControl()
    && deps.registry.allConfiguredSupportTenantErasureAdmission()
  );
  const tenantErasureUnavailable = (c: Context): Response => c.json({
    error: {
      code: "draining",
      message: "tenant erasure control is unavailable while the runner fleet is upgrading",
      retryable: true,
    },
  }, 503);
  const proxyTenantErasureControl = async (
    c: Context,
    input: (
      | {
        mode: "admit";
        body: Uint8Array;
        idempotencyKey: string;
        expectedTenantId: string;
      }
      | {
        mode: "replay";
        body: Uint8Array;
        idempotencyKey: string;
        expectedTenantId: string;
      }
      | {
        mode: "status";
        expectedTenantId: string;
        expectedRequestId: string;
      }
    ),
  ): Promise<Response> => {
    const admission = input.mode === "admit";
    const available = () => admission
      ? tenantErasureAdmissionAvailable()
      : tenantErasureControlAvailable();
    if (!available()) return tenantErasureUnavailable(c);

    const upstreamUrl = new URL(c.req.url);
    upstreamUrl.pathname = input.mode === "admit"
      ? INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX
      : input.mode === "replay"
        ? INTERNAL_TENANT_ERASURE_REPLAY_PATH
        : `${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/${input.expectedRequestId}`;
    upstreamUrl.search = input.mode === "status"
      ? `?tenantId=${encodeURIComponent(input.expectedTenantId)}`
      : "";
    const upstreamHeaders = new Headers({
      [INTERNAL_ROUTER_TOKEN_HEADER]: deps.internalRunnerToken!,
      [INTERNAL_TENANT_ERASURE_ACTOR_HEADER]: deps.tenantErasureOperatorId!,
    });
    if (input.mode !== "status") {
      upstreamHeaders.set("content-type", "application/json");
      upstreamHeaders.set("idempotency-key", input.idempotencyKey);
    }
    const expectedAckHeader = input.mode === "replay"
      ? INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER
      : INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER;
    const expectedAckValue = input.mode === "replay"
      ? INTERNAL_TENANT_ERASURE_REPLAY_ACK_VALUE
      : INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE;
    const expectedSuccessStatus = input.mode === "status" ? 200 : 202;

    const tried = new Set<string>();
    let target = deps.registry.anyHealthy();
    if (!target) return tenantErasureUnavailable(c);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const targetCompatible = admission
        ? deps.registry.supportsTenantErasureAdmission(target)
        : deps.registry.supportsTenantErasureControl(target);
      if (!available() || !targetCompatible) return tenantErasureUnavailable(c);
      tried.add(target);

      let response: Response;
      try {
        response = await forward(
          target,
          upstreamUrl,
          input.mode === "status" ? "GET" : "POST",
          upstreamHeaders,
          input.mode === "status" ? undefined : input.body,
          deps.upstreamHeaderTimeoutMs,
        );
      } catch (error) {
        deps.registry.markFailure(target);
        const name = error instanceof Error ? error.name : "unknown error";
        log.warn(`[router] tenant erasure target unreachable (${name})`);
        const next = pickOther(deps, undefined, tried);
        if (!next || attempt >= maxAttempts) return tenantErasureUnavailable(c);
        target = next;
        continue;
      }

      if (
        response.headers.get(expectedAckHeader)
        !== expectedAckValue
      ) {
        await response.body?.cancel().catch(() => {});
        return tenantErasureUnavailable(c);
      }
      // The ACK proves that this is the private T2 route, not that an incompatible runner still
      // honors the public edge contract. Do not publish an unexpected success status or projection.
      if (response.status < 400) {
        if (response.status !== expectedSuccessStatus) {
          void response.body?.cancel().catch(() => {});
          return tenantErasureUnavailable(c);
        }
        const read = await readCapped(response.body, TENANT_ERASURE_RESPONSE_MAX_BYTES);
        let projection: unknown;
        try {
          if (!read.ok) return tenantErasureUnavailable(c);
          projection = JSON.parse(new TextDecoder().decode(read.bytes));
        } catch {
          return tenantErasureUnavailable(c);
        }
        const parsed = TenantErasureRequest.safeParse(projection);
        if (
          !parsed.success
          || parsed.data.tenantId !== input.expectedTenantId
          || (input.mode === "status" && parsed.data.id !== input.expectedRequestId)
        ) {
          return tenantErasureUnavailable(c);
        }
        response = new Response(read.bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      const result = streamBack(response);
      result.headers.set("Cache-Control", "no-store");
      result.headers.set("X-Content-Type-Options", "nosniff");
      return result;
    }
    return tenantErasureUnavailable(c);
  };

  app.get("/healthz", (c) => c.text("ok"));
  // Serve the immutable contract locally. Forwarding this endpoint would make API discovery depend
  // on fleet health and could expose a mixed-version runner's document during a rolling upgrade.
  app.get("/openapi.json", (c) => c.json(OPENAPI_DOCUMENT));
  app.get("/readyz", (c) => {
    if (deps.ready && !deps.ready()) return c.text("draining", 503);
    const healthy = deps.registry.list().filter((t) => t.healthy).length;
    return healthy > 0 ? c.text(`ready (${healthy} runners)`) : c.text("no healthy runner", 503);
  });
  app.get("/v1/capabilities", async (c) => {
    // Ask a runner rather than hardcoding: the router must not claim capabilities the fleet lacks.
    const target = deps.registry.anyHealthy();
    if (target) {
      try {
        const res = await fetch(`${target}/v1/capabilities`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) {
          // A mixed or malformed runner must not make this router violate the contract it serves at
          // /openapi.json. Deployment still drains old runners before promoting the new router.
          const parsed = Capabilities.safeParse(await res.json());
          if (parsed.success) {
            const lifecycle = parsed.data.features.sessionLifecycle.filter((feature) => (
              // Physical purge is not implemented. Never forward an accidental or stale runner
              // claim, even if every runner reports it during a rolling upgrade.
              feature !== "purge"
              && (feature !== "tombstone" || tombstoneAvailable())
            ));
            return c.json({
              ...parsed.data,
              service: "agent-router",
              features: {
                ...parsed.data.features,
                sessionLifecycle: lifecycle,
                blobAttachments: parsed.data.features.blobAttachments && blobAttachmentsAvailable(),
                dataErasureRequests: parsed.data.features.dataErasureRequests && erasureRequestsAvailable(),
                userErasureWorker: deps.internalRunnerToken
                  && deps.registry.allHealthySupportUserErasureWorker()
                  ? ["drain-v1"]
                  : [],
                // Fleet rollout state is private control-plane information. External callers only
                // need the public dataErasureRequests result; workers use the token-protected ACK.
                erasureJobControl: [],
                dataGovernance: dataGovernanceWritersAvailable()
                  ? [DATA_GOVERNANCE_CANONICAL_RETENTION_V1, DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1]
                  : [],
                dataGovernanceManagement: dataGovernanceAvailable(),
                purgePolicyEvaluation: deps.registry.allConfiguredSupportPurgePolicyEvaluation()
                  ? [PURGE_POLICY_EVALUATOR_V1]
                  : [],
                // Evaluation is evidence only. Destructive execution requires a future, separate
                // protocol and fleet gate; it cannot be enabled by runner input or this barrier.
                dataPurgeExecution: false,
                userDataExport: userDataExportReadable()
                  ? [USER_DATA_EXPORT_ARTIFACT_NDJSON_V1]
                  : [],
                dataExportRequests: dataExportRequestsAvailable(),
                tenantErasureControl: tenantErasureControlAvailable()
                  ? [TENANT_ERASURE_PLATFORM_CONTROL_V1]
                  : [],
                tenantErasureRequests: tenantErasureAdmissionAvailable(),
                tenantCredentialRevocation:
                  deps.registry.allConfiguredSupportTenantCredentialRevocation()
                    ? [TENANT_CREDENTIAL_REVOCATION_STORE_V1]
                    : [],
                tenantCredentialRevocationWorker:
                  tenantCredentialRevocationExecutionAvailable(),
                tenantCredentialLifecycle:
                  deps.registry.allConfiguredSupportTenantCredentialLifecycle()
                    ? [TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1]
                    : [],
                tenantCredentialLifecycleTrackingActive:
                  deps.registry.allConfiguredTenantCredentialLifecycleTrackingActive(),
                tenantCredentialTargetExecution:
                  deps.registry.allConfiguredSupportTenantCredentialTargetExecution()
                    ? [TENANT_CREDENTIAL_TARGET_EXECUTION_EXTERNAL_V1]
                    : [],
                tenantCredentialTargetExecutionWorker:
                  tenantCredentialTargetExecutionAvailable(),
                tenantRestoreJournal:
                  deps.registry.allConfiguredSupportTenantRestoreJournal()
                    ? [TENANT_RESTORE_JOURNAL_INDEPENDENT_V1]
                    : [],
                tenantRestoreJournalWorker:
                  tenantRestoreJournalExecutionAvailable(),
                tenantRestoreJournalNamespaceSha256:
                  deps.registry.allConfiguredSupportTenantRestoreJournal()
                    ? parsed.data.features.tenantRestoreJournalNamespaceSha256
                    : null,
                tenantRestoreJournalTargetRootSha256:
                  deps.registry.allConfiguredSupportTenantRestoreJournal()
                    ? parsed.data.features.tenantRestoreJournalTargetRootSha256
                    : null,
                tenantRestoreRuntimeEpochSha256:
                  deps.registry.allConfiguredSupportTenantRestoreJournal()
                    ? parsed.data.features.tenantRestoreRuntimeEpochSha256
                    : null,
                tenantPurgeExecution:
                  [
                    ...(deps.registry.allConfiguredSupportTenantPurgeExecution()
                      ? [TENANT_PURGE_EXECUTION_LOCAL_ACK_V1]
                      : []),
                    ...(deps.registry.allConfiguredSupportTenantDatabasePurge()
                      ? [TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1]
                      : []),
                  ],
                tenantPurgeExecutionWorker: tenantPurgeExecutionAvailable(),
                tenantDatabasePurgeWorker: tenantDatabasePurgeAvailable(),
                tenantRedisPurge: deps.registry.allConfiguredSupportTenantRedisPurge()
                  ? [TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1]
                  : [],
                tenantRedisPurgeWorker: tenantRedisPurgeAvailable(),
                tenantRedisPurgeNamespaceSha256:
                  deps.registry.allConfiguredSupportTenantRedisPurge()
                    ? (deps.tenantRedisPurgeNamespaceSha256 ?? null)
                    : null,
                // Per-instance runtime identity and activation are private rollout state. The
                // worker consumes the token-protected fleet proof route instead.
                tenantRuntimeDrain: [],
                tenantRuntimeDrainEndpoint: false,
              },
            } satisfies Capabilities);
          }
        }
      } catch {
        /* report unavailable below */
      }
    }
    return c.json({
      error: {
        code: "draining",
        message: `no healthy runner with protocol ${PROTOCOL_VERSION} is available`,
        retryable: true,
      },
    }, 503);
  });

  /**
   * A worker must pass this fleet-wide barrier before every queue claim. Authentication happens
   * before returning any capability state, so an external probe cannot enumerate rollout status.
   */
  app.get(INTERNAL_ERASURE_JOB_CONTROL_READY_PATH, (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }
    if (!erasureJobControlAvailable()) return c.body(null, 503);
    c.header(INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER, INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE);
    return c.body(null, 204);
  });

  /**
   * Dedicated evaluator barrier. A valid ACK authorizes only a claim from the policy-evaluation
   * queue; it conveys no authority over erasure jobs, lifecycle outbox entries or blob deletion.
   */
  app.get(INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH, (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }
    if (!purgePolicyEvaluationAvailable()) return c.body(null, 503);
    c.header(
      INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER,
      INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE,
    );
    return c.body(null, 204);
  });

  /**
   * Credential revocation has its own fresh, non-sticky rollout barrier. Its ACK authorizes one
   * credential-job claim only and never enables the separate content-purge execution capability.
   */
  app.get(INTERNAL_TENANT_CREDENTIAL_REVOCATION_READY_PATH, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }
    try {
      await deps.registry.refresh();
    } catch {
      return c.body(null, 503);
    }
    if (!tenantCredentialRevocationExecutionAvailable()) return c.body(null, 503);
    c.header(
      INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER,
      INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_VALUE,
    );
    return c.body(null, 204);
  });

  /** One fresh all-configured proof authorizes one external credential execution boundary. */
  app.get(INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_READY_PATH, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }
    try {
      await deps.registry.refresh();
    } catch {
      return c.body(null, 503);
    }
    if (!tenantCredentialTargetExecutionAvailable()) return c.body(null, 503);
    c.header(
      INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_HEADER,
      INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_VALUE,
    );
    return c.body(null, 204);
  });
  app.all(INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_READY_PATH, (c) => internalNotFound(c));
  app.all(`${INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_READY_PATH}/*`, (c) => (
    internalNotFound(c)
  ));

  /** One fresh exact-fleet proof authorizes one independent restore-journal boundary. */
  app.get(INTERNAL_TENANT_RESTORE_JOURNAL_READY_PATH, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }
    try {
      await deps.registry.refresh();
    } catch {
      return c.body(null, 503);
    }
    if (!tenantRestoreJournalExecutionAvailable()) return c.body(null, 503);
    c.header(
      INTERNAL_TENANT_RESTORE_JOURNAL_ACK_HEADER,
      INTERNAL_TENANT_RESTORE_JOURNAL_ACK_VALUE,
    );
    return c.body(null, 204);
  });
  app.all(INTERNAL_TENANT_RESTORE_JOURNAL_READY_PATH, (c) => {
    privateInternalHeaders(c);
    return internalNotFound(c);
  });
  app.all(`${INTERNAL_TENANT_RESTORE_JOURNAL_READY_PATH}/*`, (c) => {
    privateInternalHeaders(c);
    return internalNotFound(c);
  });

  /**
   * T3e has its own fresh, non-sticky all-configured barrier. Its ACK authorizes one bounded local
   * execution pass only; it neither changes dataPurgeExecution nor proves any domain completed.
   */
  app.get(INTERNAL_TENANT_PURGE_EXECUTION_READY_PATH, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }
    try {
      await deps.registry.refresh();
    } catch {
      return c.body(null, 503);
    }
    if (!tenantPurgeExecutionAvailable()) return c.body(null, 503);
    c.header(
      INTERNAL_TENANT_PURGE_EXECUTION_ACK_HEADER,
      INTERNAL_TENANT_PURGE_EXECUTION_ACK_VALUE,
    );
    return c.body(null, 204);
  });

  /**
   * T3f has a distinct fresh, non-sticky all-configured barrier. Its ACK authorizes one bounded
   * database-content worker boundary only and cannot be substituted by the T3e execution ACK.
   */
  app.get(INTERNAL_TENANT_DATABASE_PURGE_READY_PATH, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }
    try {
      await deps.registry.refresh();
    } catch {
      return c.body(null, 503);
    }
    if (!tenantDatabasePurgeAvailable()) return c.body(null, 503);
    c.header(
      INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER,
      INTERNAL_TENANT_DATABASE_PURGE_ACK_VALUE,
    );
    return c.body(null, 204);
  });

  /** T3g has a distinct, non-sticky barrier bound to one exact Redis namespace. */
  app.get(INTERNAL_TENANT_REDIS_PURGE_READY_PATH, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }
    try {
      await deps.registry.refresh();
    } catch {
      return c.body(null, 503);
    }
    if (!tenantRedisPurgeAvailable()) return c.body(null, 503);
    c.header(INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER, INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE);
    return c.body(null, 204);
  });

  /**
   * T3b is broadcast to the exact all-configured fleet. It must never reuse session ownership,
   * consistent hashing, sticky compatibility or the healthy subset. A fresh private identity
   * snapshot is taken on both sides of the fanout so a boot change cannot produce a fleet proof.
   */
  app.post(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      await c.req.raw.body?.cancel().catch(() => {});
      return internalNotFound(c);
    }
    if (!(deps.tenantRuntimeDrainExecutionEnabled?.() ?? false)) {
      await c.req.raw.body?.cancel().catch(() => {});
      return c.body(null, 503);
    }

    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (
      !Number.isSafeInteger(declaredLength)
      || declaredLength < 0
      || declaredLength > TENANT_RUNTIME_DRAIN_BODY_MAX_BYTES
    ) {
      await c.req.raw.body?.cancel().catch(() => {});
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const read = await readCapped(c.req.raw.body, TENANT_RUNTIME_DRAIN_BODY_MAX_BYTES);
    if (!read.ok) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const authority = TenantRuntimeDrainRequest.safeParse(raw);
    if (!authority.success) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }

    try {
      const before = await deps.registry.freshTenantRuntimeDrainSnapshot();
      const receipts = await Promise.all(before.targets.map(async (target) => {
        const input = TenantRuntimeDrainRunnerRequest.parse({
          ...authority.data,
          targetSha256: target.targetSha256,
          expectedRunnerId: target.runnerId,
          expectedBootId: target.bootId,
        });
        const response = await fetchRuntimeTarget(`${target.url}${INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH}`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            [INTERNAL_ROUTER_TOKEN_HEADER]: deps.internalRunnerToken!,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(deps.upstreamHeaderTimeoutMs ?? 15_000),
        });
        if (
          response.status !== 200
          || response.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)
            !== INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE
          || !response.headers.get("cache-control")?.split(",").some((value) => (
            value.trim().toLowerCase() === "no-store"
          ))
        ) {
          await response.body?.cancel().catch(() => {});
          throw new Error("tenant runtime target did not acknowledge drain");
        }
        const responseBody = await readCapped(
          response.body,
          TENANT_RUNTIME_DRAIN_RESPONSE_MAX_BYTES,
        );
        if (!responseBody.ok) throw new Error("tenant runtime target response is too large");
        let receiptPayload: unknown;
        try {
          receiptPayload = JSON.parse(new TextDecoder().decode(responseBody.bytes));
        } catch {
          throw new Error("tenant runtime target response is malformed");
        }
        const receipt = TenantRuntimeRevocationLocalReceipt.safeParse(receiptPayload);
        if (
          !receipt.success
          || receipt.data.targetSha256 !== target.targetSha256
          || receipt.data.runnerId !== target.runnerId
          || receipt.data.bootId !== target.bootId
          || receipt.data.requestId !== authority.data.requestId
          || receipt.data.tenantId !== authority.data.tenantId
          || receipt.data.subjectGeneration !== authority.data.subjectGeneration
          || receipt.data.t3aReceiptSha256 !== authority.data.t3aReceiptSha256
        ) throw new Error("tenant runtime target receipt is not bound to the fleet request");
        return receipt.data;
      }));

      const after = await deps.registry.freshTenantRuntimeDrainSnapshot();
      if (
        before.fleetSha256 !== after.fleetSha256
        || before.targets.length !== after.targets.length
        || before.targets.some((target, index) => {
          const current = after.targets[index];
          return !current
            || current.url !== target.url
            || current.targetSha256 !== target.targetSha256
            || current.runnerId !== target.runnerId
            || current.bootId !== target.bootId;
        })
      ) throw new Error("tenant runtime fleet changed during drain");

      const targets = receipts.sort((left, right) => (
        left.targetSha256 < right.targetSha256
          ? -1
          : left.targetSha256 > right.targetSha256
            ? 1
            : 0
      ));
      const proof = TenantRuntimeRevocationFleetProof.parse({
        fleetSha256: tenantRuntimeFleetSha256(targets),
        targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
        targets,
      });
      c.header(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER, INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE);
      return c.json(proof, 200);
    } catch {
      return c.json({
        error: {
          code: "draining",
          message: "tenant runtime drain is unavailable across the configured fleet",
          retryable: true,
        },
      }, 503);
    }
  });
  // Reserve every unsupported method and nested variant so it cannot fall through to the generic
  // proxy and accidentally become an owner-routed or public operation.
  app.all(INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH, (c) => {
    privateInternalHeaders(c);
    return internalNotFound(c);
  });
  app.all(`${INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH}/*`, (c) => {
    privateInternalHeaders(c);
    return internalNotFound(c);
  });
  // Runner-private paths must never fall through to the ordinary proxy, even though that proxy
  // also strips the internal token. The router control plane has one, distinct execution path.
  for (const path of [
    INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
    INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH,
  ]) {
    app.all(path, (c) => {
      privateInternalHeaders(c);
      return internalNotFound(c);
    });
    app.all(`${path}/*`, (c) => {
      privateInternalHeaders(c);
      return internalNotFound(c);
    });
  }

  /**
   * A runner must acquire this fresh, content-free ACK immediately before committing an
   * irreversible tenant gate. Unlike the worker barrier, this observation is deliberately not
   * sticky: every configured stable runner must be healthy and admission-active right now.
   */
  app.get(INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }
    await deps.registry.refresh();
    if (!tenantErasureAdmissionAvailable()) return c.body(null, 503);
    c.header(
      INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER,
      INTERNAL_TENANT_ERASURE_ADMISSION_ACK_VALUE,
    );
    return c.body(null, 204);
  });

  const requireTenantErasureOperator = async (c: Context): Promise<Response | undefined> => {
    if (bearerTokenMatches(c.req.header("authorization"), deps.tenantErasureOperatorToken)) {
      return undefined;
    }
    // Do not parse unauthenticated input, but do cancel its stream so a rejected keep-alive POST
    // cannot retain transport resources indefinitely.
    await c.req.raw.body?.cancel().catch(() => {});
    c.header("WWW-Authenticate", "Bearer");
    return c.json({
      error: { code: "unauthorized", message: "platform operator token required" },
    }, 401);
  };

  const createTenantErasureRequest = async (c: Context): Promise<Response> => {
    privateInternalHeaders(c);
    const unauthorized = await requireTenantErasureOperator(c);
    if (unauthorized) return unauthorized;

    const requestHeaders = TenantErasureRequestHeaders.safeParse({
      "idempotency-key": c.req.header("idempotency-key"),
    });
    if (!requestHeaders.success) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maxBodyBytes) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const read = await readCapped(c.req.raw.body, maxBodyBytes);
    if (!read.ok) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const request = TenantErasureCreateRequest.safeParse(raw);
    if (!request.success) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }

    await deps.registry.refresh();
    const admission = tenantErasureAdmissionAvailable();
    return proxyTenantErasureControl(c, {
      // The discriminated mode derives path, ACK and availability inside the proxy. Once replay is
      // selected, no later gate transition can accidentally retarget this request to admission.
      mode: admission ? "admit" : "replay",
      body: new TextEncoder().encode(JSON.stringify(request.data)),
      idempotencyKey: requestHeaders.data["idempotency-key"],
      expectedTenantId: request.data.tenantId,
    });
  };

  const getTenantErasureRequest = async (c: Context): Promise<Response> => {
    privateInternalHeaders(c);
    const unauthorized = await requireTenantErasureOperator(c);
    if (unauthorized) return unauthorized;

    const params = TenantErasureRequestParams.safeParse({ requestId: c.req.param("requestId") });
    const query = TenantErasureRequestQuery.safeParse({ tenantId: c.req.query("tenantId") });
    if (!params.success || !query.success) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    return proxyTenantErasureControl(c, {
      mode: "status",
      expectedTenantId: query.data.tenantId,
      expectedRequestId: params.data.requestId,
    });
  };

  app.post(TENANT_ERASURE_PUBLIC_COLLECTION, createTenantErasureRequest);
  app.post(`${TENANT_ERASURE_PUBLIC_COLLECTION}/`, createTenantErasureRequest);
  app.get(`${TENANT_ERASURE_PUBLIC_COLLECTION}/:requestId`, getTenantErasureRequest);
  app.get(`${TENANT_ERASURE_PUBLIC_COLLECTION}/:requestId/`, getTenantErasureRequest);

  /**
   * Operational view. Off unless an admin token is configured: it lists every internal runner address
   * and would otherwise let anyone probe whether an arbitrary session id exists.
   */
  app.get("/_router/targets", async (c) => {
    if (!deps.adminToken) return c.json({ error: { code: "not_found", message: "not found" } }, 404);
    if (c.req.header("authorization") !== `Bearer ${deps.adminToken}`) return c.json({ error: { code: "unauthorized", message: "admin token required" } }, 401);
    const sessionId = c.req.query("sessionId");
    const valid = sessionId && isCanonicalId("sess", sessionId) ? sessionId : undefined;
    return c.json({
      runners: deps.registry.list(),
      ...(valid ? { owner: (await deps.registry.owner(valid)) ?? null, candidate: deps.registry.candidate(valid) ?? null } : {}),
    });
  });

  /**
   * Runner-worker to router control plane. The shared credential is checked before the session id
   * or body is parsed, and only the fixed claim envelope is ever forwarded to a configured target.
   */
  app.post(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/:id`, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }

    const sessionId = c.req.param("id");
    if (!isCanonicalId("sess", sessionId)) return internalNotFound(c);

    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (declaredLength > INTERNAL_ERASURE_BODY_MAX_BYTES) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const read = await readCapped(c.req.raw.body, INTERNAL_ERASURE_BODY_MAX_BYTES);
    if (!read.ok) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const parsed = UserErasureDrainRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const body = new TextEncoder().encode(JSON.stringify(parsed.data));
    const upstreamUrl = new URL(c.req.url);
    upstreamUrl.pathname = `${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/${sessionId}`;
    upstreamUrl.search = "";
    const upstreamHeaders = new Headers({
      "content-type": "application/json",
      [INTERNAL_ROUTER_TOKEN_HEADER]: deps.internalRunnerToken!,
    });

    const owner = await deps.registry.owner(sessionId);
    let target = owner ?? deps.registry.candidate(sessionId);
    if (owner && !deps.registry.supportsUserErasureWorker(owner)) {
      return c.json({
        error: { code: "draining", message: "session erasure owner is upgrading", retryable: true },
      }, 503);
    }
    if (!target || !deps.registry.supportsUserErasureWorker(target)) {
      target = deps.registry.list().find((candidate) => (
        candidate.healthy && deps.registry.supportsUserErasureWorker(candidate.url)
      ))?.url;
    }
    if (!target) {
      return c.json({
        error: { code: "draining", message: "no erasure-capable runner is available", retryable: true },
      }, 503);
    }

    const tried = new Set<string>();
    let rerouted = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!deps.registry.supportsUserErasureWorker(target)) {
        return c.json({
          error: { code: "draining", message: "session erasure target is upgrading", retryable: true },
        }, 503);
      }
      tried.add(target);
      let response: Response;
      try {
        response = await forward(
          target,
          upstreamUrl,
          "POST",
          upstreamHeaders,
          body,
          deps.upstreamHeaderTimeoutMs,
        );
      } catch {
        deps.registry.markFailure(target);
        const retry = deps.registry.list().find((candidate) => (
          candidate.healthy
          && !tried.has(candidate.url)
          && deps.registry.supportsUserErasureWorker(candidate.url)
        ))?.url;
        if (!retry || attempt === 1) {
          return c.json({
            error: { code: "draining", message: "session erasure owner is unavailable", retryable: true },
          }, 503);
        }
        target = retry;
        continue;
      }

      if (response.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER) !== INTERNAL_ERASURE_DRAIN_ACK_VALUE) {
        await response.body?.cancel().catch(() => {});
        return c.json({
          error: { code: "draining", message: "runner lacks the erasure drain-v1 contract", retryable: true },
        }, 503);
      }

      if (response.status === 409 && !rerouted && attempt === 0) {
        const localFenced = response.headers.get(INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER)
          === INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE;
        if (localFenced) {
          // While Redis still names any authoritative owner, bypassing this process could overlap
          // provider/tool side effects. Once that lease naturally disappears, retrying the same
          // locally-fenced hash candidate can never make progress, so exclude it exactly once.
          const ownerPresent = await deps.registry.hasLeaseOwner(sessionId);
          if (ownerPresent === false) {
            const retry = deps.registry.list().find((candidate) => (
              candidate.healthy
              && !tried.has(candidate.url)
              && deps.registry.supportsUserErasureWorker(candidate.url)
            ))?.url;
            if (retry) {
              await response.body?.cancel().catch(() => {});
              rerouted = true;
              target = retry;
              continue;
            }
          }
        }
        if (!localFenced) {
          const advertisedOwner = response.headers.get("x-owner");
          const ownerUrl = advertisedOwner ? deps.registry.routeableUrl(advertisedOwner) : undefined;
          if (
            ownerUrl
            && !tried.has(ownerUrl)
            && deps.registry.supportsUserErasureWorker(ownerUrl)
          ) {
            await response.body?.cancel().catch(() => {});
            rerouted = true;
            target = ownerUrl;
            continue;
          }
        }
      }

      const result = streamBack(response);
      result.headers.set(INTERNAL_ERASURE_DRAIN_ACK_HEADER, INTERNAL_ERASURE_DRAIN_ACK_VALUE);
      result.headers.set("Cache-Control", "no-store");
      result.headers.set("X-Content-Type-Options", "nosniff");
      return result;
    }

    return c.json({
      error: { code: "draining", message: "session erasure owner is unavailable", retryable: true },
    }, 503);
  });

  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    if (
      url.pathname === INTERNAL_TOMBSTONE_PATH_PREFIX
      || url.pathname.startsWith(`${INTERNAL_TOMBSTONE_PATH_PREFIX}/`)
      || url.pathname === INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX
      || url.pathname.startsWith(`${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/`)
      || url.pathname === INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX
      || url.pathname.startsWith(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/`)
      || url.pathname === INTERNAL_ERASURE_JOB_CONTROL_READY_PATH
      || url.pathname.startsWith(`${INTERNAL_ERASURE_JOB_CONTROL_READY_PATH}/`)
      || url.pathname === INTERNAL_ERASURE_JOB_CONTROL_V1_READY_PATH
      || url.pathname.startsWith(`${INTERNAL_ERASURE_JOB_CONTROL_V1_READY_PATH}/`)
      || url.pathname === INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH
      || url.pathname.startsWith(`${INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH}/`)
      || url.pathname === INTERNAL_TENANT_CREDENTIAL_REVOCATION_READY_PATH
      || url.pathname.startsWith(`${INTERNAL_TENANT_CREDENTIAL_REVOCATION_READY_PATH}/`)
      || url.pathname === INTERNAL_TENANT_PURGE_EXECUTION_READY_PATH
      || url.pathname.startsWith(`${INTERNAL_TENANT_PURGE_EXECUTION_READY_PATH}/`)
      || url.pathname === INTERNAL_TENANT_DATABASE_PURGE_READY_PATH
      || url.pathname.startsWith(`${INTERNAL_TENANT_DATABASE_PURGE_READY_PATH}/`)
      || url.pathname === INTERNAL_TENANT_REDIS_PURGE_READY_PATH
      || url.pathname.startsWith(`${INTERNAL_TENANT_REDIS_PURGE_READY_PATH}/`)
      || url.pathname === INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH
      || url.pathname.startsWith(`${INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH}/`)
      || url.pathname === INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX
      || url.pathname.startsWith(`${INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX}/`)
      || url.pathname === INTERNAL_TENANT_ERASURE_REPLAY_PATH
      || url.pathname.startsWith(`${INTERNAL_TENANT_ERASURE_REPLAY_PATH}/`)
    ) {
      privateInternalHeaders(c);
      return c.json({ error: { code: "not_found", message: "not found" } }, 404);
    }
    // The platform credential must never enter the generic proxy. Unsupported methods and malformed
    // tenant-control paths fail at the router edge rather than forwarding Authorization to a runner.
    if (
      isTenantErasurePathFamily(url.pathname)
      || authorizationContainsBearerToken(
        c.req.header("authorization"),
        deps.tenantErasureOperatorToken,
      )
    ) {
      privateInternalHeaders(c);
      return c.json({ error: { code: "not_found", message: "not found" } }, 404);
    }
    const sessionId = sessionIdFrom(url.pathname);
    const method = c.req.method;
    const isTombstoneDelete = method === "DELETE"
      && !!sessionId
      && IDEMPOTENT_SESSION_DELETE.test(url.pathname);
    const isBlobUpload = method === "POST"
      && !!sessionId
      && SESSION_BLOB_UPLOAD.test(url.pathname);
    const isErasureRequest = method === "POST" && USER_ERASURE_REQUEST.test(url.pathname);
    const isErasureStatus = method === "GET" && USER_ERASURE_STATUS.test(url.pathname);
    const isDataExportRequest = method === "POST" && USER_DATA_EXPORT_REQUEST.test(url.pathname);
    const isDataExportStatus = method === "GET" && USER_DATA_EXPORT_STATUS.test(url.pathname);
    const isDataExportDownload = method === "GET" && USER_DATA_EXPORT_DOWNLOAD.test(url.pathname);
    const isDataGovernanceManagement = DATA_GOVERNANCE_MANAGEMENT.test(url.pathname);
    const requiresErasureCapableTarget = erasureWriterGateEnabled()
      && USER_SCOPED_RUNTIME.test(url.pathname);
    if (
      isErasureRequest
      || isErasureStatus
      || isDataExportRequest
      || isDataExportStatus
      || isDataExportDownload
      || isDataGovernanceManagement
    ) {
      // The same admin credential can act for multiple users, so URI-only caches must never retain
      // either an owned status body or an owner-hiding 404. This also covers router-generated gates.
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
    }

    // The new router is intentionally deployed before new runners. It keeps the rest of the API
    // available during that rollout, but does not activate tombstoning until the healthy fleet is
    // homogeneous. This prevents one session from receiving old direct-delete semantics merely
    // because its owner or hash-ring target has not been upgraded yet.
    if (
      isTombstoneDelete
      && !tombstoneAvailable()
    ) {
      return c.json({
        error: {
          code: "draining",
          message: "session deletion is unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }
    if (isBlobUpload && !blobAttachmentsAvailable()) {
      return c.json({
        error: {
          code: "draining",
          message: "blob uploads are unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }
    if (isErasureRequest && !erasureRequestsAvailable()) {
      return c.json({
        error: {
          code: "draining",
          message: "data erasure requests are unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }
    if (isDataExportRequest && !dataExportRequestsAvailable()) {
      return c.json({
        error: {
          code: "draining",
          message: "user data export requests are unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }
    if ((isDataExportStatus || isDataExportDownload) && !userDataExportReadable()) {
      return c.json({
        error: {
          code: "draining",
          message: "user data export is unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }
    if (
      isErasureStatus
      && (
        !deps.registry.allHealthySupportDataErasureRequests()
        || !erasureJobControlAvailable()
      )
    ) {
      return c.json({
        error: {
          code: "draining",
          message: "data erasure request status is unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }
    if (isDataGovernanceManagement && !dataGovernanceAvailable()) {
      return c.json({
        error: {
          code: "draining",
          message: "retention policy and legal-hold management are unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }

    // Buffer the body once (a re-route replays it) but refuse an unbounded upload first: without this the
    // router OOMs before the runner's own body limit is ever consulted.
    let body: Uint8Array | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const requestBodyLimit = isBlobUpload ? maxBlobBytes : maxBodyBytes;
      const declared = Number(c.req.header("content-length") ?? "0");
      if (declared > requestBodyLimit) return c.json({ error: { code: "invalid_request", message: `request body exceeds ${requestBodyLimit} bytes` } }, 400);
      const read = await readCapped(c.req.raw.body, requestBodyLimit);
      if (!read.ok) return c.json({ error: { code: "invalid_request", message: `request body exceeds ${requestBodyLimit} bytes` } }, 400);
      body = read.bytes;
    }

    // Never send a capability-gated destructive request to the legacy public DELETE route. If a
    // configured target is accidentally a load-balancer and chooses an old pod after a new-pod
    // health probe, the versioned path fails closed instead of executing the old delete semantics.
    const upstreamUrl = new URL(url);
    const upstreamMethod = isTombstoneDelete ? "POST" : method;
    if (isTombstoneDelete) upstreamUrl.pathname = `${INTERNAL_TOMBSTONE_PATH_PREFIX}/${sessionId}`;
    const upstreamHeaders = requestHeaders(c.req.raw.headers);
    if (isTombstoneDelete) upstreamHeaders.set(INTERNAL_ROUTER_TOKEN_HEADER, deps.internalRunnerToken!);

    const tried = new Set<string>();
    let target = (sessionId ? await deps.registry.owner(sessionId) : undefined) ?? (sessionId ? deps.registry.candidate(sessionId) : deps.registry.anyHealthy());
    if (!target) return c.json({ error: { code: "draining", message: "no healthy runner available" } }, 503);

    // MAX_ATTEMPTS is the total upstream-send budget, including the initial request and any 409 route.
    let reroutes = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // owner() and every upstream attempt cross an async boundary. Revalidate both the fleet and
      // the selected destination here so a health probe cannot admit an old runner between the
      // entry gate above and the irreversible lifecycle write.
      if (
        isTombstoneDelete
        && (!tombstoneAvailable() || !deps.registry.supportsLifecycle(target, "tombstone"))
      ) {
        return c.json({
          error: {
            code: "draining",
            message: "session deletion is unavailable while the runner fleet is upgrading",
            retryable: true,
          },
        }, 503);
      }
      if (
        isBlobUpload
        && (!blobAttachmentsAvailable() || !deps.registry.supportsBlobAttachments(target))
      ) {
        return c.json({
          error: {
            code: "draining",
            message: "blob uploads are unavailable while the runner fleet is upgrading",
            retryable: true,
          },
        }, 503);
      }
      const targetSupportsErasure = deps.registry.supportsDataErasureRequests(target);
      const targetSupportsDataGovernance = deps.registry.supportsDataGovernance(target);
      const targetSupportsUserDataExport = deps.registry.supportsUserDataExport(target);
      if (isDataGovernanceManagement && (
        !dataGovernanceAvailable()
        || !targetSupportsDataGovernance
        || !deps.registry.supportsDataGovernanceManagement(target)
      )) {
        return c.json({
          error: {
            code: "draining",
            message: "retention policy and legal-hold management are unavailable while the runner fleet is upgrading",
            retryable: true,
          },
        }, 503);
      }
      if (
        (isErasureRequest && (
          !erasureRequestsAvailable()
          || !targetSupportsErasure
          || !targetSupportsDataGovernance
        ))
        || (isErasureStatus && (
          !deps.registry.allHealthySupportDataErasureRequests()
          || !erasureJobControlAvailable()
          || !targetSupportsErasure
        ))
        || (requiresErasureCapableTarget && !targetSupportsErasure)
      ) {
        return c.json({
          error: {
            code: "draining",
            message: "user-scoped runtime is unavailable while the runner fleet is upgrading",
            retryable: true,
          },
        }, 503);
      }
      if (
        (isDataExportRequest && (!dataExportRequestsAvailable() || !targetSupportsUserDataExport))
        || ((isDataExportStatus || isDataExportDownload) && (
          !userDataExportReadable() || !targetSupportsUserDataExport
        ))
      ) {
        return c.json({
          error: {
            code: "draining",
            message: "user data export is unavailable while the runner fleet is upgrading",
            retryable: true,
          },
        }, 503);
      }
      tried.add(target);
      let res: Response;
      try {
        res = await forward(target, upstreamUrl, upstreamMethod, upstreamHeaders, body, deps.upstreamHeaderTimeoutMs);
      } catch (err) {
        deps.registry.markFailure(target);
        const name = err instanceof Error ? err.name : "unknown error";
        log.warn(`[router] ${target} unreachable (${name})`);
        // Only this exact POST is deduplicated by the runner. A caller-provided Idempotency-Key on an
        // agent/session/api-key POST does not magically make that endpoint safe to replay.
        const safeToRetry = REPLAYABLE.has(method) ||
          isDataGovernanceManagement ||
          (method === "POST" && !!sessionId && IDEMPOTENT_TURN_POST.test(url.pathname) && !!c.req.header("idempotency-key")?.trim()) ||
          (method === "POST" && isErasureRequest && !!c.req.header("idempotency-key")?.trim()) ||
          (method === "POST" && isDataExportRequest && !!c.req.header("idempotency-key")?.trim()) ||
          (method === "DELETE" && !!sessionId && IDEMPOTENT_SESSION_DELETE.test(url.pathname));
        const next = safeToRetry ? pickOther(deps, sessionId, tried) : undefined;
        if (!next || attempt >= maxAttempts) {
          return c.json({ error: { code: "provider_error", message: "runner unreachable", retryable: safeToRetry } }, 502);
        }
        target = next;
        continue;
      }


      if (isTombstoneDelete && res.headers.get(INTERNAL_TOMBSTONE_ACK_HEADER) !== INTERNAL_TOMBSTONE_ACK_VALUE) {
        await res.body?.cancel().catch(() => {});
        return c.json({
          error: {
            code: "draining",
            message: "session deletion reached a runner without the tombstone-v1 internal contract",
            retryable: true,
          },
        }, 503);
      }

      // The runner tells us who really owns this session; follow it exactly once.
      if (res.status === 409 && sessionId && reroutes < 1 && attempt < maxAttempts) {
        const owner = res.headers.get("x-owner");
        const ownerUrl = owner ? deps.registry.routeableUrl(owner) : undefined;
        if (owner && !ownerUrl) log.warn(`[router] session ${sessionId}: owner "${owner}" is not a configured runner; check RUNNER_ADDR matches RUNNERS`);
        if (ownerUrl && !tried.has(ownerUrl)) {
          log.info(`[router] session ${sessionId}: re-routing to owner ${ownerUrl}`);
          reroutes += 1;
          target = ownerUrl;
          continue;
        }
      }
      const response = streamBack(res);
      if (
        isErasureRequest
        || isErasureStatus
        || isDataExportRequest
        || isDataExportStatus
        || isDataExportDownload
        || isDataGovernanceManagement
      ) {
        // New runners already send these headers. Reassert them at the public edge so a proxying
        // regression or an unexpected upstream error can never make this identity-scoped route cacheable.
        response.headers.set("Cache-Control", "no-store");
        response.headers.set("X-Content-Type-Options", "nosniff");
      }
      return response;
    }
    return c.json({ error: { code: "session_lease_conflict", message: "could not reach the session owner" } }, 409);
  });

  return app;
}

/** Read a body with a hard cap, without buffering more than the cap. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!stream) return { ok: true, bytes: new Uint8Array() };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes: out };
}

function pickOther(deps: RouterAppDeps, sessionId: string | undefined, tried: Set<string>): string | undefined {
  const healthy = deps.registry.list().filter((t) => t.healthy && !tried.has(t.url));
  if (!healthy.length) return undefined;
  if (!sessionId) return healthy[0]!.url;
  const candidate = deps.registry.candidate(sessionId);
  return candidate && !tried.has(candidate) ? candidate : healthy[0]!.url;
}

function requestHeaders(from: Headers): Headers {
  const h = new Headers();
  from.forEach((v, k) => {
    const key = k.toLowerCase();
    if (!STRIP_REQUEST.has(key) && !key.startsWith("x-agent-service-")) h.set(k, v);
  });
  return h;
}

async function forward(target: string, url: URL, method: string, headers: Headers, body: Uint8Array | undefined, headerTimeoutMs?: number): Promise<Response> {
  const dest = `${target}${url.pathname}${url.search}`;
  const controller = headerTimeoutMs ? new AbortController() : undefined;
  let timer: NodeJS.Timeout | undefined;
  if (controller) timer = setTimeout(() => controller.abort(new Error(`upstream did not send headers within ${headerTimeoutMs}ms`)), headerTimeoutMs);
  try {
    // Once fetch resolves the response headers are available. Clear the timer immediately; leaving
    // the controller un-aborted means a long-lived SSE response body can continue indefinitely.
    return await fetch(dest, {
      method,
      headers,
      body: body && body.byteLength ? body : undefined,
      redirect: "manual",
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Pass the upstream response through untouched, including the SSE body as a stream. */
function streamBack(res: Response): Response {
  const headers = new Headers();
  // getSetCookie preserves multiple Set-Cookie values that a plain set() would collapse to one.
  const cookies = res.headers.getSetCookie?.() ?? [];
  res.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (STRIP_RESPONSE.has(key) || key.startsWith("x-agent-service-") || key === "set-cookie") return;
    headers.set(k, v);
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  if (headers.get("content-type")?.includes("text/event-stream")) headers.set("X-Accel-Buffering", "no");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
