import { createHash, randomUUID } from "node:crypto";
import {
  type AgentDefinition,
  type ProviderConfig,
  type Session,
  type TenantAuthPolicy,
} from "@agent-service/protocol";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MysqlSessionStore,
  SessionGoneError,
  SubjectDeletingError,
  TenantErasureConflictError,
  newErasureRequestId,
  newLegalHoldId,
  tenantErasureRequestHash,
  userErasureRequestHash,
  type RetentionPolicyDocumentV1,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";
import { CurrentMysqlRuntimeOwner, type CurrentMysqlInspection as Connection } from "./fixtures/current-mysql-runtime.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const NOW = 1_900_000_000_000;

type Writer = Awaited<ReturnType<typeof acquireFixtureSessionAuthority>>;

/** Independent full rows after real claim; a rejected ordinary write must publish no business state. */
async function sessionWriteSnapshot(conn: Connection, session: Session): Promise<unknown> {
  const state: Record<string, unknown> = {};
  for (const [table, column, value, order] of [
    ["sessions", "session_id", session.id, "session_id"],
    ["events", "session_id", session.id, "seq"],
    ["items", "session_id", session.id, "item_id"],
    ["turns", "session_id", session.id, "turn_id"],
    ["approvals", "session_id", session.id, "approval_id"],
    ["usage_ledger", "session_id", session.id, "id"],
    ["usage_reconciliations", "session_id", session.id, "deletion_generation"],
    ["lifecycle_outbox", "aggregate_id", session.id, "topic,generation"],
    ["billing_usage_facts", "tenant_id", session.tenantId, "usage_id"],
    ["blob_objects", "session_id", session.id, "blob_id"],
    ["idempotency_keys", "session_id", session.id, "tenant_id,user_id,idem_key"],
  ] as const) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE ${column}=? ORDER BY ${order}`, [value]);
    state[table] = rows;
  }
  return state;
}

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
      `refusing to create tenant credential race database from base database "${database}": `
      + "MYSQL_TEST_URL must name a test database",
    );
  }
  return url;
}

function keyDigest(label: string): string {
  return createHash("sha256").update(`${label}:${randomUUID()}`).digest("hex");
}

function tenantRequestInput(tenantId: string, suffix: string) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `tenant-race-${suffix}-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: NOW,
  };
}

function userRequestInput(tenantId: string, userId: string) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "tenant-admin",
    idempotencyKey: `user-race-${randomUUID()}`,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs: NOW,
  };
}

function provider(tenantId: string, name: string, updatedAtMs: number): ProviderConfig {
  return {
    tenantId,
    id: "race-provider",
    name,
    api: "openai-completions",
    baseUrl: "https://example.com/v1",
    headers: {},
    models: [{
      id: "race-model",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      input: ["text"],
      reasoning: false,
    }],
    quota: {},
    fallback: [],
    createdAtMs: NOW,
    updatedAtMs,
  };
}

function agent(tenantId: string, id = newId("agt")): AgentDefinition {
  return {
    id,
    tenantId,
    version: 1,
    name: "tenant gate race",
    instructions: "test",
    model: { provider: "race-provider", model: "race-model" },
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

async function waitForSubjectLifecycleLockWaiters(
  conn: Connection,
  database: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
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

type RaceContext = Record<string, unknown>;

interface OrdinaryRaceCase {
  name: string;
  prepare: (store: MysqlSessionStore, tenantId: string) => Promise<RaceContext>;
  write: (store: MysqlSessionStore, tenantId: string, context: RaceContext) => Promise<unknown>;
  inspectPhysical: (conn: Connection, tenantId: string, context: RaceContext) => Promise<unknown>;
  assertPhysical: (physical: unknown, writeWon: boolean) => void;
  assertHidden: (store: MysqlSessionStore, tenantId: string, context: RaceContext) => Promise<void>;
  postGateWrite: (store: MysqlSessionStore, tenantId: string, context: RaceContext) => Promise<unknown>;
  rejectedWith: "subject" | "session";
}

const ordinaryRaces: OrdinaryRaceCase[] = [
  {
    name: "provider secret upsert",
    async prepare(store, tenantId) {
      await store.upsertProviderConfig({
        ...provider(tenantId, "before", NOW),
        apiKeyRef: "provider-before-key",
      }, {
        ciphertext: Buffer.from("provider-before"),
        keyId: "provider-before-key",
      });
      return {};
    },
    write: (store, tenantId) => store.upsertProviderConfig({
      ...provider(tenantId, "after", NOW + 1),
      apiKeyRef: "provider-after-key",
    }, {
      ciphertext: Buffer.from("provider-after"),
      keyId: "provider-after-key",
    }),
    async inspectPhysical(conn, tenantId) {
      const [rows] = await conn.query<(RowDataPacket & {
        secret_cipher: Buffer;
        secret_key_id: string;
        updated_at_ms: number;
      })[]>(
        `SELECT secret_cipher, secret_key_id, updated_at_ms FROM provider_configs
          WHERE tenant_id=? AND provider_id='race-provider'`,
        [tenantId],
      );
      return {
        ciphertext: rows[0]?.secret_cipher.toString("utf8"),
        keyId: rows[0]?.secret_key_id,
        updatedAtMs: Number(rows[0]?.updated_at_ms),
      };
    },
    assertPhysical(physical, writeWon) {
      expect(physical).toEqual(writeWon
        ? { ciphertext: "provider-after", keyId: "provider-after-key", updatedAtMs: NOW + 1 }
        : { ciphertext: "provider-before", keyId: "provider-before-key", updatedAtMs: NOW });
    },
    async assertHidden(store, tenantId) {
      expect(await store.getProviderConfig(tenantId, "race-provider")).toBeNull();
    },
    postGateWrite: (store, tenantId) => store.upsertProviderConfig(
      {
        ...provider(tenantId, "too-late", NOW + 2),
        apiKeyRef: "provider-too-late-key",
      },
      { ciphertext: Buffer.from("provider-too-late"), keyId: "provider-too-late-key" },
    ),
    rejectedWith: "subject",
  },
  {
    name: "tenant auth secret set",
    async prepare(store, tenantId) {
      await store.setTenantAuth(tenantId, AUTH_POLICY, {
        ciphertext: Buffer.from("auth-before"),
        keyId: "auth-before-key",
      });
      return {};
    },
    write: (store, tenantId) => store.setTenantAuth(tenantId, AUTH_POLICY, {
      ciphertext: Buffer.from("auth-after"),
      keyId: "auth-after-key",
    }),
    async inspectPhysical(conn, tenantId) {
      const [rows] = await conn.query<(RowDataPacket & {
        auth_secret_cipher: Buffer;
        auth_secret_key_id: string;
      })[]>(
        "SELECT auth_secret_cipher, auth_secret_key_id FROM tenants WHERE tenant_id=?",
        [tenantId],
      );
      return {
        ciphertext: rows[0]?.auth_secret_cipher.toString("utf8"),
        keyId: rows[0]?.auth_secret_key_id,
      };
    },
    assertPhysical(physical, writeWon) {
      expect(physical).toEqual(writeWon
        ? { ciphertext: "auth-after", keyId: "auth-after-key" }
        : { ciphertext: "auth-before", keyId: "auth-before-key" });
    },
    async assertHidden(store, tenantId) {
      expect(await store.getTenant(tenantId)).toBeNull();
    },
    postGateWrite: (store, tenantId) => store.setTenantAuth(tenantId, AUTH_POLICY, {
      ciphertext: Buffer.from("auth-too-late"),
      keyId: "auth-too-late-key",
    }),
    rejectedWith: "subject",
  },
  {
    name: "agent create",
    async prepare(_store, tenantId) {
      return { definition: agent(tenantId) };
    },
    write: (store, _tenantId, context) => store.createAgent(context.definition as AgentDefinition),
    async inspectPhysical(conn, tenantId, context) {
      const definition = context.definition as AgentDefinition;
      const [rows] = await conn.query<(RowDataPacket & { row_count: number })[]>(
        `SELECT COUNT(*) AS row_count FROM agent_versions
          WHERE tenant_id=? AND agent_id=? AND version=1`,
        [tenantId, definition.id],
      );
      return Number(rows[0]?.row_count);
    },
    assertPhysical(physical, writeWon) {
      expect(physical).toBe(writeWon ? 1 : 0);
    },
    async assertHidden(store, tenantId, context) {
      const definition = context.definition as AgentDefinition;
      expect(await store.getAgent(tenantId, definition.id, 1)).toBeNull();
    },
    postGateWrite: (store, tenantId) => store.createAgent(agent(tenantId)),
    rejectedWith: "subject",
  },
  {
    name: "session create",
    async prepare(_store, tenantId) {
      return { session: mkSession(tenantId, `user-${randomUUID()}`) };
    },
    write: (store, _tenantId, context) => store.createSession(
      context.session as ReturnType<typeof mkSession>,
    ),
    async inspectPhysical(conn, _tenantId, context) {
      const session = context.session as ReturnType<typeof mkSession>;
      const [rows] = await conn.query<(RowDataPacket & {
        session_rows: number;
        creation_events: number;
      })[]>(
        `SELECT
           (SELECT COUNT(*) FROM sessions WHERE session_id=?) AS session_rows,
           (SELECT COUNT(*) FROM events
             WHERE session_id=? AND seq=1 AND type='session/created') AS creation_events`,
        [session.id, session.id],
      );
      return {
        sessions: Number(rows[0]?.session_rows),
        events: Number(rows[0]?.creation_events),
      };
    },
    assertPhysical(physical, writeWon) {
      expect(physical).toEqual(writeWon
        ? { sessions: 1, events: 1 }
        : { sessions: 0, events: 0 });
    },
    async assertHidden(store, tenantId, context) {
      const session = context.session as ReturnType<typeof mkSession>;
      expect(await store.getSession(tenantId, session.id)).toBeNull();
    },
    postGateWrite: (store, tenantId) => store.createSession(
      mkSession(tenantId, `late-user-${randomUUID()}`),
    ),
    rejectedWith: "subject",
  },
  {
    name: "provider delete",
    async prepare(store, tenantId) {
      await store.upsertProviderConfig({
        ...provider(tenantId, "delete-me", NOW),
        apiKeyRef: "provider-delete-before-key",
      }, {
        ciphertext: Buffer.from("provider-delete-before"),
        keyId: "provider-delete-before-key",
      });
      return {};
    },
    write: (store, tenantId) => store.deleteProviderConfig(tenantId, "race-provider"),
    async inspectPhysical(conn, tenantId) {
      const [rows] = await conn.query<(RowDataPacket & { row_count: number })[]>(
        `SELECT COUNT(*) AS row_count FROM provider_configs
          WHERE tenant_id=? AND provider_id='race-provider'`,
        [tenantId],
      );
      return Number(rows[0]?.row_count);
    },
    assertPhysical(physical, writeWon) {
      expect(physical).toBe(writeWon ? 0 : 1);
    },
    async assertHidden(store, tenantId) {
      expect(await store.getProviderConfig(tenantId, "race-provider")).toBeNull();
    },
    postGateWrite: (store, tenantId) => store.deleteProviderConfig(tenantId, "race-provider"),
    rejectedWith: "subject",
  },
  {
    name: "retention policy activation",
    async prepare(store, tenantId) {
      await store.putRetentionPolicy({
        tenantId,
        policyVersion: "race-policy-before",
        policy: retentionPolicy(1),
        actorKeyId: "tenant-admin",
        atMs: NOW,
      });
      await store.putRetentionPolicy({
        tenantId,
        policyVersion: "race-policy-next",
        policy: retentionPolicy(2),
        actorKeyId: "tenant-admin",
        atMs: NOW + 1,
      });
      await store.activateRetentionPolicy({
        tenantId,
        policyVersion: "race-policy-before",
        expectedControlGeneration: 0,
        actorKeyId: "tenant-admin",
        atMs: NOW + 2,
      });
      return {};
    },
    write: (store, tenantId) => store.activateRetentionPolicy({
      tenantId,
      policyVersion: "race-policy-next",
      expectedControlGeneration: 1,
      actorKeyId: "tenant-admin",
      atMs: NOW + 3,
    }),
    async inspectPhysical(conn, tenantId) {
      const [rows] = await conn.query<(RowDataPacket & {
        active_policy_version: string;
        control_generation: number;
      })[]>(
        `SELECT active_policy_version, control_generation FROM retention_policy_controls
          WHERE tenant_id=?`,
        [tenantId],
      );
      return {
        policyVersion: rows[0]?.active_policy_version,
        generation: Number(rows[0]?.control_generation),
      };
    },
    assertPhysical(physical, writeWon) {
      expect(physical).toEqual(writeWon
        ? { policyVersion: "race-policy-next", generation: 2 }
        : { policyVersion: "race-policy-before", generation: 1 });
    },
    async assertHidden() {},
    postGateWrite: (store, tenantId) => store.activateRetentionPolicy({
      tenantId,
      policyVersion: "race-policy-next",
      expectedControlGeneration: 1,
      actorKeyId: "tenant-admin",
      atMs: NOW + 4,
    }),
    rejectedWith: "subject",
  },
  {
    name: "legal hold release",
    async prepare(store, tenantId) {
      const holdId = newLegalHoldId();
      await store.setLegalHold({
        tenantId,
        holdId,
        subjectKind: "tenant",
        subjectId: tenantId,
        reasonCode: "litigation",
        expectedControlGeneration: 0,
        actorKeyId: "tenant-admin",
        atMs: NOW,
      });
      return { holdId };
    },
    write: (store, tenantId, context) => store.releaseLegalHold({
      tenantId,
      holdId: context.holdId as string,
      expectedControlGeneration: 1,
      reasonCode: "matter_closed",
      actorKeyId: "tenant-admin",
      atMs: NOW + 1,
    }),
    async inspectPhysical(conn, tenantId, context) {
      const [rows] = await conn.query<(RowDataPacket & {
        state: string;
        released_control_generation: number | null;
      })[]>(
        "SELECT state, released_control_generation FROM legal_holds WHERE tenant_id=? AND hold_id=?",
        [tenantId, context.holdId],
      );
      return {
        state: rows[0]?.state,
        releaseGeneration: rows[0]?.released_control_generation == null
          ? null
          : Number(rows[0].released_control_generation),
      };
    },
    assertPhysical(physical, writeWon) {
      expect(physical).toEqual(writeWon
        ? { state: "released", releaseGeneration: 2 }
        : { state: "active", releaseGeneration: null });
    },
    async assertHidden() {},
    postGateWrite: (store, tenantId, context) => store.releaseLegalHold({
      tenantId,
      holdId: context.holdId as string,
      expectedControlGeneration: 1,
      reasonCode: "matter_closed",
      actorKeyId: "tenant-admin",
      atMs: NOW + 2,
    }),
    rejectedWith: "subject",
  },
  {
    name: "session commit",
    async prepare(store, tenantId) {
      const session = { ...mkSession(tenantId, `user-${randomUUID()}`), title: "before" };
      await store.createSession(session);
      const writer = await acquireFixtureSessionAuthority(store, session, 0);
      return { session, writer };
    },
    write: (store, _tenantId, context) => store.commit((context.writer as Writer).admit({
      sessionId: (context.session as ReturnType<typeof mkSession>).id,
      fence: 1,
      sessionPatch: { title: "after" },
    })),
    async inspectPhysical(conn, _tenantId, context) {
      const session = context.session as ReturnType<typeof mkSession>;
      const [rows] = await conn.query<(RowDataPacket & { title: string })[]>(
        "SELECT title FROM sessions WHERE session_id=?",
        [session.id],
      );
      return rows[0]?.title;
    },
    assertPhysical(physical, writeWon) {
      expect(physical).toBe(writeWon ? "after" : "before");
    },
    async assertHidden(store, tenantId, context) {
      const session = context.session as ReturnType<typeof mkSession>;
      expect(await store.getSession(tenantId, session.id)).toBeNull();
    },
    postGateWrite: (store, _tenantId, context) => store.commit((context.writer as Writer).admit({
      sessionId: (context.session as ReturnType<typeof mkSession>).id,
      fence: 1,
      sessionPatch: { title: "too-late" },
    })),
    rejectedWith: "session",
  },
];

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant credential revocation race matrix", () => {
    let mysqlOwner: CurrentMysqlRuntimeOwner | undefined;
    let database = "";

    beforeAll(async () => {
      mysqlOwner = new CurrentMysqlRuntimeOwner(assertDisposableTestTarget(BASE_MYSQL_URL).toString());
      database = mysqlOwner.database;
      await mysqlOwner.prepare();
    });

    afterAll(async ({}, suite) => {
      type Collected = { type: string; tasks?: readonly Collected[]; result?: { state?: string; errors?: readonly unknown[]; retryCount?: number; repeatCount?: number } };
      const tests: Collected[] = [];
      const collect = (tasks: readonly Collected[]) => { for (const task of tasks) {
        if (task.type === "test") tests.push(task); else if (task.tasks) collect(task.tasks);
      } };
      collect(suite.tasks);
      await mysqlOwner?.close({ successful: tests.length > 0 && tests.every(test => test.result?.state === "pass"
        && !test.result.errors?.length && (test.result.retryCount ?? 0) === 0 && (test.result.repeatCount ?? 0) === 0) });
    });

    it.each(ordinaryRaces)("$name admits only the writer-first or tenant-gate-first result", async (raceCase) => {
      const gateStore = await mysqlOwner!.openStore(2);
      const writeStore = await mysqlOwner!.openStore(2);
      const blocker = await mysqlOwner!.openInspection();
      const tenantId = `tenant_race_${randomUUID()}`;
      const input = tenantRequestInput(tenantId, raceCase.name.replaceAll(" ", "-"));
      try {
        await gateStore.createApiKey(tenantId, "seed-key", keyDigest("seed"));
        const context = await raceCase.prepare(gateStore, tenantId);
        const beforeRacingCommit = raceCase.rejectedWith === "session"
          ? await sessionWriteSnapshot(blocker, context.session as Session) : undefined;

        await blocker.query("START TRANSACTION");
        await blocker.query(
          `SELECT subject_id FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR UPDATE`,
          [tenantId, tenantId],
        );

        const raced = Promise.allSettled([
          gateStore.requestTenantErasure(input),
          raceCase.write(writeStore, tenantId, context),
        ]);
        await waitForSubjectLifecycleLockWaiters(blocker, database, 2);
        await blocker.query("COMMIT");

        const [gateResult, writeResult] = await raced;
        expect(gateResult.status).toBe("fulfilled");
        if (gateResult.status !== "fulfilled") return;

        const writeWon = writeResult.status === "fulfilled";
        if (!writeWon) {
          expect(writeResult.reason).toBeInstanceOf(
            raceCase.rejectedWith === "session" ? SessionGoneError : SubjectDeletingError,
          );
          if (beforeRacingCommit) expect(await sessionWriteSnapshot(blocker, context.session as Session))
            .toEqual(beforeRacingCommit);
        }
        raceCase.assertPhysical(
          await raceCase.inspectPhysical(blocker, tenantId, context),
          writeWon,
        );

        expect(await gateStore.getTenantRuntimeState(tenantId)).toEqual({
          tenantId,
          state: "deleting",
          generation: 1,
          activeRequestId: input.requestId,
        });
        await raceCase.assertHidden(gateStore, tenantId, context);
        const beforeRejectedCommit = raceCase.rejectedWith === "session"
          ? await sessionWriteSnapshot(blocker, context.session as Session) : undefined;
        await expect(raceCase.postGateWrite(writeStore, tenantId, context)).rejects.toBeInstanceOf(
          raceCase.rejectedWith === "session" ? SessionGoneError : SubjectDeletingError,
        );
        if (beforeRejectedCommit) expect(await sessionWriteSnapshot(blocker, context.session as Session))
          .toEqual(beforeRejectedCommit);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
        await writeStore.close();
        await gateStore.close();
      }
    });

    it("linearizes user-erasure admission with tenant admission without dual gate authority", async () => {
      const tenantStore = await mysqlOwner!.openStore(2);
      const userStore = await mysqlOwner!.openStore(2);
      const blocker = await mysqlOwner!.openInspection();
      const tenantId = `tenant_user_race_${randomUUID()}`;
      const userId = `user-${randomUUID()}`;
      const seedHash = keyDigest("user-race-seed");
      const tenantInput = tenantRequestInput(tenantId, "user-erasure");
      const userInput = userRequestInput(tenantId, userId);
      try {
        await tenantStore.createApiKey(tenantId, "seed-key", seedHash);
        await blocker.query("START TRANSACTION");
        await blocker.query(
          `SELECT subject_id FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR UPDATE`,
          [tenantId, tenantId],
        );

        const raced = Promise.allSettled([
          tenantStore.requestTenantErasure(tenantInput),
          userStore.requestUserErasure(userInput),
        ]);
        await waitForSubjectLifecycleLockWaiters(blocker, database, 2);
        await blocker.query("COMMIT");

        const [tenantResult, userResult] = await raced;
        expect([tenantResult, userResult].filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const [rows] = await blocker.query<(RowDataPacket & {
          tenant_admissions: number;
          tenant_fences: number;
          user_requests: number;
        })[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_erasure_admissions
               WHERE tenant_id=? AND request_id=?) AS tenant_admissions,
             (SELECT COUNT(*) FROM tenant_credential_revocation_fences
               WHERE tenant_id=? AND request_id=?) AS tenant_fences,
             (SELECT COUNT(*) FROM erasure_requests
               WHERE tenant_id=? AND request_id=? AND subject_kind='user') AS user_requests`,
          [
            tenantId,
            tenantInput.requestId,
            tenantId,
            tenantInput.requestId,
            tenantId,
            userInput.requestId,
          ],
        );
        const counts = {
          tenantAdmissions: Number(rows[0]?.tenant_admissions),
          tenantFences: Number(rows[0]?.tenant_fences),
          userRequests: Number(rows[0]?.user_requests),
        };

        if (tenantResult.status === "fulfilled") {
          expect(userResult.status).toBe("rejected");
          if (userResult.status === "rejected") {
            expect(userResult.reason).toBeInstanceOf(SubjectDeletingError);
          }
          expect(counts).toEqual({ tenantAdmissions: 1, tenantFences: 1, userRequests: 0 });
          expect(await tenantStore.getTenantRuntimeState(tenantId)).toEqual({
            tenantId,
            state: "deleting",
            generation: 1,
            activeRequestId: tenantInput.requestId,
          });
          expect(await tenantStore.resolveApiKey(seedHash)).toBeNull();
          await expect(userStore.requestUserErasure(userInput))
            .rejects.toBeInstanceOf(SubjectDeletingError);
        } else {
          expect(tenantResult.reason).toBeInstanceOf(TenantErasureConflictError);
          expect(userResult.status).toBe("fulfilled");
          expect(counts).toEqual({ tenantAdmissions: 0, tenantFences: 0, userRequests: 1 });
          expect(await tenantStore.getTenantRuntimeState(tenantId)).toEqual({
            tenantId,
            state: "active",
            generation: 0,
          });
          expect(await tenantStore.resolveApiKey(seedHash)).toMatchObject({
            tenantId,
            keyId: "seed-key",
          });
          expect(await userStore.getUserErasureRequest(tenantId, userId, userInput.requestId))
            .toMatchObject({ requestId: userInput.requestId, subjectKind: "user" });
        }
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
        await userStore.close();
        await tenantStore.close();
      }
    });
  });
} else {
  describe("MysqlSessionStore tenant credential revocation race matrix", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
