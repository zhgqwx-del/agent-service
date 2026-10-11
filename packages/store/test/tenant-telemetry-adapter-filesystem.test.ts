import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILESYSTEM_TENANT_TELEMETRY_BACKEND_KIND,
  FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  FilesystemTenantTelemetryWriteAdapter,
  MemorySessionStore,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TenantTelemetryWriteAdapterConflictError,
  TenantTelemetryWriteAdapterTemporaryError,
  tenantTelemetryFilesystemFailureDomainSha256,
  tenantTelemetryFilesystemNamespaceSha256,
  type TenantTelemetryLifecycleTargetRecord,
  type TenantTelemetryWriteAdapterInput,
} from "../src/index.js";
import { trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";

const NAMESPACE_ID = "local-telemetry-fixture-v1";
const FAILURE_DOMAIN_ID = "developer-workstation-v1";
const REF_KEY = new Uint8Array(32).fill(31);
const roots: string[] = [];
const adapters: FilesystemTenantTelemetryWriteAdapter[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.allSettled(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-telemetry-filesystem-"));
  roots.push(root);
  return root;
}

async function fixture(
  root: string,
  options: { tenantId?: string; statusCode?: number } = {},
): Promise<{
  input: TenantTelemetryWriteAdapterInput;
  targets: TenantTelemetryLifecycleTargetRecord[];
}> {
  let nowMs = 1_000;
  const tenantId = options.tenantId ?? "filesystem-telemetry-tenant";
  const store = new MemorySessionStore(
    { now: () => nowMs },
    { tenantTelemetryRefKey: REF_KEY },
  );
  const activated = await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: (["logs", "traces"] as const).map((domain) => ({
      domain,
      backendKind: FILESYSTEM_TENANT_TELEMETRY_BACKEND_KIND,
      adapterProtocol: FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
      namespaceSha256: tenantTelemetryFilesystemNamespaceSha256(
        root,
        NAMESPACE_ID,
        domain,
      ),
      failureDomainSha256:
        tenantTelemetryFilesystemFailureDomainSha256(FAILURE_DOMAIN_ID),
    })),
  });
  nowMs = 1_100;
  await store.createApiKey(tenantId, "filesystem-key", "hash");
  const artifactIdSha256 = "5".repeat(64);
  await store.enqueueTenantTelemetryArtifact({
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256,
    artifactGeneration: 1,
    ownerKind: "tenant",
    ownerId: tenantId,
    ownerUserId: null,
    sourceSchema: "structured-log-batch-v1",
    sourceGeneration: 1,
    sourceHighWaterDbMs: nowMs,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs",
      records: [trustedRunnerTelemetryRecord(nowMs, {
        opaqueRefKey: REF_KEY,
        ownerKind: "tenant",
        ownerValue: tenantId,
        statusCode: options.statusCode ?? 202,
      })],
    },
  });
  const [claim] = await store.claimTenantTelemetryWriteJobs({
    limit: 1,
    leaseMs: 10_000,
    claimToken: "filesystem-telemetry-claim",
    adapterProtocol: FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  });
  if (!claim) throw new Error("filesystem telemetry fixture claim is missing");
  return {
    targets: activated.targets,
    input: {
      writeOperationSha256: claim.writeOperationSha256,
      target: claim.target,
      inventory: claim.inventory,
      payload: claim.payload,
    },
  };
}

function adapter(
  root: string,
  targets: readonly TenantTelemetryLifecycleTargetRecord[],
  options: Partial<ConstructorParameters<typeof FilesystemTenantTelemetryWriteAdapter>[0]> = {},
): FilesystemTenantTelemetryWriteAdapter {
  const sink = new FilesystemTenantTelemetryWriteAdapter({
    root,
    namespaceId: NAMESPACE_ID,
    failureDomainId: FAILURE_DOMAIN_ID,
    expectedTargets: targets,
    localOnly: true,
    singleRunner: true,
    ...options,
  });
  adapters.push(sink);
  return sink;
}

function artifactPath(root: string, input: TenantTelemetryWriteAdapterInput): string {
  return join(
    root,
    "v1",
    input.target.targetSha256.slice(0, 2),
    input.target.targetSha256,
    input.inventory.artifactIdSha256.slice(0, 2),
    input.inventory.artifactIdSha256,
    `${input.inventory.artifactGeneration}.json`,
  );
}

function stagingPath(root: string, input: TenantTelemetryWriteAdapterInput): string {
  return join(
    dirname(artifactPath(root, input)),
    `.telemetry-${input.writeOperationSha256}.writing`,
  );
}

async function expectMissing(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("FilesystemTenantTelemetryWriteAdapter", () => {
  it("publishes one private artifact atomically and another instance inspects exact replay", async () => {
    const root = await tempRoot();
    const prepared = await fixture(root, { tenantId: "raw-tenant-must-not-be-stored" });
    const writer = adapter(root, prepared.targets);

    await expect(writer.inspectWrite(prepared.input)).resolves.toEqual({ status: "absent" });
    await expect(writer.createWrite(prepared.input)).resolves.toMatchObject({
      outcome: "written",
      replayed: false,
      writeOperationSha256: prepared.input.writeOperationSha256,
    });

    const relativeRoot = relative(process.cwd(), root);
    const reader = adapter(relativeRoot, prepared.targets);
    await expect(reader.inspectWrite(prepared.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
    const path = artifactPath(root, prepared.input);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(path, "utf8");
    expect(bytes).not.toContain("raw-tenant-must-not-be-stored");
    expect(bytes).toContain(prepared.input.inventory.payloadSha256);
  });

  it("recovers a committed response loss by exact cross-instance inspection", async () => {
    const root = await tempRoot();
    const prepared = await fixture(root);
    const writer = adapter(root, prepared.targets, {
      afterWriteCommit: () => {
        throw new Error("simulated secret response loss");
      },
    });

    await expect(writer.createWrite(prepared.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterTemporaryError);
    await expectMissing(stagingPath(root, prepared.input));
    const reader = adapter(root, prepared.targets);
    await expect(reader.inspectWrite(prepared.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
  });

  it("does not acknowledge a committed artifact until staging unlink succeeds", async () => {
    const root = await tempRoot();
    const prepared = await fixture(root);
    const committed = vi.fn();
    const writer = adapter(root, prepared.targets, {
      afterWriteCommit: committed,
      stagingUnlink: async () => {
        throw Object.assign(new Error("injected staging unlink failure"), { code: "EIO" });
      },
    });

    await expect(writer.createWrite(prepared.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterTemporaryError);
    expect(committed).not.toHaveBeenCalled();
    const canonical = artifactPath(root, prepared.input);
    const staging = stagingPath(root, prepared.input);
    const [canonicalEntry, stagingEntry] = await Promise.all([stat(canonical), stat(staging)]);
    expect(canonicalEntry.ino).toBe(stagingEntry.ino);
    expect(canonicalEntry.nlink).toBe(2);

    await writer.close();
    const restarted = adapter(root, prepared.targets);
    await expect(restarted.inspectWrite(prepared.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
    await expectMissing(staging);
    expect((await stat(canonical)).nlink).toBe(1);
  });

  it("cleans a deterministic post-link crash orphan before exact restart inspection", async () => {
    const root = await tempRoot();
    const prepared = await fixture(root);
    const writer = adapter(root, prepared.targets);
    await writer.createWrite(prepared.input);
    const canonical = artifactPath(root, prepared.input);
    const staging = stagingPath(root, prepared.input);

    // Recreate the exact durable state left by a process stopping after link(canonical) but before
    // unlink(staging).  The path is operation-scoped, so a new adapter can discover it directly.
    await link(canonical, staging);
    expect((await stat(canonical)).nlink).toBe(2);
    await writer.close();

    const restarted = adapter(root, prepared.targets);
    await expect(restarted.inspectWrite(prepared.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
    await expectMissing(staging);
    expect((await stat(canonical)).nlink).toBe(1);
  });

  it("linearizes concurrent exact creates without exposing partial bytes", async () => {
    const root = await tempRoot();
    const prepared = await fixture(root);
    const first = adapter(root, prepared.targets);
    const second = adapter(root, prepared.targets);

    const results = await Promise.all([
      first.createWrite(prepared.input),
      second.createWrite(prepared.input),
    ]);
    expect(results.map((result) => result.outcome).sort())
      .toEqual(["already_present", "written"]);
    await expect(first.inspectWrite(prepared.input)).resolves.toMatchObject({ status: "exact" });
    await expectMissing(stagingPath(root, prepared.input));
  });

  it("never cleans another operation's concurrent staging file", async () => {
    const root = await tempRoot();
    const first = await fixture(root, { statusCode: 202 });
    const second = await fixture(root, { statusCode: 503 });
    expect(first.input.writeOperationSha256).not.toBe(second.input.writeOperationSha256);
    const sink = adapter(root, first.targets);

    const results = await Promise.allSettled([
      sink.createWrite(first.input),
      sink.createWrite(second.input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    await expectMissing(stagingPath(root, first.input));
    await expectMissing(stagingPath(root, second.input));
  });

  it("reports an occupied artifact slot as conflict and never overwrites it", async () => {
    const root = await tempRoot();
    const first = await fixture(root, { statusCode: 202 });
    const different = await fixture(root, { statusCode: 503 });
    const sink = adapter(root, first.targets);
    await sink.createWrite(first.input);
    const original = await readFile(artifactPath(root, first.input));

    await expect(sink.inspectWrite(different.input)).resolves.toEqual({ status: "conflict" });
    await expect(sink.createWrite(different.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    expect(await readFile(artifactPath(root, first.input))).toEqual(original);
  });

  it("rejects symlink roots and artifact slots instead of following them", async () => {
    const physical = await tempRoot();
    const linkedRoot = `${physical}-link`;
    roots.push(linkedRoot);
    await symlink(physical, linkedRoot, "dir");
    const linkedFixture = await fixture(linkedRoot);
    const linked = adapter(linkedRoot, linkedFixture.targets);
    await expect(linked.inspectWrite(linkedFixture.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);

    const root = await tempRoot();
    const prepared = await fixture(root);
    const sink = adapter(root, prepared.targets);
    const path = artifactPath(root, prepared.input);
    await mkdir(dirname(path), { recursive: true });
    const outside = join(root, "outside");
    await writeFile(outside, "do not read", { mode: 0o600 });
    await symlink(outside, path);
    await expect(sink.inspectWrite(prepared.input)).resolves.toEqual({ status: "conflict" });
    await expect(sink.createWrite(prepared.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it("binds backend, protocol, logical namespace, failure domain, and physical root", async () => {
    const root = await tempRoot();
    const other = await tempRoot();
    const prepared = await fixture(root);

    expect(() => adapter(other, prepared.targets)).toThrow(/target configuration/);
    expect(() => adapter(root, prepared.targets, { namespaceId: "another-namespace" }))
      .toThrow(/target configuration/);
    expect(() => adapter(root, prepared.targets, { failureDomainId: "another-host" }))
      .toThrow(/target configuration/);
    expect(() => adapter(root, prepared.targets.map((target) => ({
      ...target,
      adapterProtocol: "telemetry-http-v1",
    })))).toThrow(/target configuration/);
  });

  it("is explicitly local-only and cannot be constructed in production", async () => {
    const root = await tempRoot();
    const prepared = await fixture(root);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new FilesystemTenantTelemetryWriteAdapter({
      root,
      namespaceId: NAMESPACE_ID,
      failureDomainId: FAILURE_DOMAIN_ID,
      expectedTargets: prepared.targets,
      localOnly: true,
      singleRunner: true,
    })).toThrow(/forbidden in production/);
  });
});
