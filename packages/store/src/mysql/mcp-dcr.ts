import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { McpRegistryIntegrityError } from "../mcp-registry.js";

export const MCP_DCR_MIGRATION = "0065_mcp_dcr.sql";
export const MCP_DCR_TABLES = ["mcp_registry_dynamic_clients"] as const;
export const MCP_DCR_TRIGGERS = [
  "trg_mcp_registry_dynamic_clients_bi", "trg_mcp_registry_dynamic_clients_bu", "trg_mcp_registry_dynamic_clients_bd",
  "trg_mcp_registry_dynamic_clients_gate_bi", "trg_mcp_registry_dynamic_clients_gate_bu",
  "trg_mcp_dcr_pending_bi", "trg_mcp_dcr_operations_bi", "trg_mcp_dcr_credentials_bi",
  "trg_mcp_dcr_authorizations_bi", "trg_mcp_dcr_authorizations_bu", "trg_mcp_dcr_materials_bi",
] as const;
/** The new full schema/trigger root is selected by its actual immutable marker. */
export function mcpDcrFingerprintStatement(sql: string): string {
  const start = "-- agent-service-runtime-fingerprint:mcp-dcr:start", end = "-- agent-service-runtime-fingerprint:mcp-dcr:end";
  const a = sql.indexOf(start), b = sql.indexOf(end);
  if (a < 0 || b <= a || sql.indexOf(start, a + 1) >= 0 || sql.indexOf(end, b + 1) >= 0) throw new McpRegistryIntegrityError();
  const statements = sql.slice(a + start.length, b).replace(/^\s*--.*$/gm, "").split(/;\s*\n/).map(value => value.trim()).filter(Boolean);
  const statement = statements[0], roots = statement?.match(/'[a-f0-9]{64}'/g) ?? [];
  if (statements.length !== 1 || !statement?.startsWith("SET @skill_registry_triggers_ok=") || statement.includes(";") || roots.length !== 1 || roots[0] === `'${"0".repeat(64)}'`) throw new McpRegistryIntegrityError();
  return statement;
}

export async function assertMysqlMcpDcrFingerprint(conn: PoolConnection, directory: string): Promise<void> {
  const statement = mcpDcrFingerprintStatement(await readFile(join(directory, MCP_DCR_MIGRATION), "utf8"));
  await conn.query("SET @mcp_dcr_audit_previous_gcml=@@SESSION.group_concat_max_len");
  try {
    await conn.query("SET SESSION group_concat_max_len=1048576"); await conn.query(statement);
    const [rows] = await conn.query<RowDataPacket[]>("SELECT @skill_registry_triggers_ok AS ok");
    if (Number(rows[0]?.ok) !== 1) throw new McpRegistryIntegrityError();
  } finally { await conn.query("SET SESSION group_concat_max_len=@mcp_dcr_audit_previous_gcml"); }
}
