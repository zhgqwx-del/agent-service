import { createHash, randomUUID } from "node:crypto";
import {
  type ProviderConfig,
  type TenantAuthPolicy,
} from "@agent-service/protocol";
import mysql, {
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  MysqlSessionStore,
  TenantErasureIntegrityError,
  newErasureRequestId,
  tenantCredentialRevocationClaimTokenSha256,
  tenantCredentialRevocationFenceSha256,
  tenantCredentialRevocationReceiptSha256,
  tenantErasureRequestHash,
  type TenantCredentialRevocationAuthorization,
  type TenantCredentialRevocationClaim,
  type TenantCredentialRevocationReceipt,
} from "../src/index.js";
import { mkSession } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

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

interface CredentialFixture {
  activeKeyHash: string;
  revokedKeyHash: string;
  authCipher: Buffer;
  authKeyId: string;
  providerCipher: Buffer;
  providerKeyId: string;
  providerId: string;
  providerHeaderValue: string;
}

interface CredentialSnapshot {
  apiKeys: Array<Record<string, unknown>>;
  providers: Array<Record<string, unknown>>;
  tenants: Array<Record<string, unknown>>;
}

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create tenant credential revocation fixture from base database "${database}": `
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

function digest(label: string): string {
  return createHash("sha256").update(`${label}:${randomUUID()}`).digest("hex");
}

function provider(
  tenantId: string,
  providerId: string,
  providerHeaderValue: string,
): ProviderConfig {
  const now = Date.now();
  return {
    tenantId,
    id: providerId,
    api: "openai-completions",
    baseUrl: "https://credential-fixture.invalid/v1",
    headers: { "x-fixture-marker": providerHeaderValue },
    models: [{
      id: "fixture-model",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      input: ["text"],
      reasoning: false,
    }],
    quota: {},
    fallback: [],
    createdAtMs: now,
    updatedAtMs: now,
  };
}

async function seedCredentialBearingTenant(
  store: MysqlSessionStore,
  tenantId: string,
  label: string,
): Promise<CredentialFixture> {
  const activeKeyHash = digest(`${label}:active-key`);
  const revokedKeyHash = digest(`${label}:revoked-key`);
  const authCipher = Buffer.from(`auth-material-${label}`);
  const authKeyId = `auth-key-${label}`;
  const providerCipher = Buffer.from(`provider-material-${label}`);
  const providerKeyId = `provider-key-${label}`;
  const providerId = `provider-${label}`;
  const providerHeaderValue = `header-${label}`;

  await store.createSession(mkSession(tenantId, `user-${label}`));
  await store.setTenantAuth(tenantId, AUTH_POLICY, {
    ciphertext: authCipher,
    keyId: authKeyId,
  });
  await store.createApiKey(tenantId, `active-${label}`, activeKeyHash, ["runtime", "admin"]);
  await store.createApiKey(tenantId, `revoked-${label}`, revokedKeyHash, ["runtime"]);
  expect(await store.revokeApiKey(tenantId, `revoked-${label}`)).toBe(true);
  await store.upsertProviderConfig(
    provider(tenantId, providerId, providerHeaderValue),
    { ciphertext: providerCipher, keyId: providerKeyId },
  );

  return {
    activeKeyHash,
    revokedKeyHash,
    authCipher,
    authKeyId,
    providerCipher,
    providerKeyId,
    providerId,
    providerHeaderValue,
  };
}

function tenantRequestInput(tenantId: string) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `physical-revocation-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  };
}

function authorization(
  claim: TenantCredentialRevocationClaim,
): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

async function requestAndClaim(
  store: MysqlSessionStore,
  tenantId: string,
  claimToken: string,
  leaseMs = 60_000,
): Promise<{
  requestId: string;
  claim: TenantCredentialRevocationClaim;
  authorization: TenantCredentialRevocationAuthorization;
}> {
  const input = tenantRequestInput(tenantId);
  await store.requestTenantErasure(input);
  const claim = (await store.claimTenantCredentialRevocations({
    limit: 100,
    leaseMs,
    claimToken,
  })).find((candidate) => candidate.requestId === input.requestId);
  expect(claim).toBeDefined();
  return {
    requestId: input.requestId,
    claim: claim!,
    authorization: authorization(claim!),
  };
}

async function credentialSnapshot(
  conn: Connection,
  tenantId: string,
): Promise<CredentialSnapshot> {
  const [apiKeyRows] = await conn.query<RowDataPacket[]>(
    `SELECT key_hash, key_id, tenant_id, created_at_ms, revoked_at_ms, scopes
       FROM api_keys WHERE tenant_id=? ORDER BY key_hash`,
    [tenantId],
  );
  const [providerRows] = await conn.query<RowDataPacket[]>(
    `SELECT tenant_id, provider_id, config, HEX(secret_cipher) AS secret_cipher_hex,
            secret_key_id, created_at_ms, updated_at_ms
       FROM provider_configs WHERE tenant_id=? ORDER BY provider_id`,
    [tenantId],
  );
  const [tenantRows] = await conn.query<RowDataPacket[]>(
    `SELECT tenant_id, name, auth_policy, HEX(auth_secret_cipher) AS auth_secret_cipher_hex,
            auth_secret_key_id, created_at_ms
       FROM tenants WHERE tenant_id=?`,
    [tenantId],
  );
  // Strip mysql2's RowDataPacket prototypes and normalize JSON values for stable deep equality.
  return JSON.parse(JSON.stringify({
    apiKeys: apiKeyRows,
    providers: providerRows,
    tenants: tenantRows,
  })) as CredentialSnapshot;
}

async function databaseNow(conn: Connection): Promise<number> {
  const [rows] = await conn.query<(RowDataPacket & { now_ms: number })[]>(
    "SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms",
  );
  const value = Number(rows[0]?.now_ms);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid test database clock");
  return value;
}

async function waitForBlockedQuery(
  observer: Connection,
  fragments: string[],
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<RowDataPacket[]>("SHOW FULL PROCESSLIST");
    if (rows.some((row) => {
      const info = String(row.Info ?? row.info ?? "");
      return fragments.every((fragment) => info.includes(fragment));
    })) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for blocked MySQL query: ${fragments.join(" / ")}`);
}

async function waitUntilDatabaseTimePasses(
  observer: Connection,
  timestampMs: number,
): Promise<void> {
  while (await databaseNow(observer) <= timestampMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function seedHistorical0018Admission(
  conn: Connection,
  tenantId: string,
): Promise<{ requestId: string; atMs: number; fenceSha256: string }> {
  const requestId = newErasureRequestId();
  const atMs = Date.now() + 1_000;
  const fenceBase = {
    tenantId,
    requestId,
    subjectGeneration: 1,
    fencedAtMs: atMs,
  };
  const fenceSha256 = tenantCredentialRevocationFenceSha256(fenceBase);
  await conn.beginTransaction();
  try {
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE subject_lifecycle
          SET state='deleting', generation=1, active_request_id=?, updated_at_ms=?
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?
          AND state='active' AND generation=0`,
      [requestId, atMs, tenantId, tenantId],
    );
    if (updated.affectedRows !== 1) throw new Error("historical lifecycle fixture was not gated");
    await conn.query(
      `INSERT INTO tenant_erasure_admissions
         (request_id, tenant_id, subject_generation, requested_by_key_id, idempotency_key,
          request_hash, created_at_ms, gated_at_ms, updated_at_ms, policy_version, policy_hash,
          control_generation)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,0)`,
      [
        requestId,
        tenantId,
        1,
        "platform-lifecycle-admin",
        `historical-0018-${randomUUID()}`,
        tenantErasureRequestHash(tenantId),
        atMs,
        atMs,
        atMs,
      ],
    );
    await conn.query(
      `INSERT INTO erasure_audit_events
         (request_id, seq, event_type, payload, emitted_at_ms)
       VALUES (?,1,'erasure/gated',?,?)`,
      [
        requestId,
        JSON.stringify({
          status: "gated",
          subjectKind: "tenant",
          generation: 1,
          credentialFence: "logical-v1",
        }),
        atMs,
      ],
    );
    await conn.query(
      `INSERT INTO tenant_credential_revocation_fences
         (tenant_id, request_id, subject_generation, fenced_at_ms, evidence_sha256)
       VALUES (?,?,?,?,?)`,
      [tenantId, requestId, 1, atMs, fenceSha256],
    );
    await conn.commit();
    return { requestId, atMs, fenceSha256 };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  }
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant credential physical revocation", () => {
    let baseUrl: URL;
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";

    beforeAll(async () => {
      baseUrl = assertDisposableTestTarget(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
    });

    beforeEach(async () => {
      database = `agent_service_tenant_physical_test_${process.pid}_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      if (!/^agent_service_tenant_physical_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe generated tenant credential physical-revocation database name");
      }
      await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(baseUrl, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterEach(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      database = "";
      mysqlUrl = "";
    });

    afterAll(async () => {
      await admin?.end();
    });

    it("atomically revokes every local credential family, preserves its neighbor, and replays only the exact completion", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-physical-${randomUUID()}`;
      const neighborId = `tenant-neighbor-${randomUUID()}`;
      const target = await seedCredentialBearingTenant(store, tenantId, "target");
      const neighbor = await seedCredentialBearingTenant(store, neighborId, "neighbor");
      const neighborBefore = await credentialSnapshot(conn, neighborId);
      const claimToken = `worker-${randomUUID()}`;
      try {
        const [beforeRows] = await conn.query<(RowDataPacket & {
          key_count: number;
          revoked_count: number;
          provider_count: number;
          session_count: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM api_keys WHERE tenant_id=?) AS key_count,
             (SELECT COUNT(*) FROM api_keys WHERE tenant_id=? AND revoked_at_ms IS NOT NULL)
               AS revoked_count,
             (SELECT COUNT(*) FROM provider_configs WHERE tenant_id=?) AS provider_count,
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS session_count`,
          [tenantId, tenantId, tenantId, tenantId],
        );
        expect({
          keyCount: Number(beforeRows[0]?.key_count),
          revokedCount: Number(beforeRows[0]?.revoked_count),
          providerCount: Number(beforeRows[0]?.provider_count),
          sessionCount: Number(beforeRows[0]?.session_count),
        }).toEqual({ keyCount: 2, revokedCount: 1, providerCount: 1, sessionCount: 1 });

        const fixture = await requestAndClaim(store, tenantId, claimToken);
        const receipt = await store.revokeTenantCredentialMaterial(fixture.authorization);
        expect(receipt).toMatchObject({
          requestId: fixture.requestId,
          tenantId,
          subjectGeneration: 1,
          scope: "local-db-credential-material-v1",
          apiKeyCountBefore: 2,
          apiKeyCountAfter: 0,
          providerConfigCountBefore: 1,
          providerConfigCountAfter: 0,
          authPolicyPresentBefore: true,
          authPolicyPresentAfter: false,
          authSecretCipherPresentBefore: true,
          authSecretCipherPresentAfter: false,
          authSecretKeyIdPresentBefore: true,
          authSecretKeyIdPresentAfter: false,
          completedClaimAttempt: fixture.claim.claimAttempt,
          runtimeDisposition: "not_in_scope",
          externalDisposition: "not_supported",
          contentPurgeRequired: true,
        });
        expect(receipt).not.toBeNull();

        expect(await store.revokeTenantCredentialMaterial(fixture.authorization)).toEqual(receipt);
        expect(await store.revokeTenantCredentialMaterial({
          ...fixture.authorization,
          claimToken: "wrong-response-loss-token",
        })).toBeNull();
        expect(await store.revokeTenantCredentialMaterial({
          ...fixture.authorization,
          claimAttempt: fixture.authorization.claimAttempt + 1,
        })).toBeNull();

        const targetAfter = await credentialSnapshot(conn, tenantId);
        expect(targetAfter.apiKeys).toEqual([]);
        expect(targetAfter.providers).toEqual([]);
        expect(targetAfter.tenants).toHaveLength(1);
        expect(targetAfter.tenants[0]).toMatchObject({
          tenant_id: tenantId,
          auth_policy: null,
          auth_secret_cipher_hex: null,
          auth_secret_key_id: null,
        });
        const [retainedContentRows] = await conn.query<(RowDataPacket & { session_count: number })[]>(
          "SELECT COUNT(*) AS session_count FROM sessions WHERE tenant_id=?",
          [tenantId],
        );
        expect(Number(retainedContentRows[0]?.session_count)).toBe(1);
        expect(await credentialSnapshot(conn, neighborId)).toEqual(neighborBefore);

        const job = await store.getTenantCredentialRevocationJob(tenantId, fixture.requestId);
        expect(job).toMatchObject({
          phase: "credential_store_revoked",
          attempts: fixture.claim.claimAttempt,
          completedClaimAttempt: fixture.claim.claimAttempt,
          completedClaimTokenSha256: receipt!.completedClaimTokenSha256,
        });
        expect(job).not.toHaveProperty("claimToken");
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, fixture.requestId))
          .toEqual(receipt);
        expect(await store.getTenantCredentialRevocationCutover()).toMatchObject({
          singletonId: 1,
          controlGeneration: 1,
          activatedAtMs: receipt!.storeDbTimestampMs,
          firstReceiptSha256: receipt!.receiptSha256,
        });

        const [rawReceiptRows] = await conn.query<RowDataPacket[]>(
          "SELECT * FROM tenant_credential_revocation_receipts WHERE request_id=?",
          [fixture.requestId],
        );
        const durableEvidence = JSON.stringify({ api: receipt, rows: rawReceiptRows });
        for (const forbidden of [
          target.activeKeyHash,
          target.revokedKeyHash,
          target.authCipher.toString("hex"),
          target.authKeyId,
          target.providerCipher.toString("hex"),
          target.providerKeyId,
          target.providerId,
          target.providerHeaderValue,
          claimToken,
          neighbor.activeKeyHash,
          neighbor.providerHeaderValue,
        ]) {
          expect(durableEvidence).not.toContain(forbidden);
        }
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("serializes two tenant completions and binds cutover to exactly one valid first receipt", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 12 });
      const conn = await mysql.createConnection(mysqlUrl);
      const leftTenant = `tenant-concurrent-left-${randomUUID()}`;
      const rightTenant = `tenant-concurrent-right-${randomUUID()}`;
      try {
        await Promise.all([
          seedCredentialBearingTenant(store, leftTenant, "concurrent-left"),
          seedCredentialBearingTenant(store, rightTenant, "concurrent-right"),
        ]);
        // Admission has its own cross-index/gap-lock behavior and is not the concurrency target
        // here. Establish both durable claims first, then race only the irreversible completion
        // transactions against the global cutover serialization point.
        const left = await requestAndClaim(store, leftTenant, `left-${randomUUID()}`);
        const right = await requestAndClaim(store, rightTenant, `right-${randomUUID()}`);
        const [leftReceipt, rightReceipt] = await Promise.all([
          store.revokeTenantCredentialMaterial(left.authorization),
          store.revokeTenantCredentialMaterial(right.authorization),
        ]);
        expect(leftReceipt).not.toBeNull();
        expect(rightReceipt).not.toBeNull();

        const cutover = await store.getTenantCredentialRevocationCutover();
        expect(cutover.controlGeneration).toBe(1);
        if (cutover.controlGeneration !== 1) throw new Error("cutover was not activated");
        const firstReceipt = [leftReceipt!, rightReceipt!].find(
          (receipt) => receipt.receiptSha256 === cutover.firstReceiptSha256,
        );
        expect(firstReceipt).toBeDefined();
        expect(cutover.activatedAtMs).toBe(firstReceipt!.storeDbTimestampMs);
        expect(await store.getTenantCredentialRevocationReceipt(leftTenant, left.requestId))
          .toEqual(leftReceipt);
        expect(await store.getTenantCredentialRevocationReceipt(rightTenant, right.requestId))
          .toEqual(rightReceipt);
        expect((await credentialSnapshot(conn, leftTenant)).apiKeys).toEqual([]);
        expect((await credentialSnapshot(conn, rightTenant)).apiKeys).toEqual([]);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("materializes a valid pre-0019 admission exactly once without activating cutover", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-historical-${randomUUID()}`;
      try {
        await store.createSession(mkSession(tenantId, `user-${randomUUID()}`));
        const legacy = await seedHistorical0018Admission(conn, tenantId);
        expect(await store.getTenantCredentialRevocationJob(tenantId, legacy.requestId)).toBeNull();
        expect(await store.materializeTenantCredentialRevocationJobs({ limit: 10 })).toBe(1);
        expect(await store.materializeTenantCredentialRevocationJobs({ limit: 10 })).toBe(0);
        expect(await store.getTenantCredentialRevocationJob(tenantId, legacy.requestId))
          .toMatchObject({
            requestId: legacy.requestId,
            tenantId,
            subjectGeneration: 1,
            t1FenceSha256: legacy.fenceSha256,
            phase: "queued",
            attempts: 0,
          });
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, legacy.requestId))
          .toBeNull();
        expect(await store.getTenantCredentialRevocationCutover()).toEqual({
          singletonId: 1,
          controlGeneration: 0,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("uses the database clock and gives one concurrent claimant ABA-safe authority after expiry", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-claim-${randomUUID()}`;
      const input = tenantRequestInput(tenantId);
      const leaseMs = 60_000;
      try {
        await seedCredentialBearingTenant(first, tenantId, "claim");
        await first.requestTenantErasure(input);
        const dbBefore = await databaseNow(conn);
        const [left, right] = await Promise.all([
          first.claimTenantCredentialRevocations({
            limit: 1,
            leaseMs,
            claimToken: "aba-token",
          }),
          second.claimTenantCredentialRevocations({
            limit: 1,
            leaseMs,
            claimToken: "competing-token",
          }),
        ]);
        const dbAfter = await databaseNow(conn);
        const claims = [...left, ...right].filter((claim) => claim.requestId === input.requestId);
        expect(claims).toHaveLength(1);
        const firstClaim = claims[0]!;
        expect(firstClaim.claimAttempt).toBe(1);
        expect(firstClaim.leaseUntilMs).toBeGreaterThanOrEqual(dbBefore + leaseMs);
        expect(firstClaim.leaseUntilMs).toBeLessThanOrEqual(dbAfter + leaseMs);
        expect(await first.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs,
          claimToken: "cannot-overlap-live-lease",
        })).toEqual([]);

        const expiredAt = await databaseNow(conn);
        await conn.query(
          `UPDATE tenant_credential_revocation_jobs
              SET lease_until_ms=?, updated_at_ms=GREATEST(updated_at_ms, ?)
            WHERE request_id=? AND tenant_id=?`,
          [expiredAt - 1, expiredAt, input.requestId, tenantId],
        );
        const [reclaimed] = await second.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs,
          // Reuse the same token deliberately: claimAttempt, not token uniqueness, prevents ABA.
          claimToken: firstClaim.claimToken,
        });
        expect(reclaimed).toMatchObject({
          requestId: input.requestId,
          tenantId,
          claimAttempt: 2,
          claimToken: firstClaim.claimToken,
        });
        expect(await first.renewTenantCredentialRevocation(authorization(firstClaim), {
          leaseMs,
        })).toBe(false);
        expect(await first.retryTenantCredentialRevocation(authorization(firstClaim), {
          delayMs: 0,
          errorCode: "temporary_failure",
        })).toBe(false);
        expect(await first.revokeTenantCredentialMaterial(authorization(firstClaim))).toBeNull();
        expect(await second.revokeTenantCredentialMaterial(authorization(reclaimed!)))
          .toMatchObject({ completedClaimAttempt: 2 });
      } finally {
        await conn.end();
        await second.close();
        await first.close();
      }
    });

    it("skips a locked earliest job and claims the next job without duplicate authority", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const observer = await mysql.createConnection(mysqlUrl);
      const leftTenant = `tenant-skip-locked-left-${randomUUID()}`;
      const rightTenant = `tenant-skip-locked-right-${randomUUID()}`;
      let blockerOpen = false;
      let pendingClaim: Promise<TenantCredentialRevocationClaim[]> | undefined;
      try {
        await seedCredentialBearingTenant(store, leftTenant, "skip-locked-left");
        await seedCredentialBearingTenant(store, rightTenant, "skip-locked-right");
        const leftInput = tenantRequestInput(leftTenant);
        const rightInput = tenantRequestInput(rightTenant);
        await store.requestTenantErasure(leftInput);
        await store.requestTenantErasure(rightInput);

        const [orderedRows] = await observer.query<RowDataPacket[]>(
          `SELECT request_id, tenant_id
             FROM tenant_credential_revocation_jobs
            WHERE request_id IN (?, ?)
            ORDER BY available_at_ms, request_id`,
          [leftInput.requestId, rightInput.requestId],
        );
        expect(orderedRows).toHaveLength(2);
        const first = orderedRows[0]!;
        const second = orderedRows[1]!;

        await blocker.beginTransaction();
        blockerOpen = true;
        await blocker.query(
          `SELECT request_id FROM tenant_credential_revocation_jobs
            WHERE request_id=? AND tenant_id=? FOR UPDATE`,
          [String(first.request_id), String(first.tenant_id)],
        );

        pendingClaim = store.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "skip-locked-second-worker",
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const claims = await Promise.race([
          pendingClaim,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("claim waited on an independently locked earliest job")),
              2_000,
            );
          }),
        ]).finally(() => {
          if (timeout !== undefined) clearTimeout(timeout);
        });
        expect(claims).toHaveLength(1);
        expect(claims[0]).toMatchObject({
          requestId: String(second.request_id),
          tenantId: String(second.tenant_id),
          claimAttempt: 1,
        });
        expect(await store.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "skip-locked-no-duplicate-worker",
        })).toEqual([]);

        await blocker.commit();
        blockerOpen = false;
        const releasedClaims = await store.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "skip-locked-first-worker",
        });
        expect(releasedClaims).toHaveLength(1);
        expect(releasedClaims[0]).toMatchObject({
          requestId: String(first.request_id),
          tenantId: String(first.tenant_id),
          claimAttempt: 1,
        });
        expect(await store.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "skip-locked-after-both-worker",
        })).toEqual([]);
      } finally {
        if (blockerOpen) await blocker.rollback().catch(() => {});
        await pendingClaim?.catch(() => {});
        await observer.end();
        await blocker.end();
        await store.close();
      }
    }, 10_000);

    it("requires a live deleting lifecycle for queued claims, controls, deletion, and blocked reads", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-live-proof-${randomUUID()}`;
      const input = tenantRequestInput(tenantId);
      try {
        await seedCredentialBearingTenant(store, tenantId, "live-proof");
        await store.requestTenantErasure(input);
        const updatedAtMs = await databaseNow(conn);
        const resetLifecycle = async (state: "active" | "deleting", generation: number) => {
          const [updated] = await conn.query<mysql.ResultSetHeader>(
            `UPDATE subject_lifecycle
                SET state=?, generation=?, active_request_id=?,
                    updated_at_ms=GREATEST(updated_at_ms, ?)
              WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
            [
              state,
              generation,
              state === "deleting" ? input.requestId : null,
              updatedAtMs,
              tenantId,
              tenantId,
            ],
          );
          expect(updated.affectedRows).toBe(1);
        };

        await resetLifecycle("active", 1);
        await expect(store.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "must-not-claim-active-lifecycle",
        })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(store.getTenantCredentialRevocationJob(tenantId, input.requestId))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);

        await resetLifecycle("deleting", 2);
        await expect(store.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "must-not-claim-generation-mismatch",
        })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [unclaimedRows] = await conn.query<RowDataPacket[]>(
          `SELECT phase, attempts, claim_token, lease_until_ms
             FROM tenant_credential_revocation_jobs WHERE request_id=?`,
          [input.requestId],
        );
        expect(unclaimedRows[0]).toMatchObject({
          phase: "queued",
          attempts: 0,
          claim_token: null,
          lease_until_ms: null,
        });

        await resetLifecycle("deleting", 1);
        const [claim] = await store.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "live-proof-claim",
        });
        expect(claim).toMatchObject({ requestId: input.requestId, tenantId });
        const auth = authorization(claim!);
        const credentialsBefore = await credentialSnapshot(conn, tenantId);

        await resetLifecycle("active", 1);
        await expect(store.renewTenantCredentialRevocation(auth, { leaseMs: 60_000 }))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(store.retryTenantCredentialRevocation(auth, {
          delayMs: 0,
          errorCode: "temporary_failure",
        })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(store.blockTenantCredentialRevocation(auth))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(store.revokeTenantCredentialMaterial(auth))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await credentialSnapshot(conn, tenantId)).toEqual(credentialsBefore);

        await resetLifecycle("deleting", 1);
        expect(await store.blockTenantCredentialRevocation(auth)).toBe(true);
        await resetLifecycle("active", 1);
        await expect(store.getTenantCredentialRevocationJob(tenantId, input.requestId))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("fails closed for a wrong tenant and a UCA-equivalent but raw-different tenant identity", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const suffix = randomUUID();
      const tenantId = `tenant-caf\u00e9-${suffix}`;
      const ucaEquivalent = `tenant-cafe\u0301-${suffix}`;
      const wrongTenant = `tenant-wrong-${suffix}`;
      try {
        const target = await seedCredentialBearingTenant(store, tenantId, "uca");
        const fixture = await requestAndClaim(store, tenantId, "uca-owner-token");
        const before = await credentialSnapshot(conn, tenantId);
        const [comparisonRows] = await conn.query<(RowDataPacket & {
          uca_equal: number;
          binary_equal: number;
        })[]>(
          `SELECT
             CAST(? AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_0900_as_cs =
               CAST(? AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_0900_as_cs AS uca_equal,
             BINARY ? = BINARY ? AS binary_equal`,
          [tenantId, ucaEquivalent, tenantId, ucaEquivalent],
        );
        expect({
          ucaEqual: Number(comparisonRows[0]?.uca_equal),
          binaryEqual: Number(comparisonRows[0]?.binary_equal),
        }).toEqual({ ucaEqual: 1, binaryEqual: 0 });

        expect(await store.revokeTenantCredentialMaterial({
          ...fixture.authorization,
          tenantId: wrongTenant,
        })).toBeNull();
        expect(await store.revokeTenantCredentialMaterial({
          ...fixture.authorization,
          tenantId: ucaEquivalent,
        })).toBeNull();
        expect(await credentialSnapshot(conn, tenantId)).toEqual(before);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, fixture.requestId))
          .toBeNull();

        // Raw identity corruption inside a selected credential range must be caught after owner
        // authorization, not merely hidden by the request preflight. MySQL's UCA collation selects
        // this row for the canonical tenant even though the stored bytes differ.
        await conn.query(
          "UPDATE api_keys SET tenant_id=? WHERE key_hash=?",
          [ucaEquivalent, target.activeKeyHash],
        );
        const corrupted = await credentialSnapshot(conn, tenantId);
        expect(corrupted.apiKeys.some((row) => row.tenant_id === ucaEquivalent)).toBe(true);
        await expect(store.revokeTenantCredentialMaterial(fixture.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await credentialSnapshot(conn, tenantId)).toEqual(corrupted);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, fixture.requestId))
          .toBeNull();

        await conn.query(
          "UPDATE api_keys SET tenant_id=? WHERE key_hash=?",
          [tenantId, target.activeKeyHash],
        );
        expect(await store.revokeTenantCredentialMaterial(fixture.authorization)).not.toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("refuses deletion when an inactive cutover has an orphan receipt", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-orphan-proof-${randomUUID()}`;
      try {
        await seedCredentialBearingTenant(store, tenantId, "orphan-proof-target");
        const fixture = await requestAndClaim(store, tenantId, "orphan-proof-worker");
        const before = await credentialSnapshot(conn, tenantId);
        const orphanBody: Omit<TenantCredentialRevocationReceipt, "receiptSha256"> = {
          scope: "local-db-credential-material-v1",
          requestId: newErasureRequestId(),
          tenantId: `tenant-orphan-${randomUUID()}`,
          subjectGeneration: 1,
          t1FenceSha256: digest("orphan-fence"),
          apiKeyCountBefore: 0,
          apiKeyCountAfter: 0,
          providerConfigCountBefore: 0,
          providerConfigCountAfter: 0,
          authPolicyPresentBefore: false,
          authPolicyPresentAfter: false,
          authSecretCipherPresentBefore: false,
          authSecretCipherPresentAfter: false,
          authSecretKeyIdPresentBefore: false,
          authSecretKeyIdPresentAfter: false,
          storeDbTimestampMs: await databaseNow(conn),
          completedClaimAttempt: 1,
          completedClaimTokenSha256: tenantCredentialRevocationClaimTokenSha256(
            "orphan-proof-token",
          ),
          runtimeDisposition: "not_in_scope",
          externalDisposition: "not_supported",
          contentPurgeRequired: true,
        };
        const orphan: TenantCredentialRevocationReceipt = {
          ...orphanBody,
          receiptSha256: tenantCredentialRevocationReceiptSha256(orphanBody),
        };
        await conn.query(
          `INSERT INTO tenant_credential_revocation_receipts
             (request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
              api_key_count_before, api_key_count_after, provider_config_count_before,
              provider_config_count_after, auth_policy_present_before, auth_policy_present_after,
              auth_secret_cipher_present_before, auth_secret_cipher_present_after,
              auth_secret_key_id_present_before, auth_secret_key_id_present_after,
              store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
              runtime_disposition, external_disposition, content_purge_required, receipt_sha256)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            orphan.requestId,
            orphan.tenantId,
            orphan.subjectGeneration,
            orphan.scope,
            orphan.t1FenceSha256,
            orphan.apiKeyCountBefore,
            orphan.apiKeyCountAfter,
            orphan.providerConfigCountBefore,
            orphan.providerConfigCountAfter,
            orphan.authPolicyPresentBefore,
            orphan.authPolicyPresentAfter,
            orphan.authSecretCipherPresentBefore,
            orphan.authSecretCipherPresentAfter,
            orphan.authSecretKeyIdPresentBefore,
            orphan.authSecretKeyIdPresentAfter,
            orphan.storeDbTimestampMs,
            orphan.completedClaimAttempt,
            orphan.completedClaimTokenSha256,
            orphan.runtimeDisposition,
            orphan.externalDisposition,
            orphan.contentPurgeRequired,
            orphan.receiptSha256,
          ],
        );

        await expect(store.revokeTenantCredentialMaterial(fixture.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await credentialSnapshot(conn, tenantId)).toEqual(before);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, fixture.requestId))
          .toBeNull();
        await expect(store.getTenantCredentialRevocationCutover())
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("refuses deletion when an inactive cutover has an orphan terminal job", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-orphan-terminal-${randomUUID()}`;
      try {
        await seedCredentialBearingTenant(store, tenantId, "orphan-terminal-target");
        const fixture = await requestAndClaim(store, tenantId, "orphan-terminal-worker");
        const before = await credentialSnapshot(conn, tenantId);
        const orphanAtMs = await databaseNow(conn);
        await conn.query(
          `INSERT INTO tenant_credential_revocation_jobs
             (request_id, tenant_id, subject_generation, t1_fence_sha256, phase,
              available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
              created_at_ms, updated_at_ms, credential_store_revoked_at_ms,
              completed_claim_attempt, completed_claim_token_sha256, blocked_at_ms,
              blocked_reason_code)
           VALUES (?,?,1,?,'credential_store_revoked',NULL,1,NULL,NULL,NULL,?,?,?,1,?,NULL,NULL)`,
          [
            newErasureRequestId(),
            `tenant-orphan-terminal-source-${randomUUID()}`,
            digest("orphan-terminal-fence"),
            orphanAtMs,
            orphanAtMs,
            orphanAtMs,
            tenantCredentialRevocationClaimTokenSha256("orphan-terminal-token"),
          ],
        );

        await expect(store.revokeTenantCredentialMaterial(fixture.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await credentialSnapshot(conn, tenantId)).toEqual(before);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, fixture.requestId))
          .toBeNull();
        await expect(store.getTenantCredentialRevocationCutover())
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("refuses the next deletion when active cutover has lost its first receipt", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const firstTenant = `tenant-first-proof-${randomUUID()}`;
      const nextTenant = `tenant-next-proof-${randomUUID()}`;
      try {
        await seedCredentialBearingTenant(store, firstTenant, "first-proof");
        const first = await requestAndClaim(store, firstTenant, "first-proof-worker");
        const firstReceipt = await store.revokeTenantCredentialMaterial(first.authorization);
        expect(firstReceipt).not.toBeNull();

        await seedCredentialBearingTenant(store, nextTenant, "next-proof");
        const next = await requestAndClaim(store, nextTenant, "next-proof-worker");
        const before = await credentialSnapshot(conn, nextTenant);
        for (const trigger of [
          "trg_tenant_credential_receipts_bd_bootstrap",
          "trg_tenant_credential_receipts_bd",
          "trg_tenant_credential_receipts_bd_guard_a",
          "trg_tenant_credential_receipts_bd_guard_b",
        ]) {
          await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``);
        }
        const [deleted] = await conn.query<mysql.ResultSetHeader>(
          "DELETE FROM tenant_credential_revocation_receipts WHERE request_id=?",
          [first.requestId],
        );
        expect(deleted.affectedRows).toBe(1);

        await expect(store.revokeTenantCredentialMaterial(next.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await credentialSnapshot(conn, nextTenant)).toEqual(before);
        expect(await store.getTenantCredentialRevocationReceipt(nextTenant, next.requestId))
          .toBeNull();
        await expect(store.getTenantCredentialRevocationCutover())
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it.each(["missing", "mismatched"] as const)(
      "refuses the next deletion when the active cutover first terminal job is %s",
      async (corruption) => {
        const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
        const conn = await mysql.createConnection(mysqlUrl);
        const firstTenant = `tenant-first-job-proof-${corruption}-${randomUUID()}`;
        const nextTenant = `tenant-next-job-proof-${corruption}-${randomUUID()}`;
        try {
          await seedCredentialBearingTenant(store, firstTenant, `first-job-proof-${corruption}`);
          const first = await requestAndClaim(
            store,
            firstTenant,
            `first-job-proof-worker-${corruption}`,
          );
          expect(await store.revokeTenantCredentialMaterial(first.authorization)).not.toBeNull();

          await seedCredentialBearingTenant(store, nextTenant, `next-job-proof-${corruption}`);
          const next = await requestAndClaim(
            store,
            nextTenant,
            `next-job-proof-worker-${corruption}`,
          );
          const before = await credentialSnapshot(conn, nextTenant);

          const triggerFamily = corruption === "missing" ? "bd" : "bu";
          for (const trigger of [
            `trg_tenant_credential_jobs_${triggerFamily}_bootstrap`,
            `trg_tenant_credential_jobs_${triggerFamily}`,
            `trg_tenant_credential_jobs_${triggerFamily}_guard_a`,
            `trg_tenant_credential_jobs_${triggerFamily}_guard_b`,
          ]) {
            await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``);
          }
          if (corruption === "missing") {
            const [deleted] = await conn.query<mysql.ResultSetHeader>(
              "DELETE FROM tenant_credential_revocation_jobs WHERE request_id=?",
              [first.requestId],
            );
            expect(deleted.affectedRows).toBe(1);
          } else {
            const [updated] = await conn.query<mysql.ResultSetHeader>(
              `UPDATE tenant_credential_revocation_jobs
                  SET completed_claim_token_sha256=?
                WHERE request_id=?`,
              [digest("mismatched-terminal-job-token"), first.requestId],
            );
            expect(updated.affectedRows).toBe(1);
          }

          await expect(store.getTenantCredentialRevocationCutover())
            .rejects.toBeInstanceOf(TenantErasureIntegrityError);
          await expect(store.revokeTenantCredentialMaterial(next.authorization))
            .rejects.toBeInstanceOf(TenantErasureIntegrityError);
          expect(await credentialSnapshot(conn, nextTenant)).toEqual(before);
          expect(await store.getTenantCredentialRevocationReceipt(nextTenant, next.requestId))
            .toBeNull();
        } finally {
          await conn.end();
          await store.close();
        }
      },
    );

    it("keeps the cutover proof valid after the first lifecycle advances to erased", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const firstTenant = `tenant-first-source-proof-${randomUUID()}`;
      const nextTenant = `tenant-next-source-proof-${randomUUID()}`;
      try {
        await seedCredentialBearingTenant(store, firstTenant, "first-source-proof");
        const first = await requestAndClaim(store, firstTenant, "first-source-proof-worker");
        const firstReceipt = await store.revokeTenantCredentialMaterial(first.authorization);
        expect(firstReceipt).not.toBeNull();
        const completedAtMs = await databaseNow(conn);
        const [advanced] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE subject_lifecycle
              SET state='erased', active_request_id=NULL,
                  updated_at_ms=GREATEST(updated_at_ms, ?)
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [completedAtMs, firstTenant, firstTenant],
        );
        expect(advanced.affectedRows).toBe(1);

        expect(await store.getTenantCredentialRevocationJob(firstTenant, first.requestId))
          .toMatchObject({ phase: "credential_store_revoked" });
        expect(await store.getTenantCredentialRevocationReceipt(firstTenant, first.requestId))
          .toEqual(firstReceipt);
        expect(await store.revokeTenantCredentialMaterial(first.authorization)).toEqual(firstReceipt);
        expect(await store.getTenantCredentialRevocationCutover()).toMatchObject({
          controlGeneration: 1,
          firstReceiptSha256: firstReceipt!.receiptSha256,
        });

        await seedCredentialBearingTenant(store, nextTenant, "next-source-proof");
        const next = await requestAndClaim(store, nextTenant, "next-source-proof-worker");
        await expect(store.revokeTenantCredentialMaterial(next.authorization))
          .resolves.toMatchObject({ tenantId: nextTenant });
        expect((await credentialSnapshot(conn, nextTenant)).apiKeys).toEqual([]);
        expect(await store.getTenantCredentialRevocationCutover()).toMatchObject({
          controlGeneration: 1,
          firstReceiptSha256: firstReceipt!.receiptSha256,
        });

        const [removedProjection] = await conn.query<mysql.ResultSetHeader>(
          `DELETE FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
          [firstTenant, firstTenant],
        );
        expect(removedProjection.affectedRows).toBe(1);
        expect(await store.getTenantCredentialRevocationReceipt(firstTenant, first.requestId))
          .toEqual(firstReceipt);
        expect(await store.revokeTenantCredentialMaterial(first.authorization)).toEqual(firstReceipt);
        expect(await store.getTenantCredentialRevocationCutover()).toMatchObject({
          controlGeneration: 1,
          firstReceiptSha256: firstReceipt!.receiptSha256,
        });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("still rejects an active cutover whose append-only first T1 fence is missing", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const firstTenant = `tenant-first-immutable-source-${randomUUID()}`;
      const nextTenant = `tenant-next-immutable-source-${randomUUID()}`;
      try {
        await seedCredentialBearingTenant(store, firstTenant, "first-immutable-source");
        const first = await requestAndClaim(
          store,
          firstTenant,
          "first-immutable-source-worker",
        );
        expect(await store.revokeTenantCredentialMaterial(first.authorization)).not.toBeNull();

        await seedCredentialBearingTenant(store, nextTenant, "next-immutable-source");
        const next = await requestAndClaim(store, nextTenant, "next-immutable-source-worker");
        const before = await credentialSnapshot(conn, nextTenant);
        for (const trigger of [
          "trg_tenant_credential_fences_bd_bootstrap",
          "trg_tenant_credential_fences_bd",
          "trg_tenant_credential_fences_bd_guard_a",
          "trg_tenant_credential_fences_bd_guard_b",
        ]) {
          await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``);
        }
        const [deleted] = await conn.query<mysql.ResultSetHeader>(
          "DELETE FROM tenant_credential_revocation_fences WHERE tenant_id=? AND request_id=?",
          [firstTenant, first.requestId],
        );
        expect(deleted.affectedRows).toBe(1);

        await expect(store.getTenantCredentialRevocationCutover())
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(store.revokeTenantCredentialMaterial(next.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await credentialSnapshot(conn, nextTenant)).toEqual(before);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rechecks the DB clock after a job-lock wait before renew, retry, or block", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const observer = await mysql.createConnection(mysqlUrl);
      const openBlockers: Connection[] = [];
      const leaseMs = 1_500;
      try {
        for (const action of ["renew", "retry", "block"] as const) {
          const tenantId = `tenant-${action}-lock-wait-${randomUUID()}`;
          await seedCredentialBearingTenant(store, tenantId, `${action}-lock-wait`);
          const fixture = await requestAndClaim(
            store,
            tenantId,
            `${action}-lock-wait-worker`,
            leaseMs,
          );
          const blocker = await mysql.createConnection(mysqlUrl);
          openBlockers.push(blocker);
          await blocker.beginTransaction();
          await blocker.query(
            `SELECT request_id FROM tenant_credential_revocation_jobs
              WHERE request_id=? AND tenant_id=? FOR UPDATE`,
            [fixture.requestId, tenantId],
          );

          const pending = action === "renew"
            ? store.renewTenantCredentialRevocation(fixture.authorization, { leaseMs: 60_000 })
            : action === "retry"
              ? store.retryTenantCredentialRevocation(fixture.authorization, {
                delayMs: 0,
                errorCode: "temporary_failure",
              })
              : store.blockTenantCredentialRevocation(fixture.authorization);

          await waitForBlockedQuery(observer, [
            "FROM tenant_credential_revocation_jobs",
            "FOR UPDATE",
          ]);
          expect(await databaseNow(observer)).toBeLessThan(fixture.claim.leaseUntilMs);
          await waitUntilDatabaseTimePasses(observer, fixture.claim.leaseUntilMs);
          await blocker.commit();
          await expect(pending).resolves.toBe(false);
          expect(await store.getTenantCredentialRevocationJob(tenantId, fixture.requestId))
            .toMatchObject({
              phase: "queued",
              claimToken: fixture.claim.claimToken,
              leaseUntilMs: fixture.claim.leaseUntilMs,
              attempts: fixture.claim.claimAttempt,
            });
          await blocker.end();
          openBlockers.pop();
        }
      } finally {
        for (const blocker of openBlockers) {
          await blocker.rollback().catch(() => {});
          await blocker.end().catch(() => {});
        }
        await observer.end();
        await store.close();
      }
    }, 20_000);

    it("rechecks authority after credential lock waits and before the first DELETE", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const blocker = await mysql.createConnection(mysqlUrl);
      const observer = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-delete-lock-wait-${randomUUID()}`;
      try {
        await seedCredentialBearingTenant(store, tenantId, "delete-lock-wait");
        const fixture = await requestAndClaim(
          store,
          tenantId,
          "delete-lock-wait-worker",
          1_500,
        );
        const before = await credentialSnapshot(observer, tenantId);

        await blocker.beginTransaction();
        await blocker.query(
          "SELECT tenant_id FROM tenants WHERE tenant_id=? FOR UPDATE",
          [tenantId],
        );
        const pending = store.revokeTenantCredentialMaterial(fixture.authorization);
        await waitForBlockedQuery(observer, ["FROM tenants", "FOR UPDATE"]);
        expect(await databaseNow(observer)).toBeLessThan(fixture.claim.leaseUntilMs);
        await waitUntilDatabaseTimePasses(observer, fixture.claim.leaseUntilMs);
        await blocker.commit();

        await expect(pending).resolves.toBeNull();
        expect(await credentialSnapshot(observer, tenantId)).toEqual(before);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, fixture.requestId))
          .toBeNull();
        expect(await store.getTenantCredentialRevocationCutover()).toEqual({
          singletonId: 1,
          controlGeneration: 0,
        });

        const [reclaimed] = await store.claimTenantCredentialRevocations({
          limit: 1,
          leaseMs: 60_000,
          claimToken: "delete-lock-wait-reclaimed",
        });
        expect(reclaimed).toMatchObject({
          requestId: fixture.requestId,
          tenantId,
          claimAttempt: fixture.claim.claimAttempt + 1,
        });
        await expect(store.revokeTenantCredentialMaterial(authorization(reclaimed!)))
          .resolves.toMatchObject({ completedClaimAttempt: fixture.claim.claimAttempt + 1 });
      } finally {
        await blocker.rollback().catch(() => {});
        await observer.end();
        await blocker.end();
        await store.close();
      }
    }, 10_000);

    it("rolls back credential deletion, receipt, terminal job, and first cutover on a controlled late SQL fault", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-rollback-${randomUUID()}`;
      const trigger = "test_fail_tenant_credential_cutover_update";
      try {
        await seedCredentialBearingTenant(store, tenantId, "rollback");
        const fixture = await requestAndClaim(store, tenantId, "rollback-worker-token");
        const before = await credentialSnapshot(conn, tenantId);
        await conn.query(
          `CREATE TRIGGER \`${trigger}\`
             BEFORE UPDATE ON tenant_credential_revocation_cutover
             FOR EACH ROW FOLLOWS trg_tenant_credential_cutover_bu_guard_b
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'controlled tenant credential cutover failure'`,
        );

        await expect(store.revokeTenantCredentialMaterial(fixture.authorization))
          .rejects.toThrow("controlled tenant credential cutover failure");
        expect(await credentialSnapshot(conn, tenantId)).toEqual(before);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, fixture.requestId))
          .toBeNull();
        expect(await store.getTenantCredentialRevocationJob(tenantId, fixture.requestId))
          .toMatchObject({
            phase: "queued",
            attempts: fixture.claim.claimAttempt,
            claimToken: fixture.claim.claimToken,
            leaseUntilMs: fixture.claim.leaseUntilMs,
          });
        expect(await store.getTenantCredentialRevocationCutover()).toEqual({
          singletonId: 1,
          controlGeneration: 0,
        });
      } finally {
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``).catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("surfaces bound-proof corruption instead of revoking from a plausible job envelope", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-proof-${randomUUID()}`;
      try {
        await seedCredentialBearingTenant(store, tenantId, "proof");
        const fixture = await requestAndClaim(store, tenantId, "proof-worker-token");
        const before = await credentialSnapshot(conn, tenantId);
        await conn.query(
          "UPDATE subject_lifecycle SET active_request_id=NULL WHERE tenant_id=? AND subject_kind='tenant'",
          [tenantId],
        );
        await expect(store.revokeTenantCredentialMaterial(fixture.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await credentialSnapshot(conn, tenantId)).toEqual(before);
        expect(await store.getTenantCredentialRevocationReceipt(tenantId, fixture.requestId))
          .toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore tenant credential physical revocation", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
