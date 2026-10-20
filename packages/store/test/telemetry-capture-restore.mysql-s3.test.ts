import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import mysql, { type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { createStructuredTelemetry, INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH,
  PersistedProviderCaptureFleetRequest, PersistedProviderCaptureFleetResponse,
  persistedProviderCaptureConfiguredFleetRootSha256, type AgentDefinition } from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "../../providers/src/index.js";
import { FakeVendor } from "../../testkit/src/index.js";
import { PiEngine, SessionHost, StaticToolRegistry, TenantRestoreJournalPublicationWorker,
  createPersistedProviderFailureCapture, newId,
  type TenantTelemetryWriterWorker } from "../../core/src/index.js";
import { MemoryEventBus, MemoryLeaseStore, MysqlSessionStore, tenantTelemetryS3ArtifactObjectKey,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA, TenantTelemetryCaptureRestoreIntegrityError,
  tenantTelemetryWriteAdapterResult,
  tenantTelemetryArtifactPayloadCanonicalJson, tenantTelemetryArtifactPayloadSha256,
  canonicalizeTenantTelemetryArtifactPayload,
  tenantTelemetryCaptureRecoveryJobDescriptorSha256, tenantTelemetryWriteClaimTokenSha256,
  readTenantTelemetryCaptureCheckpointFromMysql, tenantTelemetryCaptureCheckpointOperationIdentity,
  validateTenantTelemetryCaptureEpochCutoverReceipt, validateTenantTelemetryCaptureOperationRecoveryPermit,
  validateTenantTelemetryCaptureOperationRecoveryPermitV2, TENANT_TELEMETRY_CAPTURE_LINEAGE_FAMILIES,
  S3TenantBackupCatalogAdapter, S3TenantRestoreJournalAdapter, newErasureRequestId, tenantErasureRequestHash,
  type TenantTelemetryCaptureEpochCutoverReceipt, type TenantTelemetryCaptureRestoreHistoryReceipt,
  type TenantTelemetryCaptureOperationRecoveryPermit, type TenantTelemetryWriteClaim, type TenantTelemetryWriteJobRecord,
  type TenantTelemetryCaptureOperationRecoveryPermitV2, type TenantTelemetryCaptureRecoveryContext,
  type TenantTelemetryPersistedProviderCaptureProof } from "../src/index.js";
import { decodeTenantTelemetryS3Envelope } from "../src/tenant-telemetry-adapter/s3-codec.js";
import { MySqlBackupArtifactFixture, backupArtifactIntegrationEnabled,
  type CapturedCommand } from "./mysql-backup-artifact-test-helper.js";
import { trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";
import { createApp } from "../../../apps/agent-runner/src/app.js";
import { hashApiKey } from "../../../apps/agent-runner/src/auth.js";
import { loadConfig } from "../../../apps/agent-runner/src/config.js";
import { RouterPersistedProviderCaptureGate } from "../../../apps/agent-runner/src/persisted-provider-capture-gate.js";
import { runTelemetryCaptureCli } from "../../../apps/agent-runner/src/telemetry-capture-cli.js";
import { readTelemetryCaptureRefKey } from "../../../apps/agent-runner/src/telemetry-capture-ref-key.js";
import { S3TenantTelemetryWriteAdapter } from "../src/index.js";
import { reconcileTenantTelemetryWriterForStartup } from "../../../apps/agent-runner/src/tenant-telemetry-writer-config.js";
import { createTenantRestoreJournalAdapters, loadTenantRestoreJournalConfig } from "../../../apps/agent-runner/src/tenant-restore-journal-config.js";
import { createRouterApp } from "../../../apps/agent-router/src/app.js";
import { RunnerRegistry } from "../../../apps/agent-router/src/registry.js";
import * as artifactOperations from "../../../apps/agent-runner/src/mysql-backup-artifact.js";

// Same explicit native-backup and capture gates as the two constituent suites.
// The full required S3 driver must enable both and reject a skipped file.
const captureGateValue = process.env.AGENT_SERVICE_TELEMETRY_CAPTURE_INTEGRATION ?? "0";
if (captureGateValue !== "0" && captureGateValue !== "1") throw new Error("capture restore gate must be 0 or 1");
const enabled = backupArtifactIntegrationEnabled && captureGateValue === "1";
const suite = enabled ? describe : describe.skip;
function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("capture restore integration configuration is incomplete");
  return value;
}

async function httpSurface() {
  let origin = "http://127.0.0.1";
  let handler: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
  const server = createServer((incoming, outgoing) => void (async () => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const part of incoming) {
      const bytes = Buffer.from(part); size += bytes.length;
      if (size > 1_000_000) { outgoing.writeHead(413).end(); return; }
      chunks.push(bytes);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const body = Buffer.concat(chunks);
    const response = await handler(new Request(`${origin}${incoming.url}`, {
      method: incoming.method, headers, ...(body.length ? { body: body.toString("utf8") } : {}),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  })().catch(() => { outgoing.writeHead(500).end(); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, server, setHandler(value: typeof handler) { handler = value; } };
}
async function closeHttp(server: Server | undefined) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

suite("capture restore actual encrypted MySQL artifact / HTTP fleet / MinIO", () => {
  async function exerciseCaptureRestore(repeatRestore: boolean) {
    const diagnosticStartedAt = performance.now();
    type RepeatRestoreStage = "fixture_source_begin" | "fixture_source_ready" | "primary_backup_complete"
      | "restore1_ready" | "cp2_created" | "restore2_selected" | "second_five_commands_complete"
      | "runtime2_open" | "p2_claims_ack_complete" | "new_pi2_written" | "final_cold_complete"
      | "cleanup_begin" | "cleanup_end";
    const markRepeatStage = (stage: RepeatRestoreStage) => {
      if (!repeatRestore) return;
      // Closed names and monotonic elapsed time only: never log fixture IDs,
      // endpoints, database rows, dependency errors, or any key material.
      try { console.error(JSON.stringify({ stage,
        elapsedMs: Math.max(0, Math.floor(performance.now() - diagnosticStartedAt)) })); }
      catch { /* Diagnostic output must not replace the real test outcome. */ }
    };
    const databaseBase = new URL(required("MYSQL_TEST_URL")), endpoint = new URL(required("S3_TEST_ENDPOINT"));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseBase.hostname)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
      throw new Error("capture restore requires isolated loopback MySQL and object storage");
    }
    const fixture = new MySqlBackupArtifactFixture();
    const refKey = randomBytes(32), masterKey = randomBytes(32).toString("hex");
    const runtimeKey = "capture-restore-unit-runtime-key", vendorKey = "capture-restore-unit-vendor-key";
    const internalToken = "capture-restore-private-router-token-long", runnerId = "capture-restore-runner";
    const privateError = "capture-restore-private-vendor-message", prompt = "capture-restore-private-prompt";
    const prefix = `capture-restore-tests/${fixture.runId}`;
    const bucket = required("S3_TENANT_TELEMETRY_TEST_BUCKET");
    const failures: unknown[] = [], output: string[] = [], exchanges: { boundary: string; epoch: string }[] = [];
    let bodyFailed = false;
    const vendor = new FakeVendor({ expectApiKey: vendorKey }).script(...Array.from({ length: repeatRestore ? 5 : 4 }, () => ({
      httpError: { status: 429, retryAfter: "0", body: { error: { message: privateError } } },
    })));
    let runner: Awaited<ReturnType<typeof httpSurface>> | undefined;
    let router: Awaited<ReturnType<typeof httpSurface>> | undefined;
    let store: MysqlSessionStore | undefined, host: SessionHost | undefined, registry: RunnerRegistry | undefined;
    let worker: TenantTelemetryWriterWorker | undefined, sink: S3TenantTelemetryWriteAdapter | undefined;
    let providers: ProviderService | undefined;
    let lease: MemoryLeaseStore | undefined, bus: MemoryEventBus | undefined;
    let independent: S3Client | undefined;
    let captureEnv: NodeJS.ProcessEnv;
    let effectiveProof: TenantTelemetryPersistedProviderCaptureProof;
    let captureGate: RouterPersistedProviderCaptureGate;
    let cutoverDiagnostic = "not_called";
    type MaintenanceStage = "factory" | "get_run" | "get_targets" | "get_receipt"
      | "get_runtime_control" | "get_runtime_heads" | "get_journal_control" | "get_journal_targets"
      | "get_binding" | "get_reservation" | "get_history" | "get_cutover" | "record_fence"
      | "seal_replay" | "activate_runtime" | "activate" | "resolve_reservation" | "close";
    const maintenanceSteps = new Map<MaintenanceStage, { entered: number; settled: number; rejected: number }>();
    let firstMaintenanceFailure: { stage: MaintenanceStage; errorKind: string; errno: number | null; sqlState: string | null } | undefined;
    const safeErrorKinds = new Set(["Error", "TypeError", "AbortError", "ApiError",
      "TenantTelemetryCaptureRestoreIntegrityError", "PersistedProviderCaptureIntegrityError", "TenantTelemetryWriteIntegrityError",
      "TenantRestoreJournalConflictError", "TenantRestoreJournalCorruptError", "TenantBackupCatalogIntegrityError"]);
    const safeErrnos = new Set([1040, 1044, 1045, 1054, 1062, 1146, 1205, 1213, 1317, 1644, 2006, 2013]);
    const safeSqlStates = new Set(["HY000", "40001", "45000", "42S02", "42S22", "23000", "28000", "70100"]);
    function observeMaintenance(stage: MaintenanceStage, state: "entered" | "settled" | "rejected", error?: unknown) {
      // Fixed stages and saturating counters only; never collect arguments, return values,
      // error messages, native SQL, response bodies, URLs or key-bearing objects.
      const counts = maintenanceSteps.get(stage) ?? { entered: 0, settled: 0, rejected: 0 };
      counts[state] = Math.min(1_000, counts[state] + 1); maintenanceSteps.set(stage, counts);
      if (firstMaintenanceFailure !== undefined) return; // finally.close cannot replace the first failure.
      cutoverDiagnostic = `${stage}:${state}`;
      if (state !== "rejected") return;
      let errorKind = "unclassified", errno: number | null = null, sqlState: string | null = null;
      try {
        if (error instanceof Error && safeErrorKinds.has(error.name)) errorKind = error.name;
        let current = error;
        for (let depth = 0; depth < 3 && current !== null && typeof current === "object"; depth += 1) {
          const observedErrno: unknown = Reflect.get(current, "errno"), observedState: unknown = Reflect.get(current, "sqlState");
          if (errno === null && typeof observedErrno === "number" && safeErrnos.has(observedErrno)) errno = observedErrno;
          if (sqlState === null && typeof observedState === "string" && safeSqlStates.has(observedState)) sqlState = observedState;
          current = Reflect.get(current, "cause");
        }
      } catch { /* Diagnostics must not replace the original rejected operation. */ }
      firstMaintenanceFailure = { stage, errorKind, errno, sqlState };
    }
    function resetMaintenanceDiagnostics() {
      cutoverDiagnostic = "not_called"; maintenanceSteps.clear(); firstMaintenanceFailure = undefined;
    }
    // A transparent spy delegates every scan to the actual S3 adapter. It is
    // present only in the independent repeat case, never a synthetic chain.
    const journalScan = repeatRestore ? vi.spyOn(S3TenantRestoreJournalAdapter.prototype, "scanRecords") : undefined;
    let journalPublication: { tenantId: string; requestId: string; recordSha256: string;
      operationSha256: string; publicationReceiptSha256: string;
      heads: Awaited<ReturnType<MysqlSessionStore["getTenantRestoreRuntimeHeads"]>> } | undefined;
    let firstJournalFenceSha256: string | undefined;
    const legacyClaims: TenantTelemetryWriteClaim[] = [];
    const legacyJobs = new Map<string, TenantTelemetryWriteJobRecord>();
    const telemetry = createStructuredTelemetry({ component: "runner", opaqueRefKey: refKey,
      sink: { write(record) { output.push(JSON.stringify(record)); } } });
    const logger = { info() {}, warn() {}, error() {} };
    const closedFailure = (result: CapturedCommand) => {
      let code = "unclassified";
      try {
        const value: unknown = JSON.parse(result.stderr);
        const observed = value && typeof value === "object" ? Reflect.get(value, "code") : undefined;
        if (["invalid_configuration", "invalid_durable_state", "catalog_conflict", "catalog_corrupt",
          "catalog_not_ready", "journal_conflict", "operation_deadline", "operation_failed",
          "runtime_head_changed"].includes(observed)) code = observed;
      } catch { /* Output only our closed classification, never dependency text. */ }
      // These four optional artifact strings are already filtered by the helper's
      // closed stage/code/phase allowlists. Do not inspect or stringify its native error.
      const artifact = result.failureDiagnostic === undefined ? null : {
        stage: result.failureDiagnostic.stage, code: result.failureDiagnostic.code,
        productPhase: result.failureDiagnostic.productPhase, productCode: result.failureDiagnostic.productCode,
      };
      const cli = result.cliFailureDiagnostic === undefined ? null : {
        source: result.cliFailureDiagnostic.source, lines: result.cliFailureDiagnostic.lines,
      };
      const diagnostic = JSON.stringify({ artifact, cli, firstMaintenanceFailure: firstMaintenanceFailure ?? null,
        maintenanceSteps: [...maintenanceSteps].map(([stage, counts]) => ({ stage, ...counts })) });
      expect(result.status, `native command failed: ${code}; captureStore=${cutoverDiagnostic}; diagnostic=${diagnostic}`).toBe(0);
      expect(result.stderr).toBe("");
      output.push(result.stdout);
      resetMaintenanceDiagnostics();
    };
    function assertNonemptyJournalScanSince(callCount: number) {
      if (!journalScan) throw new Error("repeat_journal_scan_observer_missing");
      expect(journalScan.mock.calls.slice(callCount).some(([options]) =>
        options.sealedHead.remoteSequence === 1 && options.afterRemoteSequence === 0),
      "actual S3 sealed-prefix scan must include the published record").toBe(true);
    }
    async function publishNonemptyJournal() {
      const source = store!;
      const config = loadTenantRestoreJournalConfig(fixture.journalEnv(), { production: false, store: "mysql" });
      if (!config) throw new Error("repeat_journal_configuration_missing");
      const adapters = createTenantRestoreJournalAdapters(config);
      // This fixture invokes the formal worker explicitly, without starting a
      // daemon. Actual store authorization, S3 publication, ACK and seal remain
      // untouched; the local execution gate only checks this real primary.
      const publisher = new TenantRestoreJournalPublicationWorker({ store: source, adapters, logger,
        canExecute: async () => {
          const [control, runtime] = await Promise.all([
            source.getTenantRestoreJournalControl(), source.getTenantRestoreRuntimeControl(),
          ]);
          return control.controlGeneration === 1 && runtime.state === "active"
            && runtime.lineageKind === "primary" && runtime.runtimeEpochSha256 === effectiveProof!.runtimeEpochSha256;
        } });
      try {
        const tenantId = `${fixture.tenantId}-journal`, requestId = newErasureRequestId();
        await source.createApiKey(tenantId, "journal-source-key", createHash("sha256").update(randomBytes(32)).digest("hex"));
        expect(await source.getTenantRestoreRuntimeHeads()).toMatchObject([{ sealedRemoteSequence: 0 }]);
        expect(await source.requestTenantErasure({ tenantId, requestId, requestedByKeyId: "journal-source-key",
          idempotencyKey: `capture-restore-journal-${randomUUID()}`, requestHash: tenantErasureRequestHash(tenantId),
          atMs: Date.now() })).toMatchObject({ status: "gated", generation: 1 });
        expect(await source.getTenantRestoreJournalPublicationJob(tenantId, requestId))
          .toMatchObject({ phase: "queued", targetAckCount: 0 });
        expect(await publisher.processOnce()).toBe(1);
        expect(await source.getTenantRestoreJournalPublicationJob(tenantId, requestId))
          .toMatchObject({ phase: "published", targetAckCount: 1, remoteCommitCount: 1 });
        const bundle = await source.getTenantRestoreJournalPublicationBundle(tenantId, requestId);
        expect(bundle?.targetAcks).toHaveLength(1);
        expect(bundle?.receipt).toMatchObject({ restoreFencePublicationComplete: true, allDomainsComplete: false });
        const ack = bundle?.targetAcks[0], receipt = bundle?.receipt;
        if (!ack || !receipt) throw new Error("repeat_journal_publication_missing");
        const heads = await source.getTenantRestoreRuntimeHeads();
        expect(heads).toHaveLength(1); expect(heads[0]).toMatchObject({ sealedRemoteSequence: 1,
          sealedHeadRootSha256: ack.headRootSha256, targetSha256: ack.targetSha256 });
        journalPublication = { tenantId, requestId, recordSha256: ack.recordSha256,
          operationSha256: ack.operationSha256, publicationReceiptSha256: receipt.receiptSha256, heads };
      } finally { await publisher.stop(); }
    }
    async function assertRestoredNonemptyJournal(restoreRunId: string) {
      if (!journalPublication) throw new Error("repeat_journal_publication_missing");
      const source = store!, published = journalPublication;
      expect(await source.getTenantRestoreRuntimeHeads()).toEqual(published.heads);
      expect(await source.getTenantRestoreReplaySealedTargets(restoreRunId)).toEqual(published.heads);
      const run = await source.getTenantRestoreReplayRun(restoreRunId);
      expect(run).toMatchObject({ phase: "active", expectedEntryCount: 1, entryCount: 1, fenceCount: 1 });
      const entries = await source.listTenantRestoreReplayEntries(restoreRunId, { limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ restoreRunId, remoteSequence: 1, requestId: published.requestId,
        tenantId: published.tenantId, recordSha256: published.recordSha256, operationSha256: published.operationSha256 });
      expect(await source.getTenantRestoreReplayReceipt(restoreRunId)).toMatchObject({ entryCount: 1, fenceCount: 1,
        receiptSha256: run?.terminalReceiptSha256, restoreFenceReplayComplete: true, allDomainsComplete: false });
      const fence = await source.getTenantRestoreFence(published.tenantId);
      expect(fence).toMatchObject({ requestId: published.requestId, recordSha256: published.recordSha256,
        operationSha256: published.operationSha256, sourceRemoteSequence: 1 });
      if (!fence) throw new Error("repeat_journal_restore_fence_missing");
      if (firstJournalFenceSha256) expect(fence.fenceSha256).toBe(firstJournalFenceSha256);
      else firstJournalFenceSha256 = fence.fenceSha256;
      expect((await source.getTenantRestoreJournalPublicationBundle(published.tenantId, published.requestId))?.receipt?.receiptSha256)
        .toBe(published.publicationReceiptSha256);
    }
    async function stopRuntime() {
      const closeFailures: unknown[] = [];
      runner?.setHandler(async () => new Response(null, { status: 503 }));
      router?.setHandler(async () => new Response(null, { status: 503 }));
      const closingHost = host; host = undefined;
      try { await closingHost?.drain(2_000); } catch (error) { closeFailures.push(error); }
      // Preserve the real worker's settlement barrier before closing its store.
      // A failed host drain must not skip that barrier or any later resource.
      const closingWorker = worker; worker = undefined; sink = undefined;
      try { await closingWorker?.stop(); } catch (error) { closeFailures.push(error); }
      const closingRegistry = registry, closingBus = bus, closingLease = lease, closingStore = store;
      registry = undefined; bus = undefined; lease = undefined; store = undefined;
      for (const close of [() => closingRegistry?.close(), () => closingBus?.close(),
        () => closingLease?.close(), () => closingStore?.close()]) {
        try { await close(); } catch (error) { closeFailures.push(error); }
      }
      if (closeFailures.length) throw new Error("capture_restore_runtime_cleanup_failed");
    }
    async function startRuntime(url: string) {
      store = await MysqlSessionStore.connect({ url, connectionLimit: 6, migrationMode: "verify",
        tenantTelemetryRefKey: refKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true });
      effectiveProof = (await store.getTenantTelemetryPersistedProviderCaptureBinding())!;
      expect(effectiveProof).not.toBeNull();
      // Both the gate and actual runner readiness must carry the same boot ID.
      const bootId = randomUUID();
      captureGate = new RouterPersistedProviderCaptureGate({ routerBaseUrl: router!.origin, internalToken, runnerId, bootId });
      // The operator's one-shot key-file/ACKs are not runtime authority. Pass
      // only this closed sink configuration set into the real runner parser.
      const runtimeSinkEnv = Object.fromEntries([
        "TENANT_TELEMETRY_WRITER_ADAPTER", "TENANT_TELEMETRY_S3_NAMESPACE_ID",
        "TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID", "TENANT_TELEMETRY_S3_BUCKET",
        "TENANT_TELEMETRY_S3_PREFIX", "TENANT_TELEMETRY_S3_REGION",
        "TENANT_TELEMETRY_S3_ENDPOINT", "TENANT_TELEMETRY_S3_FORCE_PATH_STYLE",
        "TENANT_TELEMETRY_S3_PRIVATE_BUCKET_ACK", "TENANT_TELEMETRY_S3_ACCESS_KEY_ID",
        "TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY",
      ].map((name) => [name, captureEnv[name]]));
      const config = loadConfig({ ...runtimeSinkEnv, MYSQL_URL: url, NODE_ENV: "test", STORE: "mysql",
        // Parser-only placeholders: the native Store/Host above is explicit, not main metadata admission.
        MYSQL_SCHEMA_METADATA_SCHEMA: "mock_capture_restore_metadata", MYSQL_SCHEMA_METADATA_DEFINER_USER: "mock_capture_restore_definer",
        MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost",
        RUNNER_ID: runnerId, RUNNER_ADDR: runner!.origin, SECRETS_MASTER_KEY: masterKey,
        TENANT_TELEMETRY_REF_KEY: refKey.toString("hex"), TENANT_TELEMETRY_WRITER_ENABLED: "1",
        PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED: "1", INTERNAL_ROUTER_TOKEN: internalToken,
        ERASURE_ROUTER_URL: router!.origin, TENANT_TELEMETRY_WRITER_RETRY_BASE_MS: "10" });
      const assembled = await reconcileTenantTelemetryWriterForStartup(store, config, logger, {
        requireFreshFleet: (expected, boundary) => captureGate.requireFreshFleet(expected, boundary),
      });
      worker = assembled.worker; sink = assembled.adapter as S3TenantTelemetryWriteAdapter;
      expect(assembled.persistedCaptureActive).toBe(true); expect(assembled.captureActive).toBe(false);
      expect(assembled.adapter).toBeInstanceOf(S3TenantTelemetryWriteAdapter);
      const cipher = new LocalAesGcmCipher(masterKey), tools = new StaticToolRegistry([]);
      providers = new ProviderService({ store, cipher, assertBaseUrl: async () => {}, telemetry,
        persistedProviderFailureCaptureActive: true });
      lease = new MemoryLeaseStore(); bus = new MemoryEventBus();
      host = new SessionHost({ store, lease, bus, providers, tools, engine: new PiEngine(providers.models),
        logger, persistedProviderFailureCapture: createPersistedProviderFailureCapture({ store, opaqueRefKey: refKey,
          requireFreshFleet: (expected, boundary) => captureGate.requireFreshFleet(expected, boundary) }),
        config: { runnerId, runnerAddr: runner!.origin, leaseTtlMs: 5_000, leaseHoldMs: 1 } });
      const app = createApp({ store, host, providers, tools, runnerId, internalRouterToken: internalToken,
        heartbeatMs: 1_000, maxBodyBytes: 1_000_000, ready: () => true, telemetry,
        decryptSecret: (secret) => cipher.decrypt(secret.ciphertext, secret.keyId),
        encryptSecret: async (plain) => ({ ciphertext: await cipher.encrypt(plain), keyId: cipher.keyId }),
        assertPublicUrl: async () => {}, persistedProviderCapture: { bootId, localEnabled: true, writerEnabled: true,
          getBinding: () => store!.getTenantTelemetryPersistedProviderCaptureBinding() } });
      runner!.setHandler((request) => Promise.resolve(app.fetch(request)));
      registry = new RunnerRegistry({ runners: [runner!.origin], internalRouterToken: internalToken,
        healthIntervalMs: 60_000, healthTimeoutMs: 5_000 });
      const routerApp = createRouterApp({ registry, internalRunnerToken: internalToken, ready: () => true,
        persistedProviderFailureCaptureFleetEnabled: () => true, telemetry });
      router!.setHandler(async (request) => {
        const fleet = new URL(request.url).pathname === INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH;
        const input = fleet ? PersistedProviderCaptureFleetRequest.parse(await request.clone().json()) : undefined;
        const response = await routerApp.fetch(request);
        if (input && response.status === 200) {
          const observed = PersistedProviderCaptureFleetResponse.parse(await response.clone().json());
          expect(observed.nonce).toBe(input.nonce); expect(observed.proof).toEqual(effectiveProof);
          expect(response.headers.get("cache-control")).toBe("no-store");
          exchanges.push({ boundary: input.boundary, epoch: observed.proof.runtimeEpochSha256 });
        }
        return response;
      });
      registry.start(); await registry.waitForFirstProbe();
      expect(registry.list().every((entry) => entry.healthy)).toBe(true);
    }
    async function request(path: string, body?: unknown) {
      const response = await fetch(`${router!.origin}${path}`, {
        method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${runtimeKey}`, "x-user-id": fixture.userId, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBeLessThan(300);
      return response.json() as Promise<Record<string, unknown>>;
    }
    async function failureTurn(agentId: string) {
      const session = await request("/v1/sessions", { agentId, metadata: {} });
      const sessionId = session.id as string;
      const started = await request(`/v1/sessions/${sessionId}/turns`, {
        input: [{ type: "text", text: prompt }], stream: false, metadata: {} });
      const turnId = (started.turn as { id: string }).id;
      const deadline = Date.now() + 10_000;
      let turn = await request(`/v1/sessions/${sessionId}/turns/${turnId}`);
      while (turn.status === "inProgress" && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        turn = await request(`/v1/sessions/${sessionId}/turns/${turnId}`);
      }
      expect(turn).toMatchObject({ status: "failed", stopReason: "error", error: {
        code: "provider_error", message: "Provider request failed." } });
      const item = (await store!.listItems(sessionId, { limit: 100 })).find((value) => value.type === "agentMessage")!;
      expect(item).toMatchObject({ status: "failed", step: 1 });
      const events = await store!.readEvents(sessionId, 0, 100);
      expect(events.map((value) => value.seq)).toEqual(events.map((_, index) => index + 1));
      const source = await store!.verifyPersistedProviderStepFailureSource({ tenantId: fixture.tenantId,
        sessionId, turnId, itemId: item.id, stepIndex: 1, freshProof: effectiveProof });
      expect(source).toMatchObject({ status: "source_verified_queued", sourceCount: 1 });
      return { sessionId, turnId, itemId: item.id, operation: source.writeOperationSha256!,
        failureReceipt: source.failureCommitReceiptSha256 };
    }
    async function firstRestoreAudit(url: string) {
      const connection = await mysql.createConnection(url);
      try {
        const record = await readTenantTelemetryCaptureCheckpointFromMysql(connection, fixture.backupId, refKey);
        if (!record || record.checkpoint.scope !== "tenant-telemetry-capture-backup-checkpoint-v1") throw new Error("first_checkpoint_missing");
        const [histories] = await connection.query<RowDataPacket[]>(
          "SELECT receipt_json FROM tenant_telemetry_capture_restore_history_receipts WHERE restore_run_id=?", [fixture.restoreRunId]);
        const [cutovers] = await connection.query<RowDataPacket[]>(
          "SELECT receipt_json FROM tenant_telemetry_capture_epoch_cutovers WHERE restore_run_id=?", [fixture.restoreRunId]);
        const [permits] = await connection.query<RowDataPacket[]>(
          "SELECT write_operation_sha256,new_claim_attempt,permit_receipt_sha256,receipt_json FROM tenant_telemetry_capture_recovery_permits WHERE restore_run_id=? ORDER BY BINARY write_operation_sha256", [fixture.restoreRunId]);
        expect(histories).toHaveLength(1); expect(cutovers).toHaveLength(1); expect(permits).toHaveLength(3);
        const json = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;
        const history = json(histories[0]!.receipt_json) as TenantTelemetryCaptureRestoreHistoryReceipt;
        const cutover = json(cutovers[0]!.receipt_json) as TenantTelemetryCaptureEpochCutoverReceipt;
        validateTenantTelemetryCaptureEpochCutoverReceipt(cutover, history, record.checkpoint, refKey);
        const byOperation = new Map<string, TenantTelemetryCaptureOperationRecoveryPermit>();
        for (const row of permits) {
          const permit = json(row.receipt_json) as TenantTelemetryCaptureOperationRecoveryPermit;
          validateTenantTelemetryCaptureOperationRecoveryPermit(permit, cutover, history, record.checkpoint, record.leaves, refKey);
          expect(row.permit_receipt_sha256).toBe(permit.receiptSha256); expect(Number(row.new_claim_attempt)).toBe(2);
          byOperation.set(String(row.write_operation_sha256), permit);
        }
        const context: TenantTelemetryCaptureRecoveryContext = { checkpoint: record.checkpoint, leaves: record.leaves, history, cutover };
        // Exact logical rows, not only receipt counts. Never print these rows;
        // failure diagnostics expose only their content-free comparison digest.
        const fingerprint = createHash("sha256").update(JSON.stringify({ record, histories, cutovers, permits })).digest("hex");
        return { record, history, cutover, byOperation, context, fingerprint };
      } finally { await connection.end(); }
    }
    async function persistedPayloadJson(url: string, operation: string): Promise<string> {
      const connection = await mysql.createConnection(url);
      try {
        const [rows] = await connection.query<RowDataPacket[]>(
          "SELECT payload_json FROM tenant_telemetry_write_payloads WHERE tenant_id=? AND write_operation_sha256=?", [fixture.tenantId, operation]);
        expect(rows).toHaveLength(1);
        const parsed: unknown = typeof rows[0]!.payload_json === "string" ? JSON.parse(rows[0]!.payload_json) : rows[0]!.payload_json;
        return tenantTelemetryArtifactPayloadCanonicalJson(canonicalizeTenantTelemetryArtifactPayload(parsed));
      } finally { await connection.end(); }
    }
    const dependencies = {
      connectStore: async (options: Parameters<typeof MysqlSessionStore.connect>[0]) => {
        try { return await MysqlSessionStore.connect(options); }
        catch (error) {
          const name = error instanceof Error && ["TenantTelemetryCaptureRestoreIntegrityError",
            "PersistedProviderCaptureIntegrityError", "TenantTelemetryWriteIntegrityError"].includes(error.name)
            ? error.name : "unclassified";
          const line = error instanceof Error ? /\/packages\/store\/src\/mysql\/store\.ts:([0-9]+):[0-9]+/.exec(error.stack ?? "")?.[1] : undefined;
          cutoverDiagnostic = `connect_store:${name}:${line ?? "unknown"}`;
          throw error;
        }
      },
      connectCaptureRestoreMaintenance: (options: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>[0]) =>
        MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance(options),
      connectCaptureBackupSourceMaintenance: (options: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance>[0]) =>
        MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance(options),
      connectCaptureArtifactRestoreMaintenance: async (options: Parameters<typeof MysqlSessionStore.connectTenantTelemetryCaptureArtifactRestoreMaintenance>[0]) => {
        resetMaintenanceDiagnostics();
        async function observe<T>(stage: MaintenanceStage, action: () => Promise<T>): Promise<T> {
          observeMaintenance(stage, "entered");
          try { const result = await action(); observeMaintenance(stage, "settled"); return result; }
          catch (error) { observeMaintenance(stage, "rejected", error); throw error; }
        }
        const actual = await observe("factory", () => MysqlSessionStore.connectTenantTelemetryCaptureArtifactRestoreMaintenance(options));
        return Object.freeze({ ...actual,
          getTenantRestoreReplayRun: (...args: Parameters<typeof actual.getTenantRestoreReplayRun>) => observe("get_run", () => actual.getTenantRestoreReplayRun(...args)),
          getTenantRestoreReplaySealedTargets: (...args: Parameters<typeof actual.getTenantRestoreReplaySealedTargets>) => observe("get_targets", () => actual.getTenantRestoreReplaySealedTargets(...args)),
          getTenantRestoreReplayReceipt: (...args: Parameters<typeof actual.getTenantRestoreReplayReceipt>) => observe("get_receipt", () => actual.getTenantRestoreReplayReceipt(...args)),
          getTenantRestoreRuntimeControl: () => observe("get_runtime_control", () => actual.getTenantRestoreRuntimeControl()),
          getTenantRestoreRuntimeHeads: () => observe("get_runtime_heads", () => actual.getTenantRestoreRuntimeHeads()),
          getTenantRestoreJournalControl: () => observe("get_journal_control", () => actual.getTenantRestoreJournalControl()),
          getTenantRestoreJournalControlTargets: () => observe("get_journal_targets", () => actual.getTenantRestoreJournalControlTargets()),
          getTenantBackupRestoreSourceBinding: (...args: Parameters<typeof actual.getTenantBackupRestoreSourceBinding>) => observe("get_binding", () => actual.getTenantBackupRestoreSourceBinding(...args)),
          getTenantBackupRuntimeReservation: (...args: Parameters<typeof actual.getTenantBackupRuntimeReservation>) => observe("get_reservation", () => actual.getTenantBackupRuntimeReservation(...args)),
          getTenantTelemetryCaptureEpochCutoverReceipt: () => observe("get_cutover", () => actual.getTenantTelemetryCaptureEpochCutoverReceipt()),
          getTenantTelemetryCaptureRestoreHistoryReceipt: () => observe("get_history", () => actual.getTenantTelemetryCaptureRestoreHistoryReceipt()),
          recordTenantRestoreReplayFence: (...args: Parameters<typeof actual.recordTenantRestoreReplayFence>) => observe("record_fence", () => actual.recordTenantRestoreReplayFence(...args)),
          sealTenantRestoreReplay: (...args: Parameters<typeof actual.sealTenantRestoreReplay>) => observe("seal_replay", () => actual.sealTenantRestoreReplay(...args)),
          activateTenantRestoreRuntime: (...args: Parameters<typeof actual.activateTenantRestoreRuntime>) => observe("activate_runtime", () => actual.activateTenantRestoreRuntime(...args)),
          resolveTenantBackupRuntimeReservation: (...args: Parameters<typeof actual.resolveTenantBackupRuntimeReservation>) => observe("resolve_reservation", () => actual.resolveTenantBackupRuntimeReservation(...args)),
          close: () => observe("close", () => actual.close()),
          activateTenantTelemetryCaptureRestoredEpoch: (...args: Parameters<typeof actual.activateTenantTelemetryCaptureRestoredEpoch>) => observe("activate", () => actual.activateTenantTelemetryCaptureRestoredEpoch(...args)),
        });
      },
    };
    try {
      markRepeatStage("fixture_source_begin");
      await fixture.setup();
      independent = new S3Client({ endpoint: required("S3_TEST_ENDPOINT"), region: required("S3_TEST_REGION"),
        forcePathStyle: required("S3_TEST_FORCE_PATH_STYLE") === "1", credentials: {
          accessKeyId: required("S3_TEST_ACCESS_KEY_ID"), secretAccessKey: required("S3_TEST_SECRET_ACCESS_KEY") }, maxAttempts: 2 });
      runner = await httpSurface(); router = await httpSurface();
      const fleetRoot = persistedProviderCaptureConfiguredFleetRootSha256([{ url: runner.origin, runnerId }]);
      const keyFile = join(fixture.privateDirectory, "capture-ref-key");
      await writeFile(keyFile, refKey, { mode: 0o600, flag: "wx" });
      captureEnv = { NODE_ENV: "test", STORE: "mysql", MYSQL_URL: fixture.sourceUrl,
        TELEMETRY_CAPTURE_REF_KEY_FILE: keyFile, TELEMETRY_CAPTURE_LOCAL_ONLY_ACK: "1",
        TELEMETRY_CAPTURE_FLEET_STOPPED_ACK: "1", TELEMETRY_CAPTURE_LEGACY_WRITERS_DRAINED_ACK: "1",
        TELEMETRY_CAPTURE_PRODUCER_READY_ACK: "1", TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256: fleetRoot,
        TENANT_TELEMETRY_WRITER_ADAPTER: "s3", TENANT_TELEMETRY_S3_NAMESPACE_ID: `restore-sink-${fixture.runId}`,
        TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID: `local-restore-sink-${fixture.runId}`, TENANT_TELEMETRY_S3_BUCKET: bucket,
        TENANT_TELEMETRY_S3_PREFIX: prefix, TENANT_TELEMETRY_S3_REGION: required("S3_TEST_REGION"),
        TENANT_TELEMETRY_S3_ENDPOINT: required("S3_TEST_ENDPOINT"), TENANT_TELEMETRY_S3_FORCE_PATH_STYLE: required("S3_TEST_FORCE_PATH_STYLE"),
        TENANT_TELEMETRY_S3_PRIVATE_BUCKET_ACK: "1", TENANT_TELEMETRY_S3_ACCESS_KEY_ID: required("S3_TEST_ACCESS_KEY_ID"),
        TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY: required("S3_TEST_SECRET_ACCESS_KEY") };
      const activate = async (command: string) => runTelemetryCaptureCli([command], captureEnv, {
        readRefKey: readTelemetryCaptureRefKey,
        connectStore: (options) => MysqlSessionStore.connect(options),
        createAdapter: (options) => new S3TenantTelemetryWriteAdapter(options),
        writeLine(line) { output.push(line); },
      });
      await activate("activate-lifecycle");
      // Real pre-capture legacy reservations: one will be due after retry and
      // one retains its live old claim. Neither has a v2 source authority.
      const legacyStore = await MysqlSessionStore.connect({ url: fixture.sourceUrl, migrationMode: "verify",
        tenantTelemetryRefKey: refKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true });
      try {
        // A tenant predating lifecycle activation has honestly unknown history
        // and cannot use generic capture. Create a real post-lifecycle tenant
        // with complete-since-creation coverage instead of weakening that gate.
        const legacyTenantId = `${fixture.tenantId}-legacy`;
        await legacyStore.createApiKey(legacyTenantId, "legacy-source-key",
          createHash("sha256").update(randomBytes(32)).digest("hex"));
        for (let index = 0; index < 2; index++) {
          const nowMs = Date.now();
          await legacyStore.enqueueTenantTelemetryArtifact({ tenantId: legacyTenantId,
            expectedControlGeneration: 1, domain: "logs", artifactGeneration: 1,
            artifactIdSha256: createHash("sha256").update(`restore-legacy:${fixture.runId}:${index}`).digest("hex"),
            ownerKind: "tenant", ownerId: legacyTenantId, ownerUserId: null,
            sourceSchema: "structured-log-batch-v1", sourceGeneration: 0, sourceHighWaterDbMs: nowMs,
            payload: { schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA, domain: "logs",
              records: [trustedRunnerTelemetryRecord(nowMs, { opaqueRefKey: refKey,
                tenantValue: legacyTenantId, ownerKind: "tenant", ownerValue: legacyTenantId })] } });
          const claims = await legacyStore.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 300_000,
            claimToken: randomUUID(), adapterProtocol: "telemetry-s3-object-v1", captureMode: "legacy_only" });
          expect(claims).toHaveLength(1);
          const claim = claims[0]!;
          const reservation = await legacyStore.reserveTenantTelemetryExternalMutation({ tenantId: claim.tenantId,
            writeOperationSha256: claim.writeOperationSha256, claimAttempt: claim.claimAttempt,
            claimToken: claim.claimToken }, claim.target.adapterProtocol);
          expect(reservation).not.toBeNull(); legacyClaims.push({ ...claim, reservation: reservation! });
        }
      } finally { await legacyStore.close(); }
      await activate("activate-logs");
      await startRuntime(fixture.sourceUrl);
      await store!.createApiKey(fixture.tenantId, "restore-runtime-key", hashApiKey(runtimeKey), ["runtime", "admin"]);
      const vendorOrigin = await vendor.start();
      await providers!.upsertTenantProvider(fixture.tenantId, { id: "restore-provider", api: "openai-completions",
        baseUrl: vendorOrigin, apiKey: vendorKey, headers: {}, models: [{ id: "fake-model", contextWindow: 10_000,
          maxOutputTokens: 100, input: ["text"], reasoning: false }], quota: {}, fallback: [] });
      const agent: AgentDefinition = { id: newId("agt"), tenantId: fixture.tenantId, version: 1,
        name: "capture-restore", instructions: "test", model: { provider: "restore-provider", model: "fake-model" },
        tools: [], mcpServers: [], skills: [], limits: {}, approvalPolicy: "never", busyPolicy: "reject",
        sandbox: "none", metadata: {}, createdAtMs: Date.now() };
      await store!.createAgent(agent);
      const originals = [];
      for (let index = 0; index < 3; index++) originals.push(await failureTurn(agent.id));
      const claimProof = await captureGate!.requireFreshFleet(effectiveProof!, "claim");
      const claims = await store!.claimTenantTelemetryWriteJobs({ limit: 3, leaseMs: 30_000,
        claimToken: randomUUID(), adapterProtocol: sink!.adapterProtocol, captureMode: "include_v2", freshProof: claimProof });
      expect(new Set(claims.map((claim) => claim.writeOperationSha256))).toEqual(new Set(originals.map((value) => value.operation)));
      const originalReservations = new Map<string, TenantTelemetryWriteClaim["reservation"]>();
      const originalObjectBytes = new Map<string, Buffer>();
      for (const [index, claim] of claims.entries()) {
        const auth = { tenantId: claim.tenantId, writeOperationSha256: claim.writeOperationSha256,
          claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
        if (index !== 0) {
          const proof = await captureGate!.requireFreshFleet(effectiveProof!, "reserve");
          const reservation = await store!.reserveTenantTelemetryExternalMutation(auth, sink!.adapterProtocol, proof);
          expect(reservation).not.toBeNull(); originalReservations.set(claim.writeOperationSha256, reservation!);
          if (index === 2) {
            const createProof = await captureGate!.requireFreshFleet(effectiveProof!, "create");
            await store!.verifyPersistedProviderStepFailureWrite(claim.tenantId, claim.writeOperationSha256, createProof, "create");
            await sink!.createWrite({ writeOperationSha256: claim.writeOperationSha256, target: claim.target,
              inventory: claim.inventory, payload: claim.payload });
            const objectKey = tenantTelemetryS3ArtifactObjectKey(prefix, { domain: claim.inventory.domain,
              targetSha256: claim.target.targetSha256, artifactIdSha256: claim.inventory.artifactIdSha256,
              artifactGeneration: claim.inventory.artifactGeneration });
            const object = await independent.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
            originalObjectBytes.set(claim.writeOperationSha256, Buffer.from(await object.Body!.transformToByteArray()));
          }
        }
        expect(await store!.retryTenantTelemetryWrite(auth, { delayMs: 0, errorCode: "temporary_failure" })).toBe(true);
      }
      const originalJobs = new Map<string, TenantTelemetryWriteJobRecord>();
      for (const source of originals) originalJobs.set(source.operation,
        (await store!.getTenantTelemetryWriteJob(fixture.tenantId, source.operation))!);
      const dueLegacy = legacyClaims[0]!;
      expect(await store!.retryTenantTelemetryWrite({ tenantId: dueLegacy.tenantId,
        writeOperationSha256: dueLegacy.writeOperationSha256, claimAttempt: dueLegacy.claimAttempt,
        claimToken: dueLegacy.claimToken }, { delayMs: 0, errorCode: "temporary_failure" })).toBe(true);
      for (const legacy of legacyClaims) legacyJobs.set(legacy.writeOperationSha256,
        (await store!.getTenantTelemetryWriteJob(legacy.tenantId, legacy.writeOperationSha256))!);
      const originalEpoch = effectiveProof!.runtimeEpochSha256;
      // Only the new repeat case adds a separate real T1 subject. The main
      // tenant and all pending telemetry windows remain exactly as before.
      if (repeatRestore) await publishNonemptyJournal();
      markRepeatStage("fixture_source_ready");
      await stopRuntime(); // No business writer remains across the dump/import/cutover window.
      const keyEnv = { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: keyFile };
      const created = await fixture.command("create-artifact", keyEnv, dependencies); closedFailure(created);
      // Recovery must be backed by genuinely validated checkpoint leaves, not
      // by an overall artifact success or by reclassifying an unknown source.
      const sourceReader = await mysql.createConnection(fixture.sourceUrl);
      try {
        const record = await readTenantTelemetryCaptureCheckpointFromMysql(sourceReader, fixture.backupId, refKey);
        expect(record).not.toBeNull();
        for (const source of originals) {
          for (const family of ["write_job", "write_payload", "membership", "provider_source_binding",
            "provider_failure_commit", "write_reservation"] as const) {
            const identity = tenantTelemetryCaptureCheckpointOperationIdentity(family, source.operation, refKey);
            const leaves = record!.leaves.filter((leaf) => leaf.family === family && leaf.identityRefSha256 === identity);
            const count = family === "write_reservation" && !originalReservations.has(source.operation) ? 0 : 1;
            expect(leaves.length, `actual captured-v2 checkpoint ${family} count`).toBe(count);
            if (count) expect(leaves[0]!.knowledge, `actual captured-v2 checkpoint ${family} knowledge`)
              .toBe("validated_projection");
          }
        }
      } finally { await sourceReader.end(); }
      const encrypted = await readFile(join(fixture.artifactDirectory, `${fixture.backupId}.asmbak`));
      expect(encrypted.subarray(0, 8).toString("ascii")).toBe("ASMYSQL2");
      for (const privateValue of [prompt, fixture.payloadCanary, refKey.toString("hex"), masterKey]) {
        expect(encrypted.includes(Buffer.from(privateValue)), "encrypted artifact must not expose private source material").toBe(false);
      }
      markRepeatStage("primary_backup_complete");
      const targetUrl = await fixture.newDatabase();
      let activeTargetUrl = targetUrl, activeBackupId = fixture.backupId, activeRunId = fixture.restoreRunId;
      const observedTargetUrls = [targetUrl];
      let priorAudit: Awaited<ReturnType<typeof firstRestoreAudit>> | undefined;
      let priorRecoveryClaims: TenantTelemetryWriteClaim[] = [];
      let restoredSource: Awaited<ReturnType<typeof failureTurn>> | undefined;
      let restoredSourceBytes: Buffer | undefined;
      const continuation = { ...keyEnv, RESTORE_RUN_ID: fixture.restoreRunId,
        BACKUP_RUNTIME_EPOCH_ID: fixture.restoredEpochId, BACKUP_RESTORE_TARGET_MYSQL_URL: targetUrl };
      closedFailure(await fixture.command("restore-selected", continuation, dependencies));
      await expect(MysqlSessionStore.connect({ url: targetUrl, migrationMode: "verify", tenantTelemetryRefKey: refKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true })).rejects.toThrow();
      const firstReplayScanStart = journalScan?.mock.calls.length ?? 0;
      closedFailure(await fixture.command("replay-selected", { ...continuation, BACKUP_RESTORE_REPLAY_ACK: "1" }, dependencies));
      if (repeatRestore) assertNonemptyJournalScanSince(firstReplayScanStart);
      closedFailure(await fixture.command("verify-selected", { ...continuation, BACKUP_RESTORE_VERIFY_ACK: "1" }, dependencies));
      closedFailure(await fixture.command("activate-selected", { ...continuation, BACKUP_RESTORE_RUNTIME_ACTIVATION_ACK: "1" }, dependencies));
      // History alone is not current write authority. Ordinary cold startup
      // must still reject until this independent, explicit capture cutover.
      await expect(MysqlSessionStore.connect({ url: targetUrl, migrationMode: "verify", tenantTelemetryRefKey: refKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true })).rejects.toThrow();
      closedFailure(await fixture.command("activate-capture-selected", { ...continuation, ...captureEnv,
        TELEMETRY_CAPTURE_RESTORED_EPOCH_ACTIVATION_ACK: "1" }, dependencies));
      // External catalog CAS resolution stays explicit: activation never silently
      // consumes a new mutation authority or declares every restore domain done.
      closedFailure(await fixture.command("resolve-selected", { ...continuation,
        BACKUP_RESTORE_CATALOG_RESOLUTION_ACK: "1" }, dependencies));
      await startRuntime(targetUrl);
      expect(effectiveProof!.runtimeEpochSha256).not.toBe(originalEpoch);
      markRepeatStage("restore1_ready");
      if (repeatRestore) {
        await assertRestoredNonemptyJournal(fixture.restoreRunId);
        const firstEpoch = effectiveProof!.runtimeEpochSha256;
        const firstClaimProof = await captureGate!.requireFreshFleet(effectiveProof!, "claim");
        const firstClaims = await store!.claimTenantTelemetryWriteJobs({ limit: 3, leaseMs: 300_000,
          claimToken: randomUUID(), adapterProtocol: sink!.adapterProtocol, captureMode: "include_v2", freshProof: firstClaimProof });
        priorRecoveryClaims = firstClaims;
        expect(new Set(firstClaims.map((claim) => claim.writeOperationSha256))).toEqual(new Set(originals.map((source) => source.operation)));
        for (const claim of firstClaims) {
          expect(claim.claimAttempt).toBe(2); expect(claim.captureRecovery).toBeDefined();
          if (originalReservations.has(claim.writeOperationSha256)) expect(claim.reservation).toEqual(originalReservations.get(claim.writeOperationSha256));
          expect(claim.claimToken).not.toBe(claims.find((old) => old.writeOperationSha256 === claim.writeOperationSha256)!.claimToken);
        }
        // Hold the real P1 claims, so this actual worker can only write the new
        // current-epoch Pi failure, not accidentally ACK the inherited queue.
        restoredSource = await failureTurn(agent.id);
        const restoredPayloadJson = await persistedPayloadJson(targetUrl, restoredSource.operation);
        expect(await worker!.processOnce()).toBe(1);
        const currentJob = (await store!.getTenantTelemetryWriteJob(fixture.tenantId, restoredSource.operation))!;
        expect(currentJob.phase).toBe("written");
        const currentKey = tenantTelemetryS3ArtifactObjectKey(prefix, { domain: currentJob.inventory.domain,
          targetSha256: currentJob.target.targetSha256, artifactIdSha256: currentJob.inventory.artifactIdSha256,
          artifactGeneration: currentJob.inventory.artifactGeneration });
        const currentObject = await independent.send(new GetObjectCommand({ Bucket: bucket, Key: currentKey }));
        restoredSourceBytes = Buffer.from(await currentObject.Body!.transformToByteArray());
        const restoredEnvelope = decodeTenantTelemetryS3Envelope(restoredSourceBytes);
        expect(restoredEnvelope.payloadJson).toBe(restoredPayloadJson);
        expect(tenantTelemetryArtifactPayloadSha256(canonicalizeTenantTelemetryArtifactPayload(JSON.parse(restoredEnvelope.payloadJson))))
          .toBe(currentJob.inventory.payloadSha256);
        output.push(restoredEnvelope.metadataJson, restoredEnvelope.payloadJson);
        expect(await store!.getTenantTelemetryWriteAck(fixture.tenantId, restoredSource.operation)).not.toBeNull();
        for (const claim of firstClaims) {
          expect(Date.now()).toBeLessThan(claim.leaseUntilMs);
          expect(await store!.retryTenantTelemetryWrite({ tenantId: claim.tenantId, writeOperationSha256: claim.writeOperationSha256,
            claimAttempt: claim.claimAttempt, claimToken: claim.claimToken }, { delayMs: 0, errorCode: "temporary_failure" })).toBe(true);
          const pending = (await store!.getTenantTelemetryWriteJob(claim.tenantId, claim.writeOperationSha256))!;
          expect(pending).toMatchObject({ phase: "queued", attempts: 2 });
          expect(await store!.getTenantTelemetryWriteAck(claim.tenantId, claim.writeOperationSha256)).toBeNull();
          expect(tenantTelemetryCaptureRecoveryJobDescriptorSha256(pending))
            .toBe(tenantTelemetryCaptureRecoveryJobDescriptorSha256(originalJobs.get(claim.writeOperationSha256)!));
        }
        await stopRuntime();
        priorAudit = await firstRestoreAudit(targetUrl);
        expect(priorAudit.record.checkpoint.legacyUnknownCount).toBeGreaterThan(0);
        const backup2 = `backup_${randomUUID()}`, run2 = `restore_${randomUUID()}`, epoch2 = `capture-restore-second-${randomUUID()}`;
        const source2 = { ...keyEnv, MYSQL_URL: targetUrl, BACKUP_ID: backup2 };
        const backupSourceScanStart = journalScan!.mock.calls.length;
        closedFailure(await fixture.command("create-artifact", source2, dependencies));
        assertNonemptyJournalScanSince(backupSourceScanStart);
        const encrypted2 = await readFile(join(fixture.artifactDirectory, `${backup2}.asmbak`));
        expect(encrypted2.subarray(0, 8).toString("ascii")).toBe("ASMYSQL3");
        const sourceReader2 = await mysql.createConnection(targetUrl);
        try {
          const record2 = await readTenantTelemetryCaptureCheckpointFromMysql(sourceReader2, backup2, refKey);
          if (!record2 || record2.checkpoint.scope !== "tenant-telemetry-capture-backup-checkpoint-v2" || !record2.lineageLeaves) throw new Error("second_checkpoint_missing");
          expect(record2.checkpoint.lineage.families.map((family) => family.family)).toEqual([...TENANT_TELEMETRY_CAPTURE_LINEAGE_FAMILIES]);
          expect(record2.checkpoint.lineage.sourceRestoreRunId).toBe(fixture.restoreRunId);
          expect(record2.checkpoint.lineage.sourceCheckpointSha256).toBe(priorAudit.record.checkpoint.checkpointSha256);
          expect(record2.checkpoint.lineage.sourceHistoryReceiptSha256).toBe(priorAudit.history.receiptSha256);
          expect(record2.checkpoint.lineage.sourceCaptureCutoverReceiptSha256).toBe(priorAudit.cutover.receiptSha256);
          expect(record2.checkpoint.sourceRuntimeEpochSha256).toBe(firstEpoch);
          expect(record2.checkpoint.lineage.families.find((family) => family.family === "recovery_permit")!.rowCount).toBe(3);
          expect(record2.checkpoint.lineage.families.find((family) => family.family === "recovery_permit_v2")!.rowCount).toBe(0);
          for (const unknown of priorAudit.record.leaves.filter((leaf) => leaf.knowledge === "legacy_unknown")) {
            expect(record2.leaves.find((leaf) => leaf.family === unknown.family && leaf.identityRefSha256 === unknown.identityRefSha256)?.knowledge).toBe("legacy_unknown");
          }
        } finally { await sourceReader2.end(); }
        expect((await firstRestoreAudit(targetUrl)).fingerprint).toBe(priorAudit.fingerprint);
        expect(await readFile(join(fixture.artifactDirectory, `${fixture.backupId}.asmbak`))).toEqual(encrypted);
        const replay2 = await fixture.command("create-artifact", source2, dependencies); closedFailure(replay2);
        expect(JSON.parse(replay2.stdout)).toMatchObject({ disposition: "exact_replay", artifactVerified: true });
        expect(await readFile(join(fixture.artifactDirectory, `${backup2}.asmbak`))).toEqual(encrypted2);
        markRepeatStage("cp2_created");
        const secondTarget = await fixture.newDatabase(); observedTargetUrls.push(secondTarget);
        const selected2 = { ...source2, RESTORE_RUN_ID: run2, BACKUP_RUNTIME_EPOCH_ID: epoch2, BACKUP_RESTORE_TARGET_MYSQL_URL: secondTarget };
        // A real current-source marker loss must refuse before external epoch
        // reservation or native import; restore exact marker bytes afterwards.
        const reserveAttempt = vi.spyOn(S3TenantBackupCatalogAdapter.prototype, "reserveRestore");
        const importAttempt = vi.fn(artifactOperations.importVerifiedMySqlBackupArtifact);
        const markerConnection = await mysql.createConnection(targetUrl);
        let marker: RowDataPacket | undefined;
        let markerDeleted = false;
        try {
          const missingFactory = { ...dependencies,
            artifactOperations: { ...artifactOperations, importVerifiedMySqlBackupArtifact: importAttempt } };
          Reflect.set(missingFactory, "connectCaptureBackupSourceMaintenance", undefined);
          const missing = await fixture.command("restore-selected", selected2, missingFactory);
          expect(missing.status).toBe(1); expect(JSON.parse(missing.stderr)).toMatchObject({ code: "invalid_configuration" });
          expect(reserveAttempt).not.toHaveBeenCalled(); expect(importAttempt).not.toHaveBeenCalled(); output.push(missing.stderr);
          const [markers] = await markerConnection.query<RowDataPacket[]>("SELECT name,applied_at_ms FROM schema_migrations WHERE name LIKE '0058%' ORDER BY name");
          expect(markers).toHaveLength(1); marker = markers[0]!;
          const [deleted] = await markerConnection.query<ResultSetHeader>("DELETE FROM schema_migrations WHERE name=?", [marker.name]);
          markerDeleted = deleted.affectedRows === 1; expect(deleted.affectedRows).toBe(1);
          const rejected = await fixture.command("restore-selected", selected2, { ...dependencies,
            artifactOperations: { ...artifactOperations, importVerifiedMySqlBackupArtifact: importAttempt } });
          expect(rejected.status).toBe(1); expect(reserveAttempt).not.toHaveBeenCalled(); expect(importAttempt).not.toHaveBeenCalled();
          expect(JSON.parse(rejected.stderr)).not.toHaveProperty("reservationMayBeConsumed");
          expect(JSON.parse(rejected.stderr)).not.toHaveProperty("targetMayContainPartialImport"); output.push(rejected.stderr);
          expect(await fixture.tableNames(secondTarget)).toEqual([]);
        } finally {
          try {
            if (marker && markerDeleted) await markerConnection.query("INSERT INTO schema_migrations(name,applied_at_ms) VALUES(?,?)", [marker.name, marker.applied_at_ms]);
          } finally { try { await markerConnection.end(); } finally { reserveAttempt.mockRestore(); } }
        }
        closedFailure(await fixture.command("restore-selected", selected2, dependencies));
        markRepeatStage("restore2_selected");
        await expect(MysqlSessionStore.connect({ url: secondTarget, migrationMode: "verify", tenantTelemetryRefKey: refKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true })).rejects.toThrow();
        const secondReplayScanStart = journalScan!.mock.calls.length;
        closedFailure(await fixture.command("replay-selected", { ...selected2, BACKUP_RESTORE_REPLAY_ACK: "1" }, dependencies));
        assertNonemptyJournalScanSince(secondReplayScanStart);
        closedFailure(await fixture.command("verify-selected", { ...selected2, BACKUP_RESTORE_VERIFY_ACK: "1" }, dependencies));
        closedFailure(await fixture.command("activate-selected", { ...selected2, BACKUP_RESTORE_RUNTIME_ACTIVATION_ACK: "1" }, dependencies));
        await expect(MysqlSessionStore.connect({ url: secondTarget, migrationMode: "verify", tenantTelemetryRefKey: refKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true })).rejects.toThrow();
        closedFailure(await fixture.command("activate-capture-selected", { ...selected2, ...captureEnv,
          TELEMETRY_CAPTURE_RESTORED_EPOCH_ACTIVATION_ACK: "1" }, dependencies));
        closedFailure(await fixture.command("resolve-selected", { ...selected2, BACKUP_RESTORE_CATALOG_RESOLUTION_ACK: "1" }, dependencies));
        markRepeatStage("second_five_commands_complete");
        expect((await firstRestoreAudit(secondTarget)).fingerprint).toBe(priorAudit.fingerprint);
        await startRuntime(secondTarget);
        await assertRestoredNonemptyJournal(run2);
        expect(effectiveProof!.runtimeEpochSha256).not.toBe(firstEpoch); expect(effectiveProof!.runtimeEpochSha256).not.toBe(originalEpoch);
        activeTargetUrl = secondTarget; activeBackupId = backup2; activeRunId = run2;
        markRepeatStage("runtime2_open");
      }
      // Selection cannot consume even a limit=1 lease on a due unknown source;
      // a still-live old reservation also cannot bypass selection by direct API.
      expect(await store!.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 30_000,
        claimToken: randomUUID(), adapterProtocol: "telemetry-s3-object-v1", captureMode: "legacy_only" })).toEqual([]);
      const oldLive = legacyClaims[1]!;
      const oldAuthorization = { tenantId: oldLive.tenantId, writeOperationSha256: oldLive.writeOperationSha256,
        claimAttempt: oldLive.claimAttempt, claimToken: oldLive.claimToken };
      expect(Date.now()).toBeLessThan(oldLive.leaseUntilMs);
      await expect(store!.reserveTenantTelemetryExternalMutation(oldAuthorization, "telemetry-s3-object-v1"))
        .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
      const forgedAck = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
        writeOperationSha256: oldLive.writeOperationSha256, target: oldLive.target,
        inventory: oldLive.inventory, payload: oldLive.payload }, "already_present", true);
      await expect(store!.completeTenantTelemetryWrite(oldAuthorization, forgedAck))
        .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
      const create = vi.spyOn(sink!, "createWrite"), reserve = vi.spyOn(store!, "reserveTenantTelemetryExternalMutation");
      const delegatedClaim = store!.claimTenantTelemetryWriteJobs.bind(store!);
      const claimObserver = vi.spyOn(store!, "claimTenantTelemetryWriteJobs");
      if (repeatRestore) claimObserver.mockImplementationOnce(async (options) => {
        // Transparent real-DB boundary: do not replace claims/results. While
        // the new P2 lease is actually live, prove the still-unexpired old P1
        // token cannot renew it or change ANY current job projection.
        const values = await delegatedClaim(options);
        for (const claim of values) {
          const old = priorRecoveryClaims.find((value) => value.writeOperationSha256 === claim.writeOperationSha256);
          if (!old) throw new Error("second_claim_predecessor_missing");
          expect(claim.claimAttempt).toBe(3); expect(Date.now()).toBeLessThan(claim.leaseUntilMs);
          expect(Date.now()).toBeLessThan(old.leaseUntilMs);
          const before = await store!.getTenantTelemetryWriteJob(claim.tenantId, claim.writeOperationSha256);
          expect(await store!.renewTenantTelemetryWrite({ tenantId: old.tenantId, writeOperationSha256: old.writeOperationSha256,
            claimAttempt: old.claimAttempt, claimToken: old.claimToken }, { leaseMs: 1_000 })).toBe(false);
          const after = await store!.getTenantTelemetryWriteJob(claim.tenantId, claim.writeOperationSha256);
          expect(createHash("sha256").update(JSON.stringify(after)).digest("hex"))
            .toBe(createHash("sha256").update(JSON.stringify(before)).digest("hex"));
        }
        return values;
      });
      expect(await worker!.processOnce()).toBe(3);
      expect(create).toHaveBeenCalledTimes(2); expect(reserve).toHaveBeenCalledTimes(1);
      expect(claimObserver).toHaveBeenCalledOnce();
      for (const legacy of legacyClaims) {
        expect(await store!.getTenantTelemetryWriteJob(legacy.tenantId, legacy.writeOperationSha256))
          .toEqual(legacyJobs.get(legacy.writeOperationSha256));
        expect(await store!.getTenantTelemetryWriteAck(legacy.tenantId, legacy.writeOperationSha256)).toBeNull();
        const objectKey = tenantTelemetryS3ArtifactObjectKey(prefix, { domain: legacy.inventory.domain,
          targetSha256: legacy.target.targetSha256, artifactIdSha256: legacy.inventory.artifactIdSha256,
          artifactGeneration: legacy.inventory.artifactGeneration });
        await expect(independent.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey })))
          .rejects.toMatchObject({ name: "NoSuchKey" });
      }
      const claimResult = claimObserver.mock.results[0];
      if (claimResult?.type !== "return") throw new Error("capture restore claim was not returned");
      const recoveryClaims: TenantTelemetryWriteClaim[] = await claimResult.value;
      expect(recoveryClaims).toHaveLength(3);
      // Independent physical ledger oracle: written/ACK alone would also pass
      // if a buggy restore path simply bypassed every recovery permit.
      const reader = await mysql.createConnection(activeTargetUrl);
      try {
        const permitTable = repeatRestore ? "tenant_telemetry_capture_recovery_permits_v2" : "tenant_telemetry_capture_recovery_permits";
        const [permitRows] = await reader.query<RowDataPacket[]>(
          `SELECT write_operation_sha256,new_claim_attempt,permit_receipt_sha256,receipt_json FROM ${permitTable} WHERE restore_run_id=? ORDER BY BINARY write_operation_sha256`,
          [activeRunId]);
        const [historyRows] = await reader.query<RowDataPacket[]>(
          "SELECT receipt_json FROM tenant_telemetry_capture_restore_history_receipts WHERE restore_run_id=?", [activeRunId]);
        const [cutoverRows] = await reader.query<RowDataPacket[]>(
          "SELECT receipt_json FROM tenant_telemetry_capture_epoch_cutovers WHERE restore_run_id=?", [activeRunId]);
        expect(permitRows).toHaveLength(3); expect(historyRows).toHaveLength(1); expect(cutoverRows).toHaveLength(1);
        const json = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;
        const history = json(historyRows[0]!.receipt_json) as TenantTelemetryCaptureRestoreHistoryReceipt;
        const cutover = json(cutoverRows[0]!.receipt_json) as TenantTelemetryCaptureEpochCutoverReceipt;
        const checkpoint = await readTenantTelemetryCaptureCheckpointFromMysql(reader, activeBackupId, refKey);
        expect(checkpoint).not.toBeNull();
        if (!checkpoint) throw new Error("fixture actual capture checkpoint is missing");
        validateTenantTelemetryCaptureEpochCutoverReceipt(cutover, history, checkpoint.checkpoint, refKey);
        expect(effectiveProof!.captureControlEvidenceSha256).toBe(cutover.receiptSha256);
        for (const row of permitRows) {
          const permit = json(row.receipt_json) as TenantTelemetryCaptureOperationRecoveryPermit | TenantTelemetryCaptureOperationRecoveryPermitV2;
          if (repeatRestore) {
            if (!priorAudit || permit.scope !== "tenant-telemetry-capture-operation-recovery-v2" || !checkpoint.lineageLeaves) throw new Error("second_permit_context_missing");
            const previous = priorAudit.byOperation.get(String(row.write_operation_sha256));
            if (!previous) throw new Error("first_permit_missing");
            validateTenantTelemetryCaptureOperationRecoveryPermitV2(permit, { checkpoint: checkpoint.checkpoint,
              leaves: checkpoint.leaves, lineageLeaves: checkpoint.lineageLeaves, history, cutover }, refKey,
              [{ permit: previous, context: priorAudit.context }]);
            expect(permit).toMatchObject({ genesisCheckpointSha256: priorAudit.record.checkpoint.checkpointSha256,
              checkpointSha256: checkpoint.checkpoint.checkpointSha256,
              previousPermitReceiptSha256: previous.receiptSha256,
              snapshotReservationReceiptSha256: originalReservations.get(permit.writeOperationSha256)?.receiptSha256 ?? null });
            expect(permit.predecessorLineageEvidenceHmacSha256).toMatch(/^[0-9a-f]{64}$/);
            expect(permit.newClaimTokenSha256).not.toBe(previous.newClaimTokenSha256);
          } else {
            if (permit.scope !== "tenant-telemetry-capture-operation-recovery-v1") throw new Error("first_permit_scope_invalid");
            validateTenantTelemetryCaptureOperationRecoveryPermit(permit, cutover, history, checkpoint.checkpoint, checkpoint.leaves, refKey);
          }
          const claim = recoveryClaims.find((value) => value.writeOperationSha256 === row.write_operation_sha256)!;
          const original = claims.find((value) => value.writeOperationSha256 === row.write_operation_sha256)!;
          expect(claim).toBeDefined(); expect(original).toBeDefined();
          expect(permit).toMatchObject({ restoreRunId: activeRunId, runtimeEpochSha256: effectiveProof!.runtimeEpochSha256,
            writeOperationSha256: claim.writeOperationSha256, newClaimAttempt: repeatRestore ? 3 : 2, previousClaimAttempt: repeatRestore ? 2 : 1,
            previousPermitReceiptSha256: repeatRestore ? priorAudit!.byOperation.get(claim.writeOperationSha256)!.receiptSha256 : null,
            newClaimTokenSha256: tenantTelemetryWriteClaimTokenSha256(claim.claimToken),
            inventorySha256: original.inventory.inventorySha256, payloadSha256: original.inventory.payloadSha256,
            manifestSha256: original.inventory.manifestSha256,
            originalJobDescriptorSha256: tenantTelemetryCaptureRecoveryJobDescriptorSha256(originalJobs.get(claim.writeOperationSha256)!),
            recoveryMode: originalReservations.has(claim.writeOperationSha256) ? "resume_reserved" : "resume_queued" });
          expect(row.permit_receipt_sha256).toBe(permit.receiptSha256); expect(Number(row.new_claim_attempt)).toBe(repeatRestore ? 3 : 2);
          expect(claim.captureRecovery).toEqual({ permitReceiptSha256: permit.receiptSha256,
            recoveryMode: permit.recoveryMode, claimLeaseCeilingMs: permit.claimLeaseCeilingMs });
          const ack = (await store!.getTenantTelemetryWriteAck(fixture.tenantId, claim.writeOperationSha256))!;
          expect(ack.completedClaimAttempt).toBe(permit.newClaimAttempt);
          expect(ack.completedClaimTokenSha256).toBe(permit.newClaimTokenSha256);
        }
      } finally { await reader.end(); }
      for (const source of originals) {
        const job = (await store!.getTenantTelemetryWriteJob(fixture.tenantId, source.operation))!;
        const ack = (await store!.getTenantTelemetryWriteAck(fixture.tenantId, source.operation))!;
        expect(job).toMatchObject({ phase: "written", attempts: repeatRestore ? 3 : 2 });
        expect(tenantTelemetryCaptureRecoveryJobDescriptorSha256(job))
          .toBe(tenantTelemetryCaptureRecoveryJobDescriptorSha256(originalJobs.get(source.operation)!));
        if (originalReservations.has(source.operation)) expect(job.reservation).toEqual(originalReservations.get(source.operation));
        expect(ack.reservationReceiptSha256).toBe(job.reservation!.receiptSha256);
        const objectKey = tenantTelemetryS3ArtifactObjectKey(prefix, { domain: job.inventory.domain,
          targetSha256: job.target.targetSha256, artifactIdSha256: job.inventory.artifactIdSha256,
          artifactGeneration: job.inventory.artifactGeneration });
        const object = await independent.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
        const bytes = Buffer.from(await object.Body!.transformToByteArray());
        const envelope = decodeTenantTelemetryS3Envelope(bytes);
        const original = claims.find((value) => value.writeOperationSha256 === source.operation)!;
        expect(envelope.payloadJson).toBe(tenantTelemetryArtifactPayloadCanonicalJson(original.payload));
        expect(tenantTelemetryArtifactPayloadSha256(JSON.parse(envelope.payloadJson))).toBe(original.inventory.payloadSha256);
        if (originalObjectBytes.has(source.operation)) expect(bytes.equals(originalObjectBytes.get(source.operation)!)).toBe(true);
        expect(JSON.parse(envelope.metadataJson)).toMatchObject({ writeOperationSha256: source.operation });
        expect(JSON.parse(envelope.payloadJson)).toMatchObject({ domain: "logs", records: [{ code: "provider.upstream_request_failed" }] });
        output.push(objectKey, envelope.metadataJson, envelope.payloadJson);
        expect(await store!.verifyPersistedProviderStepFailureSource({ tenantId: fixture.tenantId, sessionId: source.sessionId,
          turnId: source.turnId, itemId: source.itemId, stepIndex: 1, freshProof: effectiveProof! }))
          .toMatchObject({ status: "source_verified_written", failureCommitReceiptSha256: source.failureReceipt });
      }
      markRepeatStage("p2_claims_ack_complete");
      if (repeatRestore) {
        if (!priorAudit || !restoredSource || !restoredSourceBytes) throw new Error("second_restore_history_missing");
        expect((await firstRestoreAudit(activeTargetUrl)).fingerprint).toBe(priorAudit.fingerprint);
        const priorJob = (await store!.getTenantTelemetryWriteJob(fixture.tenantId, restoredSource.operation))!;
        expect(priorJob.phase).toBe("written");
        expect(await store!.getTenantTelemetryWriteAck(fixture.tenantId, restoredSource.operation)).not.toBeNull();
        const key = tenantTelemetryS3ArtifactObjectKey(prefix, { domain: priorJob.inventory.domain, targetSha256: priorJob.target.targetSha256,
          artifactIdSha256: priorJob.inventory.artifactIdSha256, artifactGeneration: priorJob.inventory.artifactGeneration });
        const object = await independent.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        expect(Buffer.from(await object.Body!.transformToByteArray()).equals(restoredSourceBytes)).toBe(true);
      }
      const newSource = await failureTurn(agent.id);
      const newPayloadJson = repeatRestore ? await persistedPayloadJson(activeTargetUrl, newSource.operation) : undefined;
      expect(await worker!.processOnce()).toBe(1);
      expect(await store!.getTenantTelemetryWriteAck(fixture.tenantId, newSource.operation)).not.toBeNull();
      if (repeatRestore) {
        const job = (await store!.getTenantTelemetryWriteJob(fixture.tenantId, newSource.operation))!;
        const key = tenantTelemetryS3ArtifactObjectKey(prefix, { domain: job.inventory.domain, targetSha256: job.target.targetSha256,
          artifactIdSha256: job.inventory.artifactIdSha256, artifactGeneration: job.inventory.artifactGeneration });
        const object = await independent.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const envelope = decodeTenantTelemetryS3Envelope(Buffer.from(await object.Body!.transformToByteArray()));
        expect(envelope.payloadJson).toBe(newPayloadJson); output.push(envelope.metadataJson, envelope.payloadJson);
      }
      markRepeatStage("new_pi2_written");
      expect(vendor.requests).toHaveLength(repeatRestore ? 5 : 4);
      const newBoundaries = exchanges.filter((entry) => entry.epoch === effectiveProof!.runtimeEpochSha256);
      expect(new Set(newBoundaries.map((entry) => entry.boundary))).toEqual(new Set(["capture", "claim", "reserve", "create", "ack"]));
      await stopRuntime(); await startRuntime(activeTargetUrl); // Actual normal cold reconnect after permitted source/job changes.
      expect(await store!.getTenantRestoreRuntimeControl()).toMatchObject({ state: "active", lineageKind: "restore" });
      expect(await store!.getTenantTelemetryWriteAck(fixture.tenantId, newSource.operation)).not.toBeNull();
      if (repeatRestore) await assertRestoredNonemptyJournal(activeRunId);
      const allOutput = output.join("\n");
      for (const forbidden of [fixture.tenantId, fixture.userId, fixture.payloadCanary, prompt, privateError,
        refKey.toString("hex"), masterKey, runtimeKey, vendorKey, internalToken, fixture.sourceUrl, ...observedTargetUrls,
        required("S3_TEST_SECRET_ACCESS_KEY")]) {
        expect(allOutput.includes(forbidden), "closed pipeline output must not contain private material").toBe(false);
      }
      markRepeatStage("final_cold_complete");
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      markRepeatStage("cleanup_begin");
      journalScan?.mockRestore();
      for (const close of [stopRuntime, () => vendor.stop(), () => closeHttp(router?.server), () => closeHttp(runner?.server)]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      if (independent) {
        try {
          if (!/^capture-restore-tests\/[0-9a-f]{24}$/.test(prefix)) throw new Error("unsafe capture restore cleanup prefix");
          for (let page = 0; page < 10; page++) {
            const listed = await independent.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, MaxKeys: 1_000 }));
            const objects = (listed.Contents ?? []).map((value) => {
              if (!value.Key?.startsWith(`${prefix}/`)) throw new Error("capture restore cleanup escaped prefix");
              return { Key: value.Key };
            });
            if (!objects.length) break;
            const deleted = await independent.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
            if (deleted.Errors?.length || page === 9) throw new Error("capture restore cleanup incomplete");
          }
        } catch (error) { failures.push(error); }
        independent.destroy();
      }
      refKey.fill(0);
      try { await fixture.cleanup(); } catch (error) { failures.push(error); }
      markRepeatStage("cleanup_end");
      if (failures.length) {
        if (!bodyFailed) throw new Error("capture_restore_vertical_cleanup_failed");
        // Preserve the original failing assertion/stack. Cleanup is still attempted
        // in full and reported without printing dependency errors or private rows.
        console.error("capture_restore_vertical_cleanup_failed_after_primary_failure");
      }
    }
  }
  it("restores queued and both reserved windows into a new epoch, resumes exact bytes, and captures a new real Pi failure",
    () => exerciseCaptureRestore(false), 180_000);
  // User-approved 360s whole-scenario budget for two real restores plus final cold
  // startup and cleanup. Single-hop 180s, CLI 120s, leases and assertions stay unchanged.
  it("backs up an active restored epoch with pending P1 reservations and restores real ASMYSQL3 ancestry into a second fresh epoch",
    () => exerciseCaptureRestore(true), 360_000);
});
