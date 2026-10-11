import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  tenantTelemetryArtifactPayloadCanonicalJson,
  type TenantTelemetryWriteAdapterResult,
} from "../tenant-telemetry-writer.js";
import {
  validateTenantTelemetryLifecycleTarget,
  type TenantTelemetryDomain,
  type TenantTelemetryLifecycleTargetRecord,
} from "../tenant-telemetry-lifecycle.js";
import {
  TenantTelemetryWriteAdapterConflictError,
  TenantTelemetryWriteAdapterTemporaryError,
  tenantTelemetryWriteAdapterResult,
  validateTenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteAdapter,
  type TenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteInspection,
} from "./common.js";

export const FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL =
  "telemetry-filesystem-v1" as const;
export const FILESYSTEM_TENANT_TELEMETRY_BACKEND_KIND =
  "local-filesystem" as const;
export const FILESYSTEM_TENANT_TELEMETRY_SINK_PROTOCOL =
  "agent-service.telemetry-filesystem-sink.v1" as const;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SHA256 = /^[a-f0-9]{64}$/;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// The adapter is explicitly single-runner, but one runner may still issue overlapping exact
// create/inspect calls (and tests may construct multiple adapter instances).  A process-wide tail
// per physical namespace + operation keeps those calls from treating each other's deterministic
// staging file as a crash orphan.  A second process using the same namespace violates the
// mandatory singleRunner contract; different operations never share a staging path.
const operationTails = new Map<string, Promise<void>>();

async function withOperationLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = operationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld;
  });
  const tail = previous.then(() => held, () => held);
  operationTails.set(key, tail);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (operationTails.get(key) === tail) operationTails.delete(key);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return isErrno(error, "ENOENT");
}

function canonicalizeRootIdentity(root: string): string {
  let existing = root;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync.native(existing), ...missingSegments);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missingSegments.unshift(basename(existing));
      existing = parent;
    }
  }
}

function rootIdentity(value: string): { root: string; identity: string } {
  if (typeof value !== "string" || value.length < 1) {
    throw new Error("tenant telemetry filesystem root must not be empty");
  }
  const root = resolve(value);
  return { root, identity: canonicalizeRootIdentity(root) };
}

export function tenantTelemetryFilesystemNamespaceSha256(
  root: string,
  namespaceId: string,
  domain: TenantTelemetryDomain,
): string {
  if (!LOGICAL_ID.test(namespaceId)) {
    throw new Error("tenant telemetry filesystem namespace id is invalid");
  }
  if (domain !== "logs" && domain !== "traces") {
    throw new Error("tenant telemetry filesystem domain is invalid");
  }
  const { identity } = rootIdentity(root);
  return createHash("sha256")
    .update(JSON.stringify([
      "tenant-telemetry-filesystem-namespace-v1",
      namespaceId,
      identity,
      domain,
    ]))
    .digest("hex");
}

export function tenantTelemetryFilesystemFailureDomainSha256(
  failureDomainId: string,
): string {
  if (!LOGICAL_ID.test(failureDomainId)) {
    throw new Error("tenant telemetry filesystem failure-domain id is invalid");
  }
  return createHash("sha256")
    .update(JSON.stringify([
      "tenant-telemetry-filesystem-failure-domain-v1",
      failureDomainId,
    ]))
    .digest("hex");
}

interface StoredFilesystemTenantTelemetryWrite {
  protocol: typeof FILESYSTEM_TENANT_TELEMETRY_SINK_PROTOCOL;
  adapterProtocol: typeof FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;
  targetSha256: string;
  targetReceiptSha256: string;
  domain: TenantTelemetryDomain;
  writeOperationSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  payloadSha256: string;
  manifestSha256: string;
  payload: unknown;
}

function canonicalStoredJson(input: TenantTelemetryWriteAdapterInput): string {
  const payload = validateTenantTelemetryWriteAdapterInput(input);
  const stored: StoredFilesystemTenantTelemetryWrite = {
    protocol: FILESYSTEM_TENANT_TELEMETRY_SINK_PROTOCOL,
    adapterProtocol: FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    targetSha256: input.target.targetSha256,
    targetReceiptSha256: input.target.receiptSha256,
    domain: input.inventory.domain,
    writeOperationSha256: input.writeOperationSha256,
    artifactIdSha256: input.inventory.artifactIdSha256,
    artifactGeneration: input.inventory.artifactGeneration,
    payloadSha256: input.inventory.payloadSha256,
    manifestSha256: input.inventory.manifestSha256,
    payload: JSON.parse(tenantTelemetryArtifactPayloadCanonicalJson(payload)) as unknown,
  };
  return `${JSON.stringify(stored)}\n`;
}

export interface FilesystemTenantTelemetryWriteAdapterOptions {
  root: string;
  /** Non-secret logical identity; changing it requires a new 0033 target activation. */
  namespaceId: string;
  /** Non-secret local fault-domain declaration. It is not an independent production domain. */
  failureDomainId: string;
  /** Exact immutable 0033 targets allowed to publish beneath this local directory. */
  expectedTargets: readonly TenantTelemetryLifecycleTargetRecord[];
  /** Mandatory acknowledgement that this adapter is local-only and not a managed sink. */
  localOnly: true;
  /** Mandatory acknowledgement that only one runner process owns this host-local namespace. */
  singleRunner: true;
  /** Runs after durable create-only publication, allowing response-loss tests. */
  afterWriteCommit?: (
    input: TenantTelemetryWriteAdapterInput,
    result: TenantTelemetryWriteAdapterResult,
  ) => void | Promise<void>;
  /** @internal Deterministic fault-injection seam; production callers must use the default. */
  stagingUnlink?: (path: string) => Promise<void>;
}

/**
 * A private, local filesystem sink used to exercise the real durable writer across process
 * restarts. It is intentionally forbidden in production: a local directory is neither a managed
 * telemetry service nor an independent failure domain. Publication uses a same-directory hard link
 * so readers see either no artifact or the complete fsynced envelope, never a partial write.
 */
export class FilesystemTenantTelemetryWriteAdapter implements TenantTelemetryWriteAdapter {
  readonly adapterProtocol = FILESYSTEM_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;
  readonly root: string;

  private readonly rootIdentity: string;
  private readonly expectedTargets = new Map<string, TenantTelemetryLifecycleTargetRecord>();
  private readonly afterWriteCommit?: FilesystemTenantTelemetryWriteAdapterOptions[
    "afterWriteCommit"
  ];
  private readonly stagingUnlink: (path: string) => Promise<void>;
  private closed = false;

  constructor(options: FilesystemTenantTelemetryWriteAdapterOptions) {
    if (options.localOnly !== true || options.singleRunner !== true
      || process.env.NODE_ENV === "production") {
      throw new Error("filesystem tenant telemetry sink is local-only and forbidden in production");
    }
    const identity = rootIdentity(options.root);
    this.root = identity.root;
    this.rootIdentity = identity.identity;
    const failureDomainSha256 = tenantTelemetryFilesystemFailureDomainSha256(
      options.failureDomainId,
    );
    if (!Array.isArray(options.expectedTargets)
      || options.expectedTargets.length < 1
      || options.expectedTargets.length > 2) {
      throw new Error("tenant telemetry filesystem target configuration is invalid");
    }
    for (const target of options.expectedTargets) {
      try {
        validateTenantTelemetryLifecycleTarget(target);
        if (target.adapterProtocol !== this.adapterProtocol
          || target.backendKind !== FILESYSTEM_TENANT_TELEMETRY_BACKEND_KIND
          || target.namespaceSha256
            !== tenantTelemetryFilesystemNamespaceSha256(
              this.root,
              options.namespaceId,
              target.domain,
            )
          || target.failureDomainSha256 !== failureDomainSha256
          || this.expectedTargets.has(target.targetSha256)) {
          throw new Error("target mismatch");
        }
        this.expectedTargets.set(target.targetSha256, structuredClone(target));
      } catch {
        throw new Error("tenant telemetry filesystem target configuration is invalid");
      }
    }
    this.afterWriteCommit = options.afterWriteCommit;
    this.stagingUnlink = options.stagingUnlink ?? unlink;
  }

  private assertOpen(): void {
    if (this.closed) throw new TenantTelemetryWriteAdapterTemporaryError();
  }

  private assertInput(input: TenantTelemetryWriteAdapterInput): Buffer {
    this.assertOpen();
    const expected = this.expectedTargets.get(input.target.targetSha256);
    if (!expected
      || input.target.adapterProtocol !== this.adapterProtocol
      || input.target.receiptSha256 !== expected.receiptSha256) {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    try {
      return Buffer.from(canonicalStoredJson(input), "utf8");
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterConflictError) throw error;
      throw new TenantTelemetryWriteAdapterConflictError();
    }
  }

  private async canonicalRoot(create: boolean): Promise<string | null> {
    if (canonicalizeRootIdentity(this.root) !== this.rootIdentity) {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    if (create) {
      const missing: string[] = [];
      let cursor = this.root;
      for (;;) {
        try {
          const entry = await lstat(cursor);
          if (entry.isSymbolicLink() || !entry.isDirectory()) {
            throw new TenantTelemetryWriteAdapterConflictError();
          }
          break;
        } catch (error) {
          if (!isNotFound(error)) throw error;
          missing.unshift(cursor);
          const parent = dirname(cursor);
          if (parent === cursor) throw error;
          cursor = parent;
        }
      }
      for (const path of missing) {
        try {
          await mkdir(path, { mode: DIRECTORY_MODE });
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
        }
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new TenantTelemetryWriteAdapterConflictError();
        }
        await chmod(path, DIRECTORY_MODE);
        await this.syncDirectory(dirname(path));
      }
    }
    try {
      const entry = await lstat(this.root);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      await chmod(this.root, DIRECTORY_MODE);
      const canonical = await realpath(this.root);
      if (canonical !== this.rootIdentity) throw new TenantTelemetryWriteAdapterConflictError();
      return canonical;
    } catch (error) {
      if (!create && isNotFound(error)) return null;
      throw error;
    }
  }

  private async ensureDirectory(path: string, create: boolean): Promise<boolean> {
    let created = false;
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (!create) return false;
      try {
        await mkdir(path, { mode: DIRECTORY_MODE });
        created = true;
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
      }
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
    }
    await chmod(path, DIRECTORY_MODE);
    if (created) await this.syncDirectory(dirname(path));
    return true;
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async artifactPath(
    input: TenantTelemetryWriteAdapterInput,
    create: boolean,
  ): Promise<string | null> {
    const root = await this.canonicalRoot(create);
    if (!root) return null;
    const segments = [
      "v1",
      input.target.targetSha256.slice(0, 2),
      input.target.targetSha256,
      input.inventory.artifactIdSha256.slice(0, 2),
      input.inventory.artifactIdSha256,
    ];
    let parent = root;
    for (const segment of segments) {
      if (!SHA256.test(segment) && segment !== "v1" && !/^[a-f0-9]{2}$/.test(segment)) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      parent = join(parent, segment);
      if (!await this.ensureDirectory(parent, create)) return null;
    }
    const path = resolve(parent, `${input.inventory.artifactGeneration}.json`);
    const fromRoot = relative(root, path);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)
      || isAbsolute(fromRoot)) {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    return path;
  }

  private async inspectPath(path: string, expected: Buffer): Promise<"absent" | "exact" | "conflict"> {
    let entry;
    try {
      entry = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) return "absent";
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size !== expected.byteLength) {
      return "conflict";
    }
    await chmod(path, FILE_MODE);
    const current = await readFile(path);
    return current.equals(expected) ? "exact" : "conflict";
  }

  private stagingPath(path: string, input: TenantTelemetryWriteAdapterInput): string {
    return join(dirname(path), `.telemetry-${input.writeOperationSha256}.writing`);
  }

  private operationLockKey(input: TenantTelemetryWriteAdapterInput): string {
    return `${this.rootIdentity}\0${input.writeOperationSha256}`;
  }

  private async cleanupStaging(path: string): Promise<void> {
    let entry;
    try {
      entry = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) {
        await this.syncDirectory(dirname(path));
        return;
      }
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    try {
      await this.stagingUnlink(path);
    } catch (error) {
      if (!isNotFound(error)) throw new TenantTelemetryWriteAdapterTemporaryError();
    }
    let absent = false;
    try {
      await lstat(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      absent = true;
    }
    if (!absent) throw new TenantTelemetryWriteAdapterTemporaryError();
    // A result is not terminally observable until removal of the operation-scoped hard link is
    // durable.  If unlink succeeded but fsync failed, the retry repeats this directory fsync even
    // when the name is already absent.
    await this.syncDirectory(dirname(path));
  }

  private async inspectValidated(
    input: TenantTelemetryWriteAdapterInput,
    expected: Buffer,
  ): Promise<TenantTelemetryWriteInspection> {
    const path = await this.artifactPath(input, false);
    if (!path) return { status: "absent" };
    await this.cleanupStaging(this.stagingPath(path, input));
    const status = await this.inspectPath(path, expected);
    if (status === "absent" || status === "conflict") return { status };
    await this.syncDirectory(dirname(path));
    return {
      status: "exact",
      result: tenantTelemetryWriteAdapterResult(
        this.adapterProtocol,
        input,
        "already_present",
        true,
      ),
    };
  }

  async inspectWrite(input: TenantTelemetryWriteAdapterInput): Promise<TenantTelemetryWriteInspection> {
    const expected = this.assertInput(input);
    try {
      return await withOperationLock(this.operationLockKey(input), async () => {
        this.assertOpen();
        return this.inspectValidated(input, expected);
      });
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterConflictError) throw error;
      throw new TenantTelemetryWriteAdapterTemporaryError();
    }
  }

  async createWrite(input: TenantTelemetryWriteAdapterInput): Promise<TenantTelemetryWriteAdapterResult> {
    const expected = this.assertInput(input);
    try {
      return await withOperationLock(this.operationLockKey(input), async () => {
        this.assertOpen();
        const path = await this.artifactPath(input, true);
        if (!path) throw new TenantTelemetryWriteAdapterTemporaryError();
        const stagingPath = this.stagingPath(path, input);
        const existing = await this.inspectPath(path, expected);
        if (existing === "conflict") {
          await this.cleanupStaging(stagingPath);
          throw new TenantTelemetryWriteAdapterConflictError();
        }
        if (existing === "exact") {
          await this.cleanupStaging(stagingPath);
          await this.syncDirectory(dirname(path));
          this.assertOpen();
          return tenantTelemetryWriteAdapterResult(
            this.adapterProtocol,
            input,
            "already_present",
            true,
          );
        }

        // A previous process may have stopped after creating or linking this exact operation's
        // deterministic staging file.  The process-wide lock protects live calls in the declared
        // single-runner process; clearing this name cannot touch any other operation's writer.
        await this.cleanupStaging(stagingPath);
        let stagingCreated = false;
        try {
          const handle = await open(stagingPath, "wx", FILE_MODE);
          stagingCreated = true;
          try {
            await handle.chmod(FILE_MODE);
            await handle.writeFile(expected);
            await handle.sync();
          } finally {
            await handle.close();
          }

          let published = false;
          try {
            await link(stagingPath, path);
            published = true;
          } catch (error) {
            if (!isErrno(error, "EEXIST")) throw error;
          }
          await this.syncDirectory(dirname(path));
          if (!published) {
            const raced = await this.inspectPath(path, expected);
            await this.cleanupStaging(stagingPath);
            stagingCreated = false;
            if (raced === "conflict") throw new TenantTelemetryWriteAdapterConflictError();
            if (raced !== "exact") throw new TenantTelemetryWriteAdapterTemporaryError();
            this.assertOpen();
            return tenantTelemetryWriteAdapterResult(
              this.adapterProtocol,
              input,
              "already_present",
              true,
            );
          }

          const result = tenantTelemetryWriteAdapterResult(
            this.adapterProtocol,
            input,
            "written",
            false,
          );
          await this.cleanupStaging(stagingPath);
          stagingCreated = false;
          // The response-loss hook runs only after the canonical publication and staging cleanup
          // are both durable, so an exact replay can never seal while a second payload hard link
          // remains reachable.
          await this.afterWriteCommit?.(structuredClone(input), structuredClone(result));
          this.assertOpen();
          return result;
        } catch (error) {
          if (stagingCreated) {
            try {
              await this.cleanupStaging(stagingPath);
              stagingCreated = false;
            } catch (cleanupError) {
              if (cleanupError instanceof TenantTelemetryWriteAdapterConflictError) {
                throw cleanupError;
              }
              throw new TenantTelemetryWriteAdapterTemporaryError();
            }
          }
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterConflictError
        || error instanceof TenantTelemetryWriteAdapterTemporaryError) throw error;
      throw new TenantTelemetryWriteAdapterTemporaryError();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
