/** Test-only IPC driver. It is not a product command, bundle or service entry point. */
import { createStructuredTelemetry, type StructuredTelemetryRecord } from "@agent-service/protocol";
import { MysqlSessionStore, attachSessionWriteAdmission, createSessionAcquireCommand, type SessionAcquireInput, type CommitBatch, type PersistedProviderStepFailureSource } from "../../src/index.js";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { captureRefKey } from "../persisted-provider-capture.fixture.js";

type Packet = {
  protocol: "persisted-provider-capture-crash-fixture-v1";
  window: "before-commit" | "after-commit";
  batch: CommitBatch;
  source: PersistedProviderStepFailureSource;
  runtimeEnv: Readonly<{MYSQL_URL:string;MYSQL_SCHEMA_METADATA_SCHEMA:string;MYSQL_SCHEMA_METADATA_DEFINER_USER:string;MYSQL_SCHEMA_METADATA_DEFINER_HOST:string}>;
  authorityCommand: SessionAcquireInput;
};

async function send(value: object): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) { reject(new Error("test IPC unavailable")); return; }
    process.send(value, (error) => error ? reject(new Error("test IPC failed")) : resolve());
  });
}

async function hold(window: Packet["window"], witness: object = {}): Promise<never> {
  await send({ phase: "capture-window", window, ...witness });
  return new Promise<never>(() => {});
}

async function run(packet: Packet): Promise<void> {
  let store: MysqlSessionStore | undefined;
  try {
    if (packet.protocol !== "persisted-provider-capture-crash-fixture-v1"
      || !["before-commit", "after-commit"].includes(packet.window)) throw new Error("test packet invalid");
    const env=packet.runtimeEnv;
    if(!env||Object.keys(env).sort().join("|")!==["MYSQL_URL","MYSQL_SCHEMA_METADATA_SCHEMA","MYSQL_SCHEMA_METADATA_DEFINER_USER","MYSQL_SCHEMA_METADATA_DEFINER_HOST"].sort().join("|")
      ||Object.values(env).some(value=>typeof value!=="string"||value.includes("\0")))throw new Error("test runtime config invalid");
    const rawUrl = env.MYSQL_URL;
    if (!rawUrl) throw new Error("test database unavailable");
    const url = new URL(rawUrl);
    if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || !/^agent_service_test_capture_[0-9a-f]{24}$/.test(decodeURIComponent(url.pathname.slice(1)))) {
      throw new Error("test database must be disposable");
    }
    store = await MysqlSessionStore.connect({ url: rawUrl, migrationMode: "verify", connectionLimit: 1,
      schemaMetadata:{metadataSchema:env.MYSQL_SCHEMA_METADATA_SCHEMA,trustedDefiner:{user:env.MYSQL_SCHEMA_METADATA_DEFINER_USER,host:env.MYSQL_SCHEMA_METADATA_DEFINER_HOST}},
      tenantTelemetryRefKey: captureRefKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true });
    // IPC does not transport a WeakMap proof. Confirm only the original fixed live command;
    // never acquire a new owner, read a new floor, extend TTL or replace its boot/acquisition ID.
    const current=await store.sessionAuthority.confirm(createSessionAcquireCommand(packet.authorityCommand));
    if(!current.ok||current.fence!==packet.batch.fence)throw new Error("test exact authority confirmation unavailable");
    attachSessionWriteAdmission(packet.batch,current.proof);
    const item = packet.batch.items?.find((value) => value.id === packet.source.itemId);
    if (!item || item.type !== "agentMessage" || item.status !== "failed" || item.completedAtMs === undefined) throw new Error("test failed item missing");
    let record: Readonly<StructuredTelemetryRecord> | undefined;
    const telemetry = createStructuredTelemetry({ component: "provider", opaqueRefKey: captureRefKey,
      now: () => item.completedAtMs!, sink: { write(value) { record = value; } } });
    telemetry.warn("provider.upstream_request_failed", { subjectRef: telemetry.opaqueRef("tenant", packet.source.tenantId),
      ownerRef: telemetry.opaqueRef("session", packet.batch.sessionId), errorKind: "unknown" });
    const proof = await store.getTenantTelemetryPersistedProviderCaptureBinding();
    if (!proof || !record) throw new Error("test capture inactive");
    const pool = (store as unknown as { pool: Pool }).pool;
    const getConnection = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const connection = await getConnection();
      const commit = connection.commit.bind(connection);
      connection.commit = async () => {
        if (packet.window === "before-commit") {
          const [rows] = await connection.query<RowDataPacket[]>(`SELECT (s.last_seq=4) AS cursor_ok,
            (SELECT COUNT(*) FROM events e JOIN tenant_telemetry_capture_v2_failure_commit_receipts f
              ON BINARY f.write_operation_sha256=BINARY e.telemetry_capture_v2_operation_sha256
                AND BINARY f.receipt_sha256=BINARY e.telemetry_capture_v2_failure_receipt_sha256
              WHERE BINARY e.session_id=BINARY s.session_id AND e.seq=3 AND e.type='item/completed'
                AND BINARY f.tenant_id=BINARY s.tenant_id AND f.begin_last_seq=2 AND f.end_last_seq=4
                AND f.event_count=2 AND f.source_event_seq=3 AND f.source_step_index=? AND f.fence_token=?)=1 AS receipt_ok
            FROM sessions s WHERE BINARY s.session_id=BINARY ?`, [packet.source.stepIndex, packet.batch.fence, packet.batch.sessionId]);
          if (Number(rows[0]?.cursor_ok) !== 1 || Number(rows[0]?.receipt_ok) !== 1) throw new Error("test uncommitted witness unavailable");
          // Every real SQL write, including the final cursor/fence publication, has finished.
          // The parent sees only booleans, then kills before the actual COMMIT starts.
          await hold("before-commit", { cursorUpdated: true, exactFailureReceipt: true });
        }
        await commit(); // Actual server COMMIT ACK, before the business method can reply.
        await hold("after-commit");
      };
      return connection;
    };
    // This direct trusted-store fixture proves process-death atomicity, not Pi provenance or
    // real configured-fleet/S3 availability. The actual source input is never printed.
    await store.commitPersistedProviderStepFailure({ batch: packet.batch, source: packet.source, record, freshProof: proof });
    throw new Error("test kill window missed");
  } catch {
    await send({ phase: "driver-failed" }).catch(() => {});
    await store?.close().catch(() => {});
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}

process.once("message", (value) => { void run(value as Packet); });
await send({ phase: "driver-ready" });
