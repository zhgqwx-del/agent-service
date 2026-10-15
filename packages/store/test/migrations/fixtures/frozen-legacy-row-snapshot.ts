import type { Connection, RowDataPacket } from "mysql2/promise";

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const RETAINED_SOURCE_PROTOCOL = "telemetry_retained_source_protocol";
const RETAINED_SOURCE_PARENTS = [
  "tenant_erasure_admissions",
  "tenant_purge_plan_jobs",
] as const;
const RETAINED_SOURCE_TABLES = [
  "tenant_telemetry_retained_source_t1_entries",
  "tenant_telemetry_retained_source_t1_receipts",
  "tenant_telemetry_retained_source_catalog_sources",
  "tenant_telemetry_retained_source_catalog_targets",
  "tenant_telemetry_retained_source_catalog_receipts",
  "tenant_telemetry_retained_source_usage_entries",
  "tenant_telemetry_retained_source_usage_receipts",
  "tenant_telemetry_retained_source_canonical_entries",
  "tenant_telemetry_retained_source_canonical_receipts",
] as const;

type ColumnRow = RowDataPacket & { name: string };
type CountRow = RowDataPacket & { row_count: number | string };

// Capture the real old schema before migration. SELECT * after a later additive
// migration would hash newly added NULL properties instead of just old bytes.
export async function captureFrozenLegacyColumns(
  conn: Connection,
  table: string,
): Promise<readonly string[]> {
  if (!IDENTIFIER.test(table)) throw new Error(`unsafe frozen snapshot table: ${table}`);
  const [rows] = await conn.query<ColumnRow[]>(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS "
      + "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
    [table],
  );
  const columns = rows.map((row) => row.name);
  if (columns.length === 0 || columns.some((name) => typeof name !== "string" || !IDENTIFIER.test(name))
    || new Set(columns).size !== columns.length) {
    throw new Error(`invalid frozen snapshot columns: ${table}`);
  }
  if (RETAINED_SOURCE_PARENTS.some((parent) => parent === table)
    && columns.includes(RETAINED_SOURCE_PROTOCOL)) {
    throw new Error(`0054 protocol already present in frozen schema: ${table}`);
  }
  return columns;
}

// These are fresh 0054 fields/tables, not part of the historical row hash. Old
// writers must leave them genuinely NULL/empty rather than being backfilled.
export async function assertNo0054FrozenLegacyFootprint(conn: Connection): Promise<void> {
  for (const table of RETAINED_SOURCE_PARENTS) {
    const [columns] = await conn.query<ColumnRow[]>(
      "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS "
        + "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
      [table, RETAINED_SOURCE_PROTOCOL],
    );
    if (columns.length !== 1 || columns[0]?.name !== RETAINED_SOURCE_PROTOCOL) {
      throw new Error(`0054 protocol column missing after upgrade: ${table}`);
    }
    const [rows] = await conn.query<CountRow[]>(
      `SELECT COUNT(*) AS row_count FROM \`${table}\` WHERE \`${RETAINED_SOURCE_PROTOCOL}\` IS NOT NULL`,
    );
    if (rows.length !== 1 || String(rows[0]?.row_count) !== "0") {
      throw new Error(`0054 protocol backfilled for frozen rows: ${table}`);
    }
  }
  for (const table of RETAINED_SOURCE_TABLES) {
    const [rows] = await conn.query<CountRow[]>(`SELECT COUNT(*) AS row_count FROM \`${table}\``);
    if (rows.length !== 1 || String(rows[0]?.row_count) !== "0") {
      throw new Error(`0054 table has frozen-writer footprint: ${table}`);
    }
  }
}
