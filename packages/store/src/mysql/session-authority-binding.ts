import { createHash } from "node:crypto";
import * as RestoreJournal from "../tenant-restore-journal.js";
import type { PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { SessionAuthorityError } from "../session-authority.js";
import { captureSchemaMetadataReaderConfig, type SchemaMetadataReaderConfig } from "./schema-metadata.js";
import { assertSchemaRuntimePrivileges } from "./schema-runtime-privileges.js";
import type {
  ActiveSessionAuthorityBinding, CapturedSessionAuthorityBindingCommand,
  PreparedSessionAuthorityBindingCommand, SessionAuthorityBindingCommandInput,
  SessionAuthorityBindingOperatorContext, SessionAuthorityBindingSource,
  SessionAuthorityRuntimeAccount, SessionAuthorityNextEpoch, SessionAuthorityActivationKind,
  PreparedSessionAuthorityActivationRequest, CapturedSessionAuthorityActivationRequest, PreparedSessionAuthorityBindingTransition,
} from "./session-authority-binding-types.js";

export const SESSION_AUTHORITY_MIGRATION = "0066_mysql_live_session_authority.sql";
const PROTOCOL = "mysql-live-session-v1";
const commands = new WeakMap<object, Readonly<CapturedSessionAuthorityBindingCommand>>();
function fail(): never { throw new SessionAuthorityError(); }
function natural(x: unknown): asserts x is number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) fail();
}
function text(x: unknown, bytes: number): asserts x is string {
  if (typeof x !== "string" || !x || Buffer.byteLength(x) > bytes
    || Buffer.from(x).toString("utf8") !== x || /[\u0000-\u001f\u007f]/.test(x)) fail();
}
function uuid(x: unknown): asserts x is string {
  if (typeof x !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x)) fail();
}
function digest(x: unknown): asserts x is string {
  if (typeof x !== "string" || !/^[0-9a-f]{64}$/.test(x)) fail();
}
function closed(x: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!x || typeof x !== "object" || Object.getPrototypeOf(x) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(x), captured: Record<string, unknown> = {};
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || Reflect.ownKeys(descriptors).some(k => typeof k !== "string" || !keys.includes(k))
    || Object.values(descriptors).some(d => !("value" in d) || !d.enumerable)) fail();
  for (const key of keys) captured[key] = descriptors[key]!.value as unknown;
  return Object.freeze(captured);
}
function array(x: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(x) || Object.getPrototypeOf(x) !== Array.prototype) fail();
  const ds = Object.getOwnPropertyDescriptors(x) as unknown as Record<string, PropertyDescriptor>, length = ds.length;
  if (!length || !("value" in length) || typeof length.value !== "number" || !Number.isSafeInteger(length.value)
    || length.value < 0 || length.value > maximum || Reflect.ownKeys(ds).length !== length.value + 1) fail();
  const captured: unknown[] = [];
  for (let i=0; i<length.value; i++) {
    const d = ds[String(i)]; if (!d || !("value" in d) || !d.enumerable) fail();
    captured.push(d.value as unknown);
  }
  return Object.freeze(captured);
}
function account(x: SessionAuthorityRuntimeAccount): Readonly<SessionAuthorityRuntimeAccount> {
  x = closed(x, ["user", "host"]) as unknown as SessionAuthorityRuntimeAccount;
  text(x.user, 128); text(x.host, 1020);
  if ([...x.user].length > 32 || [...x.host].length > 255 || x.user.includes("@") || x.host.includes("@")) fail();
  return Object.freeze({ user: x.user, host: x.host });
}
function compare(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
export function sessionAuthorityAccountsSha256(accounts: readonly SessionAuthorityRuntimeAccount[]): string {
  const captured = array(accounts, 64); if (!captured.length) fail();
  const values = captured.map(x => account(x as SessionAuthorityRuntimeAccount)).sort((a, b) => compare(a.user, b.user) || compare(a.host, b.host));
  const entries = values.map(a => `${Buffer.byteLength(a.user)}:${a.user}:${Buffer.byteLength(a.host)}:${a.host}`);
  if (new Set(entries).size !== entries.length) fail();
  return createHash("sha256").update(`session-authority-accounts-v1|${entries.join("|")}`).digest("hex");
}
export function prepareSessionAuthorityBindingCommand(input: SessionAuthorityBindingCommandInput): PreparedSessionAuthorityBindingCommand {
  input = closed(input, ["bindingId", "activationId", "expectedBindingId", "expectedSequence", "serverUuid", "applicationDatabase",
    "newAccounts", "oldAccountNames", "activationEvidenceSha256", "expectedSource", "nextEpoch"]) as unknown as SessionAuthorityBindingCommandInput;
  uuid(input.bindingId); uuid(input.activationId); uuid(input.serverUuid); natural(input.expectedSequence);
  if (input.expectedBindingId !== null) uuid(input.expectedBindingId);
  if ((input.expectedBindingId === null) !== (input.expectedSequence === 0)
    || input.bindingId === input.expectedBindingId || input.expectedSequence === Number.MAX_SAFE_INTEGER) fail();
  text(input.applicationDatabase, 256);
  if ([...input.applicationDatabase].length > 64 || /[/\\]/.test(input.applicationDatabase)) fail();
  digest(input.activationEvidenceSha256);
  const sourceValues = sourceColumns(input.expectedSource);
  const expectedSource = Object.freeze({ kind: sourceValues[0], runtimeControlGeneration: sourceValues[1],
    runtimeControlEvidenceSha256: sourceValues[2], runtimeEpochSha256: sourceValues[3],
    restoreRunId: sourceValues[4], replayReceiptSha256: sourceValues[5] }) as SessionAuthorityBindingSource;
  const nextEpoch = captureNextEpoch(input.nextEpoch);
  if ((nextEpoch === null) !== (input.expectedBindingId === null)
    || nextEpoch !== null && (nextEpoch.runtimeEpochSha256 === expectedSource.runtimeEpochSha256
      || nextEpoch.kind === "restore_activation" && expectedSource.kind === "inactive")) fail();
  const newAccounts = Object.freeze(array(input.newAccounts,64).map(x => account(x as SessionAuthorityRuntimeAccount)));
  const accountsSha256 = sessionAuthorityAccountsSha256(newAccounts);
  const oldAccountNames = Object.freeze(array(input.oldAccountNames,256).map(x => {
    text(x, 128); if ([...x].length > 32 || x.includes("@")) fail(); return x;
  }).sort(compare));
  if (new Set(oldAccountNames).size !== oldAccountNames.length
    || newAccounts.some(x => oldAccountNames.includes(x.user))) fail();
  const commandSha256 = createHash("sha256").update(JSON.stringify([
    "session-authority-binding-command-v3", input.bindingId,input.activationId,input.expectedBindingId,
    input.expectedSequence,input.serverUuid,input.applicationDatabase,accountsSha256,
    oldAccountNames,input.activationEvidenceSha256,sourceValues,nextColumns(nextEpoch),
  ])).digest("hex");
  const captured = Object.freeze({ ...input, newAccounts, oldAccountNames, accountsSha256, commandSha256, expectedSource, nextEpoch });
  const command = Object.freeze({}) as PreparedSessionAuthorityBindingCommand;
  commands.set(command, captured); return command;
}
export function captureSessionAuthorityBindingCommand(command: PreparedSessionAuthorityBindingCommand): Readonly<CapturedSessionAuthorityBindingCommand> {
  return command && typeof command === "object" ? commands.get(command) ?? fail() : fail();
}

function sourceColumns(s: SessionAuthorityBindingSource): readonly unknown[] {
  s = closed(s, ["kind", "runtimeControlGeneration", "runtimeControlEvidenceSha256", "runtimeEpochSha256", "restoreRunId", "replayReceiptSha256"]) as unknown as SessionAuthorityBindingSource;
  natural(s.runtimeControlGeneration);
  if (s.kind === "inactive") {
    if (s.runtimeControlGeneration !== 0 || s.runtimeControlEvidenceSha256 !== null || s.runtimeEpochSha256 !== null
      || s.restoreRunId !== null || s.replayReceiptSha256 !== null) fail();
  } else {
    if (s.runtimeControlGeneration < 1) fail();
    digest(s.runtimeControlEvidenceSha256); digest(s.runtimeEpochSha256);
    if (s.kind === "primary_activation") {
      if (s.restoreRunId !== null || s.replayReceiptSha256 !== null) fail();
    } else if (s.kind === "restore_activation") {
      if (typeof s.restoreRunId !== "string" || !/^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s.restoreRunId)) fail();
      digest(s.replayReceiptSha256);
    }
    else fail();
  }
  return [s.kind, s.runtimeControlGeneration, s.runtimeControlEvidenceSha256, s.runtimeEpochSha256, s.restoreRunId, s.replayReceiptSha256];
}

/** Original store projection/catalog validation remains mandatory before this narrower source check. */
async function assertNativeSource(conn: PoolConnection, source: SessionAuthorityBindingSource): Promise<void> {
  sourceColumns(source);
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT state,control_generation,runtime_epoch_sha256 FROM tenant_restore_runtime_control WHERE singleton_id=1 FOR SHARE");
  if (rows.length !== 1) fail();
  const runtime = rows[0]!;
  if (source.kind === "inactive") {
    if (runtime.state !== "inactive" || Number(runtime.control_generation) !== 0 || runtime.runtime_epoch_sha256 !== null) fail();
    return;
  }
  if (runtime.state !== "active" || runtime.runtime_epoch_sha256 !== source.runtimeEpochSha256
    || Number(runtime.control_generation) < source.runtimeControlGeneration) fail();
  const [events] = await conn.query<RowDataPacket[]>(
    `SELECT update_kind,lineage_kind,runtime_epoch_sha256,activation_epoch_sha256,evidence_sha256,
            restore_run_id,replay_receipt_sha256
       FROM tenant_restore_runtime_events WHERE singleton_id=1 AND control_generation=? FOR SHARE`,
    [source.runtimeControlGeneration]);
  if (events.length !== 1) fail();
  const event = events[0]!;
  if (event.update_kind !== source.kind || event.activation_epoch_sha256 !== source.runtimeEpochSha256
    || event.runtime_epoch_sha256 !== source.runtimeEpochSha256 || event.evidence_sha256 !== source.runtimeControlEvidenceSha256
    || event.restore_run_id !== source.restoreRunId || event.replay_receipt_sha256 !== source.replayReceiptSha256
    || event.lineage_kind !== (source.kind === "primary_activation" ? "primary" : "restore")) fail();
  if (source.kind === "restore_activation") {
    const [runs] = await conn.query<RowDataPacket[]>(
      `SELECT runtime_epoch_sha256,phase,terminal_receipt_sha256 FROM tenant_restore_replay_runs
        WHERE restore_run_id=? FOR SHARE`, [source.restoreRunId]);
    if (runs.length !== 1 || runs[0]!.runtime_epoch_sha256 !== source.runtimeEpochSha256
      || runs[0]!.phase !== "active" || runs[0]!.terminal_receipt_sha256 !== source.replayReceiptSha256) fail();
    // The original 0031 full binding/reservation/terminal projection audit is performed by
    // the caller in this same TX; this helper does not replace or weaken that verifier.
  }
}

/** Read-only exact-source inspection; it grants no activation authority and is never cached as admission. */
export const assertSessionAuthorityBindingSource = assertNativeSource;

/** Preview only. An operator must save this in a new fixed command before the first mutation. */
export async function readSessionAuthorityBindingSource(conn: PoolConnection): Promise<SessionAuthorityBindingSource> {
  const [runtime] = await conn.query<RowDataPacket[]>(
    "SELECT state,control_generation,runtime_epoch_sha256 FROM tenant_restore_runtime_control WHERE singleton_id=1 FOR SHARE");
  if (runtime.length!==1) fail();
  if (runtime[0]!.state==="inactive" && Number(runtime[0]!.control_generation)===0 && runtime[0]!.runtime_epoch_sha256===null) {
    const source={kind:"inactive",runtimeControlGeneration:0,runtimeControlEvidenceSha256:null,runtimeEpochSha256:null,
      restoreRunId:null,replayReceiptSha256:null} as const;
    await assertNativeSource(conn,source); return Object.freeze(source);
  }
  if(runtime[0]!.state!=="active")fail();
  const [events]=await conn.query<RowDataPacket[]>(
    `SELECT update_kind,control_generation,evidence_sha256,runtime_epoch_sha256,restore_run_id,replay_receipt_sha256
       FROM tenant_restore_runtime_events WHERE singleton_id=1 AND BINARY activation_epoch_sha256=BINARY ?
       AND update_kind IN ('primary_activation','restore_activation') FOR SHARE`,[runtime[0]!.runtime_epoch_sha256]);
  if(events.length!==1)fail();const event=events[0]!;
  const source={kind:event.update_kind,runtimeControlGeneration:Number(event.control_generation),
    runtimeControlEvidenceSha256:event.evidence_sha256,runtimeEpochSha256:event.runtime_epoch_sha256,
    restoreRunId:event.restore_run_id,replayReceiptSha256:event.replay_receipt_sha256} as SessionAuthorityBindingSource;
  await assertNativeSource(conn,source);return Object.freeze(source);
}


export async function loadActiveSessionAuthorityBinding(conn: PoolConnection, lock: boolean): Promise<ActiveSessionAuthorityBinding> {
  const suffix = lock ? " FOR SHARE" : "";
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT c.control_id,c.protocol,c.current_binding_id,c.binding_sequence AS control_binding_sequence,b.*
       FROM session_authority_control c JOIN session_authority_bindings b
         ON BINARY b.binding_id=BINARY c.current_binding_id
      WHERE c.control_id=1${suffix}`);
  if (rows.length !== 1) fail();
  const row = rows[0]!;
  if (row.control_id !== 1 || row.protocol !== PROTOCOL || row.current_binding_id !== row.binding_id) fail();
  uuid(row.binding_id); uuid(row.server_uuid); digest(row.accounts_sha256);
  const bindingSequence = Number(row.binding_sequence); natural(bindingSequence);
  if (!bindingSequence || Number(row.control_binding_sequence) !== bindingSequence) fail();
  const [identity] = await conn.query<RowDataPacket[]>("SELECT @@GLOBAL.server_uuid AS server_uuid,DATABASE() AS application_database");
  if (identity.length !== 1 || identity[0]!.server_uuid !== row.server_uuid || identity[0]!.application_database !== row.application_database) fail();
  const [accounts] = await conn.query<RowDataPacket[]>(
    `SELECT account_user,account_host FROM session_authority_runtime_accounts
      WHERE BINARY binding_id=BINARY ? ORDER BY BINARY account_user,BINARY account_host${suffix}`, [row.binding_id]);
  if (sessionAuthorityAccountsSha256(accounts.map(a => ({ user: a.account_user as string, host: a.account_host as string }))) !== row.accounts_sha256) fail();
  await assertNativeSource(conn, {
    kind: row.source_kind, runtimeControlGeneration: Number(row.source_runtime_control_generation),
    runtimeControlEvidenceSha256: row.source_runtime_control_evidence_sha256,
    runtimeEpochSha256: row.source_runtime_epoch_sha256, restoreRunId: row.source_restore_run_id,
    replayReceiptSha256: row.source_replay_receipt_sha256,
  } as SessionAuthorityBindingSource);
  return Object.freeze({ bindingId: row.binding_id as string, bindingSequence,
    serverUuid: row.server_uuid as string, applicationDatabase: row.application_database as string,
    accountsSha256: row.accounts_sha256 as string });
}

/** Native authenticated runtime check; metadata config is mandatory on a 0066 runtime. */
export async function assertSessionAuthorityRuntimeConnection(conn: PoolConnection, input?: SchemaMetadataReaderConfig): Promise<void> {
  if (input === undefined) fail();
  const config = captureSchemaMetadataReaderConfig(input);
  await assertSchemaRuntimePrivileges(conn, config);
  const binding = await loadActiveSessionAuthorityBinding(conn, false);
  const [accounts] = await conn.query<RowDataPacket[]>(
    `SELECT account_user,account_host FROM session_authority_runtime_accounts
      WHERE BINARY binding_id=BINARY ?
        AND BINARY CONCAT(account_user,'@',account_host)=BINARY CURRENT_USER()`, [binding.bindingId]);
  if (accounts.length !== 1) fail();
  // Account/role/proxy evidence is re-read by assertSchemaRuntimePrivileges on every borrow.
}

function captureNextEpoch(input: SessionAuthorityNextEpoch | null): SessionAuthorityNextEpoch | null {
  if (input === null) return null;
  const x = closed(input, ["kind", "runtimeEpochSha256", "restoreRunId", "activationRequestSha256", "sealedReplayReceiptSha256"]);
  digest(x.runtimeEpochSha256); digest(x.activationRequestSha256);
  if (x.kind === "primary_activation") {
    if (x.restoreRunId !== null || x.sealedReplayReceiptSha256 !== null) fail();
  } else if (x.kind === "restore_activation") {
    if (typeof x.restoreRunId !== "string" || !/^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x.restoreRunId)) fail();
    digest(x.sealedReplayReceiptSha256);
  } else fail();
  return Object.freeze(x) as unknown as SessionAuthorityNextEpoch;
}
function nextColumns(next: SessionAuthorityNextEpoch | null): readonly unknown[] | null {
  return next === null ? null : [next.kind, next.runtimeEpochSha256, next.restoreRunId, next.activationRequestSha256, next.sealedReplayReceiptSha256];
}
const requestData = new WeakMap<object, Readonly<CapturedSessionAuthorityActivationRequest>>();
const TARGET_KEYS = ["targetOrdinal", "targetSha256", "failureDomainSha256", "adapterProtocol", "journalNamespaceSha256"] as const;
const HEAD_KEYS = [...TARGET_KEYS, "logicalDatabaseNamespaceSha256", "sealedRemoteSequence", "sealedHeadRootSha256"] as const;
function captureTarget(input: unknown, head: boolean): Record<string, unknown> {
  const x = closed(input, head ? HEAD_KEYS : TARGET_KEYS);
  natural(x.targetOrdinal); digest(x.targetSha256); digest(x.failureDomainSha256); text(x.adapterProtocol, 256); digest(x.journalNamespaceSha256);
  if (head) { digest(x.logicalDatabaseNamespaceSha256); natural(x.sealedRemoteSequence); digest(x.sealedHeadRootSha256); }
  return x;
}
/** Capture original input before any await; the original validators still run on captured data. */
export function prepareSessionAuthorityActivationRequest(kind: SessionAuthorityActivationKind,
  input: unknown): PreparedSessionAuthorityActivationRequest {
  let captured: CapturedSessionAuthorityActivationRequest;
  if (kind === "primary_activation") {
    const x = closed(input, ["adapterProtocol", "journalNamespaceSha256", "logicalDatabaseNamespaceSha256", "runtimeEpochSha256", "targets", "observedHeads"]);
    text(x.adapterProtocol, 256); digest(x.journalNamespaceSha256); digest(x.logicalDatabaseNamespaceSha256); digest(x.runtimeEpochSha256);
    const targets = Object.freeze(array(x.targets, 32).map(t => captureTarget(t, false)));
    const observedHeads = Object.freeze(array(x.observedHeads, 32).map(h => captureTarget(h, true)));
    const original = Object.freeze({ ...x, targets, observedHeads }) as unknown as RestoreJournal.ActivateTenantRestoreJournalControlInput;
    RestoreJournal.validateActivateTenantRestoreJournalControlInput(original);
    const activationRequestSha256 = createHash("sha256").update(JSON.stringify([
      "session-authority-activation-request-v1", kind, x.adapterProtocol, x.journalNamespaceSha256,
      x.logicalDatabaseNamespaceSha256, x.runtimeEpochSha256,
      targets.map(t => TARGET_KEYS.map(k => t[k])), observedHeads.map(h => HEAD_KEYS.map(k => h[k])),
    ])).digest("hex");
    captured = Object.freeze({ kind, input: original, activationRequestSha256 });
  } else if (kind === "restore_activation") {
    const x = closed(input, ["restoreRunId", "expectedControlGeneration"]);
    text(x.restoreRunId, 256); natural(x.expectedControlGeneration);
    const original = x as unknown as RestoreJournal.ActivateTenantRestoreRuntimeInput;
    RestoreJournal.validateActivateTenantRestoreRuntimeInput(original);
    const activationRequestSha256 = createHash("sha256").update(JSON.stringify([
      "session-authority-activation-request-v1", kind, x.restoreRunId, x.expectedControlGeneration,
    ])).digest("hex");
    captured = Object.freeze({ kind, input: original, activationRequestSha256 });
  } else fail();
  const request = Object.freeze({}) as PreparedSessionAuthorityActivationRequest;
  requestData.set(request, captured); return request;
}
export function captureSessionAuthorityActivationRequest(request: PreparedSessionAuthorityActivationRequest): Readonly<CapturedSessionAuthorityActivationRequest> {
  return request && typeof request === "object" ? requestData.get(request) ?? fail() : fail();
}
/** Must run in the trusted Store entry before any SQL or original exact-replay return. */
export function assertSessionAuthorityActivationRequest(context: SessionAuthorityBindingOperatorContext,
  request: PreparedSessionAuthorityActivationRequest): void {
  const command = captureSessionAuthorityBindingCommand(context.command), actual = captureSessionAuthorityActivationRequest(request), next = command.nextEpoch;
  if (!next || actual.kind !== next.kind || actual.activationRequestSha256 !== next.activationRequestSha256) fail();
  if (actual.kind === "primary_activation") {
    if (actual.input.runtimeEpochSha256 !== next.runtimeEpochSha256) fail();
  } else if (next.kind !== "restore_activation" || actual.input.restoreRunId !== next.restoreRunId) fail();
}
function sourceFrom(row: RowDataPacket, prefix = "source_"): SessionAuthorityBindingSource {
  const source = { kind: row[`${prefix}kind`], runtimeControlGeneration: Number(row[`${prefix}runtime_control_generation`]),
    runtimeControlEvidenceSha256: row[`${prefix}runtime_control_evidence_sha256`], runtimeEpochSha256: row[`${prefix}runtime_epoch_sha256`],
    restoreRunId: row[`${prefix}restore_run_id`], replayReceiptSha256: row[`${prefix}replay_receipt_sha256`] } as SessionAuthorityBindingSource;
  sourceColumns(source); return source;
}
function nextFrom(row: RowDataPacket): SessionAuthorityNextEpoch | null {
  if (row.next_epoch_kind === null) {
    if ([row.next_epoch_sha256, row.next_restore_run_id, row.activation_request_sha256, row.sealed_replay_receipt_sha256].some(x => x !== null)) fail();
    return null;
  }
  return captureNextEpoch({ kind: row.next_epoch_kind, runtimeEpochSha256: row.next_epoch_sha256, restoreRunId: row.next_restore_run_id,
    activationRequestSha256: row.activation_request_sha256, sealedReplayReceiptSha256: row.sealed_replay_receipt_sha256 } as SessionAuthorityNextEpoch);
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
async function control(conn: PoolConnection): Promise<{ current: string | null; sequence: number }> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT protocol,current_binding_id,binding_sequence FROM session_authority_control WHERE control_id=1 FOR UPDATE");
  if (rows.length !== 1 || rows[0]!.protocol !== PROTOCOL) fail();
  const current = rows[0]!.current_binding_id as string | null, sequence = Number(rows[0]!.binding_sequence); natural(sequence);
  if ((current === null) !== (sequence === 0)) fail(); if (current !== null) uuid(current);
  return { current, sequence };
}
async function nativeIdentity(conn: PoolConnection, command: Readonly<CapturedSessionAuthorityBindingCommand>): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT @@GLOBAL.server_uuid AS server_uuid,DATABASE() AS application_database");
  if (rows.length !== 1 || rows[0]!.server_uuid !== command.serverUuid || rows[0]!.application_database !== command.applicationDatabase) fail();
}
async function nativeAdmission(conn: PoolConnection, context: SessionAuthorityBindingOperatorContext): Promise<void> {
  const command = captureSessionAuthorityBindingCommand(context.command), config = captureSchemaMetadataReaderConfig(context.schemaMetadata);
  if (typeof context.assertNativeAdmission !== "function") fail();
  await context.assertNativeAdmission(conn, command, config); await nativeIdentity(conn, command);
}
async function unappliedPredecessor(conn: PoolConnection, context: SessionAuthorityBindingOperatorContext): Promise<void> {
  const command = captureSessionAuthorityBindingCommand(context.command), pointer = await control(conn);
  if (pointer.current !== command.expectedBindingId || pointer.sequence !== command.expectedSequence) fail();
  const [prior] = await conn.query<RowDataPacket[]>(
    `SELECT a.account_user FROM session_authority_runtime_accounts a JOIN session_authority_bindings b ON BINARY b.binding_id=BINARY a.binding_id
       WHERE b.binding_sequence<=? ORDER BY BINARY a.account_user FOR SHARE`, [command.expectedSequence]);
  if (prior.some(a => !command.oldAccountNames.includes(a.account_user as string))) fail();
  if (pointer.current !== null) {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT * FROM session_authority_bindings WHERE BINARY binding_id=BINARY ? FOR SHARE", [pointer.current]);
    if (rows.length !== 1 || !same(sourceColumns(sourceFrom(rows[0]!)), sourceColumns(command.expectedSource))) fail();
  }
  if (!command.oldAccountNames.length) {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT session_id FROM sessions LIMIT 1 FOR SHARE");
    if (pointer.current !== null || command.expectedSource.kind !== "inactive" || rows.length !== 0) fail();
  }
  await nativeAdmission(conn, context); await assertNativeSource(conn, command.expectedSource);
}
/** Readonly preflight. Its observed facts are never cached as mutation admission. */
export async function preflightSessionAuthorityBinding(conn: PoolConnection, context: SessionAuthorityBindingOperatorContext): Promise<void> {
  await unappliedPredecessor(conn, context);
}
interface TransitionData {
  conn: PoolConnection; command: PreparedSessionAuthorityBindingCommand; request: PreparedSessionAuthorityActivationRequest;
  admission: SessionAuthorityBindingOperatorContext["assertNativeAdmission"];
  headGeneration: number; headEvidence: string; applied: boolean;
}
const transitions = new WeakMap<object, TransitionData>();
/** Called in the original Store TX after its source locks/audit and before its first mutation. */
export async function prepareSessionAuthorityBindingTransition(conn: PoolConnection, context: SessionAuthorityBindingOperatorContext,
  request: PreparedSessionAuthorityActivationRequest): Promise<PreparedSessionAuthorityBindingTransition> {
  assertSessionAuthorityActivationRequest(context, request);
  const command = captureSessionAuthorityBindingCommand(context.command), actual = captureSessionAuthorityActivationRequest(request), pointer = await control(conn);
  let headGeneration = 0, headEvidence = RestoreJournal.EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256, applied = false;
  if (pointer.current === command.bindingId) {
    // A successful source transition changed the current epoch. Confirm its stored result first.
    await confirmSessionAuthorityBinding(conn, context); applied = true;
  } else {
    await unappliedPredecessor(conn, context);
    const [heads] = await conn.query<RowDataPacket[]>("SELECT state,control_generation,evidence_sha256 FROM tenant_restore_runtime_control WHERE singleton_id=1 FOR UPDATE");
    if (heads.length !== 1) fail(); headGeneration = Number(heads[0]!.control_generation); natural(headGeneration);
    if (heads[0]!.state === "inactive") { if (headGeneration !== 0) fail(); }
    else { if (heads[0]!.state !== "active" || headGeneration < 1) fail(); digest(heads[0]!.evidence_sha256); headEvidence = heads[0]!.evidence_sha256 as string; }
    if (headGeneration === Number.MAX_SAFE_INTEGER) fail();
    if (actual.kind === "primary_activation") {
      if (heads[0]!.state !== "inactive" || command.expectedSource.kind !== "inactive") fail();
    } else {
      const next = command.nextEpoch;
      if (!next || next.kind !== "restore_activation" || actual.input.expectedControlGeneration !== headGeneration || heads[0]!.state !== "active") fail();
      const [runs] = await conn.query<RowDataPacket[]>(
        "SELECT phase,runtime_epoch_sha256,terminal_receipt_sha256 FROM tenant_restore_replay_runs WHERE restore_run_id=? FOR SHARE", [actual.input.restoreRunId]);
      if (runs.length !== 1 || runs[0]!.phase !== "replay_sealed" || runs[0]!.runtime_epoch_sha256 !== next.runtimeEpochSha256
        || runs[0]!.terminal_receipt_sha256 !== next.sealedReplayReceiptSha256) fail();
    }
  }
  const token = Object.freeze({}) as PreparedSessionAuthorityBindingTransition;
  transitions.set(token, { conn, command: context.command, request, admission: context.assertNativeAdmission, headGeneration, headEvidence, applied });
  return token;
}
/** Native historical-head proof, including journal advances between immutable old activation and transition. */
async function historicalHead(conn: PoolConnection, old: SessionAuthorityBindingSource, generation: number, evidence: string): Promise<void> {
  natural(generation); digest(evidence);
  if (old.kind === "inactive") {
    if (generation !== 0 || evidence !== RestoreJournal.EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256) fail();
    return;
  }
  if (generation < old.runtimeControlGeneration) fail();
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT runtime_epoch_sha256,evidence_sha256 FROM tenant_restore_runtime_events WHERE singleton_id=1 AND control_generation=? FOR SHARE", [generation]);
  if (rows.length !== 1 || rows[0]!.runtime_epoch_sha256 !== old.runtimeEpochSha256 || rows[0]!.evidence_sha256 !== evidence) fail();
}
async function assertResultRelation(conn: PoolConnection, command: Readonly<CapturedSessionAuthorityBindingCommand>, row: RowDataPacket): Promise<void> {
  const source = sourceFrom(row), old = sourceFrom(row, "expected_source_"), next = nextFrom(row);
  if (!same(sourceColumns(old), sourceColumns(command.expectedSource)) || !same(nextColumns(next), nextColumns(command.nextEpoch))) fail();
  if (next === null) {
    if (command.expectedBindingId !== null || command.expectedSequence !== 0 || !same(sourceColumns(source), sourceColumns(old))
      || row.transition_predecessor_control_generation !== null || row.transition_predecessor_control_evidence_sha256 !== null) fail();
  } else {
    if (!command.expectedBindingId || source.kind !== next.kind || source.runtimeEpochSha256 !== next.runtimeEpochSha256
      || source.restoreRunId !== next.restoreRunId || source.replayReceiptSha256 !== next.sealedReplayReceiptSha256) fail();
    const generation = Number(row.transition_predecessor_control_generation), evidence = row.transition_predecessor_control_evidence_sha256;
    natural(generation); digest(evidence); if (generation === Number.MAX_SAFE_INTEGER || source.runtimeControlGeneration !== generation + 1) fail();
    const [prior] = await conn.query<RowDataPacket[]>("SELECT * FROM session_authority_bindings WHERE BINARY binding_id=BINARY ? FOR SHARE", [command.expectedBindingId]);
    if (prior.length !== 1 || Number(prior[0]!.binding_sequence) !== command.expectedSequence
      || !same(sourceColumns(sourceFrom(prior[0]!)), sourceColumns(old))) fail();
    await historicalHead(conn, old, generation, evidence);
    const [events] = await conn.query<RowDataPacket[]>(
      "SELECT previous_control_evidence_sha256 FROM tenant_restore_runtime_events WHERE singleton_id=1 AND control_generation=? FOR SHARE", [source.runtimeControlGeneration]);
    if (events.length !== 1 || events[0]!.previous_control_evidence_sha256 !== evidence) fail();
  }
  await assertNativeSource(conn, source);
}
/** Exact readonly current-result confirmation. Never refreshes old source, nonce or command. */
export async function confirmSessionAuthorityBinding(conn: PoolConnection, context: SessionAuthorityBindingOperatorContext): Promise<ActiveSessionAuthorityBinding> {
  const command = captureSessionAuthorityBindingCommand(context.command), actual = await loadActiveSessionAuthorityBinding(conn, true);
  const [rows] = await conn.query<RowDataPacket[]>("SELECT * FROM session_authority_bindings WHERE BINARY binding_id=BINARY ? FOR SHARE", [command.bindingId]);
  if (rows.length !== 1 || actual.bindingId !== command.bindingId || actual.bindingSequence !== command.expectedSequence + 1
    || actual.accountsSha256 !== command.accountsSha256 || actual.serverUuid !== command.serverUuid || actual.applicationDatabase !== command.applicationDatabase
    || rows[0]!.activation_id !== command.activationId || rows[0]!.predecessor_binding_id !== command.expectedBindingId
    || rows[0]!.activation_evidence_sha256 !== command.activationEvidenceSha256 || rows[0]!.command_sha256 !== command.commandSha256) fail();
  await assertResultRelation(conn, command, rows[0]!); await nativeAdmission(conn, context); return actual;
}
export const confirmSessionAuthorityBindingCommand = confirmSessionAuthorityBinding;

async function writeBinding(conn: PoolConnection, context: SessionAuthorityBindingOperatorContext,
  source: SessionAuthorityBindingSource, head: { generation: number; evidence: string } | null): Promise<ActiveSessionAuthorityBinding> {
  const command = captureSessionAuthorityBindingCommand(context.command), pointer = await control(conn);
  if (pointer.current !== command.expectedBindingId || pointer.sequence !== command.expectedSequence) fail();
  await nativeAdmission(conn, context); await assertNativeSource(conn, source);
  const columns = ["binding_id", "binding_sequence", "predecessor_binding_id", "activation_id", "server_uuid", "application_database",
    "accounts_sha256", "activation_evidence_sha256", "command_sha256", "source_kind", "source_runtime_control_generation",
    "source_runtime_control_evidence_sha256", "source_runtime_epoch_sha256", "source_restore_run_id", "source_replay_receipt_sha256",
    "expected_source_kind", "expected_source_runtime_control_generation", "expected_source_runtime_control_evidence_sha256", "expected_source_runtime_epoch_sha256",
    "expected_source_restore_run_id", "expected_source_replay_receipt_sha256", "next_epoch_kind", "next_epoch_sha256", "next_restore_run_id",
    "activation_request_sha256", "sealed_replay_receipt_sha256", "transition_predecessor_control_generation", "transition_predecessor_control_evidence_sha256"];
  const values = [command.bindingId, pointer.sequence + 1, pointer.current, command.activationId, command.serverUuid, command.applicationDatabase,
    command.accountsSha256, command.activationEvidenceSha256, command.commandSha256, ...sourceColumns(source), ...sourceColumns(command.expectedSource),
    ...(nextColumns(command.nextEpoch) ?? [null, null, null, null, null]), head?.generation ?? null, head?.evidence ?? null];
  await conn.query("SET @session_authority_binding_previous_gcml=@@SESSION.group_concat_max_len");
  let result: ActiveSessionAuthorityBinding | undefined, hasError = false, firstError: unknown;
  const remember = (error: unknown) => { if (!hasError) { hasError = true; firstError = error; } };
  try {
    await conn.query("SET SESSION group_concat_max_len=1048576");
    await conn.query(`INSERT INTO session_authority_bindings(${columns.join(",")},activated_at_db_ms)
      VALUES (${values.map(() => "?").join(",")},FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000))`, values);
    for (const account of command.newAccounts) await conn.query("INSERT INTO session_authority_runtime_accounts(binding_id,account_user,account_host) VALUES (?,?,?)",
      [command.bindingId, account.user, account.host]);
    const [updated] = await conn.query<ResultSetHeader>(
      "UPDATE session_authority_control SET current_binding_id=?,binding_sequence=? WHERE control_id=1 AND current_binding_id <=> ? AND binding_sequence=?",
      [command.bindingId, pointer.sequence + 1, pointer.current, pointer.sequence]);
    if (updated.affectedRows !== 1) fail(); result = await confirmSessionAuthorityBinding(conn, context);
  } catch (error) { remember(error); }
  try { await conn.query("SET SESSION group_concat_max_len=@session_authority_binding_previous_gcml"); } catch (error) { remember(error); }
  if (hasError) throw firstError; return result ?? fail();
}
/** Only initial/adopt-current-source: no epoch transition and no optional token bypass. */
export async function initializeSessionAuthorityBinding(conn: PoolConnection, context: SessionAuthorityBindingOperatorContext): Promise<ActiveSessionAuthorityBinding> {
  const command = captureSessionAuthorityBindingCommand(context.command); if (command.nextEpoch !== null) fail();
  const pointer = await control(conn);
  if (pointer.current === command.bindingId) return confirmSessionAuthorityBinding(conn, context);
  await unappliedPredecessor(conn, context); return writeBinding(conn, context, command.expectedSource, null);
}
export const initializeSessionAuthorityBindingCommand = initializeSessionAuthorityBinding;
/** Caller owns the original TX/COMMIT. Token is private to its lexical transaction and consumed once. */
export async function advanceSessionAuthorityBinding(conn: PoolConnection, context: SessionAuthorityBindingOperatorContext,
  token: PreparedSessionAuthorityBindingTransition, actualSource: SessionAuthorityBindingSource): Promise<ActiveSessionAuthorityBinding> {
  sourceColumns(actualSource);
  const data = token && typeof token === "object" ? transitions.get(token) : undefined;
  if (!data || data.conn !== conn || data.command !== context.command || data.admission !== context.assertNativeAdmission) fail();
  transitions.delete(token); assertSessionAuthorityActivationRequest(context, data.request);
  const command = captureSessionAuthorityBindingCommand(context.command), next = command.nextEpoch;
  if (!next || actualSource.kind !== next.kind || actualSource.runtimeEpochSha256 !== next.runtimeEpochSha256
    || actualSource.restoreRunId !== next.restoreRunId || actualSource.replayReceiptSha256 !== next.sealedReplayReceiptSha256) fail();
  if (data.applied) {
    const confirmed = await confirmSessionAuthorityBinding(conn, context);
    const [rows] = await conn.query<RowDataPacket[]>("SELECT * FROM session_authority_bindings WHERE BINARY binding_id=BINARY ? FOR SHARE", [command.bindingId]);
    if (rows.length !== 1 || !same(sourceColumns(sourceFrom(rows[0]!)), sourceColumns(actualSource))) fail(); return confirmed;
  }
  if (actualSource.runtimeControlGeneration !== data.headGeneration + 1) fail();
  await historicalHead(conn, command.expectedSource, data.headGeneration, data.headEvidence);
  await assertNativeSource(conn, actualSource);
  const [events] = await conn.query<RowDataPacket[]>(
    "SELECT previous_control_evidence_sha256 FROM tenant_restore_runtime_events WHERE singleton_id=1 AND control_generation=? FOR SHARE", [actualSource.runtimeControlGeneration]);
  if (events.length !== 1 || events[0]!.previous_control_evidence_sha256 !== data.headEvidence) fail();
  return writeBinding(conn, context, actualSource, { generation: data.headGeneration, evidence: data.headEvidence });
}
