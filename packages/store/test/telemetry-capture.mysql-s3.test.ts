import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalAesGcmCipher, ProviderService } from "../../providers/src/index.js";
import { FakeVendor, type ScriptedReply } from "../../testkit/src/index.js";
import { PiEngine, SessionHost, StaticToolRegistry, createPersistedProviderFailureCapture, newId,
  type TenantTelemetryWriterWorker } from "../../core/src/index.js";
import { createStructuredTelemetry, INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER, INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE,
  INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER, INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH,
  PersistedProviderCaptureFleetRequest, PersistedProviderCaptureFleetResponse,
  PersistedProviderCaptureRunnerReady, persistedProviderCaptureConfiguredFleetRootSha256,
  persistedProviderCaptureFleetObservationSha256,
  type AgentDefinition, type PersistedProviderCaptureFleetRequest as FleetRequest,
  type PersistedProviderCaptureRunnerReady as RunnerReady } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MysqlSessionStore, S3TenantTelemetryWriteAdapter,
  tenantTelemetryS3ArtifactObjectKey, type S3TenantRestoreJournalAdapter,
  type TenantTelemetryPersistedProviderCaptureProof } from "../src/index.js";
import { decodeTenantTelemetryS3Envelope } from "../src/tenant-telemetry-adapter/s3-codec.js";
import { createApp } from "../../../apps/agent-runner/src/app.js";
import { hashApiKey } from "../../../apps/agent-runner/src/auth.js";
import { loadConfig } from "../../../apps/agent-runner/src/config.js";
import { RouterPersistedProviderCaptureGate } from "../../../apps/agent-runner/src/persisted-provider-capture-gate.js";
import { readTelemetryCaptureRefKey } from "../../../apps/agent-runner/src/telemetry-capture-ref-key.js";
import { runTelemetryCaptureCli, type TelemetryCaptureCliDependencies } from "../../../apps/agent-runner/src/telemetry-capture-cli.js";
import { reconcileTenantTelemetryWriterForStartup } from "../../../apps/agent-runner/src/tenant-telemetry-writer-config.js";
import { createTenantRestoreJournalAdapters, loadTenantRestoreJournalConfig } from "../../../apps/agent-runner/src/tenant-restore-journal-config.js";
import { createRouterApp } from "../../../apps/agent-router/src/app.js";
import { RunnerRegistry } from "../../../apps/agent-router/src/registry.js";

const gates = [process.env.AGENT_SERVICE_INTEGRATION ?? "0", process.env.AGENT_SERVICE_TELEMETRY_CAPTURE_INTEGRATION ?? "0"];
if (gates.some((value) => value !== "0" && value !== "1")) throw new Error("capture integration gates must be 0 or 1");
const enabled = gates.every((value) => value === "1");
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real capture suite`);
  return value;
}
const base = new URL(enabled ? required("MYSQL_TEST_URL") : "mysql://root@127.0.0.1/agent_service_test");
if (base.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(base.pathname))) {
  throw new Error("MYSQL_TEST_URL must name a disposable test database");
}
const endpoint = new URL(enabled ? required("S3_TEST_ENDPOINT") : "http://127.0.0.1:9000");
if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search
  || endpoint.hash || endpoint.pathname !== "/" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)) {
  throw new Error("capture integration S3 endpoint must be a credential-free loopback origin");
}
const telemetryBucket = enabled ? required("S3_TENANT_TELEMETRY_TEST_BUCKET") : "disabled-capture-telemetry";
const journalBucket = enabled ? required("S3_RESTORE_JOURNAL_TEST_BUCKET") : "disabled-capture-journal";
if (telemetryBucket === journalBucket) throw new Error("capture telemetry and journal test buckets must differ");
for (const bucket of [telemetryBucket, journalBucket]) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) throw new Error("unsafe capture test bucket");
}
const region = enabled ? required("S3_TEST_REGION") : "us-east-1";
const accessKeyId = enabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = enabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const pathStyle = enabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (!['0', '1'].includes(pathStyle)) throw new Error("invalid capture test path style");
const runId = randomBytes(12).toString("hex");
const database = `as_capture_v2_test_${process.pid}_${randomBytes(4).toString("hex")}`;
function databaseUrl(name: string) { const url = new URL(base); url.pathname = `/${name}`; return url.toString(); }
const mysqlUrl = databaseUrl(database);
const telemetryPrefix = `capture-v2-tests/telemetry/${runId}`;
const journalPrefix = `capture-v2-tests/journal/${runId}`;
const key = randomBytes(32);
const masterKey = randomBytes(32).toString("hex");
const tenantId = "raw-capture-e2e-tenant";
const userId = "raw-capture-e2e-user";
const apiKey = "capture-e2e-runtime-key";
const vendorKey = "capture-e2e-vendor-secret";
const internalToken = "capture-e2e-private-router-token-long";
const runnerId = "capture-e2e-runner";
const bootId = randomUUID();
const privateVendorError = "vendor-private-error-must-not-be-telemetry";
const partialText = "partial-model-content-must-not-be-telemetry";
const promptText = "private-prompt-must-not-be-telemetry";

/** Real native HTTP transport for the product Hono apps, not a fetch/gate response stub. */
async function appServer(observe?: (request: Request, response: Response) => Promise<void>) {
  let origin = "http://127.0.0.1";
  let handler: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
  const server = createServer((incoming, outgoing) => void (async () => {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const part of incoming) {
      const chunk = Buffer.from(part);
      length += chunk.length;
      if (length > 1_000_000) { outgoing.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const request = new Request(`${origin}${incoming.url}`, {
      method: incoming.method, headers, ...(body ? { body } : {}),
    });
    const observedRequest = request.clone();
    const response = await handler(request);
    await observe?.(observedRequest, response.clone());
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  })().catch(() => { outgoing.writeHead(500).end(); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, origin, setHandler(next: typeof handler) { handler = next; } };
}
type AppServer = Awaited<ReturnType<typeof appServer>>;
const fleetRequests: FleetRequest[] = [];
type ReadyObservation = { origin: string; requestNonce: string; ready: RunnerReady };
const readyObservations: ReadyObservation[] = [];
// The observer records each POST's actual GET interval around the product router call. It does
// not inject a gate proof, alter the independent challenges, or replace any HTTP response.
const fleetExchanges = new Map<string, { request: FleetRequest; readiness: ReadyObservation[] }>();
const processLogs: string[] = [];
const operatorOutput: string[] = [];
const telemetry = createStructuredTelemetry({ component: "runner", opaqueRefKey: key,
  sink: { write(record) { processLogs.push(JSON.stringify(record)); } } });
const runtimeLogger = { info() {}, warn() { processLogs.push("runtime-warning"); }, error() { processLogs.push("runtime-error"); } };
let admin: Connection | undefined;
let query: Connection | undefined;
let store: MysqlSessionStore | undefined;
let cleanupClient: S3Client | undefined;
let secondClient: S3Client | undefined;
let journalAdapter: S3TenantRestoreJournalAdapter | undefined;
let keyDirectory: string | undefined;
let operatorEnv: NodeJS.ProcessEnv;
let runnerServer: AppServer | undefined;
let routerServer: AppServer | undefined;
let registry: RunnerRegistry | undefined;
let host: SessionHost | undefined;
let providers: ProviderService | undefined;
let worker: TenantTelemetryWriterWorker | undefined;
let fleetProof: TenantTelemetryPersistedProviderCaptureProof;
const lease = new MemoryLeaseStore();
const bus = new MemoryEventBus();

async function captureCommand(command: string, extra: NodeJS.ProcessEnv = {}) {
  const dependencies: TelemetryCaptureCliDependencies = {
    readRefKey: readTelemetryCaptureRefKey,
    connectStore: (options) => MysqlSessionStore.connect(options),
    createAdapter: (options) => new S3TenantTelemetryWriteAdapter(options),
    writeLine(line) { operatorOutput.push(line); },
  };
  await runTelemetryCaptureCli([command], { ...operatorEnv, ...extra }, dependencies);
  const result = JSON.parse(operatorOutput.at(-1)!) as Record<string, unknown>;
  expect(result).toMatchObject({ status: "ok", command, erasuresBlocked: true, executionReady: false, allDomainsComplete: false });
  return result;
}
async function runtimeRequest(path: string, body?: unknown) {
  const response = await fetch(`${routerServer!.origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${apiKey}`, "x-user-id": userId, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<Record<string, unknown>>;
}
async function cleanupPrefix(bucket: string, prefix: string) {
  if (!/^capture-v2-tests\/(?:telemetry|journal)\/[0-9a-f]{24}$/.test(prefix)) throw new Error("unexpected capture cleanup prefix");
  for (let page = 0; page < 10; page++) {
    const found = await cleanupClient!.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, MaxKeys: 1000 }));
    const keys = (found.Contents ?? []).flatMap((object) => object.Key ? [{ Key: object.Key }] : []);
    if (!keys.length) return;
    if (keys.some((object) => !object.Key.startsWith(`${prefix}/`))) throw new Error("capture cleanup escaped generated prefix");
    const removed = await cleanupClient!.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
    if (removed.Errors?.length) throw new Error("capture object cleanup failed");
  }
  throw new Error("capture cleanup exceeded bounded pages");
}
async function closeServer(server: Server | undefined) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const describeIntegration = enabled ? describe : describe.skip;
describeIntegration("persisted provider capture actual Pi/HTTP fleet/MySQL/MinIO", () => {
  beforeAll(async () => {
    if (!/^as_capture_v2_test_[0-9]+_[0-9a-f]{8}$/.test(database)) throw new Error("unexpected capture database");
    admin = await mysql.createConnection(databaseUrl("mysql"));
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const clientOptions = { endpoint: endpoint.origin, region, forcePathStyle: pathStyle === "1",
      credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2 };
    cleanupClient = new S3Client(clientOptions);
    secondClient = new S3Client(clientOptions);
    keyDirectory = await mkdtemp(join(tmpdir(), "agent-service-capture-v2-"));
    const keyFile = join(keyDirectory, "ref-key");
    await writeFile(keyFile, key, { mode: 0o600 });
    // Migrations occur only in this explicit fixture step. Every operator connection is verify-only.
    store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4, tenantTelemetryRefKey: key,
      tenantTelemetryPersistedProviderCaptureLocalOnly: true });
    const journalConfig = loadTenantRestoreJournalConfig({
      RESTORE_JOURNAL_ADAPTER: "s3", RESTORE_JOURNAL_DATABASE_NAMESPACE_ID: `capture-db-${runId}`,
      RESTORE_JOURNAL_RUNTIME_EPOCH_ID: `capture-primary-${runId}`, RESTORE_JOURNAL_NAMESPACE_ID: `capture-journal-${runId}`,
      RESTORE_JOURNAL_FAILURE_DOMAIN_ID: `local-journal-${runId}`, RESTORE_JOURNAL_INDEPENDENT_FAILURE_DOMAIN_ACK: "1",
      RESTORE_JOURNAL_S3_ENDPOINT: endpoint.origin, RESTORE_JOURNAL_S3_REGION: region,
      RESTORE_JOURNAL_S3_BUCKET: journalBucket, RESTORE_JOURNAL_S3_PREFIX: journalPrefix,
      RESTORE_JOURNAL_S3_FORCE_PATH_STYLE: pathStyle, RESTORE_JOURNAL_S3_PRIVATE_BUCKET_ACK: "1",
      RESTORE_JOURNAL_S3_ACCESS_KEY_ID: accessKeyId, RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY: secretAccessKey,
    }, { production: false, store: "mysql" });
    if (!journalConfig) throw new Error("capture journal config missing");
    [journalAdapter] = createTenantRestoreJournalAdapters(journalConfig);
    if (!journalAdapter) throw new Error("capture journal adapter missing");
    await journalAdapter.validateStartup();
    const externalHead = await journalAdapter.readHead();
    await store.activateTenantRestoreJournalControl({ adapterProtocol: journalConfig.adapterProtocol,
      journalNamespaceSha256: journalConfig.journalNamespaceSha256,
      logicalDatabaseNamespaceSha256: journalConfig.logicalDatabaseNamespaceSha256,
      runtimeEpochSha256: journalConfig.runtimeEpochSha256, targets: journalConfig.targets.map((target) => target.descriptor),
      observedHeads: [{ ...journalConfig.targets[0]!.descriptor,
        logicalDatabaseNamespaceSha256: journalConfig.logicalDatabaseNamespaceSha256,
        sealedRemoteSequence: externalHead.remoteSequence, sealedHeadRootSha256: externalHead.headRootSha256 }] });
    await store.close(); store = undefined;
    // Origins are allocated before activation, but no app writer exists until afterwards.
    runnerServer = await appServer(async (request, response) => {
      if (new URL(request.url).pathname !== INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH) return;
      const ready = PersistedProviderCaptureRunnerReady.parse(await response.json());
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get(INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_HEADER)).toBe(INTERNAL_PERSISTED_PROVIDER_CAPTURE_ACK_VALUE);
      expect(request.method).toBe("GET");
      expect(new URL(request.url).origin).toBe(runnerServer!.origin);
      expect(ready.runnerId).toBe(runnerId); expect(ready.bootId).toBe(bootId);
      const requestNonce = request.headers.get(INTERNAL_PERSISTED_PROVIDER_CAPTURE_NONCE_HEADER)!;
      expect(ready.nonce).toBe(requestNonce);
      const { protocol: _protocol, configuredFleetRootSha256: _root, ...expectedBinding } = fleetProof;
      expect(ready.binding).toEqual(expectedBinding);
      expect(ready.configuredFleetRootSha256).toBe(fleetProof.configuredFleetRootSha256);
      readyObservations.push({ origin: new URL(request.url).origin, requestNonce, ready });
    });
    routerServer = await appServer(async (request, response) => {
      if (new URL(request.url).pathname !== INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH) return;
      const requested = PersistedProviderCaptureFleetRequest.parse(await request.clone().json());
      const returned = PersistedProviderCaptureFleetResponse.parse(await response.json());
      expect(returned.nonce).toBe(requested.nonce); expect(returned.proof).toEqual(fleetProof);
      expect(request.method).toBe("POST");
      expect(new URL(request.url).origin).toBe(routerServer!.origin);
      expect(returned.runnerId).toBe(requested.runnerId); expect(returned.bootId).toBe(requested.bootId);
      expect(returned.boundary).toBe(requested.boundary);
      const exchange = fleetExchanges.get(requested.nonce)!;
      expect(exchange.request).toEqual(requested);
      expect(exchange.readiness.map((entry) => entry.origin)).toEqual([runnerServer!.origin]);
      expect(returned.fleetObservationSha256).toBe(persistedProviderCaptureFleetObservationSha256(
        exchange.readiness.map((entry) => ({ url: entry.origin, runnerId: entry.ready.runnerId, bootId: entry.ready.bootId })),
      ));
      expect(response.headers.get("cache-control")).toBe("no-store");
      fleetRequests.push(requested);
    });
    const configuredFleetRootSha256 = persistedProviderCaptureConfiguredFleetRootSha256([{ url: runnerServer.origin, runnerId }]);
    operatorEnv = { NODE_ENV: "test", STORE: "mysql", MYSQL_URL: mysqlUrl,
      TELEMETRY_CAPTURE_REF_KEY_FILE: keyFile, TELEMETRY_CAPTURE_OPERATION_TIMEOUT_MS: "60000",
      TELEMETRY_CAPTURE_LOCAL_ONLY_ACK: "1", TELEMETRY_CAPTURE_FLEET_STOPPED_ACK: "1",
      TELEMETRY_CAPTURE_LEGACY_WRITERS_DRAINED_ACK: "1", TELEMETRY_CAPTURE_PRODUCER_READY_ACK: "1",
      TELEMETRY_CAPTURE_CONFIGURED_FLEET_ROOT_SHA256: configuredFleetRootSha256,
      TENANT_TELEMETRY_WRITER_ADAPTER: "s3", TENANT_TELEMETRY_S3_NAMESPACE_ID: `capture-sink-${runId}`,
      TENANT_TELEMETRY_S3_FAILURE_DOMAIN_ID: `local-sink-${runId}`, TENANT_TELEMETRY_S3_BUCKET: telemetryBucket,
      TENANT_TELEMETRY_S3_PREFIX: telemetryPrefix, TENANT_TELEMETRY_S3_REGION: region,
      TENANT_TELEMETRY_S3_ENDPOINT: endpoint.origin, TENANT_TELEMETRY_S3_FORCE_PATH_STYLE: pathStyle,
      TENANT_TELEMETRY_S3_PRIVATE_BUCKET_ACK: "1", TENANT_TELEMETRY_S3_ACCESS_KEY_ID: accessKeyId,
      TENANT_TELEMETRY_S3_SECRET_ACCESS_KEY: secretAccessKey };
    await captureCommand("status");
    expect(await captureCommand("preflight")).toMatchObject({ capabilityProbe: true, mutatedProbeObjects: true });
    await captureCommand("activate-lifecycle");
    await captureCommand("activate-logs");
    store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 6, migrationMode: "verify", tenantTelemetryRefKey: key,
      tenantTelemetryPersistedProviderCaptureLocalOnly: true });
    query = await mysql.createConnection(mysqlUrl);
    fleetProof = (await store.getTenantTelemetryPersistedProviderCaptureBinding())!;
    expect(fleetProof.configuredFleetRootSha256).toBe(configuredFleetRootSha256);
    const gate = new RouterPersistedProviderCaptureGate({ routerBaseUrl: routerServer.origin, internalToken, runnerId, bootId });
    const applicationEnv = Object.fromEntries(Object.entries(operatorEnv).filter(([name]) =>
      !name.startsWith("TELEMETRY_CAPTURE_") && name !== "TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE"));
    const config = loadConfig({ ...applicationEnv,
      // Parser-only placeholders: this fixture assembles its real Store/Host directly, not main metadata admission.
      MYSQL_SCHEMA_METADATA_SCHEMA: "mock_capture_metadata", MYSQL_SCHEMA_METADATA_DEFINER_USER: "mock_capture_definer",
      MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost",
      RUNNER_ID: runnerId, RUNNER_ADDR: runnerServer.origin, SECRETS_MASTER_KEY: masterKey,
      TENANT_TELEMETRY_REF_KEY: key.toString("hex"), TENANT_TELEMETRY_WRITER_ENABLED: "1",
      PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED: "1", INTERNAL_ROUTER_TOKEN: internalToken,
      ERASURE_ROUTER_URL: routerServer.origin,
      TENANT_TELEMETRY_WRITER_POLL_MS: "10", TENANT_TELEMETRY_WRITER_RETRY_BASE_MS: "10",
    });
    const writer = await reconcileTenantTelemetryWriterForStartup(store, config, runtimeLogger, {
      requireFreshFleet: (expected, boundary) => gate.requireFreshFleet(expected, boundary),
    });
    worker = writer.worker;
    expect(writer.persistedCaptureActive).toBe(true);
    expect(writer.captureActive).toBe(false);
    const cipher = new LocalAesGcmCipher(masterKey);
    providers = new ProviderService({ store, cipher, assertBaseUrl: async () => {},
      telemetry, persistedProviderFailureCaptureActive: true });
    const tools = new StaticToolRegistry([]);
    host = new SessionHost({ store, lease, bus, providers, tools, engine: new PiEngine(providers.models),
      logger: runtimeLogger, persistedProviderFailureCapture: createPersistedProviderFailureCapture({
        store, opaqueRefKey: key, requireFreshFleet: (expected, boundary) => gate.requireFreshFleet(expected, boundary),
      }), config: { runnerId, runnerAddr: runnerServer.origin, leaseTtlMs: 5_000, leaseHoldMs: 1 } });
    const app = createApp({ store, host, providers, tools, runnerId, internalRouterToken: internalToken,
      heartbeatMs: 1_000, maxBodyBytes: 1_000_000, ready: () => true, telemetry,
      decryptSecret: (secret) => cipher.decrypt(secret.ciphertext, secret.keyId),
      encryptSecret: async (plain) => ({ ciphertext: await cipher.encrypt(plain), keyId: cipher.keyId }),
      assertPublicUrl: async () => {}, persistedProviderCapture: { bootId, localEnabled: true, writerEnabled: true,
        getBinding: () => store!.getTenantTelemetryPersistedProviderCaptureBinding() } });
    runnerServer.setHandler((request) => Promise.resolve(app.fetch(request)));
    registry = new RunnerRegistry({ runners: [runnerServer.origin], internalRouterToken: internalToken,
      healthIntervalMs: 60_000, healthTimeoutMs: 5_000 });
    const router = createRouterApp({ registry, internalRunnerToken: internalToken, ready: () => true,
      persistedProviderFailureCaptureFleetEnabled: () => true, telemetry });
    routerServer.setHandler(async (request) => {
      if (new URL(request.url).pathname !== INTERNAL_PERSISTED_PROVIDER_CAPTURE_FLEET_PATH) return router.fetch(request);
      const requested = PersistedProviderCaptureFleetRequest.parse(await request.clone().json());
      const before = readyObservations.length;
      const response = await router.fetch(request);
      fleetExchanges.set(requested.nonce, { request: requested, readiness: readyObservations.slice(before) });
      return response;
    });
    registry.start(); await registry.waitForFirstProbe();
    expect(registry.list().every((target) => target.healthy)).toBe(true);
    await store.createApiKey(tenantId, "capture-key", hashApiKey(apiKey), ["runtime", "admin"]);
  }, 120_000);

  afterAll(async () => {
    const cleanupFailures: unknown[] = [];
    for (const close of [() => host?.drain(2_000), () => worker?.stop(), () => registry?.close(),
      () => closeServer(routerServer?.server), () => closeServer(runnerServer?.server),
      () => query?.end(), () => store?.close(), () => bus.close(), () => lease.close()]) {
      try { await close(); } catch (error) { cleanupFailures.push(error); }
    }
    await journalAdapter?.close().catch((error) => cleanupFailures.push(error));
    for (const [bucket, prefix] of [[telemetryBucket, telemetryPrefix], [journalBucket, journalPrefix]]) {
      if (!cleanupClient) break;
      try { await cleanupPrefix(bucket!, prefix!); } catch (error) { cleanupFailures.push(error); }
    }
    cleanupClient?.destroy(); secondClient?.destroy(); key.fill(0);
    if (admin) {
      try {
        if (!/^as_capture_v2_test_[0-9]+_[0-9a-f]{8}$/.test(database)) throw new Error("unexpected capture database");
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      } catch (error) { cleanupFailures.push(error); }
      await admin.end().catch((error) => cleanupFailures.push(error));
    }
    if (keyDirectory) {
      if (!keyDirectory.startsWith(join(tmpdir(), "agent-service-capture-v2-"))) throw new Error("unexpected capture key directory");
      await rm(keyDirectory, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    }
    if (cleanupFailures.length) throw new Error("capture_e2e_cleanup_failed");
  }, 30_000);

  const cases: { name: string; reply: ScriptedReply; partial: boolean }[] = [
    { name: "HTTP 401", reply: { httpError: { status: 401, body: { error: { message: privateVendorError } } } }, partial: false },
    { name: "HTTP 429", reply: { httpError: { status: 429, retryAfter: "0", body: { error: { message: privateVendorError } } } }, partial: false },
    { name: "SSE error", reply: { sseError: { message: privateVendorError, type: "server_error" } }, partial: false },
    { name: "socket drop", reply: { text: partialText, dropAfterChunks: 2 }, partial: false },
    { name: "empty stream", reply: { emptyStream: true }, partial: false },
    { name: "streamed failure", reply: { text: partialText, sseError: { message: privateVendorError }, sseErrorDelayMs: 50 }, partial: true },
  ];
  it.each(cases)("captures $name through the public runtime API and real fresh fleet to external ACK", async ({ name, reply, partial }) => {
    const vendor = new FakeVendor({ expectApiKey: vendorKey }).script(reply);
    const origin = await vendor.start();
    try {
      const beforeFleet = fleetRequests.length;
      const beforeReady = readyObservations.length;
      const providerId = `capture-provider-${cases.findIndex((entry) => entry.name === name)}`;
      await providers!.upsertTenantProvider(tenantId, { id: providerId, api: "openai-completions", baseUrl: origin,
        apiKey: vendorKey, headers: {}, models: [{ id: "fake-model", contextWindow: 10_000, maxOutputTokens: 100,
          input: ["text"], reasoning: false }], quota: {}, fallback: [] });
      const agent: AgentDefinition = { id: newId("agt"), tenantId, version: 1, name: "capture-e2e", instructions: "test",
        model: { provider: providerId, model: "fake-model" }, tools: [], mcpServers: [], skills: [], limits: {},
        approvalPolicy: "never", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
      await store!.createAgent(agent);
      const session = await runtimeRequest("/v1/sessions", { agentId: agent.id, metadata: {} });
      const sessionId = session.id as string;
      const started = await runtimeRequest(`/v1/sessions/${sessionId}/turns`, {
        input: [{ type: "text", text: promptText }], stream: false, metadata: {} });
      const turnId = (started.turn as { id: string }).id;
      const completionDeadline = Date.now() + 10_000;
      let turn = await runtimeRequest(`/v1/sessions/${sessionId}/turns/${turnId}`);
      while (turn.status === "inProgress" && Date.now() < completionDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        turn = await runtimeRequest(`/v1/sessions/${sessionId}/turns/${turnId}`);
      }
      expect(turn).toMatchObject({ status: "failed", stopReason: "error", error: { code: "provider_error", message: "Provider request failed." } });
      expect(vendor.requests).toHaveLength(1);
      expect(vendor.lastRequest).toMatchObject({ path: "/v1/chat/completions", body: { stream: true } });
      const items = await store!.listItems(sessionId, { limit: 100 });
      const failed = items.filter((item) => item.type === "agentMessage");
      expect(failed).toHaveLength(1);
      const item = failed[0]!;
      expect(item).toMatchObject({ type: "agentMessage", status: "failed", step: 1 });
      if (partial) expect(item.type === "agentMessage" ? item.text : undefined).toBe(partialText);
      const events = await store!.readEvents(sessionId, 0, 100);
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
      expect(events.findIndex((event) => event.type === "item/completed" && event.item.id === item.id))
        .toBeLessThan(events.findIndex((event) => event.type === "turn/completed"));
      const [usageRows] = await query!.query<RowDataPacket[]>(
        "SELECT usage_id FROM usage_ledger WHERE tenant_id=? AND session_id=? AND turn_id=? AND step=1",
        [tenantId, sessionId, turnId]);
      expect(usageRows).toHaveLength(1);
      const [billingRows] = await query!.query<RowDataPacket[]>(
        "SELECT fact_sha256 FROM billing_usage_facts WHERE tenant_id=? AND usage_id=?",
        [tenantId, usageRows[0]!.usage_id]);
      expect(billingRows).toHaveLength(1);
      const source = { tenantId, sessionId, turnId, itemId: item.id, stepIndex: 1, freshProof: fleetProof };
      const queued = await store!.verifyPersistedProviderStepFailureSource(source);
      expect(queued).toMatchObject({ status: "source_verified_queued", sourceCount: 1, writeAckReceiptSha256: null,
        executionReady: false, allDomainsComplete: false });
      const operation = queued.writeOperationSha256!;
      const preJob = await store!.getTenantTelemetryWriteJob(tenantId, operation);
      expect(preJob).toMatchObject({ phase: "queued", recordCount: 1, attempts: 0 });
      expect(preJob?.reservation).toBeUndefined();
      // Deterministic scheduling calls the actual embedded worker; its fresh HTTP boundaries and
      // real S3 adapter are those assembled by the production startup helper above.
      expect(await worker!.processOnce()).toBe(1);
      const written = await store!.verifyPersistedProviderStepFailureSource(source);
      expect(written).toMatchObject({ status: "source_verified_written", sourceCount: 1,
        failureCommitReceiptSha256: queued.failureCommitReceiptSha256,
        sourceBindingReceiptSha256: queued.sourceBindingReceiptSha256, membershipSha256: queued.membershipSha256 });
      expect(written.writeAckReceiptSha256).toMatch(/^[0-9a-f]{64}$/);
      const job = (await store!.getTenantTelemetryWriteJob(tenantId, operation))!;
      const ack = (await store!.getTenantTelemetryWriteAck(tenantId, operation))!;
      expect(job).toMatchObject({ phase: "written", attempts: 1 });
      expect(job.reservation).toBeDefined();
      expect(ack.receiptSha256).toBe(written.writeAckReceiptSha256);
      const objectKey = tenantTelemetryS3ArtifactObjectKey(telemetryPrefix, {
        domain: job.inventory.domain, targetSha256: job.target.targetSha256,
        artifactIdSha256: job.inventory.artifactIdSha256, artifactGeneration: job.inventory.artifactGeneration });
      const external = await secondClient!.send(new GetObjectCommand({ Bucket: telemetryBucket, Key: objectKey }));
      const bytes = await external.Body!.transformToByteArray();
      const envelope = decodeTenantTelemetryS3Envelope(bytes);
      const payload = JSON.parse(envelope.payloadJson);
      expect(payload).toMatchObject({ domain: "logs", records: [{ code: "provider.upstream_request_failed", fields: { errorKind: "unknown" } }] });
      expect(payload.records).toHaveLength(1);
      expect(JSON.parse(envelope.metadataJson)).toMatchObject({ writeOperationSha256: operation });
      const observed = fleetRequests.slice(beforeFleet);
      expect(new Set(observed.map((request) => request.boundary))).toEqual(new Set(["capture", "claim", "reserve", "create", "ack"]));
      for (const request of observed) {
        expect(request.runnerId).toBe(runnerId); expect(request.bootId).toBe(bootId);
        expect(request.configuredFleetRootSha256).toBe(fleetProof.configuredFleetRootSha256);
        const exchange = fleetExchanges.get(request.nonce)!;
        expect(exchange.readiness).toHaveLength(1); // Every configured origin, not a healthy subset.
        for (const ready of exchange.readiness) {
          expect(ready.origin).toBe(runnerServer!.origin);
          expect(ready.ready.runnerId).toBe(request.runnerId); expect(ready.ready.bootId).toBe(request.bootId);
          expect(ready.ready.binding).toEqual(request.binding);
          expect(ready.ready.configuredFleetRootSha256).toBe(request.configuredFleetRootSha256);
          expect(ready.ready.nonce).toBe(ready.requestNonce); // Its own GET challenge, not the POST challenge.
        }
      }
      expect(readyObservations.length - beforeReady).toBe(observed.length);
      expect(new Set(fleetRequests.map((request) => request.nonce)).size).toBe(fleetRequests.length);
      expect(new Set(readyObservations.map((entry) => entry.requestNonce)).size).toBe(readyObservations.length);
      await captureCommand("verify-source", { TELEMETRY_CAPTURE_TENANT_ID: tenantId,
        TELEMETRY_CAPTURE_SESSION_ID: sessionId, TELEMETRY_CAPTURE_TURN_ID: turnId,
        TELEMETRY_CAPTURE_ITEM_ID: item.id, TELEMETRY_CAPTURE_STEP_INDEX: "1" });
      const outputs = [envelope.metadataJson, envelope.payloadJson, objectKey, ...processLogs, ...operatorOutput].join("\n");
      for (const forbidden of [tenantId, userId, sessionId, turnId, item.id, promptText, partialText, privateVendorError,
        vendorKey, apiKey, internalToken, origin, masterKey, key.toString("hex")]) {
        expect(outputs.includes(forbidden)).toBe(false);
      }
      // The independent verifier must not find this source under a different tenant or step.
      expect((await store!.verifyPersistedProviderStepFailureSource({ ...source, tenantId: "other-capture-tenant" })).sourceCount).toBe(0);
      expect((await store!.verifyPersistedProviderStepFailureSource({ ...source, stepIndex: 2 })).sourceCount).toBe(0);
    } finally { await vendor.stop(); }
  }, 30_000);

  it("does not manufacture failed-step telemetry for a successful real provider stream", async () => {
    const vendor = new FakeVendor({ expectApiKey: vendorKey }).script({ text: "successful answer" });
    const origin = await vendor.start();
    try {
      const beforeFleet = fleetRequests.length;
      await providers!.upsertTenantProvider(tenantId, { id: "capture-success", api: "openai-completions", baseUrl: origin,
        apiKey: vendorKey, headers: {}, models: [{ id: "fake-model", contextWindow: 10_000, maxOutputTokens: 100,
          input: ["text"], reasoning: false, price: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }], quota: {}, fallback: [] });
      const agent: AgentDefinition = { id: newId("agt"), tenantId, version: 1, name: "capture-success", instructions: "test",
        model: { provider: "capture-success", model: "fake-model" }, tools: [], mcpServers: [], skills: [], limits: {},
        approvalPolicy: "never", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
      await store!.createAgent(agent);
      const session = await runtimeRequest("/v1/sessions", { agentId: agent.id, metadata: {} });
      const sessionId = session.id as string;
      const started = await runtimeRequest(`/v1/sessions/${sessionId}/turns`, {
        input: [{ type: "text", text: promptText }], stream: false, metadata: {} });
      const turnId = (started.turn as { id: string }).id;
      const deadline = Date.now() + 10_000;
      let turn = await runtimeRequest(`/v1/sessions/${sessionId}/turns/${turnId}`);
      while (turn.status === "inProgress" && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        turn = await runtimeRequest(`/v1/sessions/${sessionId}/turns/${turnId}`);
      }
      expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn" });
      // A real known toy price keeps the default cost ceiling active. Unpriced successful
      // steps must still close with max_cost; this fixture does not disable that safety valve.
      const costCNY = (turn.usage as { costCNY?: number }).costCNY;
      expect(costCNY).toBeCloseTo(0.00012, 8); // FakeVendor reports 100 input + 20 output tokens.
      expect(costCNY).toBeGreaterThan(0);
      expect(costCNY).toBeLessThan(10);
      const item = (await store!.listItems(sessionId, { limit: 100 })).find((entry) => entry.type === "agentMessage")!;
      expect(item).toMatchObject({ status: "completed", text: "successful answer", step: 1 });
      expect(await store!.verifyPersistedProviderStepFailureSource({ tenantId, sessionId, turnId,
        itemId: item.id, stepIndex: 1, freshProof: fleetProof })).toMatchObject({ status: "not_found", sourceCount: 0 });
      expect(fleetRequests).toHaveLength(beforeFleet);
      expect(vendor.requests).toHaveLength(1);
      expect((await store!.listTenantTelemetryApplicationDomainControls()).every((control) => control.state === "inactive")).toBe(true);
    } finally { await vendor.stop(); }
  }, 30_000);
});
