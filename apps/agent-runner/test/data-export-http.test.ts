import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SessionHost, ToolRegistry } from "@agent-service/core";
import type { ProviderService } from "@agent-service/providers";
import {
  BLOB_STORAGE_FORMAT,
  MemoryBlobStore,
  MemorySessionStore,
  USER_DATA_EXPORT_CONTENT_TYPE,
  USER_DATA_EXPORT_FORMAT,
  USER_DATA_EXPORT_SCHEMA_VERSION,
  UserDataExportIdempotencyMismatchError,
  UserDataExportPolicyUnavailableError,
  userDataExportManifestSha256,
  userDataExportStorageKey,
  type RequestUserDataExportInput,
  type UserDataExportArtifactPart,
  type UserDataExportArtifactRecord,
  type UserDataExportDownloadLease,
  type UserDataExportRequestRecord,
  type UserDataExportRequestStore,
} from "@agent-service/store";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";

const REQUEST_ID = "export_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b";
const OTHER_REQUEST_ID = "export_029a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b";
const ARTIFACT_ID = "xart_119a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b";
const INTERNAL_TOKEN = "data-export-test-internal-token-0001";
const POLICY_SHA256 = "1".repeat(64);

function requestRecord(overrides: Partial<UserDataExportRequestRecord> = {}): UserDataExportRequestRecord {
  return {
    requestId: REQUEST_ID,
    tenantId: "t_export",
    userId: "u_owner",
    subjectGeneration: 0,
    requestedByKeyId: "admin",
    idempotencyKeySha256: "2".repeat(64),
    requestHash: "3".repeat(64),
    format: USER_DATA_EXPORT_FORMAT,
    schemaVersion: USER_DATA_EXPORT_SCHEMA_VERSION,
    policyVersion: "policy-v1",
    policySha256: POLICY_SHA256,
    artifactTtlMs: 60_000,
    status: "queued",
    currentBuildGeneration: 0,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

class FakeExportStore implements UserDataExportRequestStore {
  readonly requestCalls: RequestUserDataExportInput[] = [];
  readonly getCalls: Array<[string, string, string]> = [];
  readonly acquireCalls: Array<[string, string, string, string, number]> = [];
  readonly renewCalls: Array<[string, string, number]> = [];
  readonly releaseCalls: Array<[string, string]> = [];
  readonly idempotent = new Map<string, UserDataExportRequestRecord>();
  requestError?: Error;
  statusRecord: UserDataExportRequestRecord | null = null;
  download: UserDataExportDownloadLease | null = null;
  renewResult = true;

  async requestUserDataExport(input: RequestUserDataExportInput): Promise<UserDataExportRequestRecord> {
    this.requestCalls.push(structuredClone(input));
    if (this.requestError) throw this.requestError;
    const key = JSON.stringify([input.tenantId, input.userId, input.idempotencyKeySha256]);
    const replay = this.idempotent.get(key);
    if (replay) return structuredClone(replay);
    const record = requestRecord({
      requestId: input.requestId,
      tenantId: input.tenantId,
      userId: input.userId,
      requestedByKeyId: input.requestedByKeyId,
      idempotencyKeySha256: input.idempotencyKeySha256,
      requestHash: input.requestHash,
    });
    this.idempotent.set(key, record);
    return structuredClone(record);
  }

  async getUserDataExport(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<UserDataExportRequestRecord | null> {
    this.getCalls.push([tenantId, userId, requestId]);
    if (
      !this.statusRecord
      || this.statusRecord.tenantId !== tenantId
      || this.statusRecord.userId !== userId
      || this.statusRecord.requestId !== requestId
    ) return null;
    return structuredClone(this.statusRecord);
  }

  async acquireUserDataExportDownload(
    tenantId: string,
    userId: string,
    requestId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<UserDataExportDownloadLease | null> {
    this.acquireCalls.push([tenantId, userId, requestId, leaseToken, leaseMs]);
    if (
      !this.download
      || this.download.request.tenantId !== tenantId
      || this.download.request.userId !== userId
      || this.download.request.requestId !== requestId
    ) return null;
    return {
      ...structuredClone(this.download),
      leaseToken,
      leaseUntilMs: this.download.leaseUntilMs,
    };
  }

  async renewUserDataExportDownload(
    artifactId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    this.renewCalls.push([artifactId, leaseToken, leaseMs]);
    return this.renewResult;
  }

  async releaseUserDataExportDownload(artifactId: string, leaseToken: string): Promise<void> {
    this.releaseCalls.push([artifactId, leaseToken]);
  }
}

async function fixture(options: { admission?: boolean; attachExport?: boolean } = {}) {
  const sessions = new MemorySessionStore();
  await sessions.createApiKey("t_export", "admin", hashApiKey("admin-key"), ["runtime", "admin"]);
  await sessions.createApiKey("t_export", "runtime", hashApiKey("runtime-key"), ["runtime"]);
  await sessions.createApiKey("t_other", "other", hashApiKey("other-key"), ["runtime", "admin"]);
  const exports = new FakeExportStore();
  const objects = new MemoryBlobStore();
  const attachExport = options.attachExport ?? true;
  const app = createApp({
    store: sessions,
    host: {} as SessionHost,
    providers: {} as ProviderService,
    tools: {} as ToolRegistry,
    runnerId: "export-test-runner",
    internalRouterToken: INTERNAL_TOKEN,
    heartbeatMs: 60_000,
    maxBodyBytes: 1_000_000,
    maxDataExportPartBytes: 1_024,
    dataExportDownloadLeaseMs: 1_000,
    userDataExport: attachExport ? exports : undefined,
    dataExportBlob: attachExport ? objects : undefined,
    dataExportRequestsEnabled: options.admission ?? false,
    ready: () => true,
    decryptSecret: async () => "unused",
    encryptSecret: async () => ({ ciphertext: Buffer.from("unused"), keyId: "unused" }),
  });
  const call = (
    path: string,
    init: RequestInit = {},
    identity: { key?: string; userId?: string | null } = {},
  ) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${identity.key ?? "admin-key"}`);
    if (identity.userId !== null) headers.set("x-user-id", identity.userId ?? "u_owner");
    return app.request(path, { ...init, headers });
  };
  return { app, call, exports, objects };
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

async function readyDownload(
  exports: FakeExportStore,
  objects: MemoryBlobStore,
  chunks = [Buffer.from('{"part":1}\n'), Buffer.from('{"part":2}\n')],
): Promise<{ record: UserDataExportRequestRecord; artifact: UserDataExportArtifactRecord; parts: UserDataExportArtifactPart[]; body: Buffer }> {
  const body = Buffer.concat(chunks);
  const contentSha256 = createHash("sha256").update(body).digest("hex");
  const record = requestRecord({
    status: "ready",
    currentBuildGeneration: 1,
    currentArtifactId: ARTIFACT_ID,
    snapshotAtMs: 1_100,
    readyAtMs: 1_200,
    expiresAtMs: 61_200,
    artifactSha256: contentSha256,
    artifactSizeBytes: body.byteLength,
    recordCount: 2,
    updatedAtMs: 1_200,
  });
  const artifact: UserDataExportArtifactRecord = {
    artifactId: ARTIFACT_ID,
    requestId: REQUEST_ID,
    tenantId: "t_export",
    userId: "u_owner",
    subjectGeneration: 0,
    buildGeneration: 1,
    state: "ready",
    format: USER_DATA_EXPORT_FORMAT,
    schemaVersion: USER_DATA_EXPORT_SCHEMA_VERSION,
    contentType: USER_DATA_EXPORT_CONTENT_TYPE,
    storageBackend: objects.backend,
    storageFormat: BLOB_STORAGE_FORMAT,
    policyVersion: "policy-v1",
    policySha256: POLICY_SHA256,
    snapshotRootSha256: "4".repeat(64),
    artifactTtlMs: 60_000,
    partCount: chunks.length,
    recordCount: 2,
    totalSizeBytes: body.byteLength,
    contentSha256,
    manifestSha256: "5".repeat(64),
    snapshotAtMs: 1_100,
    stagingExpiresAtMs: 10_000,
    readyAtMs: 1_200,
    expiresAtMs: 61_200,
    deletionGeneration: 0,
    createdAtMs: 1_100,
  };
  const parts: UserDataExportArtifactPart[] = [];
  for (const [partNumber, chunk] of chunks.entries()) {
    const storageKey = userDataExportStorageKey(
      { tenantId: record.tenantId, userId: record.userId },
      REQUEST_ID,
      ARTIFACT_ID,
      partNumber,
    );
    const uploadToken = `upload-token-${String(partNumber).padStart(8, "0")}`;
    const descriptor = await objects.putIfAbsent(storageKey, chunk, {
      uploadToken,
      contentType: USER_DATA_EXPORT_CONTENT_TYPE,
      maxBytes: 1_024,
    });
    parts.push({
      artifactId: ARTIFACT_ID,
      requestId: REQUEST_ID,
      buildGeneration: 1,
      partNumber,
      state: "uploaded",
      storageBackend: objects.backend,
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey,
      uploadToken,
      sha256: descriptor.sha256,
      sizeBytes: descriptor.sizeBytes,
      contentType: descriptor.contentType,
      uploadedAtMs: 1_150 + partNumber,
      deletionGeneration: 0,
      createdAtMs: 1_100,
    });
  }
  artifact.manifestSha256 = userDataExportManifestSha256(parts);
  exports.statusRecord = record;
  exports.download = {
    request: record,
    artifact,
    parts,
    leaseToken: "ignored-by-fake",
    leaseUntilMs: 99_999,
  };
  return { record, artifact, parts, body };
}

describe("agent-runner user data export HTTP API", () => {
  it("separates code awareness from the default-off request admission gate", async () => {
    const unavailable = await fixture({ attachExport: false, admission: true });
    expect(await (await unavailable.app.request("/v1/capabilities")).json()).toMatchObject({
      features: { userDataExport: [], dataExportRequests: false },
    });

    const gated = await fixture({ admission: false });
    expect(await (await gated.app.request("/v1/capabilities")).json()).toMatchObject({
      features: { userDataExport: ["artifact-ndjson-v1"], dataExportRequests: false },
    });
    const blocked = await gated.call("/v1/data-export-requests", {
      method: "POST",
      headers: { "idempotency-key": "export-once" },
    });
    expect(blocked.status).toBe(503);
    expectPrivate(blocked);

    const enabled = await fixture({ admission: true });
    expect(await (await enabled.app.request("/v1/capabilities")).json()).toMatchObject({
      features: { userDataExport: ["artifact-ndjson-v1"], dataExportRequests: true },
    });
  });

  it("requires an admin service key, a user identity and a non-empty idempotency key", async () => {
    const { call, exports } = await fixture({ admission: true });
    const runtimeOnly = await call("/v1/data-export-requests", {
      method: "POST",
      headers: { "idempotency-key": "export-once" },
    }, { key: "runtime-key" });
    expect(runtimeOnly.status).toBe(403);
    expectPrivate(runtimeOnly);

    const noUser = await call("/v1/data-export-requests", {
      method: "POST",
      headers: { "idempotency-key": "export-once" },
    }, { userId: null });
    expect(noUser.status).toBe(400);
    expectPrivate(noUser);

    const noKey = await call("/v1/data-export-requests", { method: "POST" });
    expect(noKey.status).toBe(400);
    expectPrivate(noKey);
    expect(exports.requestCalls).toHaveLength(0);
  });

  it("passes only owner-scoped request material and returns an idempotent public response", async () => {
    const { call, exports } = await fixture({ admission: true });
    const first = await call("/v1/data-export-requests", {
      method: "POST",
      headers: { "idempotency-key": " stable-export-key " },
    });
    const second = await call("/v1/data-export-requests", {
      method: "POST",
      headers: { "idempotency-key": "stable-export-key" },
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await first.json()).toEqual(await second.json());
    expect(exports.requestCalls).toHaveLength(2);
    expect(exports.requestCalls[0]).toMatchObject({
      tenantId: "t_export",
      userId: "u_owner",
      requestedByKeyId: "admin",
    });
    expect(exports.requestCalls[0]!.idempotencyKeySha256).toBe(
      createHash("sha256").update("stable-export-key").digest("hex"),
    );
    expect(exports.requestCalls[0]!.requestHash).toBe(exports.requestCalls[1]!.requestHash);
    expect(exports.requestCalls[0]!.requestId).not.toBe(exports.requestCalls[1]!.requestId);
    expectPrivate(second);
  });

  it("maps unavailable policy and idempotency conflicts without leaking cacheable details", async () => {
    const { call, exports } = await fixture({ admission: true });
    for (const [error, status, code] of [
      [new UserDataExportPolicyUnavailableError(), 503, "draining"],
      [new UserDataExportIdempotencyMismatchError(), 409, "idempotency_conflict"],
    ] as const) {
      exports.requestError = error;
      const response = await call("/v1/data-export-requests", {
        method: "POST",
        headers: { "idempotency-key": "export-once" },
      });
      expect(response.status).toBe(status);
      expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
      expectPrivate(response);
    }
  });

  it("confines status to the tenant and user and exposes only the strict public ready shape", async () => {
    const { call, exports, objects } = await fixture();
    const { record } = await readyDownload(exports, objects);
    const response = await call(`/v1/data-export-requests/${REQUEST_ID}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: REQUEST_ID,
      scope: "user",
      userId: "u_owner",
      format: "ndjson-v1",
      status: "ready",
      snapshotAtMs: 1_100,
      readyAtMs: 1_200,
      expiresAtMs: 61_200,
      artifact: {
        contentType: USER_DATA_EXPORT_CONTENT_TYPE,
        sizeBytes: record.artifactSizeBytes,
        sha256: record.artifactSha256,
      },
      createdAtMs: 1_000,
      updatedAtMs: 1_200,
    });
    expectPrivate(response);

    expect((await call(`/v1/data-export-requests/${REQUEST_ID}`, {}, { userId: "u_other" })).status).toBe(404);
    expect((await call(`/v1/data-export-requests/${REQUEST_ID}`, {}, { key: "other-key" })).status).toBe(404);
    expect(exports.getCalls).toContainEqual(["t_export", "u_other", REQUEST_ID]);
    expect(exports.getCalls).toContainEqual(["t_other", "u_owner", REQUEST_ID]);
  });

  it("streams verified parts in order, publishes integrity headers and releases the lease", async () => {
    const { call, exports, objects } = await fixture();
    const ready = await readyDownload(exports, objects);
    const response = await call(`/v1/data-export-requests/${REQUEST_ID}/download`);
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(response.headers.get("content-type")).toBe(USER_DATA_EXPORT_CONTENT_TYPE);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="agent-service-user-export-${REQUEST_ID}.ndjson"`,
    );
    expect(response.headers.get("content-length")).toBe(String(ready.body.byteLength));
    expect(response.headers.get("x-artifact-size")).toBe(String(ready.body.byteLength));
    expect(response.headers.get("content-digest")).toBe(
      `sha-256=:${Buffer.from(ready.artifact.contentSha256!, "hex").toString("base64")}:`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ready.body);
    expect(exports.renewCalls).toHaveLength(ready.parts.length);
    expect(exports.releaseCalls).toHaveLength(1);
    expect(exports.releaseCalls[0]![0]).toBe(ARTIFACT_ID);
  });

  it("releases leases on cancellation, missing ownership and corrupt artifact parts", async () => {
    const { call, exports, objects } = await fixture();
    await readyDownload(exports, objects);

    const cancelled = await call(`/v1/data-export-requests/${REQUEST_ID}/download`);
    expect(cancelled.status).toBe(200);
    await cancelled.body!.cancel("client stopped");
    expect(exports.releaseCalls).toHaveLength(1);

    const hidden = await call(
      `/v1/data-export-requests/${REQUEST_ID}/download`,
      {},
      { userId: "u_other" },
    );
    expect(hidden.status).toBe(404);
    expectPrivate(hidden);
    expect(exports.releaseCalls).toHaveLength(1);

    exports.download!.parts[0]!.sha256 = "f".repeat(64);
    exports.download!.artifact.manifestSha256 = userDataExportManifestSha256(
      exports.download!.parts,
    );
    const corrupt = await call(`/v1/data-export-requests/${REQUEST_ID}/download`);
    expect(corrupt.status).toBe(200);
    await expect(corrupt.arrayBuffer()).rejects.toThrow();
    expect(exports.releaseCalls).toHaveLength(2);
  });

  it("rejects owner, generation, backend and locator metadata before reading or streaming", async () => {
    const corruptions: Array<(download: UserDataExportDownloadLease) => void> = [
      (download) => { download.artifact.subjectGeneration += 1; },
      (download) => { download.artifact.storageBackend = "foreign-v1"; },
      (download) => { download.parts[0]!.requestId = OTHER_REQUEST_ID; },
      (download) => { download.parts[0]!.contentType = "application/octet-stream"; },
      (download) => {
        download.parts[0]!.storageKey = userDataExportStorageKey(
          { tenantId: "t_export", userId: "u_other" },
          REQUEST_ID,
          ARTIFACT_ID,
          0,
        );
      },
      (download) => { download.artifact.manifestSha256 = "f".repeat(64); },
    ];

    for (const corrupt of corruptions) {
      const { call, exports, objects } = await fixture();
      await readyDownload(exports, objects);
      corrupt(exports.download!);
      const get = vi.spyOn(objects, "get");
      const response = await call(`/v1/data-export-requests/${REQUEST_ID}/download`);
      expect(response.status).toBe(500);
      expectPrivate(response);
      expect(get).not.toHaveBeenCalled();
      expect(exports.releaseCalls).toHaveLength(1);
      get.mockRestore();
    }
  });

  it("fails closed and releases immediately when ready part metadata is non-contiguous", async () => {
    const { call, exports, objects } = await fixture();
    await readyDownload(exports, objects);
    exports.download!.parts[0]!.partNumber = 1;
    const response = await call(`/v1/data-export-requests/${REQUEST_ID}/download`);
    expect(response.status).toBe(500);
    expectPrivate(response);
    expect(exports.releaseCalls).toHaveLength(1);
  });
});
