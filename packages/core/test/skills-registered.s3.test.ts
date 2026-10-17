import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore, S3BlobStore, createSkillRegistryAccess, type SkillOwner } from "@agent-service/store";
import { RegisteredSkillService } from "../src/skills/registered.js";

// The AWS SDK is the store adapter's existing production dependency. Resolve it
// from that real package, not an undeclared hoist or a second test-only SDK copy.
interface S3Output { Contents?: { Key?: string }[]; IsTruncated?: boolean; Errors?: unknown[] }
interface S3Admin { send(command: object, options: { abortSignal: AbortSignal }): Promise<S3Output>; destroy(): void }
type Command = new (input: Record<string, unknown>) => object;
const requireStore = createRequire(new URL("../../store/package.json", import.meta.url));
const aws = requireStore("@aws-sdk/client-s3") as {
  S3Client: new (config: Record<string, unknown>) => S3Admin;
  HeadBucketCommand: Command; CreateBucketCommand: Command; ListObjectsV2Command: Command;
  DeleteObjectsCommand: Command; DeleteBucketCommand: Command;
};
const gates = [process.env.AGENT_SERVICE_INTEGRATION ?? "0", process.env.AGENT_SERVICE_S3_INTEGRATION ?? "0"];
if (gates.some(value => value !== "0" && value !== "1")) throw new Error("Skill registry integration gates must be 0 or 1.");
const enabled = gates.every(value => value === "1");
function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error("Skill registry S3 fixture configuration is incomplete."); return value; }
function mysqlBase(raw: string): URL {
  let value: URL; try { value = new URL(raw); } catch { throw new Error("Skill registry fixture requires local disposable MySQL."); }
  if (value.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(value.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(value.pathname.slice(1)))) throw new Error("Skill registry fixture requires local disposable MySQL.");
  return value;
}
function s3Origin(raw: string): URL {
  let value: URL; try { value = new URL(raw); } catch { throw new Error("Skill registry fixture requires local MinIO."); }
  if (!["http:", "https:"].includes(value.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(value.hostname)
    || value.username || value.password || value.href.includes("?") || value.href.includes("#") || value.pathname !== "/") throw new Error("Skill registry fixture requires local MinIO.");
  return value;
}
const base = mysqlBase(enabled ? required("MYSQL_TEST_URL") : "mysql://root@127.0.0.1/agent_service_test");
const endpoint = s3Origin(enabled ? required("S3_TEST_ENDPOINT") : "http://127.0.0.1:9000");
const region = enabled ? required("S3_TEST_REGION") : "us-east-1";
const accessKeyId = enabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = enabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const pathStyle = enabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (pathStyle !== "0" && pathStyle !== "1") throw new Error("Skill registry S3 fixture path style is invalid.");
const clientConfig = { endpoint: endpoint.origin, region, forcePathStyle: pathStyle === "1", credentials: { accessKeyId, secretAccessKey } };
const runId = randomBytes(6).toString("hex"), database = `agent_service_skills_s3_test_${process.pid}_${runId}`;
const bucket = `agent-service-skills-test-${process.pid}-${runId}`, prefix = `skills-registry-tests/${runId}`;
function assertOwnedNames(): void {
  if (!/^agent_service_skills_s3_test_[0-9]+_[a-f0-9]{12}$/.test(database)
    || !/^agent-service-skills-test-[0-9]+-[a-f0-9]{12}$/.test(bucket)
    || !/^skills-registry-tests\/[a-f0-9]{12}$/.test(prefix)) throw new Error("Skill registry fixture ownership is invalid.");
}
function urlFor(name: string): string { const value = new URL(base); value.pathname = `/${name}`; return value.toString(); }
function absentBucket(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (e.name === "NotFound" || e.name === "NoSuchBucket") && e.$metadata?.httpStatusCode === 404;
}
function errorText(error: unknown, field: "name" | "message"): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, field);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.length <= 256 ? descriptor.value : undefined;
}
/** Classify only the adapter's closed safe vocabulary. Never include raw error
 * text, cause, request metadata, endpoint, credential or object bytes in output. */
function startupReason(error: unknown): string {
  if (error instanceof AggregateError) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "errors");
    const errors: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (Array.isArray(errors) && errors.length === 2 && errors.every(e => !(e instanceof AggregateError))) {
      return `probe_and_cleanup_${startupReason(errors[0])}_${startupReason(errors[1])}`;
    }
    return "aggregate_unclassified";
  }
  const name = errorText(error, "name"), message = errorText(error, "message");
  if (name === "S3VersionedObjectError") return "versioned_object_evidence";
  if (name !== "S3BlobError" || message === undefined) return "unclassified";
  const exact: Record<string, string> = {
    "S3 blob bucket versioning must be disabled, received Enabled": "versioning_enabled",
    "S3 blob bucket versioning must be disabled, received Suspended": "versioning_suspended",
    "S3 blob bucket versioning must be disabled, received an unexpected state": "versioning_unexpected",
    "S3 blob bucket lifecycle configuration must be absent": "lifecycle_configured",
    "S3 blob bucket Object Lock must be disabled or absent": "object_lock_configured",
    "S3 conditional-write probe did not return an ETag": "probe_missing_etag",
    "S3 endpoint ignored If-None-Match during startup probe": "probe_create_only_ignored",
    "S3 endpoint ignored If-Match during startup probe": "probe_cas_ignored",
    "S3 startup probe cleanup was not strongly visible": "probe_cleanup_not_visible",
  };
  if (Object.hasOwn(exact, message)) return exact[message]!;
  const match = /^S3 blob (startup reachability check|startup versioning check|startup lifecycle check|startup Object Lock check|startup probe metadata read|startup conditional-write probe|startup probe cleanup) failed(?: \((?:(AbortError|AccessDenied|CredentialsProviderError|InternalError|InvalidAccessKeyId|InvalidRequest|NetworkingError|NoSuchBucket|ServiceUnavailable|SignatureDoesNotMatch|SlowDown|TimeoutError)(?:\/([1-5][0-9]{2}))?|([1-5][0-9]{2}))\))?$/.exec(message);
  if (!match) return "adapter_unclassified";
  const operation: Record<string, string> = { "startup reachability check": "reachability", "startup versioning check": "versioning",
    "startup lifecycle check": "lifecycle", "startup Object Lock check": "object_lock", "startup probe metadata read": "probe_metadata",
    "startup conditional-write probe": "conditional_write", "startup probe cleanup": "probe_cleanup" };
  return `${operation[match[1]!]!}_${match[2] ?? "no_class"}_${match[3] ?? match[4] ?? "no_status"}`;
}
function fixtureFailure(stage: string, error?: unknown): Error {
  assertOwnedNames();
  // Only generated test resource names are diagnostic. These are not backend
  // locators returned to API users; no URL/config/header/error is interpolated.
  return new Error(`Skill registry S3 fixture failed at ${stage}; reason=${startupReason(error)}; owned database=${database}; owned bucket=${bucket}; inspect retained targets.`);
}
const principal = { tenantId: `skills-s3-${runId}`, userId: "owner" };
const owner: SkillOwner = { scope: "user", tenantId: principal.tenantId, userId: principal.userId };
const access = createSkillRegistryAccess({ principal, owner, authority: "user_self", access: "manage" });
const markdown = (body: string) => Buffer.from(`---\nname: review\ndescription: Cross client registered instructions\nwhenToUse: During a requested review\n---\n${body}\n`);
const describeReal = enabled ? describe : describe.skip;

describeReal("RegisteredSkillService actual MySQL and independent MinIO clients", () => {
  let admin: Connection | undefined, observer: Connection | undefined, s3: S3Admin | undefined;
  const stores = new Set<MysqlSessionStore>(), adapters = new Set<S3BlobStore>(), services = new Set<RegisteredSkillService>();
  let first: MysqlSessionStore, second: MysqlSessionStore, firstBlob: S3BlobStore, secondBlob: S3BlobStore;
  let firstService: RegisteredSkillService, secondService: RegisteredSkillService;
  let databaseCreated = false, bucketCreated = false, expired = false;
  let stage = "setup";
  const send = (command: object) => s3!.send(command, { abortSignal: AbortSignal.timeout(5000) });
  const newBlob = () => { const adapter = new S3BlobStore({ bucket, prefix, namespaceId: `skills-${runId}`, clientConfig, requestTimeoutMs: 5000 }); adapters.add(adapter); return adapter; };
  const newService = (store: MysqlSessionStore, blobs: S3BlobStore, namespaceSha256 = blobs.namespaceSha256) => {
    const service = new RegisteredSkillService({ store, blobs, namespaceSha256, timeoutMs: 10_000 }); services.add(service); return service;
  };
  async function closeOwned(): Promise<void> {
    let uncertain = false;
    for (const service of [...services]) { try { await service.close(); services.delete(service); } catch { uncertain = true; } }
    for (const adapter of [...adapters]) { try { await adapter.close(); adapters.delete(adapter); } catch { uncertain = true; } }
    for (const store of [...stores]) { try { await store.close(); stores.delete(store); } catch { uncertain = true; } }
    if (observer) { const connection = observer; try { await connection.end(); observer = undefined; } catch { connection.destroy(); uncertain = true; } }
    if (uncertain) throw fixtureFailure("owned_close");
  }
  beforeAll(async () => {
    assertOwnedNames();
    try {
      stage = "admin_connect"; admin = await mysql.createConnection({ uri: urlFor("mysql"), connectTimeout: 5000 });
      const [existing] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", timeout: 5000 }, [database]);
      if (existing.length) throw new Error("owned database already exists");
      stage = "bucket_absence"; s3 = new aws.S3Client({ ...clientConfig, maxAttempts: 1 });
      let absent = false; try { await send(new aws.HeadBucketCommand({ Bucket: bucket })); } catch (error) { if (absentBucket(error)) absent = true; else throw new Error("bucket absence is unproven"); }
      if (!absent) throw new Error("owned bucket already exists");
      stage = "bucket_create"; await send(new aws.CreateBucketCommand({ Bucket: bucket })); bucketCreated = true;
      stage = "database_create"; await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5000 }); databaseCreated = true;
      stage = "schema_migrate"; first = await MysqlSessionStore.connect({ url: urlFor(database), connectionLimit: 2 }); stores.add(first);
      stage = "second_pool"; second = await MysqlSessionStore.connect({ url: urlFor(database), connectionLimit: 2, migrationMode: "verify" }); stores.add(second);
      observer = await mysql.createConnection({ uri: urlFor(database), connectTimeout: 5000 });
      stage = "blob_construct"; firstBlob = newBlob(); secondBlob = newBlob();
      stage = "first_blob_startup"; await firstBlob.validateStartup();
      stage = "second_blob_startup"; await secondBlob.validateStartup();
      firstService = newService(first, firstBlob); secondService = newService(second, secondBlob);
    } catch (error) { await closeOwned().catch(() => {}); throw fixtureFailure(stage, error); }
  }, 120_000);
  afterAll(async () => {
    // Never delete from a late hook. A timeout/failure retains the exact random
    // DB and bucket for diagnosis; only the successful case owns cleanup below.
    try { await closeOwned(); } finally {
      s3?.destroy();
      if (admin) { const connection = admin; try { await connection.end(); admin = undefined; } catch { connection.destroy(); } }
    }
  });

  it("shares admitted bytes and immutable overrides across pools/clients, then rejects deleted generations and drift", async () => {
    const deadline = performance.now() + 29_000;
    const check = () => { if (expired || performance.now() >= deadline) { expired = true; throw fixtureFailure("case_deadline"); } };
    const work = async <T>(next: () => Promise<T>): Promise<T> => { check(); const result = await next(); check(); return result; };
    let passed = false;
    try {
      stage = "install_first";
      const bytes1 = markdown("Original shared instruction."), bytes2 = markdown("Second shared instruction.");
      const v1 = await work(() => firstService.install(owner, { access, document: bytes1, expectedRevision: 0, idempotencyKey: "first" }));
      const v2 = await work(() => firstService.install(owner, { access, document: bytes2, expectedRevision: 1, idempotencyKey: "second" }));
      expect(firstBlob).not.toBe(secondBlob); expect(first).not.toBe(second);
      expect(firstBlob.namespaceSha256).toBe(secondBlob.namespaceSha256);
      expect(v2.storageNamespaceSha256).toBe(secondBlob.namespaceSha256);
      const [manifestRows] = await work(() => observer!.query<RowDataPacket[]>({ sql: "SELECT COUNT(*) AS n FROM blob_objects WHERE storage_key IN (?,?)", timeout: 5000 }, [v1.storageKey, v2.storageKey]));
      expect(Number(manifestRows[0]?.n)).toBe(0);
      const [versionRows] = await work(() => observer!.query<RowDataPacket[]>({ sql: "SELECT COUNT(*) AS n FROM skill_registry_versions", timeout: 5000 }));
      expect(Number(versionRows[0]?.n)).toBe(2);
      await work(() => firstService.close()); services.delete(firstService);
      await work(() => firstBlob.close()); adapters.delete(firstBlob);
      await work(() => first.close()); stores.delete(first);
      stage = "second_client_catalog";
      const listed = await work(() => secondService.list(principal, ["registry:review"], new AbortController().signal));
      expect(listed).toHaveLength(1); expect(listed[0]!.versionSha256).toBe(v2.versionSha256);
      expect(JSON.stringify(listed)).not.toContain("Second shared instruction."); expect(JSON.stringify(listed)).not.toContain("skill-packages/");
      const loaded = await work(() => secondService.load(principal, ["registry:review"], { name: "review", invocation: "model", availableTools: [], expectedVersionSha256: v2.versionSha256 }, new AbortController().signal));
      expect(loaded).toMatchObject({ id: v2.slotId, body: "Second shared instruction.\n", contentSha256: v2.sha256, versionSha256: v2.versionSha256 });
      const override = { overrides: [{ name: "review", versionId: v1.versionId }] };
      const pinned = await work(() => secondService.load(principal, ["registry:review"], { name: "review", invocation: "user", availableTools: [], expectedVersionSha256: v1.versionSha256 }, new AbortController().signal, override));
      expect(pinned.body).toBe("Original shared instruction.\n");
      expect((await work(() => secondService.readVersion(owner, "review", v1.versionId, { access }))).document).toBe(bytes1.toString());
      stage = "isolation_and_namespace";
      await expect(secondService.list({ ...principal, userId: "foreign-user" }, ["registry:review"], new AbortController().signal)).rejects.toMatchObject({ code: "not_found" }); check();
      const drift = newService(second, secondBlob, "b".repeat(64));
      await expect(drift.list(principal, ["registry:review"], new AbortController().signal)).rejects.toMatchObject({ code: "invalid_request" }); check();
      await work(() => drift.close()); services.delete(drift);
      stage = "delete_and_reject";
      const deleted = await work(() => secondService.deleteInstalled(owner, "review", { access, expectedRevision: 2, idempotencyKey: "delete" }));
      expect(deleted).toMatchObject({ state: "deleted", revision: 3, currentVersionId: null });
      await expect(secondService.list(principal, ["registry:review"], new AbortController().signal, override)).rejects.toMatchObject({ code: "not_found" }); check();
      await expect(secondService.readVersion(owner, "review", v1.versionId, { access })).rejects.toMatchObject({ code: "not_found" }); check();
      // Logical deletion does not claim physical cleanup. The independently read
      // object still contains exact bytes until the isolated fixture is removed.
      expect((await work(() => secondBlob.get(v1.storageKey, { maxBytes: 65_536 })))?.data).toEqual(bytes1);
      await work(() => closeOwned());
      stage = "cold_verify";
      const cold = await work(() => MysqlSessionStore.connect({ url: urlFor(database), migrationMode: "verify", connectionLimit: 1 })); stores.add(cold);
      const coldBlob = newBlob(), coldService = newService(cold, coldBlob);
      expect((await work(() => coldService.getInstalled(owner, "review", { access })))?.state).toBe("deleted");
      await expect(coldService.readVersion(owner, "review", v1.versionId, { access })).rejects.toMatchObject({ code: "not_found" }); check();
      expect((await work(() => coldBlob.get(v2.storageKey, { maxBytes: 65_536 })))?.data).toEqual(bytes2);
      await work(() => closeOwned()); check(); passed = true;
    } catch (error) { throw fixtureFailure(stage, error); }
    finally {
      try {
      try { await closeOwned(); } catch { passed = false; }
      if (performance.now() >= deadline) expired = true;
      if (passed && !expired && databaseCreated && bucketCreated) {
        assertOwnedNames(); check(); stage = "owned_cleanup";
        const objects = await work(() => send(new aws.ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 })));
        if (objects.IsTruncated || objects.Contents?.some(object => !object.Key || !object.Key.startsWith(`${prefix}/`))) throw new Error("Skill registry cleanup ownership is uncertain; evidence is retained.");
        const keys = (objects.Contents ?? []).map(object => ({ Key: object.Key! }));
        if (keys.length) {
          const removed = await work(() => send(new aws.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } })));
          if (removed.Errors?.length) throw new Error("Skill registry owned object cleanup failed.");
        }
        const empty = await work(() => send(new aws.ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 })));
        if (empty.Contents?.length || empty.IsTruncated) throw new Error("Skill registry owned bucket is not empty.");
        await work(() => send(new aws.DeleteBucketCommand({ Bucket: bucket }))); bucketCreated = false;
        check(); await work(() => admin!.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 })); databaseCreated = false;
      } else if (passed) throw fixtureFailure("expired_before_cleanup");
      } catch (error) { throw fixtureFailure(`${stage}_cleanup`, error); }
    }
    expect(databaseCreated, fixtureFailure("database_cleanup_incomplete").message).toBe(false);
    expect(bucketCreated, fixtureFailure("bucket_cleanup_incomplete").message).toBe(false);
  });
});
