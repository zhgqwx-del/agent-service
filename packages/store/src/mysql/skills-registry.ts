import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import * as Skills from "../skills.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SKILL_REGISTRY_MIGRATION = "0060_skill_registry.sql";
export const SKILL_REGISTRY_TABLES = ["skill_registry_owners", "skill_registry_slots", "skill_registry_installations", "skill_registry_versions", "skill_registry_deletions"] as const;
export const SKILL_REGISTRY_TRIGGERS = [...SKILL_REGISTRY_TABLES.flatMap(table => ["bi", "bu", "bd"].map(suffix => `trg_${table}_${suffix}`)), "trg_skill_registry_t3d_bu", "trg_skill_registry_t3f_bu", "trg_skill_registry_slots_gate_bi", "trg_skill_registry_slots_gate_bu", "trg_skill_registry_versions_gate_bi"];
export function skillRegistryFingerprintStatement(sql: string, kind: "schema" | "triggers"): string {
  const start = `-- agent-service-runtime-fingerprint:skill-registry-${kind}:start`, end = `-- agent-service-runtime-fingerprint:skill-registry-${kind}:end`;
  const a = sql.indexOf(start), b = sql.indexOf(end);
  if (a < 0 || b <= a || sql.indexOf(start, a + start.length) >= 0 || sql.indexOf(end, b + end.length) >= 0) fail();
  const statements = sql.slice(a + start.length, b).replace(/^\s*--.*$/gm, "").split(/;\s*\n/).map(x => x.trim()).filter(Boolean);
  const statement = statements[0], roots = statement?.match(/'[0-9a-f]{64}'/g) ?? [];
  if (statements.length !== 1 || !statement?.startsWith(`SET @skill_registry_${kind}_ok=`) || statement.includes(";") ||
    roots.length !== (kind === "schema" ? 7 : 1) || roots.some(x => x === `'${"0".repeat(64)}'`)) fail();
  return statement;
}
export async function assertMysqlSkillRegistryFingerprint(conn: PoolConnection, directory: string) {
  const sql = await readFile(join(directory, SKILL_REGISTRY_MIGRATION), "utf8");
  const statements = [skillRegistryFingerprintStatement(sql, "schema"), skillRegistryFingerprintStatement(sql, "triggers")];
  await conn.query("SET @skill_registry_previous_gcml=@@SESSION.group_concat_max_len");
  try {
    await conn.query("SET SESSION group_concat_max_len=1048576");
    for (const statement of statements) await conn.query(statement);
    const [rows] = await conn.query<Row[]>("SELECT @skill_registry_schema_ok AS schema_ok,@skill_registry_triggers_ok AS triggers_ok");
    if (Number(rows[0]?.schema_ok) !== 1 || Number(rows[0]?.triggers_ok) !== 1) fail();
  } finally { await conn.query("SET SESSION group_concat_max_len=@skill_registry_previous_gcml"); }
}

type Row = RowDataPacket & Record<string, unknown>;
const ownerHash = (owner: Skills.SkillOwner) => Skills.skillRegistryDigest("skill-registry-owner-v1", owner);
function fail(): never { throw new Skills.SkillRegistryIntegrityError(); }
function parse(value: unknown): unknown {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return fail(); }
}
export type SkillRegistryGate = (conn: PoolConnection, principal: Skills.SkillRegistryPrincipal, owner: Skills.SkillOwner, now: number, authority: "user_self" | "tenant_admin" | "platform_operator") => Promise<void>;

/** A bounded, current locking image. The owner control serializes missing-key/CAS races. */
export async function readMysqlSkillRegistryImage(conn: PoolConnection, owner: Skills.SkillOwner, lock = false): Promise<Skills.SkillRegistryImage> {
  const ownerSha = ownerHash(owner), suffix = lock ? " FOR UPDATE" : "";
  const [controls] = await conn.query<Row[]>(`SELECT owner_json FROM skill_registry_owners WHERE owner_sha256=?${suffix}`, [ownerSha]);
  if (controls.length > 1 || controls[0] && Skills.skillOwnerKey(parse(controls[0].owner_json) as Skills.SkillOwner) !== Skills.skillOwnerKey(owner)) fail();
  const image = Skills.emptySkillRegistryImage();
  // With no owner, FK-protected child rows cannot exist. A missing-owner read
  // linearizes here and must not continue into an independently newer child view.
  if (!controls[0]) return image;
  for (const [table, field, order] of [
    ["skill_registry_slots", "slots", "slot_id"], ["skill_registry_installations", "installations", "installation_id"],
    ["skill_registry_versions", "versions", "version_id"], ["skill_registry_deletions", "deletions", "idempotency_key_sha256"],
  ] as const) {
    const index = table === "skill_registry_versions" ? " FORCE INDEX (idx_skill_version_owner_list)" : "";
    const [rows] = await conn.query<Row[]>(`SELECT * FROM ${table}${index} WHERE owner_sha256=? ORDER BY ${order} LIMIT 32769${suffix}`, [ownerSha]);
    if (rows.length > 32768 || rows.length && !controls[0]) fail();
    const records = rows.map(row => {
      const record = parse(row.record_json) as Record<string, unknown>;
      if (!record || typeof record !== "object" || row.owner_sha256 !== ownerSha) fail();
      const source = field === "deletions" ? record.slot as Record<string, unknown> : record;
      const pairs = field === "slots" ? [["slot_id","slotId"],["name","name"],["revision","revision"],["generation","generation"],["state","state"],["current_version_id","currentVersionId"],["created_at_ms","createdAtMs"],["updated_at_ms","updatedAtMs"]]
        : field === "installations" ? [["installation_id","installationId"],["slot_id","slotId"],["revision","revision"],["generation","generation"],["state","state"],["version_id","versionId"],["idempotency_key_sha256","idempotencyKeySha256"],["request_sha256","requestSha256"]]
        : field === "versions" ? [["version_id","versionId"],["slot_id","slotId"],["revision","revision"],["generation","generation"],["installation_id","installationId"],["version_sha256","versionSha256"]]
        : [["slot_id","slotId"],["revision","revision"]];
      for (const [column, key] of pairs) {
        const expected = source?.[key!], actual = row[column!];
        if (typeof expected === "number" ? Number(actual) !== expected : actual !== expected) fail();
      }
      if (field === "deletions" && (row.idempotency_key_sha256 !== record.idempotencyKeySha256 || row.request_sha256 !== record.requestSha256)) fail();
      return record;
    });
    Object.assign(image, { [field]: records });
  }
  Skills.assertSkillRegistryImage(image, owner); return image;
}

async function persist(conn: PoolConnection, owner: Skills.SkillOwner, before: Skills.SkillRegistryImage, after: Skills.SkillRegistryImage) {
  const o = ownerHash(owner);
  // Versions precede ready-manifest and current-slot transitions; every intermediate
  // SQL statement remains inside this transaction and has a matching native guard.
  for (const row of after.slots) if (!before.slots.some(x => x.slotId === row.slotId)) {
    await conn.query("INSERT INTO skill_registry_slots (slot_id,owner_sha256,name,revision,generation,state,current_version_id,created_at_ms,updated_at_ms,record_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [row.slotId,o,row.name,row.revision,row.generation,row.state,row.currentVersionId,row.createdAtMs,row.updatedAtMs,JSON.stringify(row)]);
  }
  for (const row of after.slots) {
    const old = before.slots.find(x => x.slotId === row.slotId);
    if (old && row.revision !== old.revision && row.state === "active") {
      await conn.query("UPDATE skill_registry_slots SET revision=?,generation=?,state=?,current_version_id=?,updated_at_ms=?,record_json=? WHERE slot_id=? AND revision=?",
        [row.revision,row.generation,row.state,row.currentVersionId,row.updatedAtMs,JSON.stringify(row),row.slotId,old.revision]);
    }
  }
  for (const row of after.installations) if (!before.installations.some(x => x.installationId === row.installationId)) {
    await conn.query("INSERT INTO skill_registry_installations (installation_id,owner_sha256,slot_id,revision,generation,state,version_id,idempotency_key_sha256,request_sha256,record_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [row.installationId,o,row.slotId,row.revision,row.generation,row.state,row.versionId,row.idempotencyKeySha256,row.requestSha256,JSON.stringify(row)]);
  }
  for (const row of after.versions) if (!before.versions.some(x => x.versionId === row.versionId)) {
    await conn.query("INSERT INTO skill_registry_versions (version_id,owner_sha256,slot_id,revision,generation,installation_id,version_sha256,record_json) VALUES (?,?,?,?,?,?,?,?)",
      [row.versionId,o,row.slotId,row.revision,row.generation,row.installationId,row.versionSha256,JSON.stringify(row)]);
  }
  for (const row of after.installations) {
    const old = before.installations.find(x => x.installationId === row.installationId);
    if (old && old.state !== row.state) await conn.query("UPDATE skill_registry_installations SET state=?,version_id=?,record_json=? WHERE installation_id=? AND state='staging'",
      [row.state,row.versionId,JSON.stringify(row),row.installationId]);
  }
  for (const row of after.slots) {
    const old = before.slots.find(x => x.slotId === row.slotId);
    if (old && !(row.revision !== old.revision && row.state === "active") && JSON.stringify(old) !== JSON.stringify(row)) {
      await conn.query("UPDATE skill_registry_slots SET revision=?,generation=?,state=?,current_version_id=?,updated_at_ms=?,record_json=? WHERE slot_id=? AND revision=?",
        [row.revision,row.generation,row.state,row.currentVersionId,row.updatedAtMs,JSON.stringify(row),row.slotId,old.revision]);
    }
  }
  for (const row of after.deletions) if (!before.deletions.some(x => x.idempotencyKeySha256 === row.idempotencyKeySha256)) {
    await conn.query("INSERT INTO skill_registry_deletions (owner_sha256,idempotency_key_sha256,slot_id,revision,request_sha256,record_json) VALUES (?,?,?,?,?,?)",
      [o,row.idempotencyKeySha256,row.slot.slotId,row.slot.revision,row.requestSha256,JSON.stringify(row)]);
  }
}

export class MysqlSkillRegistry implements Skills.SkillRegistryStore {
  constructor(private readonly pool: Pool, private readonly gate: SkillRegistryGate) {}
  private async operation<T, I extends Skills.SkillRegistryOwnerInput>(input: I, fields: readonly string[], mutate: boolean,
    work: (image: Skills.SkillRegistryImage, staged: I, now: number) => T): Promise<T> {
    const checked = Skills.skillRegistryInput(input, fields, mutate);
    if ("admission" in checked.input && "name" in checked.input) Skills.assertSkillPackageAdmission(checked.input.admission as Skills.SkillPackageAdmission, checked.input.owner, checked.input.name as string);
    const conn = await this.pool.getConnection();
    try {
      // This new domain alone uses RC: exact owner-control X serializes every
      // accepted read/write while RC avoids unrelated owners' empty-range gaps.
      // No old lifecycle/capture transaction isolation is changed.
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"); await conn.beginTransaction();
      const [time] = await conn.query<Row[]>("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms");
      const gateNow = Number(time[0]?.now_ms); if (!Number.isSafeInteger(gateNow) || gateNow < 0) fail();
      await this.gate(conn, checked.principal, checked.input.owner, gateNow, checked.authority);
      if (mutate) await conn.query("INSERT INTO skill_registry_owners (owner_sha256,owner_json,created_at_ms) VALUES (?,?,?) ON DUPLICATE KEY UPDATE owner_sha256=owner_sha256",
        [ownerHash(checked.input.owner),JSON.stringify(checked.input.owner),gateNow]);
      const before = await readMysqlSkillRegistryImage(conn, checked.input.owner, true), after = structuredClone(before);
      // A contender can wait behind a complete publication. Its earlier gate
      // clock is not the mutation clock; sample again under the exact owner X.
      const [mutationTime] = await conn.query<Row[]>("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms");
      const now = Number(mutationTime[0]?.now_ms); if (!Number.isSafeInteger(now) || now < 0) fail();
      const outbound = structuredClone(work(after, checked.input, now));
      Skills.assertSkillRegistryImage(after, checked.input.owner);
      if (mutate) await persist(conn, checked.input.owner, before, after);
      await conn.commit(); return outbound;
    } catch (error) { await conn.rollback().catch(() => {}); throw error; } finally { conn.release(); }
  }
  prepareSkillInstallation(input: Skills.PrepareSkillInstallationInput) { return this.operation(input,["access","owner","name","expectedRevision","idempotencyKey","admission","backend","storageNamespaceSha256"],true,Skills.prepareSkillRegistryImage); }
  publishSkillInstallation(input: Skills.PublishSkillInstallationInput) { return this.operation(input,["access","owner","installationId","uploadToken","descriptor"],true,Skills.publishSkillRegistryImage); }
  deleteSkillSlot(input: Skills.DeleteSkillSlotInput) { return this.operation(input,["access","owner","name","expectedRevision","idempotencyKey"],true,Skills.deleteSkillRegistryImage); }
  listSkillSlots(input: Skills.ListSkillSlotsInput) { return this.operation(input,["access","owner","limit","cursor"],false,Skills.listSkillRegistryImage); }
  listSkillVersions(input: Skills.ListSkillVersionsInput) { return this.operation(input,["access","owner","name","limit","cursor"],false,Skills.listSkillRegistryVersions); }
  getSkillSlot(input: Skills.GetSkillSlotInput) { return this.operation(input,["access","owner","name"],false,(image,staged) => image.slots.find(x => x.slotId === Skills.skillSlotId(staged.owner,staged.name)) ?? null); }
  getReadableSkillVersion(input: Skills.GetReadableSkillVersionInput) { return this.operation(input,["access","owner","name","versionId"],false,Skills.readSkillRegistryImage); }
  async listUserSkillExportSnapshot(input: Skills.SkillRegistryOwnerInput) { Skills.assertSkillExportOwner(input); return this.operation(input,["access","owner"],false,(image,staged)=>Skills.exportSkillRegistryImage(image,staged.owner)); }
}

/** Startup scans all physical owner rows; orphan/foreign JSON cannot disappear behind a filter. */
export async function assertMysqlSkillRegistryProjection(conn: PoolConnection): Promise<void> {
  const [owners] = await conn.query<Row[]>("SELECT owner_sha256,owner_json FROM skill_registry_owners ORDER BY owner_sha256");
  for (const row of owners) {
    const owner = parse(row.owner_json); Skills.validateSkillOwner(owner);
    if (row.owner_sha256 !== ownerHash(owner)) fail();
    await readMysqlSkillRegistryImage(conn, owner);
  }
  for (const table of ["skill_registry_slots","skill_registry_installations","skill_registry_versions","skill_registry_deletions"]) {
    const [orphan] = await conn.query<Row[]>(`SELECT COUNT(*) AS n FROM ${table} r LEFT JOIN skill_registry_owners o ON BINARY o.owner_sha256=BINARY r.owner_sha256 WHERE o.owner_sha256 IS NULL`);
    if (Number(orphan[0]?.n) !== 0) fail();
  }
}
