import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  AgentDefinition,
  AgentDefinitionRequest,
  AgentListQuery,
  AgentVersionQuery,
  ApiKeyIdParams,
  ApiError,
  ApprovalListQuery,
  ApprovalResponseRequest,
  CreateApiKeyRequest,
  CreateSessionRequest,
  DATA_EXPORT_CONTENT_TYPE,
  DataExportRequestHeaders,
  DataExportRequestParams,
  DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
  DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
  DynamicToolResultRequest,
  ErrorBody,
  ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1,
  ERASURE_JOB_CONTROL_QUARANTINE_V1,
  EXCLUDABLE_EVENT_TYPES,
  EventStreamHeaders,
  EventStreamQuery,
  ErasureRequestHeaders,
  ErasureRequestParams,
  ItemListQuery,
  LegalHoldListQuery,
  LegalHoldParams,
  LegalHoldReleaseRequest,
  LegalHoldSetRequest,
  INTERNAL_ERASURE_DRAIN_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_ACK_VALUE,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE,
  INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX,
  INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX,
  INTERNAL_TENANT_ERASURE_ACTOR_HEADER,
  INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_REPLAY_ACK_VALUE,
  INTERNAL_TENANT_ERASURE_REPLAY_PATH,
  INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER,
  INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE,
  INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
  INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH,
  INTERNAL_TOMBSTONE_ACK_HEADER,
  INTERNAL_TOMBSTONE_ACK_VALUE,
  INTERNAL_ROUTER_TOKEN_HEADER,
  OPENAPI_DOCUMENT,
  PROTOCOL_VERSION,
  PURGE_POLICY_EVALUATOR_V1,
  Pagination,
  RetentionPolicyActivateRequest,
  RetentionPolicyParams,
  RetentionPolicyPutRequest,
  TENANT_CREDENTIAL_REVOCATION_STORE_V1,
  TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
  TENANT_ERASURE_PLATFORM_CONTROL_V1,
  TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
  TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1,
  TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
  TENANT_RUNTIME_DRAIN_V1,
  TenantErasureCreateRequest,
  TenantErasureRequestHeaders,
  TenantErasureRequestParams,
  TenantErasureRequestQuery,
  TenantRuntimeDrainReady,
  TenantRuntimeDrainRunnerRequest,
  TenantRuntimeRevocationLocalReceipt,
  isCanonicalId,
  type IdPrefix,
  ProviderIdParams,
  SessionListQuery,
  StartTurnHeaders,
  StartTurnQuery,
  TurnStartRequest,
  TenantAuthPolicyInput,
  UsageQuery,
  UpsertProviderRequest,
  TurnSteerRequest,
  UserErasureDrainRequest,
  USER_DATA_EXPORT_ARTIFACT_NDJSON_V1,
  type Capabilities,
  type BlobUploadResponse,
  ImageMediaType,
  type Event,
  type ErasureRequest,
  type TenantErasureRequest,
  type DataExportRequest,
  UserId,
} from "@agent-service/protocol";
import type { SessionHost, TenantRuntimeCoordinator, ToolRegistry } from "@agent-service/core";
import { ErasureLocalTurnFencedError, newId } from "@agent-service/core";
import {
  BLOB_STORAGE_FORMAT,
  CredentialSourceConflictError,
  ErasureIdempotencyMismatchError,
  LegalHoldConflictError,
  LegalHoldGenerationConflictError,
  LegalHoldNotFoundError,
  RetentionPolicyGenerationConflictError,
  RetentionPolicyNotFoundError,
  RetentionPolicyVersionConflictError,
  SubjectDeletingError,
  TenantErasureConflictError,
  TenantErasureTargetNotFoundError,
  UserDataExportIdempotencyMismatchError,
  UserDataExportPolicyUnavailableError,
  UserDataExportStateError,
  erasureWriteAuthorizationMatches,
  newUserDataExportRequestId,
  newErasureRequestId,
  tenantErasureRequestHash,
  userDataExportIdempotencyKeySha256,
  userDataExportManifestSha256,
  userDataExportRequestHash,
  userDataExportStorageKey,
  publicErasureRequestStatus,
  userErasureRequestHash,
  type RetentionPolicyStore,
  type BlobStore,
  type SessionStore,
  type SubjectLifecycleStore,
  type TenantCredentialRevocationStore,
  type UserDataExportRequestRecord,
  type UserDataExportRequestStore,
} from "@agent-service/store";
import { redactProviderConfig, type ProviderService } from "@agent-service/providers";
import { assertMayActAs, authMiddleware, generateApiKey, hashApiKey, requireAdmin, requireUser, TenantPolicyCache, type AuthEnv } from "./auth.js";
import { needsSecret, validateAuthPolicy } from "./auth-policy.js";
import { sseResponse } from "./sse.js";

export interface AppDeps {
  store: SessionStore;
  host: SessionHost;
  providers: ProviderService;
  tools: ToolRegistry;
  runnerId: string;
  internalRouterToken: string;
  heartbeatMs: number;
  maxBodyBytes: number;
  /** Accept new attachment uploads. Reads remain available while this rolling-upgrade gate is off. */
  blobAttachmentsEnabled?: boolean;
  /** Raw upload ceiling. Main validates that this is no larger than maxBodyBytes. */
  maxBlobBytes?: number;
  /** Additive rollout gate; must stay off until every writer checks the durable subject gate. */
  erasureRequestsEnabled?: boolean;
  /** Advertise the irreversible generation-zero compensation contract only while its worker runs. */
  legacyTombstoneCompensationEnabled?: boolean;
  /** Canonical policy/legal-hold management; independent from and incapable of physical purge. */
  dataGovernanceManagementEnabled?: boolean;
  /** Store/runtime implements the sealed, non-destructive policy-evaluation contract. */
  purgePolicyEvaluationSupported?: boolean;
  /** Code-aware export store. Admission remains independently gated for rolling upgrades. */
  userDataExport?: UserDataExportRequestStore;
  dataExportBlob?: BlobStore;
  dataExportRequestsEnabled?: boolean;
  dataExportDownloadLeaseMs?: number;
  maxDataExportPartBytes?: number;
  retentionPolicy?: RetentionPolicyStore;
  subjectLifecycle?: SubjectLifecycleStore;
  /** Local half of the irreversible tenant-admission rollout switch. */
  tenantErasureRequestsEnabled?: boolean;
  /** Fresh router proof that every configured runtime can enforce the tenant fence. */
  tenantErasureAdmissionGate?: { canAdmit: () => Promise<boolean> };
  /** Local credential-revocation worker activation; the router barrier remains separately required. */
  tenantCredentialRevocationWorkerEnabled?: boolean;
  /** Durable write-once tracking state; code awareness is advertised independently. */
  tenantCredentialLifecycleTrackingActive?: () => boolean | Promise<boolean>;
  /** Local T3e worker activation; code awareness remains separately advertised during rollout. */
  tenantPurgeExecutionWorkerEnabled?: boolean;
  /** Local T3f database-content worker activation; its router barrier remains independent. */
  tenantDatabasePurgeWorkerEnabled?: boolean;
  /** T3g code-awareness is advertised only when a concrete Redis purge adapter is wired. */
  tenantRedisPurgeSupported?: boolean;
  /** Local T3g worker activation; its router barrier remains independent. */
  tenantRedisPurgeWorkerEnabled?: boolean;
  /** Hash of the operator-asserted Redis namespace/prefix targeted by the adapter. */
  tenantRedisPurgeNamespaceSha256?: string;
  /** Narrow T3a store surface; its presence is the code-awareness signal advertised to routers. */
  tenantCredentialRevocation?: TenantCredentialRevocationStore;
  /** Narrow T3b runtime surface; main owns the coordinator and per-process boot identity. */
  tenantRuntimeDrain?: {
    bootId: string;
    drain: (
      request: TenantRuntimeDrainRunnerRequest,
    ) => Promise<TenantRuntimeRevocationLocalReceipt>;
  };
  /** Local private endpoint activation, independent from code awareness. */
  tenantRuntimeDrainEnabled?: boolean;
  /** Shared process-local admission fence used by auth, provider I/O and SessionHost turns. */
  tenantRuntime?: TenantRuntimeCoordinator;
  ready: () => boolean;
  /** decrypts a tenant's stored auth secret (HS256 key / introspection credential) */
  decryptSecret: (secret: { ciphertext: Buffer; keyId: string }) => Promise<string>;
  encryptSecret: (plaintext: string) => Promise<{ ciphertext: Buffer; keyId: string }>;
  fetchImpl?: typeof fetch;
  /** tenant auth policy cache TTL; shorter means faster convergence across runners */
  policyCacheMs?: number;
  /** rejects a tenant-supplied URL that is not a public http(s) endpoint (SSRF guard); injectable for tests */
  assertPublicUrl?: (url: string) => Promise<void>;
}

const parse = async <T extends z.ZodTypeAny>(schema: T, body: unknown): Promise<z.infer<T>> => {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError("invalid_request", "validation failed", r.error.flatten());
  return r.data;
};
const json = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

// This claim-only envelope is intentionally far smaller than the public runtime request budget.
// Keeping a separate ceiling also ensures future public body-limit changes cannot widen this path.
const INTERNAL_ERASURE_DRAIN_MAX_BODY_BYTES = 2_048;
const INTERNAL_TENANT_ERASURE_MAX_BODY_BYTES = 2_048;
const INTERNAL_TENANT_RUNTIME_DRAIN_MAX_BODY_BYTES = 4_096;
const TENANT_ERASURE_ACTOR_ID = /^[A-Za-z0-9._-]{1,64}$/;

function internalTokenMatches(received: string | undefined, expected: string): boolean {
  const left = createHash("sha256").update(received ?? "").digest();
  const right = createHash("sha256").update(expected).digest();
  return received !== undefined && timingSafeEqual(left, right);
}

function governanceApiError(error: unknown): never {
  if (
    error instanceof RetentionPolicyVersionConflictError
    || error instanceof RetentionPolicyGenerationConflictError
    || error instanceof LegalHoldConflictError
    || error instanceof LegalHoldGenerationConflictError
  ) {
    throw new ApiError("state_conflict", error.message);
  }
  if (error instanceof RetentionPolicyNotFoundError || error instanceof LegalHoldNotFoundError) {
    throw new ApiError("not_found", error.message);
  }
  throw error;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AuthEnv>();
  const tenantRedisPurgeSupported = deps.tenantRedisPurgeSupported === true
    && /^[0-9a-f]{64}$/.test(deps.tenantRedisPurgeNamespaceSha256 ?? "");
  const maxBlobBytes = deps.maxBlobBytes ?? deps.maxBodyBytes;
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 1 || maxBlobBytes > deps.maxBodyBytes) {
    throw new Error("maxBlobBytes must be a positive safe integer no larger than maxBodyBytes");
  }
  const dataExportDownloadLeaseMs = deps.dataExportDownloadLeaseMs ?? 30_000;
  if (
    !Number.isSafeInteger(dataExportDownloadLeaseMs)
    || dataExportDownloadLeaseMs < 1_000
    || dataExportDownloadLeaseMs > 60_000
  ) throw new Error("dataExportDownloadLeaseMs must be between 1000 and 60000");
  const maxDataExportPartBytes = deps.maxDataExportPartBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxDataExportPartBytes) || maxDataExportPartBytes < 1) {
    throw new Error("maxDataExportPartBytes must be a positive safe integer");
  }

  app.onError((err, c) => {
    if (err instanceof SubjectDeletingError) {
      const apiError = new ApiError("subject_deleting", err.message);
      return c.json(apiError.toBody() satisfies ErrorBody, apiError.status as 400);
    }
    if (err instanceof ApiError) {
      // agent-router reads this to re-route the request to the current owner (design §4.2).
      const owner = (err.details as { ownerAddr?: string } | undefined)?.ownerAddr;
      if (err.code === "session_lease_conflict" && owner) {
        // The router needs the owner address; an external client must not learn internal topology.
        c.header("X-Owner", owner);
        const body = err.toBody();
        return c.json({ error: { ...body.error, details: undefined } } satisfies ErrorBody, err.status as 400);
      }
      return c.json(err.toBody() satisfies ErrorBody, err.status as 400);
    }
    console.error(err);
    return c.json({ error: { code: "internal_error", message: "internal error" } } satisfies ErrorBody, 500);
  });

  // ---------- unauthenticated ----------
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/readyz", (c) => (deps.ready() ? c.text("ready") : c.text("not ready", 503)));
  app.get("/openapi.json", (c) => c.json(OPENAPI_DOCUMENT));
  app.get("/v1/capabilities", async (c) =>
    c.json({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 3_600_000 },
        approvals: true,
        sessionLifecycle: ["archive", "unarchive", "tombstone"],
        blobAttachments: deps.blobAttachmentsEnabled === true,
        dataErasureRequests: deps.erasureRequestsEnabled === true
          && deps.legacyTombstoneCompensationEnabled === true
          && deps.subjectLifecycle !== undefined,
        userErasureWorker: deps.subjectLifecycle === undefined ? [] : ["drain-v1"],
        erasureJobControl: deps.subjectLifecycle === undefined
          ? []
          : [
              ERASURE_JOB_CONTROL_QUARANTINE_V1,
              ...(deps.legacyTombstoneCompensationEnabled === true
                ? [ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1]
                : []),
            ],
        // Code-awareness is distinct from endpoint activation: the router uses this durable-writer
        // signal to prevent an old erasure admission path from omitting an already-active policy.
        dataGovernance: deps.retentionPolicy !== undefined
          ? [DATA_GOVERNANCE_CANONICAL_RETENTION_V1, DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1]
          : [],
        dataGovernanceManagement: deps.retentionPolicy !== undefined
          && deps.dataGovernanceManagementEnabled === true,
        purgePolicyEvaluation: deps.purgePolicyEvaluationSupported === true
          ? [PURGE_POLICY_EVALUATOR_V1]
          : [],
        dataPurgeExecution: false,
        userDataExport: deps.userDataExport !== undefined && deps.dataExportBlob !== undefined
          ? [USER_DATA_EXPORT_ARTIFACT_NDJSON_V1]
          : [],
        dataExportRequests: deps.dataExportRequestsEnabled === true
          && deps.userDataExport !== undefined
          && deps.dataExportBlob !== undefined,
        tenantErasureControl: deps.subjectLifecycle === undefined
          ? []
          : [TENANT_ERASURE_PLATFORM_CONTROL_V1],
        tenantErasureRequests: deps.tenantErasureRequestsEnabled === true
          && deps.subjectLifecycle !== undefined
          && deps.tenantErasureAdmissionGate !== undefined,
        tenantCredentialRevocation: deps.tenantCredentialRevocation === undefined
          ? []
          : [TENANT_CREDENTIAL_REVOCATION_STORE_V1],
        tenantCredentialRevocationWorker:
          deps.tenantCredentialRevocation !== undefined
          && deps.tenantCredentialRevocationWorkerEnabled === true,
        tenantCredentialLifecycle: [
          TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
        ],
        tenantCredentialLifecycleTrackingActive:
          await deps.tenantCredentialLifecycleTrackingActive?.() === true,
        // Code awareness and activation are deliberately separate rolling-upgrade signals.
        tenantPurgeExecution: [
          TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
          TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1,
        ],
        tenantPurgeExecutionWorker: deps.tenantPurgeExecutionWorkerEnabled === true,
        tenantDatabasePurgeWorker: deps.tenantDatabasePurgeWorkerEnabled === true,
        tenantRedisPurge: tenantRedisPurgeSupported
          ? [TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1]
          : [],
        tenantRedisPurgeWorker: tenantRedisPurgeSupported
          && deps.tenantRedisPurgeWorkerEnabled === true,
        tenantRedisPurgeNamespaceSha256:
          tenantRedisPurgeSupported
            ? deps.tenantRedisPurgeNamespaceSha256!
            : null,
        tenantRuntimeDrain: deps.tenantRuntimeDrain === undefined
          ? []
          : [TENANT_RUNTIME_DRAIN_V1],
        tenantRuntimeDrainEndpoint: deps.tenantRuntimeDrain !== undefined
          && deps.tenantRuntimeDrainEnabled === true,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    } satisfies Capabilities),
  );

  const runtimeDrainReadyPath = INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH;
  const runtimeDrainExecutePath = INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH;
  const requireRuntimeDrainToken: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRouterToken)) {
      await c.req.raw.body?.cancel().catch(() => {});
      throw new ApiError("not_found", "not found");
    }
    await next();
  };
  for (const path of [runtimeDrainReadyPath, runtimeDrainExecutePath]) {
    app.use(path, privateResponseHeaders);
    app.use(`${path}/*`, privateResponseHeaders);
    app.use(path, requireRuntimeDrainToken);
    app.use(`${path}/*`, requireRuntimeDrainToken);
  }

  app.get(runtimeDrainReadyPath, (c) => {
    if (!deps.tenantRuntimeDrain || deps.tenantRuntimeDrainEnabled !== true) {
      return c.body(null, 503);
    }
    const identity = TenantRuntimeDrainReady.parse({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      capability: TENANT_RUNTIME_DRAIN_V1,
      endpointEnabled: true,
      runnerId: deps.runnerId,
      bootId: deps.tenantRuntimeDrain.bootId,
    });
    c.header(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER, INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE);
    return c.json(identity, 200);
  });
  app.all(runtimeDrainReadyPath, (c) => {
    throw new ApiError("not_found", "not found");
  });
  app.all(`${runtimeDrainReadyPath}/*`, (c) => {
    throw new ApiError("not_found", "not found");
  });

  app.use(runtimeDrainExecutePath, async (c, next) => {
    if (!deps.tenantRuntimeDrain || deps.tenantRuntimeDrainEnabled !== true) {
      await c.req.raw.body?.cancel().catch(() => {});
      return c.body(null, 503);
    }
    await next();
  });
  app.use(runtimeDrainExecutePath, bodyLimit({
    maxSize: INTERNAL_TENANT_RUNTIME_DRAIN_MAX_BODY_BYTES,
    onError: () => {
      throw new ApiError(
        "invalid_request",
        `request body exceeds ${INTERNAL_TENANT_RUNTIME_DRAIN_MAX_BODY_BYTES} bytes`,
      );
    },
  }));
  app.post(runtimeDrainExecutePath, async (c) => {
    // The activation middleware above narrows this before any body inspection.
    if (!deps.tenantRuntimeDrain) throw new ApiError("not_found", "not found");
    const request = await parse(TenantRuntimeDrainRunnerRequest, await json(c));
    if (
      request.expectedRunnerId !== deps.runnerId
      || request.expectedBootId !== deps.tenantRuntimeDrain.bootId
    ) throw new ApiError("state_conflict", "tenant runtime identity changed");

    const result = await deps.tenantRuntimeDrain.drain(request);
    const receipt = TenantRuntimeRevocationLocalReceipt.safeParse(result);
    if (
      !receipt.success
      || receipt.data.targetSha256 !== request.targetSha256
      || receipt.data.runnerId !== request.expectedRunnerId
      || receipt.data.bootId !== request.expectedBootId
      || receipt.data.requestId !== request.requestId
      || receipt.data.tenantId !== request.tenantId
      || receipt.data.subjectGeneration !== request.subjectGeneration
      || receipt.data.t3aReceiptSha256 !== request.t3aReceiptSha256
    ) throw new Error("tenant runtime drain returned an invalid local receipt");
    c.header(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER, INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE);
    return c.json(receipt.data, 200);
  });
  app.all(runtimeDrainExecutePath, (c) => {
    throw new ApiError("not_found", "not found");
  });
  app.all(`${runtimeDrainExecutePath}/*`, (c) => {
    throw new ApiError("not_found", "not found");
  });

  // Runner-only worker traffic bypasses tenant authentication. Authenticate the fixed internal
  // token before inspecting the session id, Content-Length or JSON so every untrusted probe has
  // the same private 404 response. The durable request is then the sole source of phase/authority.
  const erasureDrainPath = `${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/:id`;
  app.use(erasureDrainPath, privateResponseHeaders);
  app.use(erasureDrainPath, async (c, next) => {
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRouterToken)) {
      throw new ApiError("not_found", "not found");
    }
    await next();
  });
  app.use(erasureDrainPath, validateIdParams);
  app.use(erasureDrainPath, bodyLimit({
    maxSize: INTERNAL_ERASURE_DRAIN_MAX_BODY_BYTES,
    onError: () => {
      throw new ApiError(
        "invalid_request",
        `request body exceeds ${INTERNAL_ERASURE_DRAIN_MAX_BODY_BYTES} bytes`,
      );
    },
  }));
  app.post(erasureDrainPath, async (c) => {
    if (!deps.subjectLifecycle) throw new ApiError("not_found", "not found");
    const sessionId = c.req.param("id");
    if (!sessionId) throw new ApiError("not_found", "not found");
    const authority = await parse(UserErasureDrainRequest, await json(c));
    const record = await deps.subjectLifecycle.getUserErasureRequest(
      authority.tenantId,
      authority.userId,
      authority.requestId,
    );
    if (!record || !erasureWriteAuthorizationMatches(record, authority, Date.now())) {
      throw new ApiError("not_found", "not found");
    }

    const operation = record.status === "draining"
      ? deps.host.drainSessionForErasure.bind(deps.host)
      : record.status === "tombstoning"
        ? deps.host.eraseSessionForErasure.bind(deps.host)
        : undefined;
    if (!operation) throw new ApiError("not_found", "not found");
    try {
      await operation(authority, sessionId);
    } catch (error) {
      // A routing 409 must carry proof that this is a drain-v1 runner, while unrelated failures
      // (especially owner/claim 404s) do not gain a distinguishing header.
      if (error instanceof ApiError && error.status === 409) {
        c.header(INTERNAL_ERASURE_DRAIN_ACK_HEADER, INTERNAL_ERASURE_DRAIN_ACK_VALUE);
      }
      if (error instanceof ErasureLocalTurnFencedError) {
        c.header(
          INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER,
          INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE,
        );
      }
      throw error;
    }
    c.header(INTERNAL_ERASURE_DRAIN_ACK_HEADER, INTERNAL_ERASURE_DRAIN_ACK_VALUE);
    return c.body(null, 204);
  });
  // Prevent unsupported methods from falling through to the ordinary /v1 auth middleware.
  app.all(erasureDrainPath, (c) => {
    throw new ApiError("not_found", "not found");
  });

  // Versioned runner-only tenant lifecycle control. The public platform credential terminates at
  // the router; only its fixed private credential reaches this route. Authenticate that token
  // before looking at the target, query or body so direct probes cannot enumerate tenant state.
  const tenantErasureControlPath = INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX;
  const tenantErasureReplayPath = INTERNAL_TENANT_ERASURE_REPLAY_PATH;
  const tenantErasureStatusPath = `${tenantErasureControlPath}/:requestId`;
  app.use(tenantErasureControlPath, privateResponseHeaders);
  app.use(`${tenantErasureControlPath}/*`, privateResponseHeaders);
  app.use(tenantErasureReplayPath, privateResponseHeaders);
  const requireTenantErasureControl: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRouterToken)) {
      throw new ApiError("not_found", "not found");
    }
    c.header(INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER, INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE);
    await next();
  };
  const requireTenantErasureReplay: MiddlewareHandler<AuthEnv> = async (c, next) => {
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRouterToken)) {
      throw new ApiError("not_found", "not found");
    }
    c.header(INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER, INTERNAL_TENANT_ERASURE_REPLAY_ACK_VALUE);
    await next();
  };
  app.use(tenantErasureControlPath, requireTenantErasureControl);
  app.use(`${tenantErasureControlPath}/*`, requireTenantErasureControl);
  app.use(tenantErasureReplayPath, requireTenantErasureReplay);
  app.use(tenantErasureControlPath, bodyLimit({
    maxSize: INTERNAL_TENANT_ERASURE_MAX_BODY_BYTES,
    onError: () => {
      throw new ApiError(
        "invalid_request",
        `request body exceeds ${INTERNAL_TENANT_ERASURE_MAX_BODY_BYTES} bytes`,
      );
    },
  }));
  app.use(tenantErasureReplayPath, bodyLimit({
    maxSize: INTERNAL_TENANT_ERASURE_MAX_BODY_BYTES,
    onError: () => {
      throw new ApiError(
        "invalid_request",
        `request body exceeds ${INTERNAL_TENANT_ERASURE_MAX_BODY_BYTES} bytes`,
      );
    },
  }));
  app.post(tenantErasureControlPath, async (c) => {
    if (!deps.subjectLifecycle) {
      throw new ApiError("draining", "tenant erasure control is unavailable on this runner");
    }
    const headers = await parse(TenantErasureRequestHeaders, {
      "idempotency-key": c.req.header("idempotency-key"),
    });
    const input = await parse(TenantErasureCreateRequest, await json(c));
    try {
      const replay = await deps.subjectLifecycle.replayTenantErasure({
        tenantId: input.tenantId,
        idempotencyKey: headers["idempotency-key"],
        requestHash: tenantErasureRequestHash(input.tenantId),
      });
      if (replay) return c.json(publicTenantErasureRequest(replay), 202);
    } catch (error) {
      if (error instanceof ErasureIdempotencyMismatchError) {
        throw new ApiError("idempotency_conflict", error.message);
      }
      throw error;
    }

    if (
      deps.tenantErasureRequestsEnabled !== true
      || !deps.tenantErasureAdmissionGate
    ) {
      throw new ApiError("draining", "tenant erasure requests are not activated on this fleet");
    }
    const actorId = c.req.header(INTERNAL_TENANT_ERASURE_ACTOR_HEADER);
    if (!actorId || !TENANT_ERASURE_ACTOR_ID.test(actorId)) {
      throw new ApiError("draining", "tenant erasure platform authority is unavailable");
    }

    // This proof is intentionally consumed immediately before the store transaction. It prevents
    // a caller that can reach a runner's private address from using a stale capability observation
    // to admit a fence while any configured runtime is old, unavailable or locally gated.
    if (!await deps.tenantErasureAdmissionGate.canAdmit()) {
      throw new ApiError("draining", "tenant erasure fleet barrier is closed");
    }
    try {
      const record = await deps.subjectLifecycle.requestTenantErasure({
        requestId: newErasureRequestId(),
        tenantId: input.tenantId,
        requestedByKeyId: actorId,
        idempotencyKey: headers["idempotency-key"],
        requestHash: tenantErasureRequestHash(input.tenantId),
        atMs: Date.now(),
      });
      return c.json(publicTenantErasureRequest(record), 202);
    } catch (error) {
      if (error instanceof ErasureIdempotencyMismatchError) {
        throw new ApiError("idempotency_conflict", error.message);
      }
      if (error instanceof TenantErasureConflictError) {
        throw new ApiError("state_conflict", error.message);
      }
      if (error instanceof TenantErasureTargetNotFoundError) {
        throw new ApiError("not_found", "not found");
      }
      throw error;
    }
  });
  app.post(tenantErasureReplayPath, async (c) => {
    if (!deps.subjectLifecycle) {
      throw new ApiError("draining", "tenant erasure replay is unavailable on this runner");
    }
    const headers = await parse(TenantErasureRequestHeaders, {
      "idempotency-key": c.req.header("idempotency-key"),
    });
    const input = await parse(TenantErasureCreateRequest, await json(c));
    try {
      const record = await deps.subjectLifecycle.replayTenantErasure({
        tenantId: input.tenantId,
        idempotencyKey: headers["idempotency-key"],
        requestHash: tenantErasureRequestHash(input.tenantId),
      });
      if (!record) {
        throw new ApiError("draining", "tenant erasure admission is closed and no replay exists");
      }
      return c.json(publicTenantErasureRequest(record), 202);
    } catch (error) {
      if (error instanceof ErasureIdempotencyMismatchError) {
        throw new ApiError("idempotency_conflict", error.message);
      }
      throw error;
    }
  });
  app.get(tenantErasureStatusPath, async (c) => {
    if (!deps.subjectLifecycle) {
      throw new ApiError("draining", "tenant erasure status is unavailable on this runner");
    }
    const [{ requestId }, { tenantId }] = await Promise.all([
      parse(TenantErasureRequestParams, { requestId: c.req.param("requestId") }),
      parse(TenantErasureRequestQuery, c.req.query()),
    ]);
    const record = await deps.subjectLifecycle.getTenantErasureRequest(tenantId, requestId);
    if (!record) throw new ApiError("not_found", "tenant erasure request not found");
    return c.json(publicTenantErasureRequest(record));
  });
  app.all(tenantErasureControlPath, (c) => {
    throw new ApiError("not_found", "not found");
  });
  app.all(`${tenantErasureControlPath}/*`, (c) => {
    throw new ApiError("not_found", "not found");
  });
  app.all(tenantErasureReplayPath, (c) => {
    throw new ApiError("not_found", "not found");
  });

  const v1 = new Hono<AuthEnv>();
  // Blob bytes and hydrated tool output are user data. Apply these headers before auth/id
  // validation so success and every error response share the same cache and sniffing policy.
  v1.use("/sessions/:id/blobs", privateResponseHeaders);
  v1.use("/sessions/:id/blobs/:blobId", privateResponseHeaders);
  v1.use("/sessions/:id/items/:itemId/output", privateResponseHeaders);
  // Erasure status is user-owned data. Install these before body limits, auth and parameter
  // validation so success and every 4xx/5xx response are forbidden from entering a cache.
  v1.use("/data-erasure-requests", privateResponseHeaders);
  v1.use("/data-erasure-requests/:requestId", privateResponseHeaders);
  v1.use("/data-export-requests", privateResponseHeaders);
  v1.use("/data-export-requests/:requestId", privateResponseHeaders);
  v1.use("/data-export-requests/:requestId/download", privateResponseHeaders);
  v1.use("/retention-policies/*", privateResponseHeaders);
  v1.use("/legal-holds", privateResponseHeaders);
  v1.use("/legal-holds/*", privateResponseHeaders);
  /**
   * Reject any non-canonical id before it reaches the store or the lease.
   * A case variant of a session id used to find the real row (MySQL's default collation is
   * case-insensitive) while hashing to a DIFFERENT Redis lease key — two writers, fencing bypassed.
   */
  v1.use("/sessions/:id/*", validateIdParams);
  v1.use("/sessions/:id", validateIdParams);
  v1.use("/_internal/session-tombstone/:id", async (c, next) => {
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRouterToken)) {
      throw new ApiError("not_found", "not found");
    }
    c.header(INTERNAL_TOMBSTONE_ACK_HEADER, INTERNAL_TOMBSTONE_ACK_VALUE);
    await next();
  });
  v1.use("/_internal/session-tombstone/:id", validateIdParams);
  v1.use("/agents/:id", validateIdParams);
  v1.use("/sessions/:id/blobs", bodyLimit({
    maxSize: maxBlobBytes,
    onError: () => { throw new ApiError("invalid_request", `blob body exceeds ${maxBlobBytes} bytes`); },
  }));
  // Reject oversized bodies before they are buffered or parsed.
  v1.use("*", bodyLimit({ maxSize: deps.maxBodyBytes, onError: () => { throw new ApiError("invalid_request", `request body exceeds ${deps.maxBodyBytes} bytes`); } }));
  const policyCache = new TenantPolicyCache(deps.policyCacheMs, deps.tenantRuntime);
  v1.use("*", authMiddleware({
    store: deps.store,
    decryptSecret: deps.decryptSecret,
    fetchImpl: deps.fetchImpl,
    cache: policyCache,
    tenantRuntime: deps.tenantRuntime,
  }));

  // ---------- agents ----------
  v1.post("/agents", async (c) => {
    requireAdmin(c);
    const input = await parse(AgentDefinitionRequest, await json(c));
    const def = AgentDefinition.parse({ ...input, id: newId("agt"), tenantId: c.get("tenantId"), version: 1, createdAtMs: Date.now() });
    await deps.store.createAgent(def);
    return c.json(def, 201);
  });
  v1.get("/agents", async (c) => {
    requireAdmin(c);
    const q = await parse(AgentListQuery, c.req.query());
    return c.json(await deps.store.listAgents(c.get("tenantId"), { cursor: q.cursor, limit: q.limit }));
  });
  v1.get("/agents/:id", async (c) => {
    // `instructions` is the system prompt. A runtime key (which may live nearer the edge) must not read it.
    requireAdmin(c);
    const q = await parse(AgentVersionQuery, c.req.query());
    const def = await deps.store.getAgent(c.get("tenantId"), c.req.param("id"), q.version);
    if (!def) throw new ApiError("not_found", "agent not found");
    return c.json(def);
  });
  v1.put("/agents/:id", async (c) => {
    requireAdmin(c);
    const prev = await deps.store.getAgent(c.get("tenantId"), c.req.param("id"));
    if (!prev) throw new ApiError("not_found", "agent not found");
    const input = await parse(AgentDefinitionRequest, await json(c));
    const def = AgentDefinition.parse({ ...input, id: prev.id, tenantId: prev.tenantId, version: prev.version + 1, createdAtMs: Date.now() });
    await deps.store.createAgent(def);
    return c.json(def);
  });

  // ---------- providers / models / tools ----------
  v1.get("/providers", async (c) => c.json({ data: (await deps.providers.listVisible(c.get("tenantId"))).map(redactProviderConfig) }));
  v1.put("/providers/:id", async (c) => {
    requireAdmin(c);
    const { id } = await parse(ProviderIdParams, { id: c.req.param("id") });
    const input = await parse(UpsertProviderRequest, await json(c));
    return c.json(redactProviderConfig(await deps.providers.upsertTenantProvider(c.get("tenantId"), {
      ...input,
      id,
    })));
  });
  v1.delete("/providers/:id", async (c) => {
    requireAdmin(c);
    const { id } = await parse(ProviderIdParams, { id: c.req.param("id") });
    const ok = await deps.providers.deleteTenantProvider(c.get("tenantId"), id);
    if (!ok) throw new ApiError("not_found", "provider not found");
    return c.body(null, 204);
  });
  v1.get("/models", async (c) => {
    const providers = await deps.providers.listVisible(c.get("tenantId"));
    // models carry no secrets, so no redaction needed here
    return c.json({ data: providers.flatMap((p) => p.models.map((m) => ({ provider: p.id, ...m }))) });
  });
  v1.get("/tools", (c) => c.json({ data: deps.tools.list().map(({ execute: _e, ...t }) => t) }));

  // ---------- api keys ----------
  // A leaked key has to be revocable, and a new environment needs a way to mint its first non-bootstrap
  // key, without anyone reaching into the database.
  v1.get("/tenant/api-keys", async (c) => {
    requireAdmin(c);
    return c.json({ data: await deps.store.listApiKeys(c.get("tenantId")) });
  });
  v1.post("/tenant/api-keys", async (c) => {
    requireAdmin(c);
    const input = await parse(CreateApiKeyRequest, await json(c));
    const existing = await deps.store.listApiKeys(c.get("tenantId"));
    if (existing.some((k) => k.keyId === input.keyId && !k.revokedAtMs)) throw new ApiError("invalid_request", `an active key named "${input.keyId}" already exists`);
    const key = generateApiKey();
    await deps.store.createApiKey(c.get("tenantId"), input.keyId, hashApiKey(key), input.scopes);
    // The only time the secret is ever returned: it is stored as a hash.
    return c.json({ keyId: input.keyId, scopes: input.scopes, key }, 201);
  });
  v1.delete("/tenant/api-keys/:keyId", async (c) => {
    requireAdmin(c);
    const { keyId } = await parse(ApiKeyIdParams, { keyId: c.req.param("keyId") });
    if (keyId === c.get("apiKeyId")) throw new ApiError("invalid_request", "refusing to revoke the key making this request");
    if (!(await deps.store.revokeApiKey(c.get("tenantId"), keyId))) throw new ApiError("not_found", "no active key with that id");
    return c.body(null, 204);
  });

  // ---------- tenant auth policy ----------
  // Who may set this: the service key itself. A tenant configures how its OWN users are identified.
  v1.get("/tenant/auth", async (c) => {
    requireAdmin(c);
    const t = await deps.store.getTenant(c.get("tenantId"));
    return c.json({ tenantId: c.get("tenantId"), policy: t?.authPolicy ?? { mode: "trusted_caller" }, hasSecret: !!t?.authSecret });
  });
  v1.put("/tenant/auth", async (c) => {
    requireAdmin(c);
    const input = await parse(TenantAuthPolicyInput, await json(c));
    const tenantId = c.get("tenantId");
    let encryptedSecret: Awaited<ReturnType<AppDeps["encryptSecret"]>> | undefined;
    for (;;) {
      const existing = await deps.store.getTenant(tenantId);
      const storedKind = existing?.authPolicy.mode === "end_user_token"
        ? existing.authPolicy.verifier.kind
        : undefined;
      await validateAuthPolicy(input, !!existing?.authSecret, deps.assertPublicUrl, storedKind);
      if (input.secret && !encryptedSecret) encryptedSecret = await deps.encryptSecret(input.secret);
      const secret = input.secret
        ? encryptedSecret
        : needsSecret(input.policy)
          ? undefined
          : null;
      try {
        const stored = await deps.store.setTenantAuth(
          tenantId,
          input.policy,
          secret,
          existing?.authCredentialSourceRevision ?? null,
        );
        policyCache.invalidate(tenantId); // effective immediately here; other runners within the TTL
        return c.json({ tenantId, policy: input.policy, hasSecret: !!stored.authSecret });
      } catch (error) {
        if (
          !(error instanceof CredentialSourceConflictError)
          || error.sourceKind !== "tenant_auth"
        ) throw error;
        // Re-validate against the new policy/secret kind before retrying the store-managed CAS.
      }
    }
  });

  // ---------- sessions ----------
  v1.post("/sessions", async (c) => {
    const req = await parse(CreateSessionRequest, await json(c));
    const principal = requireUser(c);
    assertMayActAs(c, req.userId);
    return c.json(await deps.host.createSession(principal, req), 201);
  });
  v1.post("/sessions/:id/blobs", async (c) => {
    const principal = requireUser(c);
    if (deps.blobAttachmentsEnabled !== true) {
      // Capability=false only withholds new writes. Reader routes intentionally remain available
      // during a mixed-version rollout so blobs written by an upgraded peer stay readable.
      throw new ApiError("draining", "blob attachment uploads are not enabled on this runner");
    }
    const parsedContentType = ImageMediaType.safeParse(c.req.header("content-type"));
    if (!parsedContentType.success) {
      throw new ApiError("invalid_request", "Content-Type must be image/png, image/jpeg, image/webp, or image/gif");
    }
    const contentType = parsedContentType.data;
    const data = Buffer.from(await c.req.arrayBuffer());
    if (data.byteLength === 0) throw new ApiError("invalid_request", "blob body must not be empty");
    // bodyLimit is the allocation guard; retain an explicit check for adapters/tests that construct
    // a request without a reliable Content-Length header.
    if (data.byteLength > maxBlobBytes) {
      throw new ApiError("invalid_request", `blob body exceeds ${maxBlobBytes} bytes`);
    }
    const uploaded = await deps.host.uploadInputBlob(principal, c.req.param("id"), data, contentType);
    const response = {
      blobId: uploaded.blobId,
      purpose: "input_image",
      state: "staging",
      sizeBytes: uploaded.sizeBytes,
      contentType,
      expiresAtMs: uploaded.expiresAtMs,
    } satisfies BlobUploadResponse;
    return c.json(response, 201);
  });
  v1.get("/sessions/:id/blobs/:blobId", async (c) => {
    const blob = await deps.host.readInputBlob(requireUser(c), c.req.param("id"), c.req.param("blobId"));
    if (!blob) throw new ApiError("not_found", "blob not found");
    if (!blob.contentType || !ImageMediaType.safeParse(blob.contentType).success) {
      // Do not let corrupt persisted metadata become a response header or change browser handling.
      throw new ApiError("internal_error", "blob metadata is invalid");
    }
    c.header("Content-Type", blob.contentType);
    c.header("Content-Length", String(blob.sizeBytes));
    return c.body(new Uint8Array(blob.data));
  });
  v1.get("/sessions", async (c) => {
    const q = await parse(SessionListQuery, c.req.query());
    // A user-scoped caller sees only its own sessions. Listing across users is an admin operation:
    // without this, a service key with no user identity enumerated the whole tenant.
    const caller = c.get("principal").userId;
    if (!caller) requireAdmin(c);
    else if (q.userId && q.userId !== caller) throw new ApiError("forbidden", "cannot list another user's sessions");
    return c.json(await deps.store.listSessions(c.get("tenantId"), { userId: caller || q.userId, cursor: q.cursor, limit: q.limit, includeArchived: q.includeArchived }));
  });
  v1.get("/sessions/:id", async (c) => c.json(await deps.host.getSession(requireUser(c), c.req.param("id"))));
  // Router-only, versioned destructive path. A mixed backend containing an older runner cannot
  // accidentally execute legacy public DELETE semantics because that binary does not own this path.
  v1.post("/_internal/session-tombstone/:id", async (c) => {
    await deps.host.deleteSession(requireUser(c), c.req.param("id"));
    return c.body(null, 204);
  });
  v1.delete("/sessions/:id", async (c) => {
    await deps.host.deleteSession(requireUser(c), c.req.param("id"));
    return c.body(null, 204);
  });
  v1.post("/sessions/:id/compact", async (c) => {
    return c.json(await deps.host.compactSession(requireUser(c), c.req.param("id")));
  });
  v1.post("/sessions/:id/archive", async (c) => {
    return c.json(await deps.host.archiveSession(requireUser(c), c.req.param("id")));
  });
  v1.post("/sessions/:id/unarchive", async (c) => {
    return c.json(await deps.host.unarchiveSession(requireUser(c), c.req.param("id")));
  });
  v1.post("/sessions/:id/resume", async (c) => {
    const session = await deps.host.getSession(requireUser(c), c.req.param("id"));
    const [turns, approvals] = await Promise.all([deps.store.listTurns(session.id, { limit: 20 }), deps.store.listApprovals(session.id, { pendingOnly: true })]);
    return c.json({ session, recentTurns: turns.data, pendingApprovalIds: approvals.map((a) => a.id), lastSeq: session.lastSeq });
  });

  // ---------- turns ----------
  v1.post("/sessions/:id/turns", async (c) => {
    const principal = requireUser(c);
    const sessionId = c.req.param("id");
    const turnHeaders = await parse(StartTurnHeaders, {
      "idempotency-key": c.req.header("idempotency-key"),
    });
    const idem = turnHeaders["idempotency-key"];
    // Authorize the session before consulting replay state. Otherwise a same-tenant caller who knows
    // another user's session id and idempotency key can receive that user's completed turn.
    if (idem) await deps.host.getSession(principal, sessionId);
    const req = await parse(TurnStartRequest, await json(c));
    const query = await parse(StartTurnQuery, c.req.query());
    const exclude = parseExclude(query.exclude);

    // Preflight runs BEFORE any stream is opened, so busy / lease / draining / provider failures are
    // real HTTP status codes instead of an error event inside a 200 response.
    const begun = await deps.host.beginTurn(principal, sessionId, req, { idempotencyKey: idem });
    if (begun.replayed) {
      c.header("Idempotency-Replayed", "true");
      return c.json({ turn: begun.turn }, 200);
    }

    if (!req.stream) {
      begun.run();
      return c.json({ turn: begun.turn, steered: begun.steered ?? false }, 202);
    }
    // `turn/started` is already persisted, so replaying from seqStart-1 delivers the whole turn.
    // When the input was steered into a running turn, that turn is replayed from its own beginning.
    const afterSeq = begun.turn.seqStart - 1;
    const turnId = begun.turn.id;
    return sseResponse(
      c,
      async (send, close) => {
        // End the stream once OUR turn completed and the session reported idle, so the client's last
        // event is the status it should resume from. Closing on any `idle` would end the stream early
        // (a stale-projection repair can emit one before our turn even starts).
        let completed = false;
        let fallback: NodeJS.Timeout | undefined;
        try {
          return await deps.host.subscribe(principal, sessionId, afterSeq, (e) => {
            send(e);
            if (e.type === "session/deleted") {
              clearTimeout(fallback);
              close();
              return;
            }
            if (e.type === "turn/completed" && e.turn.id === turnId) {
              completed = true;
              // The idle status is published right after, but a fenced-out turn never writes it.
              fallback = setTimeout(close, 2_000);
            } else if (completed && e.type === "session/status/changed" && e.status.type === "idle") {
              clearTimeout(fallback);
              close();
            }
          }, { exclude });
        } finally {
          begun.run(); // must run even if attaching failed, or the turn would hold its lease forever
        }
      },
      { heartbeatMs: deps.heartbeatMs, sessionId },
    );
  });

  v1.get("/sessions/:id/turns", async (c) => {
    await deps.host.getSession(requireUser(c), c.req.param("id"));
    const q = await parse(Pagination, c.req.query());
    return c.json(await deps.store.listTurns(c.req.param("id"), { cursor: q.cursor, limit: q.limit, sortDirection: q.sortDirection }));
  });
  v1.get("/sessions/:id/turns/:turnId", async (c) => {
    await deps.host.getSession(requireUser(c), c.req.param("id"));
    const t = await deps.store.getTurn(c.req.param("id"), c.req.param("turnId"));
    if (!t) throw new ApiError("not_found", "turn not found");
    return c.json(t);
  });
  v1.post("/sessions/:id/turns/:turnId/interrupt", async (c) => c.json(await deps.host.interrupt(requireUser(c), c.req.param("id"), c.req.param("turnId"))));
  v1.post("/sessions/:id/turns/:turnId/steer", async (c) => {
    const req = await parse(TurnSteerRequest, await json(c));
    await deps.host.steer(requireUser(c), c.req.param("id"), c.req.param("turnId"), req);
    return c.json({ ok: true }, 202);
  });
  v1.post("/sessions/:id/turns/:turnId/tool-results", async (c) => {
    const principal = requireUser(c);
    const req = await parse(DynamicToolResultRequest, await json(c));
    await deps.host.submitDynamicToolResultOrThrow(principal, c.req.param("id"), req.toolCallId, { content: req.content, isError: req.isError });
    return c.json({ ok: true }, 202);
  });

  // ---------- usage ----------
  v1.get("/usage", async (c) => {
    const q = await parse(UsageQuery, c.req.query());
    // Same rule as listing sessions: tenant-wide usage (and `groupBy=user`, which enumerates user ids)
    // is an admin view; a user-scoped caller is confined to its own numbers.
    const caller = c.get("principal").userId;
    if (!caller) requireAdmin(c);
    else if (q.userId && q.userId !== caller) throw new ApiError("forbidden", "cannot read another user's usage");
    return c.json(await deps.store.queryUsage(c.get("tenantId"), { ...q, userId: caller || q.userId }));
  });

  // ---------- subject data lifecycle ----------
  v1.post("/data-erasure-requests", async (c) => {
    if (!deps.erasureRequestsEnabled || !deps.subjectLifecycle) {
      throw new ApiError("draining", "data erasure requests are not activated on this fleet");
    }
    requireAdmin(c);
    const principal = requireUser(c);
    const headers = await parse(ErasureRequestHeaders, {
      "x-user-id": c.req.header("x-user-id"),
      "x-end-user-token": c.req.header("x-end-user-token"),
      "idempotency-key": c.req.header("idempotency-key"),
    });
    let record;
    try {
      record = await deps.subjectLifecycle.requestUserErasure({
        requestId: newErasureRequestId(),
        tenantId: principal.tenantId,
        userId: principal.userId,
        requestedByKeyId: c.get("apiKeyId"),
        idempotencyKey: headers["idempotency-key"],
        requestHash: userErasureRequestHash(principal.tenantId, principal.userId),
        atMs: Date.now(),
      });
    } catch (error) {
      if (error instanceof ErasureIdempotencyMismatchError) {
        throw new ApiError("idempotency_conflict", error.message);
      }
      throw error;
    }
    return c.json(publicErasureRequest(record), 202);
  });
  v1.get("/data-erasure-requests/:requestId", async (c) => {
    if (!deps.subjectLifecycle) throw new ApiError("draining", "data erasure request status is unavailable");
    requireAdmin(c);
    const principal = requireUser(c);
    const { requestId } = await parse(ErasureRequestParams, c.req.param());
    const record = await deps.subjectLifecycle.getUserErasureRequest(principal.tenantId, principal.userId, requestId);
    if (!record) throw new ApiError("not_found", "erasure request not found");
    return c.json(publicErasureRequest(record));
  });

  // ---------- asynchronous user data export ----------
  const exportStore = () => {
    if (!deps.userDataExport || !deps.dataExportBlob) {
      throw new ApiError("draining", "user data export is unavailable on this runner");
    }
    return { store: deps.userDataExport, blob: deps.dataExportBlob };
  };

  v1.post("/data-export-requests", async (c) => {
    if (!deps.dataExportRequestsEnabled) {
      throw new ApiError("draining", "user data export requests are not activated on this fleet");
    }
    requireAdmin(c);
    const principal = requireUser(c);
    const headers = await parse(DataExportRequestHeaders, {
      "x-user-id": c.req.header("x-user-id"),
      "x-end-user-token": c.req.header("x-end-user-token"),
      "idempotency-key": c.req.header("idempotency-key"),
    });
    const { store } = exportStore();
    try {
      const record = await store.requestUserDataExport({
        requestId: newUserDataExportRequestId(),
        tenantId: principal.tenantId,
        userId: principal.userId,
        requestedByKeyId: c.get("apiKeyId"),
        idempotencyKeySha256: userDataExportIdempotencyKeySha256(headers["idempotency-key"]),
        requestHash: userDataExportRequestHash(principal.tenantId, principal.userId),
      });
      return c.json(publicUserDataExportRequest(record), 202);
    } catch (error) {
      if (error instanceof UserDataExportIdempotencyMismatchError) {
        throw new ApiError("idempotency_conflict", error.message);
      }
      if (error instanceof UserDataExportPolicyUnavailableError) {
        throw new ApiError("draining", error.message);
      }
      if (error instanceof UserDataExportStateError || error instanceof SubjectDeletingError) {
        throw new ApiError("state_conflict", error.message);
      }
      throw error;
    }
  });

  v1.get("/data-export-requests/:requestId", async (c) => {
    requireAdmin(c);
    const principal = requireUser(c);
    const { requestId } = await parse(DataExportRequestParams, c.req.param());
    const record = await exportStore().store.getUserDataExport(
      principal.tenantId,
      principal.userId,
      requestId,
    );
    if (!record) throw new ApiError("not_found", "data export request not found");
    return c.json(publicUserDataExportRequest(record));
  });

  v1.get("/data-export-requests/:requestId/download", async (c) => {
    requireAdmin(c);
    const principal = requireUser(c);
    const { requestId } = await parse(DataExportRequestParams, c.req.param());
    const { store, blob } = exportStore();
    const leaseToken = randomUUID();
    const download = await store.acquireUserDataExportDownload(
      principal.tenantId,
      principal.userId,
      requestId,
      leaseToken,
      dataExportDownloadLeaseMs,
    );
    if (!download) throw new ApiError("not_found", "data export artifact not found");
    const { request, artifact, parts } = download;
    let metadataValid = false;
    try {
      const totalSizeBytes = parts.reduce((total, part) => total + (part.sizeBytes ?? 0), 0);
      metadataValid = request.requestId === requestId
        && request.tenantId === principal.tenantId
        && request.userId === principal.userId
        && request.status === "ready"
        && request.currentArtifactId === artifact.artifactId
        && request.currentBuildGeneration === artifact.buildGeneration
        && request.subjectGeneration === artifact.subjectGeneration
        && request.format === artifact.format
        && request.schemaVersion === artifact.schemaVersion
        && request.policyVersion === artifact.policyVersion
        && request.policySha256 === artifact.policySha256
        && request.artifactTtlMs === artifact.artifactTtlMs
        && request.snapshotAtMs === artifact.snapshotAtMs
        && request.readyAtMs === artifact.readyAtMs
        && request.expiresAtMs === artifact.expiresAtMs
        && request.artifactSha256 === artifact.contentSha256
        && request.artifactSizeBytes === artifact.totalSizeBytes
        && request.recordCount === artifact.recordCount
        && artifact.requestId === requestId
        && artifact.tenantId === principal.tenantId
        && artifact.userId === principal.userId
        && artifact.storageBackend === blob.backend
        && artifact.storageFormat === BLOB_STORAGE_FORMAT
        && artifact.contentType === DATA_EXPORT_CONTENT_TYPE
        && artifact.state === "ready"
        && artifact.deletionGeneration === 0
        && artifact.partCount !== undefined
        && artifact.totalSizeBytes !== undefined
        && artifact.contentSha256 !== undefined
        && artifact.manifestSha256 !== undefined
        && parts.length === artifact.partCount
        && parts.every((part, index) => (
          part.artifactId === artifact.artifactId
          && part.requestId === requestId
          && part.buildGeneration === artifact.buildGeneration
          && part.partNumber === index
          && part.state === "uploaded"
          && part.storageBackend === artifact.storageBackend
          && part.storageFormat === artifact.storageFormat
          && part.storageKey === userDataExportStorageKey(
            { tenantId: principal.tenantId, userId: principal.userId },
            requestId,
            artifact.artifactId,
            part.partNumber,
          )
          && part.sha256 !== undefined
          && part.sizeBytes !== undefined
          && part.contentType === DATA_EXPORT_CONTENT_TYPE
          && part.deletionGeneration === 0
        ))
        && Number.isSafeInteger(totalSizeBytes)
        && totalSizeBytes === artifact.totalSizeBytes
        && userDataExportManifestSha256(parts) === artifact.manifestSha256;
    } catch {
      metadataValid = false;
    }
    if (!metadataValid) {
      await store.releaseUserDataExportDownload(artifact.artifactId, leaseToken).catch(() => {});
      throw new Error("ready data export artifact is corrupt");
    }

    let partIndex = 0;
    let totalBytes = 0;
    let finished = false;
    let leaseLost = false;
    const digest = createHash("sha256");
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const finalize = async () => {
      if (finished) return;
      finished = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      await store.releaseUserDataExportDownload(artifact.artifactId, leaseToken).catch(() => {});
    };
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    heartbeat = setInterval(() => {
      void store.renewUserDataExportDownload(
        artifact.artifactId,
        leaseToken,
        dataExportDownloadLeaseMs,
      ).then((renewed) => {
        if (renewed || finished) return;
        leaseLost = true;
        streamController?.error(new Error("data export download lease expired"));
        void finalize();
      }).catch(() => {
        if (finished) return;
        leaseLost = true;
        streamController?.error(new Error("data export download lease renewal failed"));
        void finalize();
      });
    }, Math.max(250, Math.floor(dataExportDownloadLeaseMs / 3)));
    heartbeat.unref?.();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      async pull(controller) {
        if (finished || leaseLost) return;
        try {
          if (partIndex >= parts.length) {
            if (
              totalBytes !== artifact.totalSizeBytes
              || digest.digest("hex") !== artifact.contentSha256
            ) throw new Error("data export artifact digest is corrupt");
            controller.close();
            await finalize();
            return;
          }
          if (!await store.renewUserDataExportDownload(
            artifact.artifactId,
            leaseToken,
            dataExportDownloadLeaseMs,
          )) throw new Error("data export download lease expired");
          const part = parts[partIndex]!;
          if (part.sizeBytes! > maxDataExportPartBytes) {
            throw new Error("data export part exceeds the configured read ceiling");
          }
          const object = await blob.get(part.storageKey, { maxBytes: maxDataExportPartBytes });
          if (leaseLost || finished) {
            throw new Error("data export download lease expired");
          }
          if (
            !object
            || object.storageKey !== part.storageKey
            || object.sha256 !== part.sha256
            || object.sizeBytes !== part.sizeBytes
            || object.contentType !== part.contentType
            || createHash("sha256").update(object.data).digest("hex") !== part.sha256
          ) throw new Error("data export artifact part is missing or corrupt");
          totalBytes += object.data.byteLength;
          if (!Number.isSafeInteger(totalBytes)) throw new Error("data export size overflowed");
          digest.update(object.data);
          partIndex += 1;
          controller.enqueue(object.data);
        } catch (error) {
          controller.error(error);
          await finalize();
        }
      },
      async cancel() {
        await finalize();
      },
    });
    const digestBase64 = Buffer.from(artifact.contentSha256!, "hex").toString("base64");
    return new Response(stream, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": DATA_EXPORT_CONTENT_TYPE,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename="agent-service-user-export-${requestId}.ndjson"`,
        "Content-Digest": `sha-256=:${digestBase64}:`,
        "X-Artifact-Size": String(artifact.totalSizeBytes),
        "Content-Length": String(artifact.totalSizeBytes),
      },
    });
  });

  const governanceStore = () => {
    if (!deps.dataGovernanceManagementEnabled || !deps.retentionPolicy) {
      throw new ApiError("draining", "retention policy and legal-hold management are not activated on this fleet");
    }
    return deps.retentionPolicy;
  };

  v1.put("/retention-policies/:policyVersion", async (c) => {
    requireAdmin(c);
    const store = governanceStore();
    const { policyVersion } = await parse(RetentionPolicyParams, c.req.param());
    const input = await parse(RetentionPolicyPutRequest, await json(c));
    try {
      return c.json(await store.putRetentionPolicy({
        tenantId: c.get("tenantId"),
        policyVersion,
        policy: input.policy,
        actorKeyId: c.get("apiKeyId"),
        atMs: Date.now(),
      }));
    } catch (error) {
      governanceApiError(error);
    }
  });
  v1.post("/retention-policies/:policyVersion/activate", async (c) => {
    requireAdmin(c);
    const store = governanceStore();
    const { policyVersion } = await parse(RetentionPolicyParams, c.req.param());
    const input = await parse(RetentionPolicyActivateRequest, await json(c));
    try {
      const control = await store.activateRetentionPolicy({
        tenantId: c.get("tenantId"),
        policyVersion,
        expectedControlGeneration: input.expectedControlGeneration,
        actorKeyId: c.get("apiKeyId"),
        atMs: Date.now(),
      });
      const policy = await store.getRetentionPolicy(c.get("tenantId"), policyVersion);
      if (!policy) throw new Error("activated retention policy disappeared");
      return c.json({ control, policy });
    } catch (error) {
      governanceApiError(error);
    }
  });
  // Register the fixed segment before the parameter route for routers/frameworks that preserve
  // declaration order when matching an otherwise-valid policy version named "active".
  v1.get("/retention-policies/active", async (c) => {
    requireAdmin(c);
    const active = await governanceStore().getActiveRetentionPolicy(c.get("tenantId"));
    if (!active) throw new ApiError("not_found", "no active retention policy");
    return c.json(active);
  });
  v1.get("/retention-policies/:policyVersion", async (c) => {
    requireAdmin(c);
    const { policyVersion } = await parse(RetentionPolicyParams, c.req.param());
    const policy = await governanceStore().getRetentionPolicy(c.get("tenantId"), policyVersion);
    if (!policy) throw new ApiError("not_found", "retention policy not found");
    return c.json(policy);
  });
  v1.post("/legal-holds", async (c) => {
    requireAdmin(c);
    const store = governanceStore();
    const input = await parse(LegalHoldSetRequest, await json(c));
    const tenantId = c.get("tenantId");
    if (
      (input.subjectKind === "tenant" && input.subjectId !== tenantId)
      || (input.subjectKind === "user" && !UserId.safeParse(input.subjectId).success)
    ) throw new ApiError("invalid_request", "legal hold subject does not match its declared scope");
    try {
      return c.json(await store.setLegalHold({
        ...input,
        tenantId,
        actorKeyId: c.get("apiKeyId"),
        atMs: Date.now(),
      }));
    } catch (error) {
      governanceApiError(error);
    }
  });
  v1.post("/legal-holds/:holdId/release", async (c) => {
    requireAdmin(c);
    const store = governanceStore();
    const { holdId } = await parse(LegalHoldParams, c.req.param());
    const input = await parse(LegalHoldReleaseRequest, await json(c));
    try {
      return c.json(await store.releaseLegalHold({
        ...input,
        tenantId: c.get("tenantId"),
        holdId,
        actorKeyId: c.get("apiKeyId"),
        atMs: Date.now(),
      }));
    } catch (error) {
      governanceApiError(error);
    }
  });
  v1.get("/legal-holds/:holdId", async (c) => {
    requireAdmin(c);
    const { holdId } = await parse(LegalHoldParams, c.req.param());
    const hold = await governanceStore().getLegalHold(c.get("tenantId"), holdId);
    if (!hold) throw new ApiError("not_found", "legal hold not found");
    return c.json(hold);
  });
  v1.get("/legal-holds", async (c) => {
    requireAdmin(c);
    const store = governanceStore();
    const query = await parse(LegalHoldListQuery, c.req.query());
    const tenantId = c.get("tenantId");
    if (
      (query.subjectKind === "tenant" && query.subjectId !== tenantId)
      || (query.subjectKind === "user" && !UserId.safeParse(query.subjectId).success)
    ) throw new ApiError("invalid_request", "legal hold subject does not match its declared scope");
    const state = await store.getActiveLegalHoldState(
      tenantId,
      query.subjectKind,
      query.subjectId,
    );
    return c.json({ control: state.control, data: state.holds });
  });

  // ---------- items / events ----------
  v1.get("/sessions/:id/items", async (c) => {
    await deps.host.getSession(requireUser(c), c.req.param("id"));
    const q = await parse(ItemListQuery, c.req.query());
    return c.json({ data: await deps.store.listItems(c.req.param("id"), { turnId: q.turnId, afterSeq: q.afterSeq, limit: q.limit }) });
  });
  v1.get("/sessions/:id/items/:itemId/output", async (c) => {
    const output = await deps.host.readItemOutput(requireUser(c), c.req.param("id"), c.req.param("itemId"));
    if (!output) throw new ApiError("not_found", "item output not found");
    return c.json(output);
  });
  v1.get("/sessions/:id/events", async (c) => {
    const principal = requireUser(c);
    const sessionId = c.req.param("id");
    await deps.host.getSession(principal, sessionId);
    const [query, headers] = await Promise.all([
      parse(EventStreamQuery, c.req.query()),
      parse(EventStreamHeaders, { "last-event-id": c.req.header("last-event-id") }),
    ]);
    const after = query.after ?? headers["last-event-id"] ?? -1;
    const exclude = parseExclude(query.exclude);
    return sseResponse(
      c,
      (send, close) => deps.host.subscribe(principal, sessionId, after, (event) => {
        send(event);
        // A tombstone is the final event visible to an already-established subscriber. New
        // subscriptions fail ownership lookup with 404, so keeping this stream alive would only
        // emit heartbeats for a resource the caller can no longer access.
        if (event.type === "session/deleted") close();
      }, { exclude }),
      { heartbeatMs: deps.heartbeatMs, sessionId },
    );
  });

  // ---------- approvals ----------
  v1.get("/sessions/:id/approvals", async (c) => {
    await deps.host.getSession(requireUser(c), c.req.param("id"));
    const q = await parse(ApprovalListQuery, c.req.query());
    return c.json({ data: await deps.store.listApprovals(c.req.param("id"), { pendingOnly: q.pending === "true" }) });
  });
  v1.post("/sessions/:id/approvals/:approvalId", async (c) => {
    const req = await parse(ApprovalResponseRequest, await json(c));
    return c.json(await deps.host.resolveApproval(requireUser(c), c.req.param("id"), c.req.param("approvalId"), req.decision));
  });

  app.route("/v1", v1);
  return app;
}

function publicErasureRequest(record: Awaited<ReturnType<SubjectLifecycleStore["requestUserErasure"]>>): ErasureRequest {
  return {
    id: record.requestId,
    scope: "user",
    userId: record.subjectId,
    generation: record.generation,
    status: publicErasureRequestStatus(record),
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  };
}

function publicTenantErasureRequest(
  record: Awaited<ReturnType<SubjectLifecycleStore["requestTenantErasure"]>>,
): TenantErasureRequest {
  if (record.status !== "gated") {
    throw new Error("tenant erasure admission has an unsupported public status");
  }
  return {
    id: record.requestId,
    scope: "tenant",
    tenantId: record.tenantId,
    generation: record.generation,
    status: "gated",
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  };
}

function publicUserDataExportRequest(record: UserDataExportRequestRecord): DataExportRequest {
  const base = {
    id: record.requestId,
    scope: "user" as const,
    userId: record.userId,
    format: record.format,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  };
  if (record.status === "ready") {
    if (
      record.snapshotAtMs === undefined
      || record.readyAtMs === undefined
      || record.expiresAtMs === undefined
      || record.artifactSha256 === undefined
      || record.artifactSizeBytes === undefined
    ) throw new Error("ready data export request is incomplete");
    return {
      ...base,
      status: "ready",
      snapshotAtMs: record.snapshotAtMs,
      readyAtMs: record.readyAtMs,
      expiresAtMs: record.expiresAtMs,
      artifact: {
        contentType: DATA_EXPORT_CONTENT_TYPE,
        sizeBytes: record.artifactSizeBytes,
        sha256: record.artifactSha256,
      },
    };
  }
  return { ...base, status: record.status };
}

/**
 * Only high-volume, non-terminal event types may be excluded. Excluding e.g. `session/status/changed`
 * would leave a streaming client waiting forever, so an unknown value is a client error.
 */
const ID_PARAMS: [string, IdPrefix][] = [
  ["id", "sess"],
  ["turnId", "turn"],
  ["blobId", "blob"],
  ["itemId", "item"],
  ["approvalId", "apr"],
];

const privateResponseHeaders: MiddlewareHandler<AuthEnv> = async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
};

const validateIdParams: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const path = c.req.path;
  for (const [param, prefix] of ID_PARAMS) {
    const value = c.req.param(param as never) as string | undefined;
    if (!value) continue;
    // `/agents/:id` reuses the `id` param with a different prefix
    const expected = param === "id" && path.startsWith("/v1/agents") ? "agt" : prefix;
    if (!isCanonicalId(expected as IdPrefix, value)) throw new ApiError("not_found", "not found");
  }
  await next();
};

function parseExclude(q: string | undefined): Set<string> | undefined {
  if (!q) return undefined;
  const wanted = q.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = wanted.filter((t) => !(EXCLUDABLE_EVENT_TYPES as readonly string[]).includes(t));
  if (bad.length) throw new ApiError("invalid_request", `these event types cannot be excluded: ${bad.join(", ")}`, { excludable: EXCLUDABLE_EVENT_TYPES });
  return new Set(wanted);
}
