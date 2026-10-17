import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import * as M from "../mcp-registry.js";

export const MCP_REGISTRY_MIGRATION = "0062_mcp_registry.sql";
export const MCP_REGISTRY_TABLES = ["mcp_registry_controls", "mcp_registry_versions", "mcp_registry_authorizations", "mcp_registry_pending", "mcp_registry_operations", "mcp_registry_credentials", "mcp_registry_materials", "mcp_registry_replays"] as const;
export const MCP_REGISTRY_TRIGGERS = [...MCP_REGISTRY_TABLES.flatMap(t => ["bi", "bu", "bd"].map(s => `trg_${t}_${s}`)), "trg_mcp_registry_t3a_bu", "trg_mcp_registry_t3d_bu", "trg_mcp_registry_t3f_bu", "trg_mcp_registry_controls_gate_bu", "trg_mcp_registry_versions_gate_bi", "trg_mcp_registry_operations_gate_bi", "trg_mcp_registry_credentials_gate_bi", "trg_mcp_registry_authorizations_gate_bu"];
export function mcpRegistryFingerprintStatement(sql: string): string {
  const start = "-- agent-service-runtime-fingerprint:mcp-registry:start", end = "-- agent-service-runtime-fingerprint:mcp-registry:end";
  const a = sql.indexOf(start), b = sql.indexOf(end);
  if (a < 0 || b <= a || sql.indexOf(start, a + 1) >= 0 || sql.indexOf(end, b + 1) >= 0) fail();
  const statements = sql.slice(a + start.length, b).replace(/^\s*--.*$/gm, "").split(/;\s*\n/).map(x => x.trim()).filter(Boolean), statement = statements[0];
  const roots = statement?.match(/'[a-f0-9]{64}'/g) ?? [];
  if (statements.length !== 1 || !statement?.startsWith("SET @skill_registry_triggers_ok=") || statement.includes(";") || roots.length !== 1 || roots[0] === `'${"0".repeat(64)}'`) fail();
  return statement;
}
export async function assertMysqlMcpRegistryFingerprint(conn: PoolConnection, directory: string): Promise<void> {
  const sql = mcpRegistryFingerprintStatement(await readFile(join(directory, MCP_REGISTRY_MIGRATION), "utf8"));
  await conn.query("SET @mcp_registry_previous_gcml=@@SESSION.group_concat_max_len");
  try { await conn.query("SET SESSION group_concat_max_len=1048576"); await conn.query(sql);
    const [rows] = await conn.query<Row[]>("SELECT @skill_registry_triggers_ok AS ok"); if (Number(rows[0]?.ok) !== 1) fail();
  } finally { await conn.query("SET SESSION group_concat_max_len=@mcp_registry_previous_gcml"); }
}
type Row = RowDataPacket & Record<string, unknown>;
function fail(): never { throw new M.McpRegistryIntegrityError(); }
function parse<T>(value: unknown): T { try { return (typeof value === "string" ? JSON.parse(value) : value) as T; } catch { return fail(); } }
const ownerSha = (owner: M.McpRegistrationOwner) => M.mcpRegistryDigest("mcp-registration-owner-v1", owner);
const json = (value: unknown) => JSON.stringify(value);
const same = (a: unknown, b: unknown) => M.mcpRegistryDigest("mcp-row-comparison-v1", a) === M.mcpRegistryDigest("mcp-row-comparison-v1", b);
const CHILDREN = [
  ["mcp_registry_versions", "versions", "config_version_id", "configVersionId"],
  ["mcp_registry_authorizations", "authorizations", "authorization_key", "authorizationKey"],
  ["mcp_registry_pending", "pending", "authorization_id", "authorizationId"],
  ["mcp_registry_operations", "operations", "operation_id", "operationId"],
  ["mcp_registry_credentials", "credentials", "credential_version_id", "credentialVersionId"],
  ["mcp_registry_materials", "materials", "material_id", "materialId"],
  ["mcp_registry_replays", "replays", "key_sha256", "keySha256"],
] as const;
export type McpRegistryGate = (conn: PoolConnection, context: M.McpRegistryGateContext, now: number) => Promise<void>;
export async function readMysqlMcpRegistryImage(conn: PoolConnection, owner: M.McpRegistrationOwner, name: string, lock = true, subject: M.McpCredentialSubject | null = null, auditEpoch: number | null = null): Promise<M.McpRegistryImage> {
  const registrationId = M.mcpRegistrationId(owner, name), suffix = lock ? " FOR UPDATE" : "", shared = lock ? " FOR SHARE" : "";
  const [control] = await conn.query<Row[]>(`SELECT owner_json,owner_tenant_id,owner_user_id,name,record_json FROM mcp_registry_controls WHERE registration_id=?${subject ? shared : suffix}`, [registrationId]);
  const image = M.emptyMcpRegistryImage(); if (!control.length) return image;
  if (control.length !== 1 || !same(parse(control[0]!.owner_json), owner) || control[0]!.name !== name || control[0]!.owner_tenant_id !== owner.tenantId || control[0]!.owner_user_id !== owner.userId) fail();
  image.slot = parse<M.McpRegistrationSlot | null>(control[0]!.record_json);
  let epoch: number | null = null;
  if (subject) {
    const [rows] = await conn.query<Row[]>(`SELECT authorization_key,registration_id,subject_tenant_id,subject_user_id,record_json FROM mcp_registry_authorizations WHERE registration_id=? AND subject_tenant_id=? AND subject_user_id=? AND BINARY subject_tenant_id=BINARY ? AND BINARY subject_user_id=BINARY ?${suffix}`, [registrationId, subject.tenantId, subject.userId, subject.tenantId, subject.userId]);
    if (rows.length > 1) fail(); if (rows[0]) { const row = rows[0], auth = parse<M.McpUserAuthorization>(row.record_json);
      if (row.authorization_key !== auth.authorizationKey || row.registration_id !== registrationId || row.subject_tenant_id !== subject.tenantId || row.subject_user_id !== subject.userId || !same(auth.subject, subject)) fail();
      epoch = auth.authorizationEpoch; image.authorizations = [auth]; }
  }
  if (auditEpoch !== null && (lock || !subject || !Number.isSafeInteger(auditEpoch) || auditEpoch < 1 || epoch === null || auditEpoch > epoch)) fail();
  const epochs = [...new Set([epoch ?? 0, ...(auditEpoch === null ? [] : [auditEpoch])])];
  for (const [table, field, key] of CHILDREN) {
    if (subject && field === "authorizations") continue;
    if (!subject && !["versions", "materials", "replays"].includes(field)) continue;
    if (subject && epoch === null && !["versions", "materials"].includes(field)) continue;
    const extra = field === "pending" ? ",state_sha256" : field === "operations" ? ",authorization_key,authorization_epoch,predecessor_token_revision" : "";
    let where = "registration_id=?", parameters: unknown[] = [registrationId], index = "", rowLock = suffix;
    if (field === "versions") {
      rowLock = subject ? shared : suffix;
      if (subject) { where += " AND config_version_id IN (?,?)"; parameters.push(image.slot?.currentVersionId ?? "", image.authorizations[0]?.configVersionId ?? ""); }
      else { where += " AND config_generation=?"; parameters.push(image.slot?.generation ?? 1); }
    } else if (field === "materials") {
      // An archived epoch may refer to another immutable configuration. Load
      // those exact IDs, not every user's history or every configuration row.
      const missing = [...new Set([...image.pending, ...image.operations, ...image.credentials].map(r => r.configVersionId))].filter(id => !image.versions.some(v => v.configVersionId === id));
      if (missing.length) {
        const [versions] = await conn.query<Row[]>(`SELECT config_version_id,registration_id,subject_tenant_id,subject_user_id,record_json FROM mcp_registry_versions WHERE registration_id=? AND config_version_id IN (${missing.map(()=>"?").join(",")})${shared}`, [registrationId, ...missing]);
        if (versions.length !== missing.length) fail();
        for (const row of versions) { const v = parse<M.McpRegistrationVersion>(row.record_json); if (row.config_version_id !== v.configVersionId || row.registration_id !== registrationId || row.subject_tenant_id !== null || row.subject_user_id !== null) fail(); image.versions.push(v); }
      }
      index = " FORCE INDEX (idx_mcp_materials_subject)";
      if (!subject) { const ids = image.versions.map(v => v.configVersionId); where += ` AND subject_tenant_id IS NULL AND subject_user_id IS NULL AND material_id IN (${ids.length ? ids.map(()=>"?").join(",") : "NULL"})`; parameters.push(...ids); }
      else { where += ` AND subject_tenant_id=? AND subject_user_id=? AND BINARY subject_tenant_id=BINARY ? AND BINARY subject_user_id=BINARY ? AND authorization_epoch IN (${epochs.map(()=>"?").join(",")})`; parameters.push(subject.tenantId, subject.userId, subject.tenantId, subject.userId, ...epochs); }
    } else if (field === "replays") {
      index = " FORCE INDEX (idx_mcp_replays_subject)";
      where += ` AND subject_tenant_id <=> ? AND subject_user_id <=> ? AND (BINARY subject_tenant_id <=> BINARY ?) AND (BINARY subject_user_id <=> BINARY ?) AND authorization_epoch IN (${epochs.map(()=>"?").join(",")})`;
      parameters.push(subject?.tenantId ?? null, subject?.userId ?? null, subject?.tenantId ?? null, subject?.userId ?? null, ...epochs);
      if (!subject) { where += " AND JSON_EXTRACT(record_json,'$.result.generation')=?"; parameters.push(image.slot?.generation ?? 1); }
    } else {
      index = ` FORCE INDEX (idx_mcp_${field}_subject)`;
      where += ` AND subject_tenant_id=? AND subject_user_id=? AND BINARY subject_tenant_id=BINARY ? AND BINARY subject_user_id=BINARY ? AND authorization_epoch IN (${epochs.map(()=>"?").join(",")})`; parameters.push(subject!.tenantId, subject!.userId, subject!.tenantId, subject!.userId, ...epochs);
    }
    const limit = field === "materials" && auditEpoch !== null ? M.MCP_REGISTRY_HISTORICAL_MATERIAL_LIMIT : 8192;
    const [rows] = await conn.query<Row[]>(`SELECT ${key},registration_id,subject_tenant_id,subject_user_id,record_json${extra} FROM ${table}${index} WHERE ${where} ORDER BY ${key} LIMIT ${limit + 1}${rowLock}`, parameters);
    if (rows.length > limit) fail();
    if (subject && field === "materials") {
      const ids = image.versions.map(v => v.configVersionId);
      if (ids.length) { const [client] = await conn.query<Row[]>(`SELECT ${key},registration_id,subject_tenant_id,subject_user_id,record_json FROM ${table} WHERE material_id IN (${ids.map(()=>"?").join(",")}) AND registration_id=? AND subject_tenant_id IS NULL AND subject_user_id IS NULL${shared}`, [...ids, registrationId]); rows.push(...client); }
    }
    const records = rows.map(row => parse<Record<string, unknown>>(row.record_json));
    for (let index = 0; index < rows.length; index++) {
      const column = CHILDREN.find(c => c[0] === table)![3]; if (records[index]![column] !== rows[index]![key] || rows[index]!.registration_id !== registrationId) fail();
      const record = records[index]!, rowSubject = storedSubject(record);
      if (rows[index]!.subject_tenant_id !== (rowSubject?.tenantId ?? null) || rows[index]!.subject_user_id !== (rowSubject?.userId ?? null) || field === "pending" && rows[index]!.state_sha256 !== record.stateSha256) fail();
      if (field === "operations" && (rows[index]!.authorization_key !== record.authorizationKey || Number(rows[index]!.authorization_epoch) !== record.authorizationEpoch || Number(rows[index]!.predecessor_token_revision) !== record.predecessorTokenRevision)) fail();
    }
    // Each branch is a closed physical family, not caller-selected table or arbitrary JSON.
    if (field === "versions") image.versions = records as unknown as M.McpRegistrationVersion[];
    else if (field === "authorizations") image.authorizations = records as unknown as M.McpUserAuthorization[];
    else if (field === "pending") image.pending = records as unknown as M.McpPendingAuthorization[];
    else if (field === "operations") image.operations = records as unknown as M.McpCredentialOperation[];
    else if (field === "credentials") image.credentials = records as unknown as M.McpCredentialVersion[];
    else if (field === "materials") image.materials = records as unknown as M.McpStoredMaterial[];
    else image.replays = records as unknown as M.McpRegistryReplay[];
  }
  if (auditEpoch === null) M.assertMcpRegistryImage(image, owner, name);
  else M.assertMcpRegistryHistoricalEpochImage(image, owner, name, auditEpoch);
  return image;
}
function storedSubject(record: Record<string, unknown>): M.McpCredentialSubject | null {
  if ("subject" in record) return record.subject as M.McpCredentialSubject;
  if ("aad" in record) return (record.aad as M.McpSecretAad).subject;
  if ("result" in record && record.result && typeof record.result === "object" && "subject" in record.result) return (record.result as M.McpUserAuthorization).subject;
  return null;
}
async function persist(conn: PoolConnection, before: M.McpRegistryImage, after: M.McpRegistryImage) {
  const slot = after.slot; if (!slot) fail(); const registrationId = slot.registrationId;
  // A new auth epoch is visible before its pending row; a token pointer is only
  // published after the exact pending operation and immutable credential exist.
  for (const row of after.authorizations) {
    const old = before.authorizations.find(a => a.authorizationKey === row.authorizationKey);
    if (old && old.authorizationEpoch !== row.authorizationEpoch) await conn.query("UPDATE mcp_registry_authorizations SET record_json=? WHERE authorization_key=? AND registration_id=?", [json(row), row.authorizationKey, registrationId]);
  }
  for (const [table, field, key, property] of CHILDREN) {
    if (field === "replays") continue;
    for (const row of after[field]) {
      const record = row as unknown as Record<string, unknown>, pk = record[property];
      const previous = before[field].find(r => (r as unknown as Record<string, unknown>)[property] === pk);
      if (previous && same(previous, row)) continue;
      const subject = storedSubject(record);
      if (!previous) {
        const extra = field === "pending" ? ",state_sha256" : field === "operations" ? ",authorization_key,authorization_epoch,predecessor_token_revision" : "";
        const placeholder = field === "pending" ? ",?" : field === "operations" ? ",?,?,?" : "";
        const values: unknown[] = [pk, registrationId, subject?.tenantId ?? null, subject?.userId ?? null, json(row)];
        if (field === "pending") values.push(record.stateSha256);
        if (field === "operations") values.push(record.authorizationKey, record.authorizationEpoch, record.predecessorTokenRevision);
        await conn.query(`INSERT INTO ${table} (${key},registration_id,subject_tenant_id,subject_user_id,record_json${extra}) VALUES (?,?,?,?,?${placeholder})`, values);
      }
    }
  }
  for (const field of ["pending", "operations", "authorizations", "materials"] as const) {
    const [table, , key, property] = CHILDREN.find(c => c[1] === field)!;
    for (const row of after[field]) {
      const record = row as unknown as Record<string, unknown>, pk = record[property];
      const old = before[field].find(r => (r as unknown as Record<string, unknown>)[property] === pk);
      if (!old || same(old, row) || field === "authorizations" && (old as M.McpUserAuthorization).authorizationEpoch !== (row as M.McpUserAuthorization).authorizationEpoch) continue;
      await conn.query(`UPDATE ${table} SET record_json=? WHERE ${key}=? AND registration_id=?`, [json(row), pk, registrationId]);
    }
  }
  if (!same(before.slot, after.slot)) await conn.query("UPDATE mcp_registry_controls SET record_json=? WHERE registration_id=?", [json(slot), registrationId]);
  // Replay rows seal the already-written exact result in this transaction, not
  // a caller-declared future projection. They are published last.
  for (const row of after.replays) if (!before.replays.some(old => old.keySha256 === row.keySha256)) {
    const subject = storedSubject(row as unknown as Record<string, unknown>);
    await conn.query("INSERT INTO mcp_registry_replays (key_sha256,registration_id,subject_tenant_id,subject_user_id,record_json) VALUES (?,?,?,?,?)",
      [row.keySha256, registrationId, subject?.tenantId ?? null, subject?.userId ?? null, json(row)]);
  }
}
export class MysqlMcpRegistry implements M.McpRegistryStore {
  constructor(private readonly pool: Pool, private readonly gate: McpRegistryGate) {}
  private async operation<I extends M.McpRegistryNameInput,T>(input: I, fields: readonly string[], mode: "manage" | "runtime" | undefined, mutate: boolean, work: (image: M.McpRegistryImage, staged: I, now: number) => T): Promise<T> {
    const checked = M.mcpRegistryInput(input, fields, mode), registrationId = M.mcpRegistrationId(checked.input.owner, checked.input.name);
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"); await conn.beginTransaction();
      const now = async () => { const [rows] = await conn.query<Row[]>("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms"); const n = Number(rows[0]?.now_ms); if (!Number.isSafeInteger(n) || n < 0) fail(); return n; };
      await this.gate(conn, { ...checked, owner: checked.input.owner }, await now());
      if (mutate && checked.mode === "manage") await conn.query("INSERT INTO mcp_registry_controls (registration_id,owner_sha256,owner_json,owner_tenant_id,owner_user_id,name,record_json) VALUES (?,?,?,?,?,?,NULL) ON DUPLICATE KEY UPDATE registration_id=registration_id",
        [registrationId, ownerSha(checked.input.owner), json(checked.input.owner), checked.input.owner.tenantId, checked.input.owner.userId, checked.input.name]);
      const before = await readMysqlMcpRegistryImage(conn, checked.input.owner, checked.input.name, true, checked.mode === "runtime" ? checked.principal : null), after = structuredClone(before);
      const selected = mutate ? M.mcpRegistryMutationReplaySelection(checked.input, fields) : null;
      if (selected) {
        const [rows] = await conn.query<Row[]>("SELECT registration_id,subject_tenant_id,subject_user_id,record_json FROM mcp_registry_replays WHERE key_sha256=? FOR SHARE", [selected.keySha256]);
        if (rows.length > 1) fail(); if (rows[0] && (rows[0].registration_id !== registrationId || rows[0].subject_tenant_id !== (selected.subject?.tenantId ?? null) || rows[0].subject_user_id !== (selected.subject?.userId ?? null))) fail();
        M.assertMcpRegistryReplayHistory(rows[0] ? parse<M.McpRegistryReplay>(rows[0].record_json) : null, selected, before);
      }
      const outbound = structuredClone(work(after, checked.input, await now())); M.assertMcpRegistryImage(after, checked.input.owner, checked.input.name);
      if (mutate) await persist(conn, before, after);
      await conn.commit(); return outbound;
    } catch (error) { await conn.rollback().catch(() => {}); throw error; } finally { conn.release(); }
  }
  upsertMcpRegistration(i: M.UpsertMcpRegistrationInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.upsert,"manage",true,M.upsertMcpRegistryImage); }
  setMcpRegistrationState(i: M.SetMcpRegistrationStateInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.registrationState,"manage",true,M.setMcpRegistrationImageState); }
  getMcpRegistration(i: M.McpRegistryNameInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.name,undefined,false,M.mcpRegistrationView); }
  beginMcpAuthorization(i: M.BeginMcpAuthorizationInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.begin,"runtime",true,M.beginMcpAuthorizationImage); }
  getMcpPendingAuthorization(i: M.McpRegistryNameInput & { idempotencyKey: string }) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.pending,"runtime",false,M.getMcpPendingImage); }
  consumeMcpAuthorization(i: M.ConsumeMcpAuthorizationInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.consume,"runtime",true,M.consumeMcpAuthorizationImage); }
  beginMcpRefresh(i: M.BeginMcpRefreshInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.refresh,"runtime",true,M.beginMcpRefreshImage); }
  finishMcpCredentialOperation(i: M.FinishMcpCredentialOperationInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.finish,"runtime",true,M.finishMcpCredentialOperationImage); }
  getMcpUserAuthorization(i: M.McpRegistryNameInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.name,"runtime",false,M.getMcpUserAuthorizationImage); }
  setMcpUserAuthorizationState(i: M.SetMcpUserAuthorizationStateInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.authorizationState,"runtime",true,M.setMcpUserAuthorizationImageState); }
  getMcpRuntimeAuthorization(i: M.McpRegistryNameInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.name,"runtime",false,M.getMcpRuntimeImage); }
  getMcpAuthorizationContext(i: M.McpRegistryNameInput) { return this.operation(i,M.MCP_REGISTRY_INPUT_FIELDS.name,"runtime",false,M.getMcpAuthorizationContextImage); }
  async listMcpRegistrations(input: M.ListMcpRegistrationsInput): Promise<M.McpRegistrationPage> {
    const checked = M.mcpRegistryInput(input, M.MCP_REGISTRY_INPUT_FIELDS.list), conn = await this.pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"); await conn.beginTransaction();
      const [time] = await conn.query<Row[]>("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms");
      await this.gate(conn, { ...checked, owner: checked.input.owner }, Number(time[0]?.now_ms));
      // Bounded metadata listing linearizes at this statement; runtime use independently rechecks its exact slot.
      M.listMcpRegistrationImages([], checked.input);
      const [rows] = await conn.query<Row[]>("SELECT owner_json,name,record_json FROM mcp_registry_controls WHERE owner_sha256=? AND registration_id>? ORDER BY registration_id LIMIT ?", [ownerSha(input.owner), checked.input.cursor ?? "", checked.input.limit + 1]);
      const slots = rows.map(row => { if (!same(parse(row.owner_json), input.owner)) fail(); const slot = parse<M.McpRegistrationSlot>(row.record_json); if (!slot || slot.registrationId !== M.mcpRegistrationId(input.owner,String(row.name))) fail(); return slot; });
      const result = structuredClone(M.listMcpRegistrationImages(slots, checked.input)); await conn.commit(); return result;
    } catch (error) { await conn.rollback().catch(() => {}); throw error; } finally { conn.release(); }
  }
  async lookupMcpAuthorizationState(stateSha256: string) {
    if (!/^[a-f0-9]{64}$/.test(stateSha256)) fail();
    // Owner-hiding locator only. Current locked operation and lifecycle checks below are the authority.
    const [rows] = await this.pool.query<Row[]>("SELECT c.owner_json,c.name,p.record_json FROM mcp_registry_pending p JOIN mcp_registry_controls c ON c.registration_id=p.registration_id WHERE p.state_sha256=?", [stateSha256]);
    if (!rows.length) return null; if (rows.length !== 1) fail();
    const pending = parse<M.McpPendingAuthorization>(rows[0]!.record_json), owner = parse<M.McpRegistrationOwner>(rows[0]!.owner_json), name = String(rows[0]!.name);
    const access = M.createMcpRegistryAccess({ principal: pending.subject, owner, authority: "user_self", access: "runtime" });
    return this.operation({ access, owner, name }, M.MCP_REGISTRY_INPUT_FIELDS.name, "runtime", false, (image, _input, now) => {
      const p = image.pending.find(p => p.stateSha256 === stateSha256), a = p && image.authorizations.find(a => a.authorizationKey === p.authorizationKey);
      if (!p || p.state !== "pending" || p.expiresAtMs <= now || image.slot?.state !== "enabled" || image.slot.currentVersionId !== p.configVersionId || p.registrationRevision !== image.slot.revision || a?.state !== "pending" || a.authorizationEpoch !== p.authorizationEpoch || a.registrationRevision !== image.slot.revision) return null;
      return { owner, name, subject: p.subject, authorizationId: p.authorizationId };
    });
  }
}
export async function assertMysqlMcpRegistryProjection(conn: PoolConnection): Promise<void> {
  // Startup already owns one read-only consistent snapshot. Page every physical
  // historical family; hot operations only lock their subject/current epoch.
  let cursor = "";
  for (;;) {
    const [controls] = await conn.query<Row[]>("SELECT registration_id,owner_sha256,owner_json,name FROM mcp_registry_controls WHERE registration_id>? ORDER BY registration_id LIMIT 100", [cursor]);
    if (!controls.length) break;
    for (const row of controls) {
      const owner = parse<M.McpRegistrationOwner>(row.owner_json); M.validateMcpRegistrationOwner(owner);
      const registrationId = M.mcpRegistrationId(owner, String(row.name));
      if (row.owner_sha256 !== ownerSha(owner) || row.registration_id !== registrationId) fail();
      const config = await readMysqlMcpRegistryImage(conn, owner, String(row.name), false); if (!config.slot) fail();
      // Old generations and their config-only replay/material are not silently
      // exempted merely because a delete/recreate moved the current frontier.
      let versionCursor = "";
      for (;;) {
        const [versions] = await conn.query<Row[]>("SELECT config_version_id,subject_tenant_id,subject_user_id,record_json FROM mcp_registry_versions WHERE registration_id=? AND config_version_id>? ORDER BY config_version_id LIMIT 100", [registrationId, versionCursor]);
        if (!versions.length) break;
        for (const vrow of versions) {
          const version = parse<M.McpRegistrationVersion>(vrow.record_json);
          if (vrow.config_version_id !== version.configVersionId || vrow.subject_tenant_id !== null || vrow.subject_user_id !== null) fail();
          const image = structuredClone(config); image.versions = image.versions.filter(v => v.configVersionId !== version.configVersionId); image.versions.push(version);
          const [materials] = await conn.query<Row[]>("SELECT subject_tenant_id,subject_user_id,record_json FROM mcp_registry_materials WHERE material_id=? AND registration_id=?", [version.configVersionId, registrationId]);
          if (materials.length > 1) fail(); if (materials[0]) {
            if (materials[0].subject_tenant_id !== null || materials[0].subject_user_id !== null) fail();
            image.materials = image.materials.filter(m => m.materialId !== version.configVersionId); image.materials.push(parse<M.McpStoredMaterial>(materials[0].record_json));
          }
          if (version.clientSecretCommitmentSha256 !== null && !image.materials.some(m => m.materialId === version.configVersionId)) fail();
          M.assertMcpRegistryImage(image, owner, String(row.name));
        }
        versionCursor = String(versions.at(-1)!.config_version_id);
      }
      let replayCursor = "";
      for (;;) {
        const [replays] = await conn.query<Row[]>("SELECT key_sha256,subject_tenant_id,subject_user_id,record_json FROM mcp_registry_replays WHERE registration_id=? AND subject_tenant_id IS NULL AND subject_user_id IS NULL AND key_sha256>? ORDER BY key_sha256 LIMIT 100", [registrationId, replayCursor]);
        if (!replays.length) break;
        for (const r of replays) { const replay = parse<M.McpRegistryReplay>(r.record_json); if (r.key_sha256 !== replay.keySha256 || replay.kind !== "registration") fail(); M.assertMcpRegistryImage({ ...config, replays: [replay] }, owner, String(row.name)); }
        replayCursor = String(replays.at(-1)!.key_sha256);
      }
      let authCursor = "";
      for (;;) {
        const [subjects] = await conn.query<Row[]>("SELECT authorization_key,subject_tenant_id,subject_user_id FROM mcp_registry_authorizations WHERE registration_id=? AND authorization_key>? ORDER BY authorization_key LIMIT 100", [registrationId, authCursor]);
        if (!subjects.length) break;
        for (const a of subjects) {
          const subject = { tenantId: String(a.subject_tenant_id), userId: String(a.subject_user_id) }; M.validateMcpCredentialSubject(subject);
          await readMysqlMcpRegistryImage(conn, owner, String(row.name), false, subject);
          let previousEpoch = 0;
          for (;;) {
            const [epochs] = await conn.query<Row[]>(`SELECT authorization_epoch FROM (
              SELECT authorization_epoch FROM mcp_registry_pending WHERE registration_id=? AND subject_tenant_id=? AND subject_user_id=? AND BINARY subject_tenant_id=BINARY ? AND BINARY subject_user_id=BINARY ?
              UNION SELECT authorization_epoch FROM mcp_registry_operations WHERE registration_id=? AND subject_tenant_id=? AND subject_user_id=? AND BINARY subject_tenant_id=BINARY ? AND BINARY subject_user_id=BINARY ?
              UNION SELECT authorization_epoch FROM mcp_registry_credentials WHERE registration_id=? AND subject_tenant_id=? AND subject_user_id=? AND BINARY subject_tenant_id=BINARY ? AND BINARY subject_user_id=BINARY ?
              UNION SELECT authorization_epoch FROM mcp_registry_materials WHERE registration_id=? AND subject_tenant_id=? AND subject_user_id=? AND BINARY subject_tenant_id=BINARY ? AND BINARY subject_user_id=BINARY ?
              UNION SELECT authorization_epoch FROM mcp_registry_replays WHERE registration_id=? AND subject_tenant_id=? AND subject_user_id=? AND BINARY subject_tenant_id=BINARY ? AND BINARY subject_user_id=BINARY ?
            ) e WHERE authorization_epoch>? ORDER BY authorization_epoch LIMIT 100`, [...Array.from({length:5}, () => [registrationId, subject.tenantId, subject.userId, subject.tenantId, subject.userId]).flat(), previousEpoch]);
            if (!epochs.length) break;
            for (const epoch of epochs) await readMysqlMcpRegistryImage(conn, owner, String(row.name), false, subject, Number(epoch.authorization_epoch));
            previousEpoch = Number(epochs.at(-1)!.authorization_epoch);
          }
        }
        authCursor = String(subjects.at(-1)!.authorization_key);
      }
    }
    cursor = String(controls.at(-1)!.registration_id);
  }
  for (const [table] of CHILDREN) { const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS n FROM ${table} a LEFT JOIN mcp_registry_controls c ON c.registration_id=a.registration_id WHERE c.registration_id IS NULL`); if (Number(rows[0]?.n) !== 0) fail(); }
  for (const table of ["mcp_registry_pending", "mcp_registry_operations", "mcp_registry_credentials", "mcp_registry_materials", "mcp_registry_replays"]) {
    const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS n FROM ${table} c LEFT JOIN mcp_registry_authorizations a ON a.registration_id=c.registration_id AND a.subject_tenant_id=c.subject_tenant_id AND BINARY a.subject_tenant_id=BINARY c.subject_tenant_id AND a.subject_user_id=c.subject_user_id AND BINARY a.subject_user_id=BINARY c.subject_user_id WHERE (c.subject_tenant_id IS NULL)<>(c.subject_user_id IS NULL) OR (c.subject_tenant_id IS NOT NULL AND a.authorization_key IS NULL)`);
    if (Number(rows[0]?.n) !== 0) fail();
  }
  const [unclassified] = await conn.query<Row[]>(`SELECT
    (SELECT COUNT(*) FROM mcp_registry_versions WHERE subject_tenant_id IS NOT NULL OR subject_user_id IS NOT NULL)
    +(SELECT COUNT(*) FROM mcp_registry_materials m LEFT JOIN mcp_registry_versions v ON v.config_version_id=m.material_id AND v.registration_id=m.registration_id WHERE m.subject_tenant_id IS NULL AND (m.subject_user_id IS NOT NULL OR v.config_version_id IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(m.record_json,'$.aad.purpose'))<>'as_client'))
    +(SELECT COUNT(*) FROM mcp_registry_replays WHERE subject_tenant_id IS NULL AND (subject_user_id IS NOT NULL OR JSON_UNQUOTE(JSON_EXTRACT(record_json,'$.kind'))<>'registration')) AS n`);
  if (Number(unclassified[0]?.n) !== 0) fail();
}
