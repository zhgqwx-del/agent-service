import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  emptyUsage,
  type AgentDefinition,
  type Approval,
  type Item,
  type ProviderConfig,
  type Session,
  type TenantAuthPolicy,
  type Turn,
} from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  MysqlSessionStore,
  SessionGoneError,
  SubjectDeletingError,
  TenantErasureConflictError,
  TenantErasureIntegrityError,
  TenantErasureTargetNotFoundError,
  newErasureRequestId,
  newLegalHoldId,
  newUsageId,
  tenantCredentialRevocationFenceSha256,
  tenantErasureRequestHash,
  userErasureRequestHash,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureWriteAuthorization,
  type RetentionPolicyDocumentV1,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const NOW = 1_900_000_000_000;

function retentionPolicy(seed = 0): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 10_000 + seed,
    userErasureGraceMs: 20_000 + seed,
    operationalUsageRetentionMs: 30_000 + seed,
    idempotencyReceiptRetentionMs: 40_000 + seed,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 50_000 + seed,
  };
}

const AUTH_POLICY: TenantAuthPolicy = {
  mode: "end_user_token",
  tokenHeader: "x-end-user-token",
  verifier: {
    kind: "jwt",
    hs256: true,
    algorithms: ["HS256"],
    subjectClaim: "sub",
    clockToleranceSec: 0,
  },
};

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create tenant credential fixture database from base database "${database}": `
      + "MYSQL_TEST_URL must name a test database",
    );
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function keyDigest(label: string): string {
  return createHash("sha256").update(`${label}:${randomUUID()}`).digest("hex");
}

function tenantRequestInput(tenantId: string, idempotencyKey = "tenant-erase-once") {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: NOW,
  };
}

function userRequestInput(tenantId: string, userId: string, atMs = NOW) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "tenant-admin",
    idempotencyKey: `user-erase-${randomUUID()}`,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs,
  };
}

function jobAuthorization(claim: ErasureJobClaim): ErasureJobAuthorization {
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

function writeAuthorization(claim: ErasureJobClaim): ErasureWriteAuthorization {
  if (claim.subjectKind !== "user") throw new Error("test requires a user erasure claim");
  return {
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function claimRequest(
  store: MysqlSessionStore,
  requestId: string,
  nowMs: number,
  claimToken: string,
): Promise<ErasureJobClaim> {
  const claim = (await store.claimErasureJobs({
    nowMs,
    limit: 100,
    leaseMs: 100_000,
    claimToken,
  })).find((candidate) => candidate.requestId === requestId);
  expect(claim).toBeDefined();
  return claim!;
}

async function advanceToAwaitingPurgePolicy(
  store: MysqlSessionStore,
  tenantId: string,
  userId: string,
  atMs: number,
) {
  const input = userRequestInput(tenantId, userId, atMs);
  await store.requestUserErasure(input);
  const transitions = [
    ["gated", "draining"],
    ["draining", "tombstoning"],
    ["tombstoning", "reconciling_usage"],
    ["reconciling_usage", "awaiting_purge_policy"],
  ] as const;
  for (const [index, [fromStatus, toStatus]] of transitions.entries()) {
    const transitionAtMs = atMs + index + 1;
    const claim = await claimRequest(
      store,
      input.requestId,
      transitionAtMs,
      `mysql-authority-${userId.slice(-8)}-${index}`,
    );
    expect(claim.status).toBe(fromStatus);
    expect(await store.transitionErasureJob(jobAuthorization(claim), {
      fromStatus,
      toStatus,
      atMs: transitionAtMs,
      ...(toStatus === "awaiting_purge_policy" ? {} : { availableAtMs: transitionAtMs }),
    })).toBe(true);
  }
  return input;
}

async function installOrphanTenantEvidence(
  conn: Connection,
  evidenceKind: "admission" | "fence",
  tenantId: string,
  atMs: number,
): Promise<void> {
  const requestId = newErasureRequestId();
  if (evidenceKind === "admission") {
    await conn.query(
      `INSERT INTO tenant_erasure_admissions
         (request_id, tenant_id, subject_generation, requested_by_key_id,
          idempotency_key, request_hash, created_at_ms, gated_at_ms, updated_at_ms,
          policy_version, policy_hash, control_generation)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,0)`,
      [
        requestId,
        tenantId,
        1,
        "platform-lifecycle-admin",
        `orphan-authority-${randomUUID()}`,
        tenantErasureRequestHash(tenantId),
        atMs,
        atMs,
        atMs,
      ],
    );
    return;
  }
  const fenceBase = {
    tenantId,
    requestId,
    subjectGeneration: 1,
    fencedAtMs: atMs,
  };
  await conn.query(
    `INSERT INTO tenant_credential_revocation_fences
       (tenant_id, request_id, subject_generation, fenced_at_ms, evidence_sha256)
     VALUES (?,?,?,?,?)`,
    [
      tenantId,
      requestId,
      1,
      atMs,
      tenantCredentialRevocationFenceSha256(fenceBase),
    ],
  );
}

function provider(tenantId: string, id = "provider"): ProviderConfig {
  return {
    tenantId,
    id,
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
    headers: {},
    models: [{
      id: "model",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      input: ["text"],
      reasoning: false,
    }],
    quota: {},
    fallback: [],
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

function agent(tenantId: string, id = newId("agt")): AgentDefinition {
  return {
    id,
    tenantId,
    version: 1,
    name: "tenant fence test",
    instructions: "test",
    model: { provider: "provider", model: "model" },
    tools: [],
    mcpServers: [],
    skills: [],
    limits: {},
    approvalPolicy: "never",
    busyPolicy: "reject",
    sandbox: "none",
    metadata: {},
    createdAtMs: NOW,
  };
}

async function stageUploadedBlob(store: MysqlSessionStore, session: Session, fence: number) {
  const blobId = newId("blob");
  const now = Date.now();
  const staged = {
    owner: { tenantId: session.tenantId, userId: session.userId },
    sessionId: session.id,
    fence,
    blobId,
    purpose: "tool_output" as const,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey: `objects/${blobId.slice("blob_".length)}`,
    uploadToken: `upload-${blobId.slice("blob_".length)}`,
    createdAtMs: now,
    stagingExpiresAtMs: now + 60_000,
  };
  await store.stageBlob(staged);
  await store.markBlobUploaded({
    owner: staged.owner,
    sessionId: staged.sessionId,
    fence: staged.fence,
    blobId: staged.blobId,
    uploadToken: staged.uploadToken,
    sha256: "a".repeat(64),
    sizeBytes: 42,
    contentType: "application/vnd.agent-service.tool-output+json",
    uploadedAtMs: now + 1,
  });
  return staged;
}

async function waitForSubjectLifecycleLockWaiters(
  conn: Connection,
  database: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [rows] = await conn.query<(RowDataPacket & { waiters: number })[]>(
      `SELECT COUNT(DISTINCT waits.REQUESTING_ENGINE_TRANSACTION_ID) AS waiters
         FROM performance_schema.data_lock_waits waits
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA=? AND requested.OBJECT_NAME='subject_lifecycle'`,
      [database],
    );
    if (Number(rows[0]?.waiters ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${expected} subject lifecycle lock waiters`);
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant credential revocation fence", () => {
    let admin: Connection | undefined;
    let mysqlUrl = "";
    let database = "";

    beforeAll(async () => {
      const base = assertDisposableTestTarget(BASE_MYSQL_URL);
      database = `agent_service_tenant_credential_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_tenant_credential_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated tenant credential fixture database name");
      }
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(base, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterAll(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin?.end();
    });

    it("atomically gates every credential family while preserving physical rows and neighbor isolation", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_credential_${randomUUID()}`;
      const neighborId = `tenant_neighbor_${randomUUID()}`;
      const targetSession = mkSession(tenantId, "user-target");
      const neighborSession = mkSession(neighborId, "user-neighbor");
      const sharedAgentId = newId("agt");
      const targetAgent = agent(tenantId, sharedAgentId);
      const neighborAgent = agent(neighborId, sharedAgentId);
      const targetKeyHash = keyDigest("target-key");
      const neighborKeyHash = keyDigest("neighbor-key");
      const targetHoldId = newLegalHoldId();
      try {
        await store.createSession(targetSession);
        await store.createAgent(targetAgent);
        await store.upsertProviderConfig(provider(tenantId), {
          ciphertext: Buffer.from([1, 2, 3, 4]),
          keyId: "local-provider-v1",
        });
        await store.createApiKey(tenantId, "tenant-key", targetKeyHash, ["runtime", "admin"]);
        await store.setTenantAuth(tenantId, AUTH_POLICY, {
          ciphertext: Buffer.from([5, 6, 7, 8]),
          keyId: "local-auth-v1",
        });
        const targetPolicy = await store.putRetentionPolicy({
          tenantId,
          policyVersion: "policy-before",
          policy: retentionPolicy(1),
          actorKeyId: "tenant-admin",
          atMs: NOW,
        });
        await store.putRetentionPolicy({
          tenantId,
          policyVersion: "policy-next",
          policy: retentionPolicy(2),
          actorKeyId: "tenant-admin",
          atMs: NOW + 1,
        });
        await store.activateRetentionPolicy({
          tenantId,
          policyVersion: "policy-before",
          expectedControlGeneration: 0,
          actorKeyId: "tenant-admin",
          atMs: NOW + 2,
        });
        await store.setLegalHold({
          tenantId,
          holdId: targetHoldId,
          subjectKind: "tenant",
          subjectId: tenantId,
          reasonCode: "litigation",
          expectedControlGeneration: 0,
          actorKeyId: "tenant-admin",
          atMs: NOW + 3,
        });

        await store.createSession(neighborSession);
        await store.createAgent(neighborAgent);
        await store.upsertProviderConfig(provider(neighborId), {
          ciphertext: Buffer.from([9, 10, 11, 12]),
          keyId: "neighbor-provider-v1",
        });
        await store.createApiKey(neighborId, "neighbor-key", neighborKeyHash, ["runtime"]);
        await store.setTenantAuth(neighborId, AUTH_POLICY, {
          ciphertext: Buffer.from([13, 14, 15, 16]),
          keyId: "neighbor-auth-v1",
        });

        const input = tenantRequestInput(tenantId);
        const created = await store.requestTenantErasure(input);
        expect(created).toMatchObject({
          requestId: input.requestId,
          tenantId,
          subjectKind: "tenant",
          subjectId: tenantId,
          generation: 1,
          status: "gated",
          attempts: 0,
        });
        expect(created).not.toHaveProperty("availableAtMs");
        expect(await store.getTenantRuntimeState(tenantId)).toEqual({
          tenantId,
          state: "deleting",
          generation: 1,
          activeRequestId: input.requestId,
        });
        expect(await store.getTenantErasureRequest(tenantId, input.requestId)).toEqual(created);
        expect(await store.getTenantCredentialRevocationFence(tenantId, input.requestId)).toEqual({
          tenantId,
          requestId: input.requestId,
          subjectGeneration: 1,
          fencedAtMs: input.atMs,
          evidenceSha256: tenantCredentialRevocationFenceSha256({
            tenantId,
            requestId: input.requestId,
            subjectGeneration: 1,
            fencedAtMs: input.atMs,
          }),
        });
        expect(await store.listErasureAuditEvents(input.requestId)).toEqual([{
          requestId: input.requestId,
          seq: 1,
          type: "erasure/gated",
          payload: {
            status: "gated",
            subjectKind: "tenant",
            generation: 1,
            credentialFence: "logical-v1",
            policyVersion: targetPolicy.policyVersion,
            policyHash: targetPolicy.policySha256,
          },
          emittedAtMs: input.atMs,
        }]);
        const claims = await store.claimErasureJobs({
          nowMs: input.atMs + 1,
          limit: 10,
          leaseMs: 1_000,
          claimToken: "tenant-request-must-remain-dormant",
        });
        expect(claims.some((claim) => claim.requestId === input.requestId)).toBe(false);
        const [queueIsolation] = await conn.query<(RowDataPacket & {
          admissions: number;
          legacy_queue_rows: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE request_id=?) AS admissions,
             (SELECT COUNT(*) FROM erasure_requests WHERE request_id=?) AS legacy_queue_rows`,
          [input.requestId, input.requestId],
        );
        expect({
          admissions: Number(queueIsolation[0]?.admissions),
          legacyQueueRows: Number(queueIsolation[0]?.legacy_queue_rows),
        }).toEqual({ admissions: 1, legacyQueueRows: 0 });

        expect(await store.resolveApiKey(targetKeyHash)).toBeNull();
        expect(await store.listApiKeys(tenantId)).toEqual([]);
        expect(await store.getTenant(tenantId)).toBeNull();
        expect(await store.getProviderConfig(tenantId, "provider")).toBeNull();
        expect(await store.listProviderConfigs(tenantId)).toEqual([]);
        expect(await store.getAgent(tenantId, targetAgent.id, 1)).toBeNull();
        expect(await store.listAgents(tenantId, { limit: 10 })).toEqual({ data: [], nextCursor: null });
        expect(await store.getSession(tenantId, targetSession.id)).toBeNull();
        expect((await store.listSessions(tenantId, { limit: 10 })).data).toEqual([]);

        await expect(store.createApiKey(tenantId, "late-key", keyDigest("late-key")))
          .rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.revokeApiKey(tenantId, "tenant-key"))
          .rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY))
          .rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.upsertProviderConfig(provider(tenantId, "late-provider")))
          .rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.deleteProviderConfig(tenantId, "provider"))
          .rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.createAgent(agent(tenantId)))
          .rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.createSession(mkSession(tenantId, "late-user")))
          .rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.putRetentionPolicy({
          tenantId,
          policyVersion: "policy-after",
          policy: retentionPolicy(3),
          actorKeyId: "tenant-admin",
          atMs: NOW + 4,
        })).rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.activateRetentionPolicy({
          tenantId,
          policyVersion: "policy-next",
          expectedControlGeneration: 1,
          actorKeyId: "tenant-admin",
          atMs: NOW + 4,
        })).rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.setLegalHold({
          tenantId,
          holdId: newLegalHoldId(),
          subjectKind: "tenant",
          subjectId: tenantId,
          reasonCode: "regulatory",
          expectedControlGeneration: 1,
          actorKeyId: "tenant-admin",
          atMs: NOW + 4,
        })).rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.releaseLegalHold({
          tenantId,
          holdId: targetHoldId,
          expectedControlGeneration: 1,
          reasonCode: "matter_closed",
          actorKeyId: "tenant-admin",
          atMs: NOW + 4,
        })).rejects.toBeInstanceOf(SubjectDeletingError);
        await expect(store.commit({
          sessionId: targetSession.id,
          fence: 1,
          sessionPatch: { title: "late" },
        })).rejects.toBeInstanceOf(SessionGoneError);
        expect((await store.getActiveRetentionPolicy(tenantId))?.policy.policyVersion)
          .toBe("policy-before");
        expect(await store.getLegalHold(tenantId, targetHoldId)).toMatchObject({ state: "active" });

        const [retainedRows] = await conn.query<(RowDataPacket & {
          api_key_rows: number;
          provider_secret_rows: number;
          auth_secret_rows: number;
          agent_rows: number;
          session_rows: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM api_keys
               WHERE tenant_id=? AND key_id='tenant-key' AND revoked_at_ms IS NULL) AS api_key_rows,
             (SELECT COUNT(*) FROM provider_configs
               WHERE tenant_id=? AND provider_id='provider' AND secret_cipher IS NOT NULL) AS provider_secret_rows,
             (SELECT COUNT(*) FROM tenants
               WHERE tenant_id=? AND auth_secret_cipher IS NOT NULL) AS auth_secret_rows,
             (SELECT COUNT(*) FROM agent_versions
               WHERE tenant_id=? AND agent_id=? AND version=1) AS agent_rows,
             (SELECT COUNT(*) FROM sessions
               WHERE tenant_id=? AND session_id=?) AS session_rows`,
          [
            tenantId,
            tenantId,
            tenantId,
            tenantId,
            targetAgent.id,
            tenantId,
            targetSession.id,
          ],
        );
        expect({
          apiKeyRows: Number(retainedRows[0]?.api_key_rows),
          providerSecretRows: Number(retainedRows[0]?.provider_secret_rows),
          authSecretRows: Number(retainedRows[0]?.auth_secret_rows),
          agentRows: Number(retainedRows[0]?.agent_rows),
          sessionRows: Number(retainedRows[0]?.session_rows),
        }).toEqual({
          apiKeyRows: 1,
          providerSecretRows: 1,
          authSecretRows: 1,
          agentRows: 1,
          sessionRows: 1,
        });

        expect(await store.resolveApiKey(neighborKeyHash)).toMatchObject({ tenantId: neighborId });
        expect(await store.getTenant(neighborId)).toMatchObject({ tenantId: neighborId });
        expect(await store.getProviderConfig(neighborId, "provider")).toMatchObject({
          config: { tenantId: neighborId },
        });
        expect(await store.getAgent(neighborId, neighborAgent.id, 1)).toMatchObject({ tenantId: neighborId });
        expect(await store.getSession(neighborId, neighborSession.id)).toMatchObject({ tenantId: neighborId });
        const neighborLateHash = keyDigest("neighbor-late-key");
        await store.createApiKey(neighborId, "neighbor-late-key", neighborLateHash);
        expect(await store.resolveApiKey(neighborLateHash)).toMatchObject({ tenantId: neighborId });
        await store.putRetentionPolicy({
          tenantId: neighborId,
          policyVersion: "neighbor-policy",
          policy: retentionPolicy(4),
          actorKeyId: "neighbor-admin",
          atMs: NOW + 4,
        });
        expect(await store.activateRetentionPolicy({
          tenantId: neighborId,
          policyVersion: "neighbor-policy",
          expectedControlGeneration: 0,
          actorKeyId: "neighbor-admin",
          atMs: NOW + 5,
        })).toMatchObject({ activePolicyVersion: "neighbor-policy" });
        const neighborHold = await store.setLegalHold({
          tenantId: neighborId,
          holdId: newLegalHoldId(),
          subjectKind: "tenant",
          subjectId: neighborId,
          reasonCode: "litigation",
          expectedControlGeneration: 0,
          actorKeyId: "neighbor-admin",
          atMs: NOW + 6,
        });
        expect(await store.releaseLegalHold({
          tenantId: neighborId,
          holdId: neighborHold.holdId,
          expectedControlGeneration: 1,
          reasonCode: "matter_closed",
          actorKeyId: "neighbor-admin",
          atMs: NOW + 7,
        })).toMatchObject({ state: "released" });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it.each(["admission", "fence"] as const)(
      "keeps ordinary session data hidden when orphan tenant %s evidence survives active lifecycle state",
      async (evidenceKind) => {
        const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
        const conn = await mysql.createConnection(mysqlUrl);
        const tenantId = `tenant_read_fence_${evidenceKind}_${randomUUID()}`;
        const userId = `user-${randomUUID()}`;
        const neighborId = `tenant_read_neighbor_${evidenceKind}_${randomUUID()}`;
        const session = mkSession(tenantId, userId);
        const neighbor = mkSession(neighborId, `neighbor-user-${randomUUID()}`);
        const now = Date.now();
        const turn: Turn = {
          id: newId("turn"),
          sessionId: session.id,
          status: "inProgress",
          seqStart: 2,
          steps: 0,
          toolCalls: 0,
          usage: emptyUsage(),
          startedAtMs: now,
        };
        const bindableBlob = await (async () => {
          await store.createSession(session);
          await store.createSession(neighbor);
          return stageUploadedBlob(store, session, 1);
        })();
        const readyBlob = await stageUploadedBlob(store, session, 2);
        const item: Item = {
          id: newId("item"),
          sessionId: session.id,
          turnId: turn.id,
          seq: 0,
          step: 1,
          status: "completed",
          createdAtMs: now,
          completedAtMs: now,
          type: "toolResult",
          toolCallId: "call-private",
          name: "private-tool",
          content: [],
          isError: false,
          outputRef: readyBlob.blobId,
        };
        const approval: Approval = {
          id: newId("apr"),
          sessionId: session.id,
          turnId: turn.id,
          itemId: item.id,
          status: "pending",
          toolCallId: "call-private",
          toolName: "private-tool",
          args: {},
          availableDecisions: ["accept", "decline"],
          createdAtMs: now,
          expiresAtMs: now + 60_000,
        };
        const scope = { tenantId, userId, sessionId: session.id };
        const idempotencyKey = `private-${randomUUID()}`;
        const owner = { tenantId, userId };
        try {
          await store.commit({
            sessionId: session.id,
            fence: 3,
            turn,
            items: [item],
            approvals: [approval],
            blobBindings: [{
              blobId: readyBlob.blobId,
              itemId: item.id,
              purpose: "tool_output",
            }],
            usageEntries: [{
              usageId: newUsageId(),
              turnId: turn.id,
              step: 1,
              provider: "private-provider",
              model: "private-model",
              usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 },
              createdAtMs: now,
            }],
            idempotency: {
              scope,
              key: idempotencyKey,
              requestHash: "b".repeat(64),
              value: { sessionId: session.id, turnId: turn.id },
              expiresAtMs: now + 60_000,
            },
            events: [
              { type: "turn/started", sessionId: session.id, emittedAtMs: now, turn },
              { type: "item/completed", sessionId: session.id, emittedAtMs: now, item },
            ],
          });

          expect(await store.getSession(tenantId, session.id)).not.toBeNull();
          expect(await store.getTurn(session.id, turn.id)).not.toBeNull();
          expect(await store.getItem(session.id, item.id)).not.toBeNull();
          expect(await store.getApproval(session.id, approval.id)).not.toBeNull();
          expect(await store.getBindableBlob({
            owner,
            sessionId: session.id,
            blobId: bindableBlob.blobId,
            purpose: "tool_output",
          })).not.toBeNull();
          expect(await store.getReadyBlob({
            owner,
            sessionId: session.id,
            blobId: readyBlob.blobId,
            itemId: item.id,
            purpose: "tool_output",
          })).not.toBeNull();
          expect((await store.queryUsage(tenantId, { groupBy: "total", limit: 10 })).data).toHaveLength(1);
          expect(await store.getIdempotencyKey(scope, idempotencyKey)).not.toBeNull();

          const requestId = newErasureRequestId();
          if (evidenceKind === "admission") {
            await conn.query(
              `INSERT INTO tenant_erasure_admissions
                 (request_id, tenant_id, subject_generation, requested_by_key_id,
                  idempotency_key, request_hash, created_at_ms, gated_at_ms, updated_at_ms,
                  policy_version, policy_hash, control_generation)
               VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,0)`,
              [
                requestId,
                tenantId,
                1,
                "platform-lifecycle-admin",
                `orphan-${randomUUID()}`,
                tenantErasureRequestHash(tenantId),
                now,
                now,
                now,
              ],
            );
          } else {
            const fenceBase = {
              tenantId,
              requestId,
              subjectGeneration: 1,
              fencedAtMs: now,
            };
            await conn.query(
              `INSERT INTO tenant_credential_revocation_fences
                 (tenant_id, request_id, subject_generation, fenced_at_ms, evidence_sha256)
               VALUES (?,?,?,?,?)`,
              [
                tenantId,
                requestId,
                1,
                now,
                tenantCredentialRevocationFenceSha256(fenceBase),
              ],
            );
          }

          await expect(store.getTenantRuntimeState(tenantId))
            .rejects.toThrow("tenant lifecycle and credential fence do not agree");
          expect(await store.getSession(tenantId, session.id)).toBeNull();
          expect(await store.listSessions(tenantId, { limit: 10 })).toEqual({ data: [], nextCursor: null });
          expect(await store.getTurn(session.id, turn.id)).toBeNull();
          expect(await store.listTurns(session.id, { limit: 10 })).toEqual({ data: [], nextCursor: null });
          expect(await store.getItem(session.id, item.id)).toBeNull();
          expect(await store.listItems(session.id, { limit: 10 })).toEqual([]);
          expect(await store.getApproval(session.id, approval.id)).toBeNull();
          expect(await store.listApprovals(session.id, {})).toEqual([]);
          expect(await store.getBindableBlob({
            owner,
            sessionId: session.id,
            blobId: bindableBlob.blobId,
            purpose: "tool_output",
          })).toBeNull();
          expect(await store.getReadyBlob({
            owner,
            sessionId: session.id,
            blobId: readyBlob.blobId,
            itemId: item.id,
            purpose: "tool_output",
          })).toBeNull();
          expect((await store.queryUsage(tenantId, { groupBy: "total", limit: 10 })).data).toEqual([]);
          expect(await store.getIdempotencyKey(scope, idempotencyKey)).toBeNull();

          expect(await store.getSession(neighborId, neighbor.id)).toMatchObject({
            tenantId: neighborId,
            userId: neighbor.userId,
          });
          expect((await store.listSessions(neighborId, { limit: 10 })).data)
            .toEqual([expect.objectContaining({ id: neighbor.id, tenantId: neighborId })]);
          // Maintenance-only raw reads remain available; the fence hides data without deleting it.
          expect(await store.getBlobManifest(readyBlob.blobId)).toMatchObject({
            tenantId,
            sessionId: session.id,
            state: "ready",
          });
        } finally {
          await conn.end();
          await store.close();
        }
      },
    );

    it("rejects a nonexistent tenant atomically with no durable erasure residue", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_missing_${randomUUID()}`;
      const input = tenantRequestInput(tenantId, "missing-target");
      try {
        await expect(store.requestTenantErasure(input))
          .rejects.toBeInstanceOf(TenantErasureTargetNotFoundError);
        const [counts] = await conn.query<(RowDataPacket & {
          tenants: number;
          lifecycles: number;
          requests: number;
          audits: number;
          fences: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenants WHERE tenant_id=?) AS tenants,
             (SELECT COUNT(*) FROM subject_lifecycle WHERE tenant_id=?) AS lifecycles,
             (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE tenant_id=?) AS requests,
             (SELECT COUNT(*) FROM erasure_audit_events WHERE request_id=?) AS audits,
             (SELECT COUNT(*) FROM tenant_credential_revocation_fences WHERE tenant_id=?) AS fences`,
          [tenantId, tenantId, tenantId, input.requestId, tenantId],
        );
        expect({
          tenants: Number(counts[0]?.tenants),
          lifecycles: Number(counts[0]?.lifecycles),
          requests: Number(counts[0]?.requests),
          audits: Number(counts[0]?.audits),
          fences: Number(counts[0]?.fences),
        }).toEqual({ tenants: 0, lifecycles: 0, requests: 0, audits: 0, fences: 0 });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("hides collation aliases when a registered tenant already has a lifecycle row", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const suffix = randomUUID().replaceAll("-", "");
      const registeredTenantId = `tenant_r\u00e9sum\u00e9_${suffix}`;
      const aliasedTenantId = registeredTenantId.normalize("NFD");
      const input = tenantRequestInput(aliasedTenantId, "registry-collation-alias");
      try {
        expect(aliasedTenantId).not.toBe(registeredTenantId);
        await store.createApiKey(
          registeredTenantId,
          "seed-key",
          keyDigest("registry-collation-alias"),
        );

        await expect(store.requestTenantErasure(input))
          .rejects.toBeInstanceOf(TenantErasureTargetNotFoundError);
        expect(await store.getTenantErasureRequest(aliasedTenantId, input.requestId)).toBeNull();

        const [counts] = await conn.query<(RowDataPacket & {
          registeredTenants: number;
          aliasedTenants: number;
          lifecycles: number;
          admissions: number;
          audits: number;
          fences: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenants WHERE BINARY tenant_id=BINARY ?) AS registeredTenants,
             (SELECT COUNT(*) FROM tenants WHERE BINARY tenant_id=BINARY ?) AS aliasedTenants,
             (SELECT COUNT(*) FROM subject_lifecycle WHERE BINARY tenant_id=BINARY ?) AS lifecycles,
             (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE request_id=?) AS admissions,
             (SELECT COUNT(*) FROM erasure_audit_events WHERE request_id=?) AS audits,
             (SELECT COUNT(*) FROM tenant_credential_revocation_fences WHERE request_id=?) AS fences`,
          [
            registeredTenantId,
            aliasedTenantId,
            aliasedTenantId,
            input.requestId,
            input.requestId,
            input.requestId,
          ],
        );
        expect({
          registeredTenants: Number(counts[0]?.registeredTenants),
          aliasedTenants: Number(counts[0]?.aliasedTenants),
          lifecycles: Number(counts[0]?.lifecycles),
          admissions: Number(counts[0]?.admissions),
          audits: Number(counts[0]?.audits),
          fences: Number(counts[0]?.fences),
        }).toEqual({
          registeredTenants: 1,
          aliasedTenants: 0,
          lifecycles: 0,
          admissions: 0,
          audits: 0,
          fences: 0,
        });

        const canonicalInput = tenantRequestInput(
          registeredTenantId,
          "registry-canonical-request",
        );
        const canonical = await store.requestTenantErasure(canonicalInput);
        expect(await store.getTenantErasureRequest(aliasedTenantId, canonical.requestId)).toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("requires exact raw registry authority and rolls back an alias lifecycle insert", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const suffix = randomUUID().replaceAll("-", "");
      const registeredTenantId = `tenant_authority_r\u00e9sum\u00e9_${suffix}`;
      const aliasedTenantId = registeredTenantId.normalize("NFD");
      const input = tenantRequestInput(aliasedTenantId, "registry-only-collation-alias");
      try {
        expect(aliasedTenantId).not.toBe(registeredTenantId);
        // Deliberately model a historical/administrative registry row that predates lifecycle
        // materialization. This forces requestTenantErasure past ensureTenantLifecycleRow and onto
        // the authoritative raw registry comparison; the staged alias lifecycle must roll back.
        await conn.query(
          "INSERT INTO tenants (tenant_id, created_at_ms) VALUES (?,?)",
          [registeredTenantId, NOW],
        );

        await expect(store.requestTenantErasure(input))
          .rejects.toBeInstanceOf(TenantErasureTargetNotFoundError);

        const [counts] = await conn.query<(RowDataPacket & {
          registeredTenants: number;
          aliasedTenants: number;
          lifecycles: number;
          admissions: number;
          audits: number;
          fences: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenants WHERE BINARY tenant_id=BINARY ?) AS registeredTenants,
             (SELECT COUNT(*) FROM tenants WHERE BINARY tenant_id=BINARY ?) AS aliasedTenants,
             (SELECT COUNT(*) FROM subject_lifecycle WHERE BINARY tenant_id=BINARY ?) AS lifecycles,
             (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE request_id=?) AS admissions,
             (SELECT COUNT(*) FROM erasure_audit_events WHERE request_id=?) AS audits,
             (SELECT COUNT(*) FROM tenant_credential_revocation_fences WHERE request_id=?) AS fences`,
          [
            registeredTenantId,
            aliasedTenantId,
            aliasedTenantId,
            input.requestId,
            input.requestId,
            input.requestId,
          ],
        );
        expect({
          registeredTenants: Number(counts[0]?.registeredTenants),
          aliasedTenants: Number(counts[0]?.aliasedTenants),
          lifecycles: Number(counts[0]?.lifecycles),
          admissions: Number(counts[0]?.admissions),
          audits: Number(counts[0]?.audits),
          fences: Number(counts[0]?.fences),
        }).toEqual({
          registeredTenants: 1,
          aliasedTenants: 0,
          lifecycles: 0,
          admissions: 0,
          audits: 0,
          fences: 0,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("replays a committed request before consulting the tenant registry", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_replay_registry_${randomUUID()}`;
      const first = tenantRequestInput(tenantId, "registry-replay");
      try {
        await store.createApiKey(tenantId, "seed-key", keyDigest("registry-replay"));
        const created = await store.requestTenantErasure(first);
        await conn.query("DELETE FROM tenants WHERE tenant_id=?", [tenantId]);
        expect(await store.requestTenantErasure({
          ...first,
          requestId: newErasureRequestId(),
          atMs: first.atMs + 1,
        })).toEqual(created);
        expect(await store.replayTenantErasure({
          tenantId,
          idempotencyKey: first.idempotencyKey,
          requestHash: first.requestHash,
        })).toEqual(created);
        expect(await store.replayTenantErasure({
          tenantId,
          idempotencyKey: "uncommitted-or-different-key",
          requestHash: first.requestHash,
        })).toBeNull();
        const [counts] = await conn.query<(RowDataPacket & {
          admissions: number;
          audits: number;
          fences: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE tenant_id=?) AS admissions,
             (SELECT COUNT(*) FROM erasure_audit_events WHERE request_id=?) AS audits,
             (SELECT COUNT(*) FROM tenant_credential_revocation_fences WHERE tenant_id=?) AS fences`,
          [tenantId, first.requestId, tenantId],
        );
        expect(counts[0]).toMatchObject({ admissions: 1, audits: 1, fences: 1 });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("treats Unicode-canonical idempotency variants as different raw keys", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_replay_exact_${randomUUID()}`;
      const composedKey = "tenant-r\u00e9play";
      const decomposedKey = "tenant-re\u0301play";
      const first = tenantRequestInput(tenantId, composedKey);
      try {
        await store.createApiKey(tenantId, "seed-key", keyDigest("exact-replay"));
        const created = await store.requestTenantErasure(first);
        expect(await store.replayTenantErasure({
          tenantId,
          idempotencyKey: composedKey,
          requestHash: first.requestHash,
        })).toEqual(created);
        expect(await store.replayTenantErasure({
          tenantId,
          idempotencyKey: decomposedKey,
          requestHash: first.requestHash,
        })).toBeNull();
        expect(await store.requestTenantErasure({
          ...first,
          requestId: newErasureRequestId(),
          idempotencyKey: decomposedKey,
          atMs: first.atMs + 1,
        })).toEqual(created);
      } finally {
        await store.close();
      }
    });

    it("validates admission, lifecycle, credential fence, and first audit in one status snapshot", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const assertIntegrityFailure = async (
        promise: Promise<unknown>,
        tenantId: string,
        requestId: string,
      ) => {
        try {
          await promise;
          throw new Error("expected tenant-erasure integrity failure");
        } catch (error) {
          expect(error).toBeInstanceOf(TenantErasureIntegrityError);
          expect((error as Error).message).toBe("tenant erasure integrity proof is invalid");
          expect((error as Error).message).not.toContain(tenantId);
          expect((error as Error).message).not.toContain(requestId);
        }
      };
      try {
        const missingAuditTenant = `tenant_status_audit_${randomUUID()}`;
        const missingAudit = tenantRequestInput(missingAuditTenant, "missing-audit");
        await store.createApiKey(missingAuditTenant, "seed-key", keyDigest("status-audit"));
        await store.requestTenantErasure(missingAudit);
        await conn.query("DELETE FROM erasure_audit_events WHERE request_id=?", [missingAudit.requestId]);
        await assertIntegrityFailure(
          store.getTenantErasureRequest(missingAuditTenant, missingAudit.requestId),
          missingAuditTenant,
          missingAudit.requestId,
        );
        await assertIntegrityFailure(
          store.replayTenantErasure({
            tenantId: missingAuditTenant,
            idempotencyKey: missingAudit.idempotencyKey,
            requestHash: missingAudit.requestHash,
          }),
          missingAuditTenant,
          missingAudit.requestId,
        );

        const lifecycleTenant = `tenant_status_lifecycle_${randomUUID()}`;
        const lifecycleInput = tenantRequestInput(lifecycleTenant, "wrong-lifecycle");
        await store.createApiKey(lifecycleTenant, "seed-key", keyDigest("status-lifecycle"));
        await store.requestTenantErasure(lifecycleInput);
        await conn.query(
          `UPDATE subject_lifecycle SET generation=generation+1
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [lifecycleTenant, lifecycleTenant],
        );
        await assertIntegrityFailure(
          store.getTenantErasureRequest(lifecycleTenant, lifecycleInput.requestId),
          lifecycleTenant,
          lifecycleInput.requestId,
        );

        const missingFenceTenant = `tenant_status_fence_${randomUUID()}`;
        const missingFence = tenantRequestInput(missingFenceTenant, "missing-fence");
        await store.createApiKey(missingFenceTenant, "seed-key", keyDigest("status-fence"));
        await conn.query(
          `INSERT INTO tenant_erasure_admissions
             (request_id, tenant_id, subject_generation, requested_by_key_id, idempotency_key,
              request_hash, created_at_ms, gated_at_ms, updated_at_ms, policy_version, policy_hash,
              control_generation)
           VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,0)`,
          [
            missingFence.requestId,
            missingFenceTenant,
            1,
            missingFence.requestedByKeyId,
            missingFence.idempotencyKey,
            missingFence.requestHash,
            missingFence.atMs,
            missingFence.atMs,
            missingFence.atMs,
          ],
        );
        await conn.query(
          `UPDATE subject_lifecycle
              SET state='deleting', generation=1, active_request_id=?, updated_at_ms=?
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [missingFence.requestId, missingFence.atMs, missingFenceTenant, missingFenceTenant],
        );
        await conn.query(
          `INSERT INTO erasure_audit_events
             (request_id, seq, event_type, payload, emitted_at_ms)
           VALUES (?,1,'erasure/gated',?,?)`,
          [
            missingFence.requestId,
            JSON.stringify({
              status: "gated",
              subjectKind: "tenant",
              generation: 1,
              credentialFence: "logical-v1",
            }),
            missingFence.atMs,
          ],
        );
        await assertIntegrityFailure(
          store.getTenantErasureRequest(missingFenceTenant, missingFence.requestId),
          missingFenceTenant,
          missingFence.requestId,
        );

        const orphanTenant = `tenant_status_orphan_${randomUUID()}`;
        const orphanRequestId = newErasureRequestId();
        await store.createApiKey(orphanTenant, "seed-key", keyDigest("status-orphan"));
        await conn.query(
          `UPDATE subject_lifecycle
              SET state='deleting', generation=1, active_request_id=?, updated_at_ms=?
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [orphanRequestId, NOW, orphanTenant, orphanTenant],
        );
        await assertIntegrityFailure(
          store.getTenantErasureRequest(orphanTenant, orphanRequestId),
          orphanTenant,
          orphanRequestId,
        );
        expect(await store.getTenantErasureRequest(
          `tenant_status_neighbor_${randomUUID()}`,
          missingFence.requestId,
        )).toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back lifecycle, request, audit, and evidence when the final fence insert fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_rollback_${randomUUID()}`;
      const apiKeyHash = keyDigest("rollback-key");
      const input = tenantRequestInput(tenantId, "rollback-key");
      try {
        await store.createApiKey(tenantId, "rollback-key", apiKeyHash, ["runtime"]);
        await store.upsertProviderConfig(provider(tenantId), {
          ciphertext: Buffer.from([21, 22, 23, 24]),
          keyId: "rollback-provider-v1",
        });
        await store.setTenantAuth(tenantId, AUTH_POLICY, {
          ciphertext: Buffer.from([25, 26, 27, 28]),
          keyId: "rollback-auth-v1",
        });
        await conn.query(
          `CREATE TRIGGER fail_tenant_credential_fence_insert
           BEFORE INSERT ON tenant_credential_revocation_fences
           FOR EACH ROW SIGNAL SQLSTATE '45000'
           SET MESSAGE_TEXT='injected tenant credential fence failure'`,
        );

        await expect(store.requestTenantErasure(input))
          .rejects.toThrow("injected tenant credential fence failure");

        expect(await store.getTenantRuntimeState(tenantId)).toEqual({
          tenantId,
          state: "active",
          generation: 0,
        });
        expect(await store.getTenantErasureRequest(tenantId, input.requestId)).toBeNull();
        expect(await store.getTenantCredentialRevocationFence(tenantId, input.requestId)).toBeNull();
        expect(await store.listErasureAuditEvents(input.requestId)).toEqual([]);
        expect(await store.resolveApiKey(apiKeyHash)).toMatchObject({ tenantId, keyId: "rollback-key" });
        expect(await store.getProviderConfig(tenantId, "provider")).toMatchObject({
          config: { tenantId },
          secret: { keyId: "rollback-provider-v1" },
        });
        expect(await store.getTenant(tenantId)).toMatchObject({
          tenantId,
          authSecret: { keyId: "rollback-auth-v1" },
        });
        await expect(store.putRetentionPolicy({
          tenantId,
          policyVersion: "rollback-policy",
          policy: retentionPolicy(5),
          actorKeyId: "rollback-admin",
          atMs: NOW + 1,
        })).resolves.toMatchObject({ policyVersion: "rollback-policy" });
        await expect(store.setLegalHold({
          tenantId,
          holdId: newLegalHoldId(),
          subjectKind: "tenant",
          subjectId: tenantId,
          reasonCode: "litigation",
          expectedControlGeneration: 0,
          actorKeyId: "rollback-admin",
          atMs: NOW + 2,
        })).resolves.toMatchObject({ state: "active" });

        const [counts] = await conn.query<(RowDataPacket & {
          requests: number;
          audits: number;
          fences: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE request_id=?) AS requests,
             (SELECT COUNT(*) FROM erasure_audit_events WHERE request_id=?) AS audits,
             (SELECT COUNT(*) FROM tenant_credential_revocation_fences WHERE request_id=?) AS fences`,
          [input.requestId, input.requestId, input.requestId],
        );
        expect({
          requests: Number(counts[0]?.requests),
          audits: Number(counts[0]?.audits),
          fences: Number(counts[0]?.fences),
        }).toEqual({ requests: 0, audits: 0, fences: 0 });
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS fail_tenant_credential_fence_insert").catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("rolls back admission, lifecycle, audit, fence, job, and idempotency when the final job insert fails", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_job_rollback_${randomUUID()}`;
      const input = tenantRequestInput(tenantId, `job-rollback-${randomUUID()}`);
      try {
        await store.createApiKey(tenantId, "seed-key", keyDigest("job-rollback-seed"));
        await conn.query(
          `CREATE TRIGGER fail_tenant_credential_job_insert
           BEFORE INSERT ON tenant_credential_revocation_jobs
           FOR EACH ROW SIGNAL SQLSTATE '45000'
           SET MESSAGE_TEXT='injected tenant credential job failure'`,
        );

        await expect(store.requestTenantErasure(input))
          .rejects.toThrow("injected tenant credential job failure");

        expect(await store.getTenantRuntimeState(tenantId)).toEqual({
          tenantId,
          state: "active",
          generation: 0,
        });
        expect(await store.getTenantErasureRequest(tenantId, input.requestId)).toBeNull();
        expect(await store.replayTenantErasure({
          tenantId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
        })).toBeNull();
        expect(await store.getTenantCredentialRevocationFence(tenantId, input.requestId)).toBeNull();
        expect(await store.getTenantCredentialRevocationJob(tenantId, input.requestId)).toBeNull();
        expect(await store.listErasureAuditEvents(input.requestId)).toEqual([]);

        const [counts] = await conn.query<(RowDataPacket & {
          admissions: number;
          idempotency_bindings: number;
          audits: number;
          fences: number;
          jobs: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE request_id=?) AS admissions,
             (SELECT COUNT(*) FROM tenant_erasure_admissions
               WHERE tenant_id=? AND idempotency_key=?) AS idempotency_bindings,
             (SELECT COUNT(*) FROM erasure_audit_events WHERE request_id=?) AS audits,
             (SELECT COUNT(*) FROM tenant_credential_revocation_fences WHERE request_id=?) AS fences,
             (SELECT COUNT(*) FROM tenant_credential_revocation_jobs WHERE request_id=?) AS jobs`,
          [
            input.requestId,
            tenantId,
            input.idempotencyKey,
            input.requestId,
            input.requestId,
            input.requestId,
          ],
        );
        expect({
          admissions: Number(counts[0]?.admissions),
          idempotencyBindings: Number(counts[0]?.idempotency_bindings),
          audits: Number(counts[0]?.audits),
          fences: Number(counts[0]?.fences),
          jobs: Number(counts[0]?.jobs),
        }).toEqual({
          admissions: 0,
          idempotencyBindings: 0,
          audits: 0,
          fences: 0,
          jobs: 0,
        });
      } finally {
        await conn.query("DROP TRIGGER IF EXISTS fail_tenant_credential_job_insert").catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("serializes concurrent tenant requests into one generation, request, audit, and fence", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_concurrent_${randomUUID()}`;
      const firstInput = tenantRequestInput(tenantId, "concurrent-left");
      const secondInput = tenantRequestInput(tenantId, "concurrent-right");
      await firstStore.createApiKey(tenantId, "seed-key", keyDigest("concurrent-seed"));
      try {
        await blocker.beginTransaction();
        await blocker.query(
          `SELECT subject_id FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR UPDATE`,
          [tenantId, tenantId],
        );

        const raced = Promise.allSettled([
          firstStore.requestTenantErasure(firstInput),
          secondStore.requestTenantErasure(secondInput),
        ]);
        await waitForSubjectLifecycleLockWaiters(blocker, database, 2);
        await blocker.commit();

        const [first, second] = await raced;
        expect(first.status).toBe("fulfilled");
        expect(second.status).toBe("fulfilled");
        if (first.status !== "fulfilled" || second.status !== "fulfilled") return;
        expect(second.value).toEqual(first.value);
        expect([firstInput.requestId, secondInput.requestId]).toContain(first.value.requestId);
        expect(await firstStore.getTenantRuntimeState(tenantId)).toEqual({
          tenantId,
          state: "deleting",
          generation: 1,
          activeRequestId: first.value.requestId,
        });

        const [counts] = await blocker.query<(RowDataPacket & {
          requests: number;
          audits: number;
          fences: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_erasure_admissions
               WHERE tenant_id=?) AS requests,
             (SELECT COUNT(*) FROM erasure_audit_events a
               JOIN tenant_erasure_admissions r ON r.request_id=a.request_id
              WHERE r.tenant_id=?) AS audits,
             (SELECT COUNT(*) FROM tenant_credential_revocation_fences
               WHERE tenant_id=?) AS fences`,
          [tenantId, tenantId, tenantId],
        );
        expect({
          requests: Number(counts[0]?.requests),
          audits: Number(counts[0]?.audits),
          fences: Number(counts[0]?.fences),
        }).toEqual({ requests: 1, audits: 1, fences: 1 });
      } finally {
        await blocker.rollback().catch(() => {});
        await blocker.end();
        await secondStore.close();
        await firstStore.close();
      }
    });

    it("linearizes an API-key create racing the tenant gate and never authorizes it afterward", async () => {
      const gateStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const keyStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant_key_race_${randomUUID()}`;
      const seedHash = keyDigest("race-seed");
      const racedHash = keyDigest("race-new");
      const input = tenantRequestInput(tenantId, "key-race");
      await gateStore.createApiKey(tenantId, "seed-key", seedHash);
      try {
        await blocker.beginTransaction();
        await blocker.query(
          `SELECT subject_id FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR UPDATE`,
          [tenantId, tenantId],
        );

        const raced = Promise.allSettled([
          gateStore.requestTenantErasure(input),
          keyStore.createApiKey(tenantId, "raced-key", racedHash),
        ]);
        await waitForSubjectLifecycleLockWaiters(blocker, database, 2);
        await blocker.commit();

        const [gated, created] = await raced;
        expect(gated.status).toBe("fulfilled");
        if (gated.status !== "fulfilled") return;

        const [keyRows] = await blocker.query<(RowDataPacket & { key_rows: number })[]>(
          "SELECT COUNT(*) AS key_rows FROM api_keys WHERE tenant_id=? AND key_hash=?",
          [tenantId, racedHash],
        );
        if (created.status === "fulfilled") {
          // Its shared tenant lock necessarily committed before the exclusive gate lock.
          expect(Number(keyRows[0]?.key_rows)).toBe(1);
        } else {
          expect(created.reason).toBeInstanceOf(SubjectDeletingError);
          expect(Number(keyRows[0]?.key_rows)).toBe(0);
        }
        expect(await gateStore.resolveApiKey(seedHash)).toBeNull();
        expect(await gateStore.resolveApiKey(racedHash)).toBeNull();
        await expect(keyStore.createApiKey(tenantId, "after-gate", keyDigest("after-gate")))
          .rejects.toBeInstanceOf(SubjectDeletingError);
      } finally {
        await blocker.rollback().catch(() => {});
        await blocker.end();
        await keyStore.close();
        await gateStore.close();
      }
    });

    it("refuses tenant admission while a user request holds worker authority", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const tenantId = `tenant_user_conflict_${randomUUID()}`;
      const userId = `user-${randomUUID()}`;
      const keyHash = keyDigest("user-conflict-key");
      const userInput = userRequestInput(tenantId, userId);
      try {
        await store.createApiKey(tenantId, "still-live", keyHash);
        await store.requestUserErasure(userInput);
        const claim = (await store.claimErasureJobs({
          nowMs: NOW + 1,
          limit: 10,
          leaseMs: 60_000,
          claimToken: `worker-${randomUUID()}`,
        })).find((candidate) => candidate.requestId === userInput.requestId);
        expect(claim).toMatchObject({
          requestId: userInput.requestId,
          subjectKind: "user",
          status: "gated",
        });

        const tenantInput = tenantRequestInput(tenantId, "blocked-by-user-worker");
        await expect(store.requestTenantErasure(tenantInput))
          .rejects.toBeInstanceOf(TenantErasureConflictError);
        expect(await store.getTenantRuntimeState(tenantId)).toEqual({
          tenantId,
          state: "active",
          generation: 0,
        });
        expect(await store.resolveApiKey(keyHash)).toMatchObject({ tenantId, keyId: "still-live" });
        expect(await store.getTenantErasureRequest(tenantId, tenantInput.requestId)).toBeNull();
        expect(await store.getTenantCredentialRevocationFence(tenantId, tenantInput.requestId)).toBeNull();
      } finally {
        await store.close();
      }
    });

    it("preserves the first tenant that owns an API-key digest", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const ownerTenant = `tenant_digest_owner_${randomUUID()}`;
      const attackerTenant = `tenant_digest_attacker_${randomUUID()}`;
      const sharedHash = keyDigest("shared-digest");
      try {
        await store.createApiKey(ownerTenant, "owner-key", sharedHash, ["runtime", "admin"]);
        await store.createApiKey(attackerTenant, "attacker-key", sharedHash, ["runtime"]);

        expect(await store.resolveApiKey(sharedHash)).toEqual({
          tenantId: ownerTenant,
          keyId: "owner-key",
          scopes: ["runtime", "admin"],
        });
        expect(await store.listApiKeys(attackerTenant)).toEqual([]);
        const [rows] = await conn.query<(RowDataPacket & {
          tenant_id: string;
          key_id: string;
          row_count: number;
        })[]>(
          `SELECT MIN(tenant_id) AS tenant_id, MIN(key_id) AS key_id, COUNT(*) AS row_count
             FROM api_keys WHERE key_hash=?`,
          [sharedHash],
        );
        expect({
          tenantId: rows[0]?.tenant_id,
          keyId: rows[0]?.key_id,
          rowCount: Number(rows[0]?.row_count),
        }).toEqual({ tenantId: ownerTenant, keyId: "owner-key", rowCount: 1 });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it.each(["admission", "fence"] as const)(
      "revokes user worker and purge evaluator authority when orphan tenant %s evidence survives an active lifecycle",
      async (evidenceKind) => {
        const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
        const conn = await mysql.createConnection(mysqlUrl);
        const tenantId = `tenant_authority_${evidenceKind}_${randomUUID()}`;
        const neighborId = `tenant_authority_neighbor_${evidenceKind}_${randomUUID()}`;
        const session = mkSession(tenantId, `user-session-${randomUUID()}`);
        try {
          await store.createSession(session);
          const existingInput = userRequestInput(tenantId, session.userId, NOW + 10);
          await store.requestUserErasure(existingInput);
          const gated = await claimRequest(
            store,
            existingInput.requestId,
            NOW + 11,
            `mysql-existing-gated-${evidenceKind}`,
          );
          expect(await store.transitionErasureJob(jobAuthorization(gated), {
            fromStatus: "gated",
            toStatus: "draining",
            atMs: NOW + 11,
            availableAtMs: NOW + 11,
          })).toBe(true);
          const existingClaim = await claimRequest(
            store,
            existingInput.requestId,
            NOW + 12,
            `mysql-existing-draining-${evidenceKind}`,
          );

          const repairInput = userRequestInput(
            tenantId,
            `user-repair-${randomUUID()}`,
            NOW + 50,
          );
          await store.requestUserErasure(repairInput);
          await conn.query(
            "UPDATE erasure_requests SET available_at_ms=NULL WHERE request_id=?",
            [repairInput.requestId],
          );
          expect(await store.claimErasureJobs({
            nowMs: NOW + 51,
            limit: 1,
            leaseMs: 100_000,
            claimToken: `mysql-repair-quarantine-${evidenceKind}`,
          })).toEqual([]);
          const repairIdentity = {
            tenantId,
            subjectKind: "user" as const,
            subjectId: repairInput.userId,
            requestId: repairInput.requestId,
            subjectGeneration: 1,
          };
          const repairInspection = (await store.inspectErasureJobIntervention(repairIdentity))!;
          expect(repairInspection).toMatchObject({
            reasonCode: "queue_control_invalid",
            allowedActions: ["normalize_queue_control"],
          });

          const scheduleInput = await advanceToAwaitingPurgePolicy(
            store,
            tenantId,
            `user-schedule-${randomUUID()}`,
            NOW + 100,
          );
          const targetEvaluationInput = await advanceToAwaitingPurgePolicy(
            store,
            tenantId,
            `user-evaluation-${randomUUID()}`,
            NOW + 200,
          );
          const neighborEvaluationInput = await advanceToAwaitingPurgePolicy(
            store,
            neighborId,
            `user-evaluation-neighbor-${randomUUID()}`,
            NOW + 300,
          );
          await conn.query(
            "DELETE FROM erasure_policy_evaluation_jobs WHERE request_id=?",
            [scheduleInput.requestId],
          );

          const targetPending = userRequestInput(
            tenantId,
            `user-pending-${randomUUID()}`,
            NOW + 500,
          );
          const neighborPending = userRequestInput(
            neighborId,
            `user-pending-neighbor-${randomUUID()}`,
            NOW + 501,
          );
          await store.requestUserErasure(targetPending);
          await store.requestUserErasure(neighborPending);

          await installOrphanTenantEvidence(conn, evidenceKind, tenantId, NOW + 1_000);
          expect(await store.getSubjectLifecycle(tenantId, "tenant", tenantId)).toMatchObject({
            state: "active",
            generation: 0,
          });
          await expect(store.getTenantRuntimeState(tenantId))
            .rejects.toThrow("tenant lifecycle and credential fence do not agree");

          const existingAuthority = jobAuthorization(existingClaim);
          expect(await store.renewErasureJobClaim(existingAuthority, {
            nowMs: NOW + 1_001,
            leaseMs: 100_000,
          })).toBe(false);
          expect(await store.transitionErasureJob(existingAuthority, {
            fromStatus: "draining",
            toStatus: "tombstoning",
            atMs: NOW + 1_001,
            availableAtMs: NOW + 1_001,
          })).toBe(false);
          await expect(store.applyErasureSessionAction({
            authority: writeAuthorization(existingClaim),
            sessionId: session.id,
            fence: 1,
            action: "fence",
          })).rejects.toThrow("stale erasure authority");
          expect(await store.inspectErasureJobIntervention(repairIdentity)).toMatchObject({
            controlGeneration: repairInspection.controlGeneration,
            allowedActions: ["normalize_queue_control"],
          });
          expect(await store.repairAndResumeErasureJob({
            ...repairIdentity,
            expectedControlGeneration: repairInspection.controlGeneration,
            expectedEvidenceSha256: repairInspection.evidenceSha256,
            actorKeyId: `mysql-repair-admin-${evidenceKind}`,
            actionCode: "normalize_queue_control",
            atMs: NOW + 1_001,
          })).toBe(false);

          const [neighborClaim] = await store.claimErasureJobs({
            nowMs: NOW + 1_001,
            limit: 1,
            leaseMs: 100_000,
            claimToken: `mysql-neighbor-worker-${evidenceKind}`,
          });
          expect(neighborClaim).toMatchObject({
            requestId: neighborPending.requestId,
            tenantId: neighborId,
          });
          expect((await store.getUserErasureRequest(
            tenantId,
            targetPending.userId,
            targetPending.requestId,
          ))?.attempts).toBe(0);

          expect(await store.scheduleAwaitingErasurePolicyEvaluations({
            nowMs: NOW + 1_001,
            limit: 1,
          })).toBe(0);
          expect(await store.getErasurePolicyEvaluationJob(scheduleInput.requestId)).toBeNull();

          const [neighborEvaluationClaim] = await store.claimErasurePolicyEvaluations({
            nowMs: NOW + 1_001,
            limit: 1,
            leaseMs: 100_000,
            claimToken: `mysql-neighbor-evaluator-${evidenceKind}`,
          });
          expect(neighborEvaluationClaim).toMatchObject({
            requestId: neighborEvaluationInput.requestId,
            tenantId: neighborId,
          });
          expect(await store.getErasurePolicyEvaluationJob(targetEvaluationInput.requestId))
            .toMatchObject({ attempts: 0 });
        } finally {
          await conn.end();
          await store.close();
        }
      },
    );
  });
} else {
  describe("MysqlSessionStore tenant credential revocation fence", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
