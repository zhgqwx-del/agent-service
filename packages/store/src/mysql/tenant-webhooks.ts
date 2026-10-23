import { transferSessionWriteAdmission } from "../session-authority.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item } from "@agent-service/protocol";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import * as W from "../tenant-webhooks.js";
import * as S from "../tenant-webhook-state.js";

export const TENANT_WEBHOOK_MIGRATION = "0063_tenant_webhooks.sql";
export const TENANT_WEBHOOK_TABLES = ["tenant_webhook_slots", "tenant_webhook_versions", "tenant_webhook_replays", "tenant_webhook_snapshots", "tenant_webhook_intents", "tenant_webhook_milestones"] as const;
export const TENANT_WEBHOOK_TRIGGERS = [...TENANT_WEBHOOK_TABLES.flatMap(t => ["bi", "bu", "bd"].map(s => `trg_${t}_${s}`)), "trg_tenant_webhook_t3a_bu", "trg_tenant_webhook_t3d_bu", "trg_tenant_webhook_t3f_bu", "trg_tenant_webhook_item_bi", "trg_tenant_webhook_item_bu"];
type Row = RowDataPacket & Record<string, unknown>;
type Access = ReturnType<typeof W.assertTenantWebhookAccess>;
export type TenantWebhookGate = (conn: PoolConnection, access: Access, now: number) => Promise<void>;
function fail(): never { throw new W.TenantWebhookIntegrityError(); }
const parse = <T>(value: unknown): T => { try { return (typeof value === "string" ? JSON.parse(value) : value) as T; } catch { return fail(); } };
const json = (value: unknown) => JSON.stringify(value);
export function tenantWebhookFingerprintStatement(sql: string): string {
  const start = "-- agent-service-runtime-fingerprint:tenant-webhooks:start", end = "-- agent-service-runtime-fingerprint:tenant-webhooks:end";
  const a = sql.indexOf(start), b = sql.indexOf(end);
  if (a < 0 || b <= a || sql.indexOf(start, a + 1) >= 0 || sql.indexOf(end, b + 1) >= 0) fail();
  const statements = sql.slice(a + start.length, b).replace(/^\s*--.*$/gm, "").split(/;\s*\n/).map(s => s.trim()).filter(Boolean), statement = statements[0];
  const roots = statement?.match(/'[a-f0-9]{64}'/g) ?? [];
  if (statements.length !== 1 || !statement?.startsWith("SET @skill_registry_triggers_ok=") || statement.includes(";") || roots.length !== 1 || roots[0] === `'${"0".repeat(64)}'`) fail();
  return statement;
}
export async function assertMysqlTenantWebhookFingerprint(conn: PoolConnection, directory: string) {
  const statement = tenantWebhookFingerprintStatement(await readFile(join(directory, TENANT_WEBHOOK_MIGRATION), "utf8"));
  await conn.query("SET @tenant_webhook_previous_gcml=@@SESSION.group_concat_max_len");
  try { await conn.query("SET SESSION group_concat_max_len=1048576"); await conn.query(statement);
    const [rows] = await conn.query<Row[]>("SELECT @skill_registry_triggers_ok AS ok"); if (Number(rows[0]?.ok) !== 1) fail();
  } finally { await conn.query("SET SESSION group_concat_max_len=@tenant_webhook_previous_gcml"); }
}
async function now(conn: PoolConnection) { const [rows] = await conn.query<Row[]>("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms"); const n = Number(rows[0]?.now_ms); W.tenantWebhookNatural(n); return n; }
async function readImage(conn: PoolConnection, webhookId: string, input: { replay?: string; call?: string; intent?: string } = {}, lock = true): Promise<S.TenantWebhookImage> {
  const suffix = lock ? " FOR UPDATE" : "", [rows] = await conn.query<Row[]>(`SELECT tenant_id,name,record_json FROM tenant_webhook_slots WHERE webhook_id=?${suffix}`, [webhookId]);
  if (rows.length > 1) fail(); const image = S.emptyTenantWebhookImage(); if (!rows[0] || rows[0].record_json === null) return image;
  image.slot = parse<W.TenantWebhookSlot>(rows[0].record_json);
  if (image.slot.webhookId !== webhookId || image.slot.tenantId !== rows[0].tenant_id || image.slot.name !== rows[0].name) fail();
  const [versions] = await conn.query<Row[]>(`SELECT config_version_id,record_json FROM tenant_webhook_versions WHERE webhook_id=? ORDER BY config_version_id${lock ? " FOR SHARE" : ""}`, [webhookId]);
  image.versions = versions.map(r => { const v = parse<W.TenantWebhookVersion>(r.record_json); if (v.configVersionId !== r.config_version_id) fail(); return v; });
  if (input.replay) { const [replays] = await conn.query<Row[]>(`SELECT key_sha256,record_json FROM tenant_webhook_replays WHERE key_sha256=? AND webhook_id=?${suffix}`, [input.replay, webhookId]); image.replays = replays.map(r => { const v = parse<S.TenantWebhookReplay>(r.record_json); if (v.keySha256 !== r.key_sha256) fail(); return v; }); }
  if (input.call) {
    const [snapshots] = await conn.query<Row[]>(`SELECT snapshot_id,record_json FROM tenant_webhook_snapshots WHERE webhook_id=? AND call_item_id=? ORDER BY snapshot_id${suffix}`, [webhookId, input.call]);
    image.snapshots = snapshots.map(r => { const v = parse<W.TenantWebhookInvocationSnapshot>(r.record_json); if (v.snapshotId !== r.snapshot_id) fail(); return v; });
  }
  if (input.intent || input.call) {
    const [intents] = await conn.query<Row[]>(`SELECT intent_id,record_json FROM tenant_webhook_intents WHERE webhook_id=? AND ${input.intent ? "intent_id=?" : "call_item_id=?"} ORDER BY intent_id${suffix}`, [webhookId, input.intent ?? input.call]);
    image.intents = intents.map(r => { const v = parse<W.TenantWebhookIntent>(r.record_json); if (v.intentId !== r.intent_id) fail(); return v; });
  }
  S.validateTenantWebhookImage(image); return image;
}
async function persist(conn: PoolConnection, before: S.TenantWebhookImage, after: S.TenantWebhookImage, onlySnapshots = false) {
  const slot = after.slot; if (!slot) return;
  const tables = onlySnapshots ? [["tenant_webhook_snapshots", "snapshots", "snapshot_id", "snapshotId"]] as const : [
    ["tenant_webhook_versions", "versions", "config_version_id", "configVersionId"], ["tenant_webhook_replays", "replays", "key_sha256", "keySha256"],
    ["tenant_webhook_snapshots", "snapshots", "snapshot_id", "snapshotId"], ["tenant_webhook_intents", "intents", "intent_id", "intentId"],
  ] as const;
  for (const [table, field, pk, property] of tables) for (const row of after[field]) {
    const record = row as unknown as Record<string, unknown>, old = before[field].find(r => (r as unknown as Record<string, unknown>)[property] === record[property]);
    if (old && S.webhookSame(old, row)) continue;
    if (old) { if (field !== "intents") fail(); await conn.query(`UPDATE ${table} SET state=?,record_json=? WHERE ${pk}=? AND webhook_id=?`, [record.state, json(row), record[property], slot.webhookId]); }
    else {
      const extra = field === "snapshots" || field === "intents" ? ",call_item_id,subject_user_id,session_id,turn_id" : "";
      const values: unknown[] = [record[property], slot.webhookId, slot.tenantId, json(row)];
      if (extra) values.push(record.callItemId, (record.subject as W.TenantWebhookSourceValue["principal"]).userId, record.sessionId, record.turnId);
      if (field === "intents") values.push(record.state);
      await conn.query(`INSERT INTO ${table} (${pk},webhook_id,tenant_id,record_json${extra}${field === "intents" ? ",state" : ""}) VALUES (?,?,?,?${extra ? ",?,?,?,?" : ""}${field === "intents" ? ",?" : ""})`, values);
    }
  }
  if (!onlySnapshots && !S.webhookSame(before.slot, slot)) await conn.query("UPDATE tenant_webhook_slots SET state=?,record_json=? WHERE webhook_id=?", [slot.state, json(slot), slot.webhookId]);
}
export class MysqlTenantWebhooks {
  constructor(private readonly pool: Pool, private readonly gate: TenantWebhookGate,
    private readonly authorize: (conn: PoolConnection, target: object, scope: { sessionId: string; fence: number }) => Promise<void>) {}
  private async transaction<T>(work: (conn: PoolConnection) => Promise<T>) {
    const conn = await this.pool.getConnection();
    try { await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"); await conn.beginTransaction(); const result = await work(conn); await conn.commit(); return result; }
    catch (error) { await conn.rollback().catch(() => {}); throw error; } finally { conn.release(); }
  }
  async upsertTenantWebhook(input: W.UpsertTenantWebhookInput) {
    const authority = W.assertTenantWebhookAccess(input.access, "admin"), id = W.tenantWebhookId(authority.tenantId, input.name);
    return this.transaction(async conn => { await this.gate(conn, authority, await now(conn));
      await this.lockConfiguration(conn, authority.tenantId);
      const [present] = await conn.query<Row[]>("SELECT webhook_id FROM tenant_webhook_slots WHERE webhook_id=? FOR UPDATE",[id]);
      if (!present.length) await conn.query("INSERT INTO tenant_webhook_slots (webhook_id,tenant_id,name,state,record_json) VALUES (?,?,?,'disabled',NULL)", [id, authority.tenantId, input.name]);
      const before = await readImage(conn, id, { replay: S.webhookReplayKey(id, "upsert", input.idempotencyKey) }), after = structuredClone(before), result = S.upsertWebhook(after, input, await now(conn));
      S.validateTenantWebhookImage(after); await this.assertActiveLimit(conn, authority.tenantId, result.slot.webhookId); await persist(conn, before, after); return result; });
  }
  async setTenantWebhookState(input: Parameters<W.TenantWebhookStore["setTenantWebhookState"]>[0]) {
    const authority = W.assertTenantWebhookAccess(input.access, "admin"), id = W.tenantWebhookId(authority.tenantId, input.name);
    return this.transaction(async conn => { await this.gate(conn, authority, await now(conn)); await this.lockConfiguration(conn, authority.tenantId);
      const before = await readImage(conn, id, { replay: S.webhookReplayKey(id, "state", input.idempotencyKey) }), after = structuredClone(before);
      const result = S.setWebhookState(after, input, await now(conn)); S.validateTenantWebhookImage(after);
      if (result.state === "enabled") await this.assertActiveLimit(conn, authority.tenantId, id); await persist(conn, before, after); return result; });
  }
  async getTenantWebhook(input: W.TenantWebhookNameInput) {
    W.tenantWebhookClosed(input, ["access", "name"]); const authority = W.assertTenantWebhookAccess(input.access), id = W.tenantWebhookId(authority.tenantId, input.name);
    return this.transaction(async conn => { await this.gate(conn, authority, await now(conn)); const image = await readImage(conn, id);
      return image.slot ? { slot: image.slot, version: image.versions.find(v => v.configVersionId === image.slot!.currentVersionId) ?? null } : null; });
  }
  async listTenantWebhooks(input: Parameters<W.TenantWebhookStore["listTenantWebhooks"]>[0]) {
    W.tenantWebhookClosed(input, ["access", "cursor", "limit"]); this.page(input.cursor, input.limit); const authority = W.assertTenantWebhookAccess(input.access, "admin");
    return this.transaction(async conn => { await this.gate(conn, authority, await now(conn));
      const [rows] = await conn.query<Row[]>("SELECT webhook_id FROM tenant_webhook_slots WHERE tenant_id=? AND BINARY tenant_id=BINARY ? AND webhook_id>? ORDER BY webhook_id LIMIT ? FOR SHARE", [authority.tenantId, authority.tenantId, input.cursor ?? "", input.limit + 1]);
      const items: W.TenantWebhookRegistration[] = []; for (const r of rows.slice(0, input.limit)) { const image = await readImage(conn, String(r.webhook_id),{},false); if (!image.slot) fail(); items.push({ slot: image.slot, version: image.versions.find(v => v.configVersionId === image.slot!.currentVersionId) ?? null }); }
      return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.slot.webhookId : null }; });
  }
  async getTenantWebhookRuntimePolicy(input: Parameters<W.TenantWebhookStore["getTenantWebhookRuntimePolicy"]>[0]) {
    W.tenantWebhookClosed(input, ["access"]); const authority = W.assertTenantWebhookAccess(input.access, "runtime");
    return this.transaction(async conn => { await this.gate(conn, authority, await now(conn));
      const [rows] = await conn.query<Row[]>("SELECT webhook_id FROM tenant_webhook_slots WHERE tenant_id=? AND BINARY tenant_id=BINARY ? AND state='enabled' ORDER BY webhook_id LIMIT 9 FOR SHARE", [authority.tenantId, authority.tenantId]);
      if (rows.length > 8) fail(); const result: {configVersionId:string;configSha256:string;phase:W.TenantWebhookPhase}[] = [];
      for (const row of rows) { const image = await readImage(conn, String(row.webhook_id), {}, false), version = image.versions.find(v => v.configVersionId === image.slot?.currentVersionId);
        if (!version) fail(); result.push({ configVersionId: version.configVersionId, configSha256: version.configSha256, phase: version.config.phase }); }
      return result; });
  }
  async source(conn: PoolConnection, input: W.TenantWebhookSourceInput, throughSeq?: number): Promise<W.TenantWebhookSourceValue> {
    W.tenantWebhookClosed(input, ["access", "sessionId", "turnId", "callItemId", "fence"]); const authority = W.assertTenantWebhookAccess(input.access, "runtime");
    await this.authorize(conn, input.access, { sessionId: input.sessionId, fence: input.fence });
    const [heads] = await conn.query<Row[]>("SELECT tenant_id,user_id,last_seq,fence_token,deleted_at_ms FROM sessions WHERE session_id=? AND BINARY session_id=BINARY ? FOR UPDATE", [input.sessionId, input.sessionId]);
    const head = heads[0]; if (!head || head.tenant_id !== authority.tenantId || head.user_id !== authority.principal!.userId || Number(head.fence_token) !== input.fence || head.deleted_at_ms !== null) throw new W.TenantWebhookConflictError();
    await this.gate(conn, authority, await now(conn));
    const [turns] = await conn.query<Row[]>("SELECT turn_id FROM turns WHERE turn_id=? AND session_id=? AND BINARY turn_id=BINARY ? AND BINARY session_id=BINARY ? FOR SHARE", [input.turnId, input.sessionId, input.turnId, input.sessionId]); if (turns.length !== 1) fail();
    const [calls] = await conn.query<Row[]>("SELECT JSON_REMOVE(body,'$.args') AS body FROM items WHERE item_id=? AND session_id=? AND turn_id=? AND type='toolCall' AND BINARY item_id=BINARY ? FOR SHARE", [input.callItemId, input.sessionId, input.turnId, input.callItemId]); if (calls.length !== 1) fail();
    const call = parse<Item>(calls[0]!.body); if (call.type !== "toolCall") fail();
    const watermark = throughSeq ?? Number(head.last_seq); if (watermark > Number(head.last_seq)) fail();
    const [snapRows] = await conn.query<Row[]>("SELECT webhook_id,record_json FROM tenant_webhook_snapshots WHERE tenant_id=? AND call_item_id=? AND BINARY tenant_id=BINARY ? ORDER BY snapshot_id FOR SHARE", [authority.tenantId, input.callItemId, authority.tenantId]);
    const snapshots = snapRows.map(r => parse<W.TenantWebhookInvocationSnapshot>(r.record_json));
    const [slots] = await conn.query<Row[]>("SELECT webhook_id FROM tenant_webhook_slots WHERE tenant_id=? AND BINARY tenant_id=BINARY ? ORDER BY webhook_id FOR SHARE", [authority.tenantId, authority.tenantId]);
    const registrations: W.TenantWebhookRegistration[] = [];
    for (const row of slots) { const image = await readImage(conn, String(row.webhook_id), { call: input.callItemId }, false); if (!image.slot) fail();
      const selected = snapshots.find(s => s.webhookId === row.webhook_id); registrations.push({ slot: image.slot, version: image.versions.find(v => v.configVersionId === (selected?.configVersionId ?? image.slot!.currentVersionId)) ?? null }); }
    const selected = registrations.filter(r => r.version !== null && (call.startedAtMs !== undefined ? snapshots.some(s => s.configVersionId === r.version!.configVersionId) : r.slot.state === "enabled"));
    const needPrompt = call.startedAtMs === undefined && selected.some(r => r.version!.config.bodyScopes.includes("prompt"));
    const needArgs = call.startedAtMs === undefined && selected.some(r => r.version!.config.bodyScopes.includes("tool_arguments"));
    if (needArgs) { const [args] = await conn.query<Row[]>("SELECT JSON_EXTRACT(body,'$.args') AS args FROM items WHERE item_id=? AND BINARY item_id=BINARY ? FOR SHARE", [input.callItemId, input.callItemId]); if (call.type === "toolCall") call.args = parse(args[0]?.args); }
    else if (call.type === "toolCall") call.args = null;
    const items: Item[] = [call];
    if (needPrompt) { const [userRows] = await conn.query<Row[]>("SELECT body FROM items WHERE session_id=? AND turn_id=? AND type='userMessage' AND seq<=? AND BINARY session_id=BINARY ? AND BINARY turn_id=BINARY ? ORDER BY seq FOR SHARE", [input.sessionId, input.turnId, watermark, input.sessionId, input.turnId]); items.push(...userRows.map(r => parse<Item>(r.body))); }
    return S.sourceValue(input, items, watermark, registrations, snapshots);
  }
  readTenantWebhookSources(input: W.TenantWebhookSourceInput) { return this.transaction(async conn => W.createStoredTenantWebhookSource(await this.source(conn, input), input.access)); }
  async stageMilestone(conn: PoolConnection, admitted: W.TenantWebhookMilestoneAdmissionInput, clock: number) {
    const original = W.assertTenantWebhookSource(admitted.source), access = W.createTenantWebhookRuntimeAccess(original.principal);
    transferSessionWriteAdmission(admitted.source, access);
    const current = await this.source(conn, { access, sessionId: original.sessionId, turnId: original.turnId, callItemId: original.callItemId, fence: original.fence }, original.throughSeq);
    if (admitted.kind !== "post" && !S.webhookSame(original.registrations, current.registrations)) throw new W.TenantWebhookConflictError();
    const stages: Array<{ before: S.TenantWebhookImage; after: S.TenantWebhookImage }> = [], intents: W.TenantWebhookIntent[] = [];
    for (const selected of current.registrations) {
      const before = await readImage(conn, selected.slot.webhookId, { call: original.callItemId }, false), after = structuredClone(before);
      intents.push(...S.applyWebhookMilestone(after, admitted, current, clock)); S.validateTenantWebhookImage(after);
      const milestoneId = W.tenantWebhookDigest("tenant-webhook-milestone-v2", { configVersionId: selected.version!.configVersionId, callItemId: original.callItemId, kind: admitted.kind });
      const started = admitted.batch.items?.find(i => i.id === original.callItemId);
      const milestone={ milestoneId, webhookId: selected.slot.webhookId, subject: original.principal, sessionId: original.sessionId, turnId: original.turnId,
        callItemId: original.callItemId, kind: admitted.kind, configVersionId: selected.version!.configVersionId, throughSeq: original.throughSeq, sourceSha256: original.sourceSha256,
        registrationRevision: selected.slot.revision, fence: original.fence, resultItemId:admitted.canonicalResult?.itemId??null,
        canonicalPayloadSha256:admitted.canonicalResult?.payloadSha256??null, canonicalPayloadBytes:admitted.canonicalResult?.payloadBytes??null,
        batchSha256: W.tenantWebhookDigest("tenant-webhook-commit-batch-v2", admitted.batch), createdAtMs: clock };
      const [prior] = await conn.query<Row[]>("SELECT record_json FROM tenant_webhook_milestones WHERE milestone_id=? FOR SHARE",[milestoneId]);
      if (prior.length) { const old=parse<typeof milestone>(prior[0]!.record_json); if (!S.webhookSame({...old,createdAtMs:clock},milestone)) throw new W.TenantWebhookConflictError(); }
      else await conn.query("INSERT INTO tenant_webhook_milestones (milestone_id,webhook_id,tenant_id,subject_user_id,session_id,turn_id,call_item_id,kind,config_version_id,started_at_ms,record_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [milestoneId, selected.slot.webhookId, original.principal.tenantId, original.principal.userId, original.sessionId, original.turnId, original.callItemId, admitted.kind,
          selected.version!.configVersionId, admitted.kind === "started" && started?.type === "toolCall" ? started.startedAtMs : null,
          json(milestone)]);
      await persist(conn, before, after, true); stages.push({ before: { ...before, snapshots: after.snapshots }, after });
    }
    return { intents, finish: async () => {
      const result = admitted.canonicalResult;
      if (result) { const item = admitted.batch.items?.find(i => i.id === result.itemId);
        if (!item || item.type !== "toolResult") fail(); if (item.outputRef) {
          const [rows] = await conn.query<Row[]>("SELECT LOWER(HEX(sha256)) AS sha256,size_bytes,item_id,user_id,session_id,state FROM blob_objects WHERE blob_id=? FOR SHARE", [item.outputRef]);
          if (rows.length !== 1 || rows[0]?.sha256 !== result.payloadSha256 || Number(rows[0]?.size_bytes) !== result.payloadBytes || rows[0]?.item_id !== item.id || rows[0]?.session_id !== original.sessionId || rows[0]?.user_id !== original.principal.userId || rows[0]?.state !== "ready"
            || !(admitted.batch.blobBindings ?? []).some(b => b.blobId === item.outputRef && b.itemId === item.id && b.purpose === "tool_output")) fail();
        }
      }
      for (const stage of stages) await persist(conn, stage.before, stage.after);
    } };
  }
  private async intentOperation<T>(access: W.TenantWebhookAccess, intentId: string, work: (image: S.TenantWebhookImage, now: number) => T, terminalRead?: (intent: W.TenantWebhookIntent) => T) {
    const authority = W.assertTenantWebhookAccess(access); W.tenantWebhookSha(intentId);
    return this.transaction(async conn => { const [found] = await conn.query<Row[]>("SELECT webhook_id,tenant_id,subject_user_id,session_id,record_json FROM tenant_webhook_intents WHERE intent_id=?", [intentId]);
      const row = found[0]; if (!row || row.tenant_id !== authority.tenantId || authority.mode === "runtime" && row.subject_user_id !== authority.principal!.userId) return null;
      const record = parse<W.TenantWebhookIntent>(row.record_json);
      if (record.intentId !== intentId || record.tenantId !== row.tenant_id || record.sessionId !== row.session_id || record.subject.userId !== row.subject_user_id) fail();
      const readonlyTerminal = terminalRead !== undefined && record.state !== "prepared" && record.state !== "sending";
      if (authority.mode === "runtime" && !readonlyTerminal) await this.authorize(conn, access, { sessionId: record.sessionId, fence: record.fence });
      const [sessions] = await conn.query<Row[]>("SELECT tenant_id,user_id,deleted_at_ms,fence_token FROM sessions WHERE session_id=? AND BINARY session_id=BINARY ? FOR SHARE", [row.session_id, row.session_id]);
      if (sessions.length !== 1 || sessions[0]?.tenant_id !== authority.tenantId || sessions[0]?.user_id !== row.subject_user_id || sessions[0]?.deleted_at_ms !== null
        || authority.mode === "runtime" && !readonlyTerminal && Number(sessions[0]?.fence_token) !== record.fence) throw new W.TenantWebhookLifecycleBlockedError();
      await this.gate(conn, authority, await now(conn)); const before = await readImage(conn, String(row.webhook_id), { intent: intentId }), after = structuredClone(before);
      if (readonlyTerminal) {
        const terminal = before.intents.find(i => i.intentId === intentId);
        if (!terminal || terminal.state === "prepared" || terminal.state === "sending" || !S.webhookSame(terminal, record)) fail();
        // A terminal cold read grants no HTTP dispatch and performs no expiry repair or persistence.
        return terminalRead!(terminal);
      }
      const result = work(after, await now(conn)); S.validateTenantWebhookImage(after); await persist(conn, before, after); return result; });
  }
  getTenantWebhookDelivery(input: Parameters<W.TenantWebhookStore["getTenantWebhookDelivery"]>[0]) { W.tenantWebhookClosed(input, ["access", "intentId"]); return this.intentOperation(input.access, input.intentId, (image, n) => { const at = image.intents.findIndex(i => i.intentId === input.intentId); image.intents[at] = S.settleExpiredWebhookIntent(image.intents[at]!, n); return image.intents[at]!; }, intent => intent); }
  abandonPreparedTenantWebhookDelivery(input: Parameters<W.TenantWebhookStore["abandonPreparedTenantWebhookDelivery"]>[0]) { W.tenantWebhookClosed(input,["access","intentId"]);W.assertTenantWebhookAccess(input.access,"runtime");return this.intentOperation(input.access,input.intentId,(image,n)=>S.abandonPreparedWebhook(image,input.intentId,n)); }
  claimTenantWebhookDelivery(input: Parameters<W.TenantWebhookStore["claimTenantWebhookDelivery"]>[0]) { W.tenantWebhookClosed(input, ["access", "intentId", "timeoutMs"]); W.assertTenantWebhookAccess(input.access, "runtime"); return this.intentOperation(input.access, input.intentId, (image, n) => S.claimWebhook(image, input.intentId, n, input.timeoutMs)); }
  async finishTenantWebhookDelivery(input: Parameters<W.TenantWebhookStore["finishTenantWebhookDelivery"]>[0]) { W.tenantWebhookClosed(input, ["access", "intentId", "claimToken", "outcome", "resultSha256"]); W.assertTenantWebhookAccess(input.access, "runtime"); const result = await this.intentOperation(input.access, input.intentId, (image, n) => S.finishWebhook(image, input, n)); if (!result) throw new W.TenantWebhookConflictError(); return result; }
  async listTenantWebhookDeliveries(input: Parameters<W.TenantWebhookStore["listTenantWebhookDeliveries"]>[0]) {
    W.tenantWebhookClosed(input, ["access", "name", "cursor", "limit"]); this.page(input.cursor, input.limit); const authority = W.assertTenantWebhookAccess(input.access, "admin"), id = W.tenantWebhookId(authority.tenantId, input.name);
    return this.transaction(async conn => { await this.gate(conn, authority, await now(conn)); const [rows] = await conn.query<Row[]>("SELECT record_json FROM tenant_webhook_intents WHERE webhook_id=? AND tenant_id=? AND BINARY tenant_id=BINARY ? AND intent_id>? ORDER BY intent_id LIMIT ?", [id, authority.tenantId, authority.tenantId, input.cursor ?? "", input.limit + 1]);
      const items = rows.slice(0, input.limit).map(r => parse<W.TenantWebhookIntent>(r.record_json)); return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.intentId : null }; });
  }
  async reconcileTenantWebhookDeliveries(input: Parameters<W.TenantWebhookStore["reconcileTenantWebhookDeliveries"]>[0]) {
    W.tenantWebhookClosed(input, ["cursor", "limit"]); this.page(input.cursor, input.limit);
    return this.transaction(async conn => { const [rows] = await conn.query<Row[]>("SELECT intent_id,record_json FROM tenant_webhook_intents WHERE state IN ('prepared','sending') AND intent_id>? ORDER BY intent_id LIMIT ? FOR UPDATE", [input.cursor ?? "", input.limit + 1]); let changed = 0; const n = await now(conn);
      for (const row of rows.slice(0, input.limit)) { const old = parse<W.TenantWebhookIntent>(row.record_json), next = S.settleExpiredWebhookIntent(old, n); if (!S.webhookSame(old, next)) { await conn.query("UPDATE tenant_webhook_intents SET state=?,record_json=? WHERE intent_id=?", [next.state, json(next), row.intent_id]); changed++; } }
      return { changed, nextCursor: rows.length > input.limit ? String(rows[input.limit - 1]!.intent_id) : null }; });
  }
  async assertTenantWebhookRuntimeGate(enabled: boolean) { if (typeof enabled !== "boolean") fail(); if (enabled) return; const conn = await this.pool.getConnection(); try { const [rows] = await conn.query<Row[]>("SELECT webhook_id FROM tenant_webhook_slots WHERE state='enabled' LIMIT 1"); if (rows.length) fail(); } finally { conn.release(); } }
  private async lockConfiguration(conn: PoolConnection, tenantId: string) {
    const [rows] = await conn.query<Row[]>("SELECT tenant_id FROM tenants WHERE tenant_id=? AND BINARY tenant_id=BINARY ? FOR UPDATE", [tenantId,tenantId]); if (rows.length !== 1) fail();
  }
  private async assertActiveLimit(conn: PoolConnection, tenantId: string, replacing: string) {
    const [rows] = await conn.query<Row[]>("SELECT webhook_id FROM tenant_webhook_slots WHERE tenant_id=? AND BINARY tenant_id=BINARY ? AND state='enabled' AND webhook_id<>? LIMIT 8 FOR SHARE", [tenantId,tenantId,replacing]);
    if (rows.length >= 8) throw new W.TenantWebhookConflictError();
  }
  private page(cursor: string | null, limit: number) { if (cursor !== null) W.tenantWebhookSha(cursor); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(); }
}

export async function assertMysqlTenantWebhookProjection(conn: PoolConnection) {
  const [slots] = await conn.query<Row[]>("SELECT webhook_id,record_json FROM tenant_webhook_slots ORDER BY webhook_id");
  if (slots.some(row => row.record_json === null)) fail();
  for (const row of slots) await readImage(conn, String(row.webhook_id), {}, false);
  for (const [table, key, property] of [["tenant_webhook_intents", "intent_id", "intentId"], ["tenant_webhook_snapshots", "snapshot_id", "snapshotId"]] as const) {
    let cursor = ""; for (;;) { const [rows] = await conn.query<Row[]>(`SELECT ${key},webhook_id,record_json FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT 100`, [cursor]); if (!rows.length) break;
      for (const row of rows) { const record = parse<W.TenantWebhookIntent | W.TenantWebhookInvocationSnapshot>(row.record_json); if ((record as unknown as Record<string, unknown>)[property] !== row[key] || record.webhookId !== row.webhook_id) fail();
        const image = await readImage(conn, record.webhookId, { call: record.callItemId }, false); if (!image.slot) fail();
        const [source] = await conn.query<Row[]>(`SELECT s.tenant_id,s.user_id,s.last_seq,c.body,c.seq FROM sessions s JOIN turns t ON t.turn_id=? AND t.session_id=s.session_id AND BINARY t.turn_id=BINARY ? AND BINARY t.session_id=BINARY s.session_id JOIN items c ON c.item_id=? AND c.session_id=s.session_id AND c.turn_id=t.turn_id AND BINARY c.item_id=BINARY ? AND BINARY c.session_id=BINARY s.session_id AND BINARY c.turn_id=BINARY t.turn_id AND c.type='toolCall' WHERE s.session_id=? AND BINARY s.session_id=BINARY ?`, [record.turnId,record.turnId,record.callItemId,record.callItemId,record.sessionId,record.sessionId]);
        if (source.length !== 1 || source[0]?.tenant_id !== record.subject.tenantId || source[0]?.user_id !== record.subject.userId
          || Number(source[0]?.seq) > record.throughSeq || record.throughSeq > Number(source[0]?.last_seq)) fail();
        const call = parse<Item>(source[0]!.body); if (call.type !== "toolCall" || call.toolCallId !== record.toolCallId) fail();
        const phase = "phase" in record ? record.phase : "postToolUse", kind = "phase" in record ? (phase === "preToolUse" ? "pre" : "post") : "started";
        const [markers] = await conn.query<Row[]>("SELECT record_json FROM tenant_webhook_milestones WHERE webhook_id=? AND call_item_id=? AND kind=? AND BINARY webhook_id=BINARY ? AND BINARY call_item_id=BINARY ?", [record.webhookId,record.callItemId,kind,record.webhookId,record.callItemId]);
        if (markers.length !== 1) fail(); const marker = parse<Record<string,unknown>>(markers[0]!.record_json);
        if (marker.configVersionId !== record.configVersionId || marker.sessionId !== record.sessionId || marker.turnId !== record.turnId || !S.webhookSame(marker.subject,record.subject)) fail();
        if (!("phase" in record) && (call.startedAtMs === undefined || marker.sourceSha256 !== record.sourceSha256 || marker.throughSeq !== record.throughSeq || marker.registrationRevision !== record.registrationRevision || marker.fence !== record.fence)) fail();
        if ("phase" in record && record.phase === "postToolUse") {
          const snapshot = image.snapshots.find(s => s.configVersionId === record.configVersionId && s.callItemId === record.callItemId);
          if (!snapshot || snapshot.sourceSha256 !== record.sourceSha256 || snapshot.throughSeq !== record.throughSeq || snapshot.registrationRevision !== record.registrationRevision || !record.resultItemId) fail();
          const [results] = await conn.query<Row[]>("SELECT body FROM items WHERE item_id=? AND session_id=? AND turn_id=? AND BINARY item_id=BINARY ? AND BINARY session_id=BINARY ? AND BINARY turn_id=BINARY ? AND type='toolResult'", [record.resultItemId,record.sessionId,record.turnId,record.resultItemId,record.sessionId,record.turnId]);
          if (results.length !== 1) fail(); const result = parse<Item>(results[0]!.body); if (result.type !== "toolResult" || result.toolCallId !== call.toolCallId || result.name !== call.name) fail();
        }
      }
      cursor = String(rows.at(-1)![key]); }
  }
}
