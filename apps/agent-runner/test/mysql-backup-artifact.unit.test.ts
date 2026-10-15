import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256, EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  tenantBackupSchemaMigrationRootSha256, tenantBackupSnapshotAnchorSha256,
  tenantRestoreReplaySealedTargetRootSha256,
  tenantRestoreJournalTargetRootSha256, tenantTelemetryRefKeyIdSha256,
  createTenantTelemetryCaptureBackupCheckpoint, tenantTelemetryCaptureCheckpointOpaqueDigest,
  assertMysqlSessionStoreDatabaseBinding,
  PERSISTED_PROVIDER_CAPTURE_PROTOCOL, PERSISTED_PROVIDER_CAPTURE_PRODUCER_PROTOCOL, PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256,
  type TenantBackupSnapshotAnchor,
  type TenantTelemetryCaptureCheckpointLeaf, type TenantTelemetryCaptureBackupCheckpointRecord,
  type TenantTelemetryCaptureBackupCheckpointStore,
} from "@agent-service/store";
import {
  acquireMySqlBackupArtifactOperator, createMySqlBackupArtifact, importVerifiedMySqlBackupArtifact,
  verifyMySqlBackupArtifact, type CreateMySqlBackupArtifactOptions,
} from "../src/mysql-backup-artifact.js";
import {
  MYSQL_BACKUP_ARTIFACT_MAGIC, MYSQL_BACKUP_ARTIFACT_V2_MAGIC,
  artifactAad, artifactEvidence, canonicalJson, canonicalMySqlBackupTableDefinition, decodeArtifactManifest, encodeArtifactManifest, sha256,
  type MySqlBackupArtifactManifest,
} from "../src/mysql-backup-artifact-codec.js";

const state = vi.hoisted(() => ({
  anchorRow: {} as Record<string, unknown>, calls: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>,
  imported: Buffer.alloc(0), targetObjects: 0, dumpBytes: Buffer.from("CREATE TABLE sample (id INT);\nINSERT INTO sample VALUES (1);\n"),
  dumpFailure: false, importFailure: false, wrongMigration: false, changedSourceIdentity: false,
  delayVersion: false, schemaChanged: false, lostLock: false,
  view: false, routine: false, event: false, myisam: false, sourceQualified: false,
  destroyedDatabases: [] as string[], killDestroyedCount: -1,
  fsDelay: undefined as { kind: "open" | "mkdir" | "mkdtemp"; path: string } | undefined,
  fsEntered: false, fsResource: undefined as unknown, resumeFs: undefined as (() => void) | undefined,
  abortOpen: undefined as { path: string; abort: () => void } | undefined,
  captureRecord: undefined as { checkpoint: Record<string, unknown>; leaves: Array<Record<string, unknown>> } | undefined,
  inactiveFootprint: 0, missingInactiveResult: false, invalidInactiveControls: false,
}));
// Only the connection-brand/identity helper is a driver double here. These
// unit tests prove orchestration/cancellation/bytes, not a real MySQL pool,
// WeakMap brand or SQL identity check; the store SQL suite proves that boundary.
vi.mock("@agent-service/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@agent-service/store")>(),
  assertMysqlSessionStoreDatabaseBinding: vi.fn(async (_store: unknown, _expected: { serverUuid: string; database: string },
    _options: { timeoutMs: number; operationAbortSignal?: AbortSignal }): Promise<void> => {}),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  const delayed = async <T>(kind: "open" | "mkdir" | "mkdtemp", path: unknown, pending: Promise<T>): Promise<T> => {
    const resource = await pending;
    if (state.fsDelay?.kind === kind && String(path).startsWith(state.fsDelay.path)) {
      state.fsEntered = true; state.fsResource = resource;
      await new Promise<void>((resolveDelay) => { state.resumeFs = resolveDelay; });
    }
    return resource;
  };
  return { ...filesystem,
    open: (...args: Parameters<typeof filesystem.open>) => {
      const pending = filesystem.open(...args);
      if (state.abortOpen?.path === String(args[0])) state.abortOpen.abort();
      return delayed("open", args[0], pending);
    },
    mkdir: (...args: Parameters<typeof filesystem.mkdir>) => delayed("mkdir", args[0], filesystem.mkdir(...args)),
    mkdtemp: (...args: Parameters<typeof filesystem.mkdtemp>) => delayed("mkdtemp", args[0], filesystem.mkdtemp(...args)),
  };
});
vi.mock("mysql2/promise", () => ({ default: { createConnection: vi.fn(async (config: { database: string }) => ({
  destroy: vi.fn(() => { state.destroyedDatabases.push(config.database); }),
  query: vi.fn(async (options: { sql: string } | string, values: unknown[]) => {
    const sql = typeof options === "string" ? options : options.sql;
    if (sql.includes("AS capture_inactive_footprint_")) return [state.missingInactiveResult ? [] : [Object.fromEntries(
      [...sql.matchAll(/\((SELECT COUNT\(\*\)[\s\S]*?)\) AS (capture_inactive_footprint_[0-9]+)/g)].map((match) => [match[2]!,
        state.inactiveFootprint || (state.captureRecord && /FROM `tenant_telemetry_capture_backup_checkpoint(?:s|_leaves)`/.test(match[1]!) ? 1 : 0)]))]];
    if (sql.includes("FROM tenant_telemetry_capture_v2_controls")) return [state.invalidInactiveControls ? [] : [
      { domain: "logs", scope: "tenant-telemetry-capture-control-v2", control_generation: 0, state: "inactive",
        capture_protocol: PERSISTED_PROVIDER_CAPTURE_PROTOCOL, producer_protocol: PERSISTED_PROVIDER_CAPTURE_PRODUCER_PROTOCOL,
        producer_contract_sha256: PERSISTED_PROVIDER_CAPTURE_CONTRACT_SHA256, activated_at_db_ms: null },
      { domain: "traces", scope: "tenant-telemetry-capture-control-v2", control_generation: 0, state: "inactive",
        capture_protocol: PERSISTED_PROVIDER_CAPTURE_PROTOCOL, producer_protocol: null, producer_contract_sha256: null, activated_at_db_ms: null },
    ]];
    if (sql.includes("FROM tenant_telemetry_capture_backup_checkpoints")) {
      const cp = state.captureRecord?.checkpoint;
      return [cp ? [{ backup_id: cp.backupId, anchor_sha256: cp.anchorSha256, checkpoint_sha256: cp.checkpointSha256,
        ref_key_id_sha256: cp.refKeyIdSha256, sealed_at_db_ms: cp.sealedAtDbMs, checkpoint_json: cp }] : []];
    }
    if (sql.includes("FROM tenant_telemetry_capture_backup_checkpoint_leaves")) return [(state.captureRecord?.leaves ?? []).map((leaf) => ({
      backup_id: BACKUP, family: leaf.family, identity_ref_sha256: leaf.identityRefSha256, record_hmac_sha256: leaf.recordHmacSha256,
      knowledge: leaf.knowledge, state: leaf.state, source_high_water_db_ms: leaf.sourceHighWaterDbMs,
    }))];
    if (sql.includes("@@server_uuid")) return [[{ server_uuid: state.changedSourceIdentity && config.database === "source_test"
      ? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" : "11111111-1111-1111-1111-111111111111", version: "8.0.26", database_name: config.database }]];
    if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
    if (sql.includes("IS_USED_LOCK")) return [[{ owned: state.lostLock ? 0 : 1 }]];
    if (sql.includes("AS object_count")) return [[{ object_count: state.targetObjects }]];
    if (sql.includes("schema_migrations")) return [[{ name: state.wrongMigration ? "wrong.sql" : "0031_fixture.sql" }]];
    if (sql.includes("backup_snapshot_anchors")) return [[state.anchorRow]];
    if (sql.includes("information_schema.TABLES")) return [[{ name: "sample", kind: state.view ? "VIEW" : "BASE TABLE", engine: state.myisam ? "MyISAM" : "InnoDB" }]];
    if (sql.includes("SHOW CREATE TABLE")) return [[{ "Create Table": state.sourceQualified ? "CREATE TABLE sample (id INT, CHECK(source_test.sample.id > 0))"
      : state.schemaChanged ? "CREATE TABLE sample (id BIGINT)" : "CREATE TABLE sample (id INT)" }]];
    if (sql.includes("information_schema.ROUTINES")) return [state.routine ? [{ name: "safe_procedure", kind: "PROCEDURE" }] : []];
    if (sql.includes("information_schema.EVENTS")) return [state.event ? [{ name: "future_event" }] : []];
    if (sql.includes("information_schema.TRIGGERS")) return [[]];
    throw new Error(`unexpected private query ${sql} ${JSON.stringify(values)}`);
  }),
})) } }));
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn((_path: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
  state.calls.push({ args, env: options.env });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { state.killDestroyedCount = state.destroyedDatabases.length;
      child.stdout.destroy(); child.stdin.destroy(); child.emit("close", 137); return true; }) });
  setImmediate(() => {
    if (args.includes("--version")) {
      if (state.delayVersion) return;
      child.stdout.end("mysql  Ver 8.0.26 for test (MySQL Community Server - GPL)\n"); child.emit("close", 0);
    } else if (args.includes("--single-transaction")) {
      child.stderr.write("private-upstream-password-and-database-detail");
      child.stdout.end(state.dumpBytes); child.emit("close", state.dumpFailure ? 1 : 0);
    } else {
      const chunks: Buffer[] = [];
      child.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stdin.on("end", () => {
        state.imported = Buffer.concat(chunks); state.targetObjects = 1;
        child.stdout.end(); child.emit("close", state.importFailure ? 1 : 0);
      });
    }
  });
  return child;
}) }));

const BACKUP = "backup_00000000-0000-4000-8000-000000000001";
const RUN = "restore_00000000-0000-4000-8000-000000000001";
const SOURCE = "mysql://fixture:unit-private-password@127.0.0.1:3306/source_test";
const TARGET = "mysql://fixture:unit-private-password@127.0.0.1:3306/target_test";
const epoch = "e".repeat(64);
const digest = (letter: string) => letter.repeat(64);
function anchor(): TenantBackupSnapshotAnchor {
  const heads = [{ targetOrdinal: 0, targetSha256: digest("a"), failureDomainSha256: digest("b"),
    adapterProtocol: "fixture-v1", journalNamespaceSha256: digest("c"), logicalDatabaseNamespaceSha256: digest("d"),
    sealedRemoteSequence: 0, sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 }];
  const body = { scope: "tenant-backup-snapshot-anchor-v1" as const, protocol: "tenant-backup-catalog-v1" as const,
    backupKind: "full" as const, backupId: BACKUP, controlEvidenceSha256: digest("a"), logicalDatabaseNamespaceSha256: digest("d"),
    journalControlEvidenceSha256: digest("b"), sourceRuntimeEpochSha256: digest("c"), sourceRuntimeControlGeneration: 1,
    sourceRuntimeControlEvidenceSha256: digest("e"), sourceRuntimeTargetCount: 1, sourceRuntimeHeads: heads,
    sourceRuntimeHeadRootSha256: tenantRestoreReplaySealedTargetRootSha256(heads),
    schemaMigrationRootSha256: tenantBackupSchemaMigrationRootSha256(["0031_fixture.sql"]), blobStorageControlEvidenceSha256: digest("f"),
    sourceCatalogSequence: 0, sourceCatalogEventRootSha256: EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
    retentionUntilDbMs: 30_000, createdAtDbMs: 1000 };
  return { ...body, anchorSha256: tenantBackupSnapshotAnchorSha256(body) };
}
function row(value: TenantBackupSnapshotAnchor): Record<string, unknown> {
  const mapping = Object.fromEntries(Object.entries(value).map(([key, val]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), val]));
  mapping.source_runtime_head_catalog_json = value.sourceRuntimeHeads;
  return mapping;
}
let directory: string;
let keyFile: string;
let key: Buffer;
let options: CreateMySqlBackupArtifactOptions;
beforeEach(async () => {
  vi.mocked(assertMysqlSessionStoreDatabaseBinding).mockReset().mockResolvedValue(undefined);
  directory = await realpath(await mkdtemp(join(tmpdir(), "mysql-backup-artifact-unit-")));
  key = randomBytes(32); keyFile = join(directory, "key"); await writeFile(keyFile, key, { mode: 0o600 });
  // Paths are checked as real, non-writable executables; spawn itself is mocked.
  const tool = join(directory, "mysql-tool"); await writeFile(tool, "unit fixture", { mode: 0o700 });
  options = { artifactDirectory: directory, sourceUrl: SOURCE, anchor: anchor(), keyFile,
    captureCheckpointStore: { sealTenantTelemetryCaptureBackupCheckpoint: vi.fn(async () => null),
      getTenantTelemetryCaptureBackupCheckpoint: vi.fn(async () => null),
      assertTenantTelemetryCaptureBackupCheckpointUnchanged: vi.fn(async () => {}) },
    tools: { mysql: tool, mysqldump: tool }, maxBytes: 1024 * 1024, deadlineMs: 5000, localOnlyAck: true, fleetStoppedAck: true };
  Object.assign(state, { anchorRow: row(options.anchor), calls: [], imported: Buffer.alloc(0), targetObjects: 0,
    dumpBytes: Buffer.from("CREATE TABLE sample (id INT);\nINSERT INTO sample VALUES (1);\n"),
    dumpFailure: false, importFailure: false, wrongMigration: false, changedSourceIdentity: false, delayVersion: false,
    schemaChanged: false, lostLock: false });
  Object.assign(state, { view: false, routine: false, event: false, myisam: false, sourceQualified: false,
    destroyedDatabases: [], killDestroyedCount: -1, fsDelay: undefined, fsEntered: false, fsResource: undefined,
    resumeFs: undefined, abortOpen: undefined, captureRecord: undefined, inactiveFootprint: 0, missingInactiveResult: false, invalidInactiveControls: false });
});
afterEach(async () => { state.resumeFs?.(); key.fill(0); await rm(directory, { recursive: true, force: true }); });

async function verify(expectedEvidence?: Awaited<ReturnType<typeof createMySqlBackupArtifact>>["evidence"]) {
  return verifyMySqlBackupArtifact({ ...options, backupId: BACKUP, expectedAnchor: options.anchor, expectedEvidence });
}
async function rewriteManifest(mutate: (manifest: MySqlBackupArtifactManifest) => void): Promise<void> {
  const path = join(directory, `${BACKUP}.asmbak`); const data = await readFile(path);
  const length = data.readUInt32BE(8); const manifest = decodeArtifactManifest(data.subarray(12, 12 + length), options.maxBytes, options.tenantTelemetryRefKey);
  mutate(manifest); const bytes = Buffer.from(canonicalJson(manifest)); const header = Buffer.alloc(12);
  data.subarray(0, 8).copy(header); header.writeUInt32BE(bytes.length, 8);
  await writeFile(path, Buffer.concat([header, bytes, data.subarray(12 + length)]), { mode: 0o600 });
}

/** Synthetic store projection fixture; only the real MySQL suite proves its DB provenance. */
function activeCheckpoint(): TenantTelemetryCaptureBackupCheckpointRecord {
  const refKey = Buffer.alloc(32, 0x61); options.tenantTelemetryRefKey = refKey;
  const a = options.anchor;
  const leaves: TenantTelemetryCaptureCheckpointLeaf[] = [
    { family: "write_job", state: "queued", knowledge: "validated_projection" },
    { family: "write_job", state: "reserved", knowledge: "validated_projection" },
    { family: "write_job", state: "written", knowledge: "validated_projection" },
    { family: "write_payload", state: "spooled", knowledge: "validated_projection" },
    { family: "legacy_failure", state: "legacy_unknown", knowledge: "legacy_unknown" },
  ].map((row, index) => ({ ...row, sourceHighWaterDbMs: 1_000,
    identityRefSha256: tenantTelemetryCaptureCheckpointOpaqueDigest(row.family as TenantTelemetryCaptureCheckpointLeaf["family"], "identity", Buffer.from(`row-${index}`), refKey),
    recordHmacSha256: tenantTelemetryCaptureCheckpointOpaqueDigest(row.family as TenantTelemetryCaptureCheckpointLeaf["family"], "record", Buffer.from(`record-${index}`), refKey),
  })) as TenantTelemetryCaptureCheckpointLeaf[];
  const checkpoint = createTenantTelemetryCaptureBackupCheckpoint({ backupId: a.backupId, anchorSha256: a.anchorSha256,
    anchorCreatedAtDbMs: a.createdAtDbMs, controlHighWaterDbMs: 1_000, logicalDatabaseNamespaceSha256: a.logicalDatabaseNamespaceSha256,
    schemaMigrationRootSha256: a.schemaMigrationRootSha256, sourceRuntimeLineageKind: "primary",
    sourceRuntimeEpochSha256: a.sourceRuntimeEpochSha256, sourceRuntimeBindingSha256: digest("1"),
    sourceRuntimeControlEvidenceSha256: a.sourceRuntimeControlEvidenceSha256, sourceRuntimeControlGeneration: a.sourceRuntimeControlGeneration,
    sourceHistoryReceiptSha256: null, sourceCaptureCutoverReceiptSha256: null,
    originalRuntimeEpochSha256: a.sourceRuntimeEpochSha256, originalRuntimeBindingSha256: digest("1"),
    originalCaptureActivationReceiptSha256: digest("2"), refKeyIdSha256: tenantTelemetryRefKeyIdSha256(refKey),
    lifecycleControlEvidenceSha256: digest("3"), captureControlEvidenceSha256: digest("4"),
    logsTargetSha256: digest("5"), logsTargetReceiptSha256: digest("6"), journalControlEvidenceSha256: a.journalControlEvidenceSha256,
    journalTargetRootSha256: tenantRestoreJournalTargetRootSha256(a.sourceRuntimeHeads.map((head) => ({ targetOrdinal: head.targetOrdinal,
      targetSha256: head.targetSha256, failureDomainSha256: head.failureDomainSha256, adapterProtocol: head.adapterProtocol,
      journalNamespaceSha256: head.journalNamespaceSha256 }))), journalHeadRootSha256: a.sourceRuntimeHeadRootSha256,
    catalogControlEvidenceSha256: a.controlEvidenceSha256, catalogHeadSequence: a.sourceCatalogSequence,
    catalogHeadRootSha256: a.sourceCatalogEventRootSha256, blobStorageControlEvidenceSha256: a.blobStorageControlEvidenceSha256,
    sealedAtDbMs: 1_100 }, leaves, refKey);
  options.captureCheckpointStore = {
    sealTenantTelemetryCaptureBackupCheckpoint: vi.fn(async (): ReturnType<TenantTelemetryCaptureBackupCheckpointStore["sealTenantTelemetryCaptureBackupCheckpoint"]> =>
      ({ disposition: "created", value: { checkpoint, leaves } })),
    getTenantTelemetryCaptureBackupCheckpoint: vi.fn(async () => ({ checkpoint, leaves })),
    assertTenantTelemetryCaptureBackupCheckpointUnchanged: vi.fn(async () => {}),
  };
  state.captureRecord = { checkpoint, leaves } as unknown as NonNullable<typeof state.captureRecord>;
  return { checkpoint, leaves };
}

describe("MySQL full logical schema v2 table definition contract", () => {
  const table = (declarations: string, tail = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin") =>
    `CREATE TABLE \`sample\` (\n${declarations}\n) ${tail}`;
  const implicit = "  `value` varchar(64) COLLATE utf8mb4_0900_as_cs DEFAULT NULL";
  const explicit = implicit.replace(" COLLATE", " CHARACTER SET utf8mb4 COLLATE");

  it("only removes proven redundant top-level string-column utf8mb4 display bytes and is idempotent", () => {
    for (const type of ["char(64)", "varchar(64)", "tinytext", "text", "mediumtext", "longtext", "enum('x,y','z')", "set('x','y')"]) {
      const original = table(explicit.replace("varchar(64)", type));
      const expected = table(implicit.replace("varchar(64)", type));
      expect(canonicalMySqlBackupTableDefinition(original)).toBe(expected);
      expect(canonicalMySqlBackupTableDefinition(expected)).toBe(expected);
    }
    // Column/index/constraint order, literals, collation and all other bytes remain exact.
    const original = table(`${explicit},\n  \`id\` int NOT NULL,\n  PRIMARY KEY (\`id\`),\n  KEY \`ix\` (\`value\` DESC) INVISIBLE,\n  CONSTRAINT \`ck\` CHECK ((\`id\` > 0))`,
      "ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC");
    expect(canonicalMySqlBackupTableDefinition(original)).toBe(original.replace(" CHARACTER SET utf8mb4", ""));
  });

  it("does not infer a collation or normalize a different charset/table charset/unknown column grammar", () => {
    const unchanged = [
      table(explicit.replace(" COLLATE utf8mb4_0900_as_cs", "")),
      table(explicit.replace("CHARACTER SET utf8mb4", "CHARACTER SET ascii")),
      table(explicit.replace("COLLATE utf8mb4_0900_as_cs", "COLLATE ascii_bin")),
      table(explicit, "ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_bin"),
      table(explicit, "ENGINE=InnoDB COMMENT='DEFAULT CHARSET=utf8mb4'"),
      table(explicit, "ENGINE=InnoDB /* DEFAULT CHARSET=utf8mb4 */"),
      table(explicit, "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 CHARACTER SET latin1"),
      table(explicit.replace("varchar(64)", "varbinary(64)")),
      table(explicit.replace("CHARACTER SET utf8mb4", "CHARACTER /*not a display space*/ SET utf8mb4")),
      table(explicit.replace("COLLATE utf8mb4_0900_as_cs", "COLLATE utf8mb4_bin COLLATE latin1_bin")),
      table(explicit.replace("varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs DEFAULT NULL",
        "varchar(64) DEFAULT ('x') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs")),
      table(explicit).replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"),
      table(explicit).replace("varchar(64)", "varchar((64)"),
    ];
    for (const sql of unchanged) expect(canonicalMySqlBackupTableDefinition(sql)).toBe(sql);
  });

  it("never edits quoted values, comments, nested CHECK/default/generated expressions or ambiguous escaping", () => {
    const unchanged = [
      table("  `value` varchar(64) COLLATE utf8mb4_bin DEFAULT ' CHARACTER SET utf8mb4'"),
      table("  `value` enum('CHARACTER SET utf8mb4 COLLATE utf8mb4_bin','x') COLLATE utf8mb4_bin DEFAULT 'x'"),
      table("  `value` varchar(64) COLLATE utf8mb4_bin COMMENT ' CHARACTER SET utf8mb4'"),
      table("  `value` varchar(64) /* CHARACTER SET utf8mb4 COLLATE utf8mb4_bin */"),
      table("  `value` varchar(64) CHARACTER SET utf8mb4 DEFAULT (cast('x' as char) COLLATE utf8mb4_bin)"),
      table("  `value` varchar(64) CHARACTER SET utf8mb4 GENERATED ALWAYS AS (cast('x' as char) COLLATE utf8mb4_bin) STORED"),
      table("  `value` varchar(64) CHARACTER SET utf8mb4 CHECK ('CHARACTER SET utf8mb4' COLLATE utf8mb4_bin = 'x')"),
      table(explicit.replace("DEFAULT NULL", "DEFAULT 'a\\' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin'")),
      table(explicit.replace("`value`", "`value\\` CHARACTER SET utf8mb4`")),
      table(explicit.replace("DEFAULT NULL", "DEFAULT 'unclosed CHARACTER SET utf8mb4")),
    ];
    for (const sql of unchanged) expect(canonicalMySqlBackupTableDefinition(sql)).toBe(sql);
    const quoted = table(explicit.replace("`value`", "`value``CHARACTER SET utf8mb4`")
      .replace("DEFAULT NULL", "DEFAULT 'one'' CHARACTER SET utf8mb4'")
      + ",\n  CONSTRAINT `ck` CHECK ('CHARACTER SET utf8mb4' = 'CHARACTER SET utf8mb4')");
    expect(canonicalMySqlBackupTableDefinition(quoted)).toBe(quoted.replace("varchar(64) CHARACTER SET utf8mb4", "varchar(64)"));
  });

  it("retains strict differences in every collation/default/order/index/constraint/counter/tail attribute", () => {
    const original = table(`${explicit},\n  \`id\` int NOT NULL,\n  PRIMARY KEY (\`id\`),\n  UNIQUE KEY \`uq\` (\`value\`),\n  KEY \`ix\` (\`value\`(8) DESC) INVISIBLE,\n  CONSTRAINT \`ck\` CHECK ((\`id\` > 0))`,
      "ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC");
    const expected = canonicalMySqlBackupTableDefinition(original);
    const variants = [
      original.replace("COLLATE utf8mb4_0900_as_cs", "COLLATE utf8mb4_bin"),
      original.replace("DEFAULT NULL", "NOT NULL"), original.replace("DEFAULT NULL", "DEFAULT 'not null'"),
      original.replace("`value`(8) DESC", "`value`(9) DESC"), original.replace("DESC", "ASC"),
      original.replace("INVISIBLE", "VISIBLE"), original.replace("UNIQUE KEY", "KEY"),
      original.replace("(`id` > 0)", "(`id` >= 0)"), original.replace("AUTO_INCREMENT=7", "AUTO_INCREMENT=8"),
      original.replace("ROW_FORMAT=DYNAMIC", "ROW_FORMAT=COMPACT"),
      original.replace("  `id` int NOT NULL,\n  PRIMARY KEY (`id`)", "  PRIMARY KEY (`id`),\n  `id` int NOT NULL"),
      original.replace("UNIQUE KEY `uq` (`value`),\n  KEY `ix` (`value`(8) DESC) INVISIBLE",
        "KEY `ix` (`value`(8) DESC) INVISIBLE,\n  UNIQUE KEY `uq` (`value`)"),
    ];
    for (const sql of variants) expect(canonicalMySqlBackupTableDefinition(sql)).not.toBe(expected);
    const foreign = table(`${explicit},\n  CONSTRAINT \`fk\` FOREIGN KEY (\`value\`) REFERENCES \`parent\` (\`value\`) ON DELETE CASCADE`);
    expect(canonicalMySqlBackupTableDefinition(foreign.replace("CASCADE", "RESTRICT")))
      .not.toBe(canonicalMySqlBackupTableDefinition(foreign));
    // No sorting of UNIQUE declarations, including the no-primary clustering case.
    const noPrimary = table(`${explicit},\n  UNIQUE KEY \`a\` (\`value\`),\n  UNIQUE KEY \`b\` (\`value\`)`);
    expect(canonicalMySqlBackupTableDefinition(noPrimary.replace("UNIQUE KEY `a` (`value`),\n  UNIQUE KEY `b` (`value`)",
      "UNIQUE KEY `b` (`value`),\n  UNIQUE KEY `a` (`value`)"))).not.toBe(canonicalMySqlBackupTableDefinition(noPrimary));
  });
});

describe("MySQL encrypted backup artifact core", () => {
  it("preserves the exact v1 envelope, AAD and provider-evidence algorithms for verified-inactive sources", async () => {
    const created = await createMySqlBackupArtifact(options);
    expect(created.manifest.version).toBe(1);
    const bytes = await readFile(join(directory, `${BACKUP}.asmbak`));
    expect(bytes.subarray(0, 8)).toEqual(MYSQL_BACKUP_ARTIFACT_MAGIC);
    expect(encodeArtifactManifest(created.manifest, options.maxBytes)).toEqual(Buffer.from(canonicalJson(created.manifest)));
    const { ciphertextBytes: _bytes, ciphertextSha256: _hash, encryption, ...body } = created.manifest;
    expect(artifactAad(created.manifest)).toEqual(Buffer.from(canonicalJson({ ...body,
      encryption: { algorithm: encryption.algorithm, nonceHex: encryption.nonceHex } })));
    expect(created.evidence.providerEvidenceSha256).toBe(sha256(canonicalJson({
      scope: "mysql-logical-full-artifact-provider-evidence-v1", backupId: BACKUP,
      anchorSha256: created.manifest.anchor.anchorSha256, sourceIdentitySha256: created.manifest.sourceIdentitySha256,
      schemaMigrationRootSha256: created.manifest.schemaMigrationRootSha256, schemaSha256: created.manifest.schemaSha256,
      sourceSnapshotSha256: created.manifest.plaintextSha256, sourceBackupSha256: sha256(bytes),
      artifactManifestSha256: sha256(canonicalJson(created.manifest)),
    })));
    expect(options.captureCheckpointStore.sealTenantTelemetryCaptureBackupCheckpoint).toHaveBeenCalledTimes(3);
  });

  it("seals before the dump, authenticates all 49 families including pending/reserved/unknown, and checks drift before publication", async () => {
    const record = activeCheckpoint(); const store = options.captureCheckpointStore;
    const seal = vi.mocked(store.sealTenantTelemetryCaptureBackupCheckpoint);
    const unchanged = vi.mocked(store.assertTenantTelemetryCaptureBackupCheckpointUnchanged);
    seal.mockImplementation(async () => {
      expect(state.calls.some((call) => call.args.includes("--single-transaction"))).toBe(false);
      return { disposition: "created", value: record };
    });
    unchanged.mockImplementation(async (input) => {
      expect(state.calls.some((call) => call.args.includes("--single-transaction"))).toBe(true);
      expect(input.checkpointSha256).toBe(record.checkpoint.checkpointSha256);
      await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
    });
    const created = await createMySqlBackupArtifact(options);
    expect(created.manifest).toMatchObject({ version: 2, scope: "mysql-logical-full-artifact-v2", captureCheckpoint: record.checkpoint });
    expect(created.manifest.version === 2 && created.manifest.captureCheckpoint.families).toHaveLength(49);
    expect(created.manifest.version === 2 && created.manifest.captureCheckpoint.legacyUnknownCount).toBe(1);
    expect(canonicalJson(created.manifest)).not.toContain("record-0");
    const bytes = await readFile(join(directory, `${BACKUP}.asmbak`));
    expect(bytes.subarray(0, 8)).toEqual(MYSQL_BACKUP_ARTIFACT_V2_MAGIC);
    expect(created.evidence.sourceBackupSha256).toBe(sha256(bytes));
    expect(unchanged).toHaveBeenCalledTimes(2);
    // A historical authenticated artifact remains verifiable after the live
    // source changes. Verification must never call the current-source audit.
    unchanged.mockClear().mockRejectedValue(new Error("source-now-changed")); seal.mockClear();
    const verified = await verify(created.evidence); await verified.close();
    expect(unchanged).not.toHaveBeenCalled(); expect(seal).not.toHaveBeenCalled();
  });

  it.each([1, 2])("authenticates existing v%s bytes without resealing after publication advances live catalog/source head", async (version) => {
    if (version === 2) activeCheckpoint();
    const created = await createMySqlBackupArtifact(options);
    const original = await readFile(join(directory, `${BACKUP}.asmbak`));
    // The private driver models the live-store audit refusing the now-advanced
    // catalog/source. The original immutable checkpoint remains in actual SQL.
    const seal = vi.mocked(options.captureCheckpointStore.sealTenantTelemetryCaptureBackupCheckpoint)
      .mockClear().mockRejectedValue(new Error("catalog-head-advanced-after-publish"));
    const unchanged = vi.mocked(options.captureCheckpointStore.assertTenantTelemetryCaptureBackupCheckpointUnchanged)
      .mockClear().mockRejectedValue(new Error("live-source-advanced-after-publish"));
    const binding = vi.mocked(assertMysqlSessionStoreDatabaseBinding).mockClear().mockRejectedValue(new Error("live-store-now-unavailable"));
    state.invalidInactiveControls = true; state.inactiveFootprint = 1;
    state.dumpBytes = Buffer.from("later-live-source-that-must-not-replace-the-original-dump");
    const replay = await createMySqlBackupArtifact(options);
    expect(replay).toEqual({ ...created, disposition: "exact_replay" });
    expect(seal).not.toHaveBeenCalled(); expect(unchanged).not.toHaveBeenCalled();
    expect(binding).not.toHaveBeenCalled();
    expect(state.calls.filter((call) => call.args.includes("--single-transaction"))).toHaveLength(1);
    await expect(readFile(join(directory, `${BACKUP}.asmbak`))).resolves.toEqual(original);
  });

  it("still rejects missing actual historical checkpoint/leaves on existing v2 replay without replacing bytes or redumping", async () => {
    activeCheckpoint(); await createMySqlBackupArtifact(options);
    const path = join(directory, `${BACKUP}.asmbak`); const original = await readFile(path);
    const seal = vi.mocked(options.captureCheckpointStore.sealTenantTelemetryCaptureBackupCheckpoint).mockClear();
    state.captureRecord = undefined;
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "capture_checkpoint_source_mismatch");
    expect(seal).not.toHaveBeenCalled();
    expect(state.calls.filter((call) => call.args.includes("--single-transaction"))).toHaveLength(1);
    await expect(readFile(path)).resolves.toEqual(original);
  });

  it("requires an actual checkpoint store and a correct protected key rather than silently creating an active v1 artifact", async () => {
    await expect(createMySqlBackupArtifact({ ...options, captureCheckpointStore: undefined as never }))
      .rejects.toHaveProperty("code", "capture_checkpoint_store_required");
    activeCheckpoint(); delete options.tenantTelemetryRefKey;
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "capture_ref_key_required");
    expect(state.calls).toHaveLength(0);
    await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
  });

  it.each([1, 2])("rejects failed source-store binding before any v%s seal, dump or artifact publication", async (version) => {
    if (version === 2) activeCheckpoint(); // Even identical historical rows cannot substitute for live source binding.
    const seal = vi.mocked(options.captureCheckpointStore.sealTenantTelemetryCaptureBackupCheckpoint);
    const binding = vi.mocked(assertMysqlSessionStoreDatabaseBinding).mockRejectedValueOnce(new Error("unit-driver-wrong-database"));
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "artifact_create_failed");
    expect(binding).toHaveBeenCalledOnce(); expect(seal).not.toHaveBeenCalled(); expect(state.calls).toHaveLength(0);
    expect(binding.mock.calls[0]![0]).toBe(options.captureCheckpointStore);
    await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("passes the actual locked source UUID/database and bounded operation signal to binding before seal", async () => {
    const binding = vi.mocked(assertMysqlSessionStoreDatabaseBinding);
    binding.mockImplementationOnce(async (_store, expected, context) => {
      expect(expected).toEqual({ serverUuid: "11111111-1111-1111-1111-111111111111", database: "source_test" });
      expect(context.timeoutMs).toBeGreaterThan(0); expect(context.timeoutMs).toBeLessThanOrEqual(options.deadlineMs);
      expect(context.operationAbortSignal).toBeInstanceOf(AbortSignal);
      expect(state.calls).toHaveLength(0);
      expect(options.captureCheckpointStore.sealTenantTelemetryCaptureBackupCheckpoint).not.toHaveBeenCalled();
    });
    await createMySqlBackupArtifact(options);
    expect(binding).toHaveBeenCalledOnce();
    expect(binding.mock.calls[0]![0]).toBe(options.captureCheckpointStore);
    expect(binding.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(options.captureCheckpointStore.sealTenantTelemetryCaptureBackupCheckpoint).mock.invocationCallOrder[0]!);
  });

  it.each(["footprint", "empty_result", "missing_control"])("rejects a false inactive store result against actual MySQL %s", async (kind) => {
    if (kind === "footprint") state.inactiveFootprint = 1;
    if (kind === "empty_result") state.missingInactiveResult = true;
    if (kind === "missing_control") state.invalidInactiveControls = true;
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "capture_inactive_source_invalid");
    expect(state.calls).toHaveLength(0);
    await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects a caller-owned store whose checkpoint is absent or different in the actual locked MySQL source", async () => {
    activeCheckpoint(); state.captureRecord = undefined;
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "capture_checkpoint_source_mismatch");
    expect(state.calls).toHaveLength(0);
    await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects omitted actual leaves, source drift and inactive-to-active transition before any artifact publication", async () => {
    const record = activeCheckpoint();
    vi.mocked(options.captureCheckpointStore.sealTenantTelemetryCaptureBackupCheckpoint)
      .mockResolvedValueOnce({ disposition: "created", value: { ...record, leaves: [] } });
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "capture_checkpoint_invalid");
    expect(state.calls).toHaveLength(0);
    vi.mocked(options.captureCheckpointStore.assertTenantTelemetryCaptureBackupCheckpointUnchanged)
      .mockRejectedValueOnce(new Error("private-source-drift"));
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "artifact_create_failed");
    await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
    vi.mocked(options.captureCheckpointStore.sealTenantTelemetryCaptureBackupCheckpoint).mockResolvedValueOnce(null);
    state.captureRecord = undefined;
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "capture_checkpoint_changed");
    await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects v2 checkpoint/AAD tampering, missing/wrong ref keys and magic downgrade without importing", async () => {
    activeCheckpoint(); await createMySqlBackupArtifact(options);
    const path = join(directory, `${BACKUP}.asmbak`); const original = await readFile(path);
    await expect(verifyMySqlBackupArtifact({ ...options, tenantTelemetryRefKey: undefined, backupId: BACKUP }))
      .rejects.toHaveProperty("code", "capture_ref_key_required");
    await expect(verifyMySqlBackupArtifact({ ...options, tenantTelemetryRefKey: Buffer.alloc(32, 0x62), backupId: BACKUP }))
      .rejects.toHaveProperty("code", "capture_checkpoint_invalid");
    await rewriteManifest((manifest) => {
      if (manifest.version !== 2) throw new Error("expected v2 fixture");
      const { checkpointSha256: _hash, ...body } = manifest.captureCheckpoint;
      body.logsTargetSha256 = digest("7");
      manifest.captureCheckpoint = { ...body, checkpointSha256: sha256(`${body.scope}\0${canonicalJson(body)}`) };
    });
    await expect(verify()).rejects.toHaveProperty("code", "authentication_failed");
    const downgraded = Buffer.from(original); MYSQL_BACKUP_ARTIFACT_MAGIC.copy(downgraded);
    await writeFile(path, downgraded); await expect(verify()).rejects.toHaveProperty("code", "artifact_format_invalid");
    expect(state.imported).toHaveLength(0);
  });

  it("binds v2 restore operations to the exact checkpoint and protected key before importing held authenticated bytes", async () => {
    activeCheckpoint(); const created = await createMySqlBackupArtifact(options); const verified = await verify(created.evidence);
    const operator = await acquireMySqlBackupArtifactOperator({ ...options, targetUrl: TARGET });
    try {
      await operator.bindRestoreOperation({ manifest: verified.manifest, evidence: verified.evidence, restoreRunId: RUN, runtimeEpochSha256: epoch });
      await importVerifiedMySqlBackupArtifact(verified, { ...options, targetUrl: TARGET, operator, restoreRunId: RUN, runtimeEpochSha256: epoch });
      expect(state.imported).toEqual(state.dumpBytes);
    } finally { await operator.close(); await verified.close(); }
  });

  it("creates real authenticated bytes, derives all evidence, and exact replay actually verifies", async () => {
    const created = await createMySqlBackupArtifact(options);
    expect(created.disposition).toBe("created");
    expect(created.evidence.sourceSnapshotSha256).toBe(sha256(state.dumpBytes));
    const bytes = await readFile(join(directory, `${BACKUP}.asmbak`));
    expect(created.evidence.sourceBackupSha256).toBe(sha256(bytes));
    expect(created.evidence).toEqual(artifactEvidence(created.manifest, sha256(bytes)));
    expect(bytes.includes(state.dumpBytes)).toBe(false);
    expect(canonicalJson(created.manifest)).not.toContain(directory);
    expect(canonicalJson(created.manifest)).not.toContain("unit-private-password");
    expect((await stat(join(directory, `${BACKUP}.asmbak`))).mode & 0o777).toBe(0o600);
    const verified = await verify(created.evidence); expect(verified.manifest).toEqual(created.manifest); await verified.close();
    const replay = await createMySqlBackupArtifact(options); expect(replay).toEqual({ ...created, disposition: "exact_replay" });
    expect(state.calls.filter((call) => call.args.includes("--single-transaction"))).toHaveLength(1);
    await expect(readdir(directory)).resolves.toEqual(expect.arrayContaining(["key", "mysql-tool", `${BACKUP}.asmbak`]));
    expect((await readdir(directory)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("uses no shell, password argv, ambient login-path or user environment and dumps full objects without selecting source on import", async () => {
    await createMySqlBackupArtifact(options);
    const dump = state.calls.find((call) => call.args.includes("--single-transaction"))!;
    expect(dump.args[0]).toMatch(/^--defaults-file=\//);
    expect(dump.args).toEqual(expect.arrayContaining(["--routines", "--events", "--triggers", "--set-gtid-purged=OFF", "--skip-add-drop-table"]));
    expect(dump.args).not.toContain("--databases"); expect(dump.args).not.toContain("--no-login-paths");
    expect(dump.args.join(" ")).not.toContain("unit-private-password");
    expect(Object.keys(dump.env).sort()).toEqual(["LANG", "LC_ALL", "MYSQL_TEST_LOGIN_FILE"]);
    expect(dump.env.HOME).toBeUndefined(); expect(dump.env.PATH).toBeUndefined(); expect(dump.env.MYSQL_PWD).toBeUndefined();
    expect(dump.env.MYSQL_TEST_LOGIN_FILE).toMatch(/\.operator-.*\/no-login-file$/);
    await expect(stat(dirname(dump.env.MYSQL_TEST_LOGIN_FILE!))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects ciphertext corruption, wrong key, GCM tag/nonce/AAD changes and selected evidence mismatch before any import", async () => {
    const created = await createMySqlBackupArtifact(options); const path = join(directory, `${BACKUP}.asmbak`);
    const original = await readFile(path);
    const corrupted = Buffer.from(original); corrupted[corrupted.length - 1] = corrupted.at(-1)! ^ 1;
    await writeFile(path, corrupted); await expect(verify()).rejects.toHaveProperty("code", "authentication_failed");
    await writeFile(path, original); await writeFile(keyFile, randomBytes(32));
    await expect(verify()).rejects.toHaveProperty("code", "authentication_failed"); await writeFile(keyFile, key);
    for (const change of [(m: MySqlBackupArtifactManifest) => { m.encryption.authTagHex = "0".repeat(32); },
      (m: MySqlBackupArtifactManifest) => { m.encryption.nonceHex = "0".repeat(24); },
      (m: MySqlBackupArtifactManifest) => { m.schemaSha256 = "0".repeat(64); }]) {
      await writeFile(path, original); await rewriteManifest(change); await expect(verify()).rejects.toHaveProperty("code", "authentication_failed");
    }
    await writeFile(path, original);
    await expect(verify({ ...created.evidence, sourceBackupSha256: "0".repeat(64) })).rejects.toHaveProperty("code", "evidence_mismatch");
    expect(state.calls.filter((call) => call.args.some((arg) => arg.startsWith("--database=")))).toHaveLength(0);
  });

  it("rejects closed manifest violations, version/length/hash drift and oversized artifacts", async () => {
    await createMySqlBackupArtifact(options); const path = join(directory, `${BACKUP}.asmbak`); const original = await readFile(path);
    await rewriteManifest((m) => { Object.assign(m, { privateLocator: "forbidden" }); });
    await expect(verify()).rejects.toHaveProperty("code", "manifest_invalid");
    await writeFile(path, original); await rewriteManifest((m) => { m.version = 2 as 1; });
    await expect(verify()).rejects.toHaveProperty("code", "manifest_invalid");
    await writeFile(path, original); await rewriteManifest((m) => { m.ciphertextSha256 = "0".repeat(64); });
    await expect(verify()).rejects.toHaveProperty("code", "artifact_digest_mismatch");
    await writeFile(path, Buffer.concat([original, Buffer.from("x")])); await expect(verify()).rejects.toHaveProperty("code", "artifact_length_mismatch");
    await writeFile(path, original); await expect(verifyMySqlBackupArtifact({ ...options, backupId: BACKUP, maxBytes: 1 })).rejects.toHaveProperty("code", "artifact_limit");
  });

  it("never publishes partial dump, over-limit or whole-operation deadline failures", async () => {
    state.dumpFailure = true; await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "dump_failed");
    await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
    state.dumpFailure = false; await expect(createMySqlBackupArtifact({ ...options, maxBytes: 1 })).rejects.toHaveProperty("code", "artifact_limit");
    await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
    state.delayVersion = true; await expect(createMySqlBackupArtifact({ ...options, deadlineMs: 40 })).rejects.toHaveProperty("code", "operation_deadline");
    expect((await readdir(directory)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("revalidates current source anchor/migrations and identity on existing exact replay without replacing bytes", async () => {
    await createMySqlBackupArtifact(options); const original = await readFile(join(directory, `${BACKUP}.asmbak`));
    state.anchorRow.anchor_sha256 = "0".repeat(64); await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "source_anchor_invalid");
    state.anchorRow = row(options.anchor); state.wrongMigration = true;
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "source_migration_mismatch");
    state.wrongMigration = false; state.changedSourceIdentity = true;
    await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "source_identity_mismatch");
    await expect(readFile(join(directory, `${BACKUP}.asmbak`))).resolves.toEqual(original);
  });

  it("rejects views, routines, events, non-InnoDB and source-qualified SQL rather than silently producing a partial backup", async () => {
    for (const [field, code] of [["view", "source_views_unsupported"], ["routine", "source_routines_unsupported"],
      ["event", "source_events_unsupported"], ["myisam", "source_schema_invalid"], ["sourceQualified", "source_schema_nonportable"]] as const) {
      state[field] = true;
      await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", code);
      await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
      state[field] = false;
    }
    expect(state.calls).toHaveLength(0);
  });

  it("cancels a running child on shared whole-operation abort before releasing its held idle named-lock session", async () => {
    state.delayVersion = true;
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(), 50);
    const start = performance.now();
    try {
      await expect(createMySqlBackupArtifact({ ...options, operationAbortSignal: controller.signal })).rejects.toHaveProperty("code", "operation_deadline");
      expect(performance.now() - start).toBeLessThan(1000);
      expect(state.killDestroyedCount).toBe(0);
      expect(state.destroyedDatabases).toEqual(["source_test"]);
      await expect(stat(join(directory, `${BACKUP}.asmbak`))).rejects.toHaveProperty("code", "ENOENT");
    } finally { clearTimeout(cancellation); }
  });

  it("freshly checks cooperative named-lock ownership at each exposed operator boundary", async () => {
    const operator = await acquireMySqlBackupArtifactOperator(options);
    try {
      await expect(operator.assertHeld()).resolves.toBeUndefined();
      state.lostLock = true;
      await expect(operator.assertHeld()).rejects.toHaveProperty("code", "operator_lock_lost");
    } finally { await operator.close(); }
  });

  it("rejects protected-looking FIFO key and artifact leaves without blocking native open", async () => {
    await createMySqlBackupArtifact(options);
    const path = join(directory, `${BACKUP}.asmbak`); const original = await readFile(path);
    for (const leaf of [keyFile, path]) {
      await unlink(leaf);
      execFileSync("/usr/bin/mkfifo", ["-m", "600", leaf], { env: { LANG: "C", LC_ALL: "C" }, stdio: "ignore" });
      const started = performance.now();
      await expect(verify()).rejects.toHaveProperty("code", "artifact_file_unprotected");
      expect(performance.now() - started).toBeLessThan(1000);
      await unlink(leaf); await writeFile(leaf, leaf === keyFile ? key : original, { mode: 0o600 });
    }
  });

  it("closes late readonly file and directory handles without deleting existing paths", async () => {
    await createMySqlBackupArtifact(options);
    const artifactPath = join(directory, `${BACKUP}.asmbak`); const original = await readFile(artifactPath);
    for (const path of [artifactPath, directory]) {
      state.fsDelay = { kind: "open", path }; state.fsEntered = false;
      const controller = new AbortController();
      const verification = verifyMySqlBackupArtifact({ ...options, backupId: BACKUP, operationAbortSignal: controller.signal });
      await vi.waitFor(() => expect(state.fsEntered).toBe(true));
      const handle = state.fsResource as FileHandle;
      controller.abort(); await expect(verification).rejects.toHaveProperty("code", "operation_deadline");
      state.fsDelay = undefined; state.resumeFs!();
      await vi.waitFor(() => expect(handle.fd).toBe(-1));
      await expect(readFile(artifactPath)).resolves.toEqual(original);
      expect((await stat(directory)).isDirectory()).toBe(true);
    }
  });

  it("owns a pending open even when the initial bound check observes cancellation before entering its race", async () => {
    const controller = new AbortController();
    state.fsDelay = { kind: "open", path: directory };
    state.abortOpen = { path: directory, abort: () => controller.abort() };
    const failure = expect(verifyMySqlBackupArtifact({ ...options, backupId: BACKUP,
      operationAbortSignal: controller.signal })).rejects.toHaveProperty("code", "operation_deadline");
    await vi.waitFor(() => expect(state.fsEntered).toBe(true));
    const handle = state.fsResource as FileHandle;
    await failure;
    state.fsDelay = undefined; state.abortOpen = undefined; state.resumeFs!();
    await vi.waitFor(() => expect(handle.fd).toBe(-1));
    expect((await stat(directory)).isDirectory()).toBe(true);
    await expect(readFile(keyFile)).resolves.toEqual(key);
  });

  it("cleans a late create-only lock by exact inode and never removes its replacement", async () => {
    const lockPath = join(directory, ".mysql-backup-artifact.operator.lock");
    for (const replace of [false, true]) {
      state.fsDelay = { kind: "open", path: lockPath }; state.fsEntered = false;
      const controller = new AbortController();
      const acquisition = acquireMySqlBackupArtifactOperator({ ...options, operationAbortSignal: controller.signal });
      await vi.waitFor(() => expect(state.fsEntered).toBe(true));
      const handle = state.fsResource as FileHandle;
      controller.abort(); await expect(acquisition).rejects.toHaveProperty("code", "operation_deadline");
      if (replace) { await rename(lockPath, `${lockPath}.old`); await writeFile(lockPath, "replacement", { mode: 0o600 }); }
      state.fsDelay = undefined; state.resumeFs!();
      await vi.waitFor(() => expect(handle.fd).toBe(-1));
      if (replace) await expect(readFile(lockPath, "utf8")).resolves.toBe("replacement");
      else await expect(stat(lockPath)).rejects.toHaveProperty("code", "ENOENT");
    }
  });

  it("removes only late newly-created empty mkdir and mkdtemp leaves", async () => {
    const newRoot = join(directory, "new-private-root");
    for (const kind of ["mkdir", "mkdtemp"] as const) {
      const artifactDirectory = kind === "mkdir" ? newRoot : directory;
      state.fsDelay = { kind, path: kind === "mkdir" ? newRoot : join(directory, ".operator-") }; state.fsEntered = false;
      const controller = new AbortController();
      const acquisition = acquireMySqlBackupArtifactOperator({ ...options, artifactDirectory, operationAbortSignal: controller.signal });
      await vi.waitFor(() => expect(state.fsEntered).toBe(true));
      const latePath = kind === "mkdir" ? newRoot : state.fsResource as string;
      controller.abort(); await expect(acquisition).rejects.toHaveProperty("code", "operation_deadline");
      state.fsDelay = undefined; state.resumeFs!();
      await vi.waitFor(async () => { await expect(stat(latePath)).rejects.toHaveProperty("code", "ENOENT"); });
      expect((await stat(directory)).isDirectory()).toBe(true);
      await expect(readFile(keyFile)).resolves.toEqual(key);
    }
  });

  it("snapshots checked URL, tool, anchor and evidence inputs before asynchronous boundaries", async () => {
    const expectedAnchor = structuredClone(options.anchor);
    const creation = createMySqlBackupArtifact(options);
    options.sourceUrl = "mysql://fixture@127.0.0.1:65500/different_test";
    options.tools.mysql = "/untrusted/replacement/mysql";
    options.anchor.anchorSha256 = "0".repeat(64);
    const created = await creation;
    expect(created.manifest.anchor).toEqual(expectedAnchor);
    const evidence = { ...created.evidence };
    const verification = verifyMySqlBackupArtifact({ ...options, backupId: BACKUP, expectedAnchor, expectedEvidence: evidence });
    evidence.sourceBackupSha256 = "0".repeat(64); expectedAnchor.anchorSha256 = "0".repeat(64);
    const verified = await verification;
    expect(verified.evidence).toEqual(created.evidence);
    await verified.close();
  });

  it("imports only authenticated held spool after path replacement, locks a different empty DB and records exact write-once operation phases", async () => {
    const created = await createMySqlBackupArtifact(options); const verified = await verify(created.evidence);
    const path = join(directory, `${BACKUP}.asmbak`); await rename(path, `${path}.old`); await writeFile(path, "replacement", { mode: 0o600 });
    const operator = await acquireMySqlBackupArtifactOperator({ ...options, targetUrl: TARGET });
    try {
      await operator.bindRestoreOperation({ manifest: verified.manifest, evidence: verified.evidence, restoreRunId: RUN, runtimeEpochSha256: epoch });
      await importVerifiedMySqlBackupArtifact(verified, { ...options, targetUrl: TARGET, operator, restoreRunId: RUN, runtimeEpochSha256: epoch });
      expect(state.imported).toEqual(state.dumpBytes);
      await operator.markRestorePrepared(RUN);
      expect((await readdir(directory)).filter((name) => name.startsWith(RUN)).sort()).toEqual([
        `${RUN}.import_completed.json`, `${RUN}.import_started.json`, `${RUN}.planned.json`, `${RUN}.target_prepared.json`]);
      const planned = JSON.parse(await readFile(join(directory, `${RUN}.planned.json`), "utf8"));
      expect(planned).toMatchObject({ sourceIdentitySha256: created.manifest.sourceIdentitySha256, targetIdentitySha256: operator.targetIdentitySha256, evidence: created.evidence });
      expect(canonicalJson(planned)).not.toContain("unit-private-password"); expect(canonicalJson(planned)).not.toContain(directory);
      await expect(importVerifiedMySqlBackupArtifact(verified, { ...options, targetUrl: TARGET, operator, restoreRunId: RUN, runtimeEpochSha256: epoch })).rejects.toHaveProperty("code", "verified_capability_invalid");
    } finally { await operator.close(); await verified.close(); }
  });

  it("refuses exact source, any nonempty/partial target, unbound/changed operation and fabricated verified capabilities", async () => {
    await expect(acquireMySqlBackupArtifactOperator({ ...options, targetUrl: SOURCE })).rejects.toHaveProperty("code", "target_is_source");
    state.targetObjects = 1; await expect(acquireMySqlBackupArtifactOperator({ ...options, targetUrl: TARGET })).rejects.toHaveProperty("code", "target_not_empty");
    state.targetObjects = 0; const created = await createMySqlBackupArtifact(options); const verified = await verify(created.evidence);
    const operator = await acquireMySqlBackupArtifactOperator({ ...options, targetUrl: TARGET });
    try {
      await expect(importVerifiedMySqlBackupArtifact(verified, { ...options, targetUrl: TARGET, operator, restoreRunId: RUN, runtimeEpochSha256: epoch })).rejects.toHaveProperty("code", "restore_operation_conflict");
      await operator.bindRestoreOperation({ manifest: verified.manifest, evidence: verified.evidence, restoreRunId: RUN, runtimeEpochSha256: epoch });
      await expect(operator.bindRestoreOperation({ manifest: verified.manifest, evidence: verified.evidence, restoreRunId: RUN, runtimeEpochSha256: "f".repeat(64) })).rejects.toHaveProperty("code", "restore_operation_conflict");
      await expect(importVerifiedMySqlBackupArtifact({ ...verified }, { ...options, targetUrl: TARGET, operator, restoreRunId: RUN, runtimeEpochSha256: epoch })).rejects.toHaveProperty("code", "verified_capability_invalid");
      state.importFailure = true;
      await expect(importVerifiedMySqlBackupArtifact(verified, { ...options, targetUrl: TARGET, operator, restoreRunId: RUN, runtimeEpochSha256: epoch })).rejects.toMatchObject({ code: "import_failed_target_isolated", targetMayContainPartialImport: true,
        diagnostic: { phase: "native_import", code: "tool_failed" } });
      expect(state.targetObjects).toBe(1);
      expect((await readdir(directory)).filter((name) => name.startsWith(RUN))).not.toContain(`${RUN}.import_completed.json`);
      await expect(operator.markRestorePrepared(RUN)).rejects.toHaveProperty("code", "restore_operation_unavailable");
    } finally { await operator.close(); await verified.close(); }
    await expect(acquireMySqlBackupArtifactOperator({ ...options, targetUrl: TARGET })).rejects.toHaveProperty("code", "target_not_empty");
  });

  it("retains closed import-phase diagnostics without exposing definitions or changing partial-target failure semantics", async () => {
    const created = await createMySqlBackupArtifact(options); const verified = await verify(created.evidence);
    const operator = await acquireMySqlBackupArtifactOperator({ ...options, targetUrl: TARGET });
    try {
      await operator.bindRestoreOperation({ manifest: verified.manifest, evidence: verified.evidence, restoreRunId: RUN, runtimeEpochSha256: epoch });
      state.schemaChanged = true;
      const failure = await importVerifiedMySqlBackupArtifact(verified, { ...options, targetUrl: TARGET, operator,
        restoreRunId: RUN, runtimeEpochSha256: epoch }).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({ code: "import_failed_target_isolated", targetMayContainPartialImport: true,
        diagnostic: { phase: "schema_digest", code: "target_schema_mismatch" } });
      const serialized = JSON.stringify(failure);
      expect(serialized).not.toContain("CREATE TABLE"); expect(serialized).not.toContain("unit-private-password");
      expect(serialized).not.toContain(directory); expect(serialized).not.toContain("source_test");
      expect(state.targetObjects).toBe(1);
    } finally { await operator.close(); await verified.close(); }
  });

  it("fails closed on production/missing ACK, unsafe paths/key permissions and competing operators", async () => {
    await expect(createMySqlBackupArtifact({ ...options, nodeEnv: "production" })).rejects.toHaveProperty("code", "local_only_required");
    await expect(createMySqlBackupArtifact({ ...options, localOnlyAck: false as true })).rejects.toHaveProperty("code", "local_only_required");
    await expect(createMySqlBackupArtifact({ ...options, fleetStoppedAck: false as true })).rejects.toHaveProperty("code", "fleet_stopped_required");
    const operator = await acquireMySqlBackupArtifactOperator(options);
    await expect(acquireMySqlBackupArtifactOperator(options)).rejects.toHaveProperty("code", "operator_busy"); await operator.close();
    await chmod(keyFile, 0o644); await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "artifact_file_unprotected");
    await chmod(keyFile, 0o600); await writeFile(keyFile, Buffer.alloc(31)); await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "key_file_invalid");
    await writeFile(keyFile, key); const alias = join(directory, "key-link"); await symlink(keyFile, alias);
    await expect(createMySqlBackupArtifact({ ...options, keyFile: alias })).rejects.toHaveProperty("code", "artifact_create_failed");
    await chmod(directory, 0o755); await expect(createMySqlBackupArtifact(options)).rejects.toHaveProperty("code", "artifact_directory_unprotected");
  });
});
