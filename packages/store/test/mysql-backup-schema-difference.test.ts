import { describe, expect, it, vi } from "vitest";
import {
  MySqlBackupArtifactFixture,
  type MySqlBackupSchemaDifference,
  type MySqlBackupSchemaSnapshot,
} from "./mysql-backup-artifact-test-helper.js";

// Synthetic SHOW CREATE/metadata images only. No constructor, connection, backup or S3 operation
// is invoked here; these examples are not evidence about an actual MySQL restore's table count.
const METADATA_KINDS = ["columns", "indexes", "constraints", "checkClauses", "foreignKeys", "keyColumns", "tableAttributes"] as const;
const TRIGGER_FIELDS = ["body", "event", "timing", "table_name", "action_order", "sql_mode", "definer", "charset", "collation", "database_collation"] as const;
const DECLARATIONS = { column: 0, primaryKey: 0, uniqueKey: 0, key: 0, foreignKey: 0, check: 0, fulltextSpatialKey: 0, options: 0, other: 0 };
const TOKENS = { identifier: 0, stringLiteral: 0, whitespace: 0, charsetIntroducer: 0, collationKeyword: 0, numeric: 0, keyword: 0, punctuation: 0, comment: 0 };
const WORDS = { CHARACTER: 0, SET: 0, COLLATE: 0, DEFAULT: 0, NULL: 0, NOT: 0, ON: 0, UPDATE: 0, CURRENT_TIMESTAMP: 0, INVISIBLE: 0, VISIBLE: 0, STORAGE: 0, COLUMN_FORMAT: 0, UTF8MB4: 0 };
const zeros = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map(k => [k, 0])) as Record<K, number>;

function snapshot(columnCounts: readonly number[] = [2], explicitCharset = false): MySqlBackupSchemaSnapshot {
  const tables = new Map<string, string>();
  const metadata: MySqlBackupSchemaSnapshot["metadata"] = {
    columns: new Map(), indexes: new Map(), constraints: new Map(), checkClauses: new Map(),
    foreignKeys: new Map(), keyColumns: new Map(), tableAttributes: new Map(),
  };
  for (const [tableIndex, count] of columnCounts.entries()) {
    const name = `sample_${tableIndex}`, columns: Record<string, unknown>[] = [];
    const lines = Array.from({ length: count }, (_, columnIndex) => {
      const column = `value_${columnIndex}`;
      columns.push({ ordinal: columnIndex + 1, name: column, type: "varchar(64)", nullable: "NO", default_value: null,
        charset: "utf8mb4", collation: "utf8mb4_bin", extra: "", generation_expression: "", comment: "",
        datetime_precision: null, numeric_precision: null, numeric_scale: null, srs_id: null });
      return `  \`${column}\` varchar(64)${explicitCharset ? " CHARACTER SET utf8mb4" : ""} COLLATE utf8mb4_bin NOT NULL`;
    });
    tables.set(name, `CREATE TABLE \`${name}\` (\n${lines.join(",\n")},\n  PRIMARY KEY (\`value_0\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    metadata.columns.set(name, JSON.stringify(columns));
    metadata.indexes.set(name, JSON.stringify([{ name: "PRIMARY", ordinal: 1, column_name: "value_0", non_unique: 0, sub_part: null,
      index_type: "BTREE", is_visible: "YES", expression: null, collation: "A", nullable: "", comment: "", packed: null }]));
    metadata.constraints.set(name, JSON.stringify([{ name: "PRIMARY", type: "PRIMARY KEY", enforced: "YES" }]));
    metadata.keyColumns.set(name, JSON.stringify([{ name: "PRIMARY", column_name: "value_0", ordinal: 1, position_in_unique_constraint: null,
      referenced_schema: null, referenced_table: null, referenced_column: null }]));
    metadata.tableAttributes.set(name, JSON.stringify([{ engine: "InnoDB", row_format: "Dynamic", collation: "utf8mb4_0900_ai_ci", create_options: "", comment: "" }]));
  }
  return { schemaSha256: "a".repeat(64), tables, metadata, triggers: new Map([["sample_trigger", {
    body: "SET NEW.value_0 = NEW.value_0", event: "INSERT", timing: "BEFORE", table_name: "sample_0", action_order: 1,
    sql_mode: "STRICT_TRANS_TABLES", definer: "fixture@localhost", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci", database_collation: "utf8mb4_0900_ai_ci",
  }]]), connectionCollation: "utf8mb4_0900_ai_ci", connectionSqlMode: "STRICT_TRANS_TABLES" };
}

async function difference(expected: MySqlBackupSchemaSnapshot, actual: MySqlBackupSchemaSnapshot): Promise<MySqlBackupSchemaDifference> {
  // Deliberately bypass the integration fixture constructor and its environment/resource setup.
  const fixture = Object.create(MySqlBackupArtifactFixture.prototype) as MySqlBackupArtifactFixture;
  const schemaSnapshot = vi.fn(async (_url?: string) => actual);
  fixture.schemaSnapshot = schemaSnapshot;
  const result = await fixture.schemaDifference(expected, "memory-only-schema-snapshot");
  expect(schemaSnapshot).toHaveBeenCalledExactlyOnceWith("memory-only-schema-snapshot");
  return result;
}

function replaceSql(image: MySqlBackupSchemaSnapshot, from: string, to: string): void {
  const sql = image.tables.get("sample_0");
  if (sql === undefined || !sql.includes(from)) throw new Error("synthetic_schema_fixture_invalid");
  image.tables.set("sample_0", sql.replace(from, to));
}

function mutateColumn(image: MySqlBackupSchemaSnapshot, field: string, value: unknown): void {
  const columns = JSON.parse(image.metadata.columns.get("sample_0") ?? "[]") as Record<string, unknown>[];
  if (!columns[0]) throw new Error("synthetic_schema_fixture_invalid");
  columns[0][field] = value;
  image.metadata.columns.set("sample_0", JSON.stringify(columns));
}

describe("MySQL backup schema-difference diagnostic classification (pure synthetic images)", () => {
  it("keeps identical images and every existing diagnostic at exact zero", async () => {
    expect(await difference(snapshot(), snapshot())).toEqual({
      sourceTableCount: 1, targetTableCount: 1, missingTables: 0, extraTables: 0,
      tableSqlMismatchCount: 0, tableSqlMismatchIgnoringAutoIncrementCount: 0,
      tableSqlOnlyLineOrderMismatchCount: 0, movedTableDeclarationCounts: DECLARATIONS,
      changedTableDeclarationCounts: DECLARATIONS, sourceChangedChunkTokenCounts: TOKENS,
      targetChangedChunkTokenCounts: TOKENS, tableSqlOnlyOutsideWhitespaceMismatchCount: 0,
      redundantExplicitCharsetMismatchCount: 0, tableSqlOnlyRedundantExplicitCharsetMismatchCount: 0,
      addedFixedKeywordCounts: WORDS, removedFixedKeywordCounts: WORDS,
      sourceTriggerCount: 1, targetTriggerCount: 1, missingTriggers: 0, extraTriggers: 0,
      triggerFieldMismatchCounts: zeros(TRIGGER_FIELDS), metadataTableMismatchCounts: zeros(METADATA_KINDS),
      connectionCollationEqual: true, connectionSqlModeEqual: true,
    });
  });

  it("counts one changed table once while retaining the original per-column count", async () => {
    const result = await difference(snapshot([4]), snapshot([4], true));
    expect(result).toMatchObject({ tableSqlMismatchCount: 1, tableSqlMismatchIgnoringAutoIncrementCount: 1,
      redundantExplicitCharsetMismatchCount: 4, tableSqlOnlyRedundantExplicitCharsetMismatchCount: 1,
      tableSqlOnlyLineOrderMismatchCount: 0, tableSqlOnlyOutsideWhitespaceMismatchCount: 0,
      changedTableDeclarationCounts: { ...DECLARATIONS, column: 4 }, movedTableDeclarationCounts: DECLARATIONS,
      metadataTableMismatchCounts: zeros(METADATA_KINDS), triggerFieldMismatchCounts: zeros(TRIGGER_FIELDS) });
    expect(result.addedFixedKeywordCounts).toEqual({ ...WORDS, CHARACTER: 4, SET: 4, UTF8MB4: 4 });
    expect(result.removedFixedKeywordCounts).toEqual(WORDS);
  });

  it("synthetically reproduces eight changed tables with thirty-six qualifying columns", async () => {
    const counts = [5, 5, 5, 5, 4, 4, 4, 4];
    const result = await difference(snapshot(counts), snapshot(counts, true));
    expect(result).toMatchObject({ sourceTableCount: 8, targetTableCount: 8, missingTables: 0, extraTables: 0,
      tableSqlMismatchCount: 8, tableSqlMismatchIgnoringAutoIncrementCount: 8,
      redundantExplicitCharsetMismatchCount: 36, tableSqlOnlyRedundantExplicitCharsetMismatchCount: 8,
      changedTableDeclarationCounts: { ...DECLARATIONS, column: 36 },
      metadataTableMismatchCounts: zeros(METADATA_KINDS), triggerFieldMismatchCounts: zeros(TRIGGER_FIELDS) });
  });

  it.each([
    ["table option", "ENGINE=InnoDB", "ENGINE=MyISAM"],
    ["column default", "COLLATE utf8mb4_bin NOT NULL", "COLLATE utf8mb4_bin NOT NULL DEFAULT 'changed'"],
    ["column comment", "COLLATE utf8mb4_bin NOT NULL", "COLLATE utf8mb4_bin NOT NULL COMMENT 'changed'"],
    ["new index", "  PRIMARY KEY (`value_0`)", "  PRIMARY KEY (`value_0`),\n  KEY `other_index` (`value_1`)"],
    ["extra declaration", "  PRIMARY KEY (`value_0`)", "  `extra_value` int NOT NULL,\n  PRIMARY KEY (`value_0`)"],
    ["extra blank line", "  PRIMARY KEY (`value_0`)", "\n  PRIMARY KEY (`value_0`)"],
    ["table charset", "DEFAULT CHARSET=utf8mb4", "DEFAULT CHARSET=utf8mb3"],
    ["column charset", "CHARACTER SET utf8mb4 COLLATE", "CHARACTER SET latin1 COLLATE"],
    ["column collation", "COLLATE utf8mb4_bin", "COLLATE utf8mb4_unicode_ci"],
    ["table collation", "COLLATE=utf8mb4_0900_ai_ci", "COLLATE=utf8mb4_unicode_ci"],
  ])("does not classify redundant charset plus a real %s drift as table-only", async (_label, from, to) => {
    const actual = snapshot([2], true); replaceSql(actual, from, to);
    const result = await difference(snapshot([2]), actual);
    expect(result.tableSqlMismatchCount).toBe(1);
    expect(result.tableSqlOnlyRedundantExplicitCharsetMismatchCount).toBe(0);
  });

  it("does not discard column order while removing otherwise qualifying charset attributes", async () => {
    const actual = snapshot([2], true), sql = actual.tables.get("sample_0");
    if (!sql) throw new Error("synthetic_schema_fixture_invalid");
    const lines = sql.split("\n"), first = lines[1], second = lines[2];
    if (!first || !second) throw new Error("synthetic_schema_fixture_invalid");
    lines[1] = second; lines[2] = first; actual.tables.set("sample_0", lines.join("\n"));
    const result = await difference(snapshot([2]), actual);
    expect(result.tableSqlMismatchCount).toBe(1);
    expect(result.tableSqlOnlyRedundantExplicitCharsetMismatchCount).toBe(0);
  });

  it.each([
    ["single-quoted SQL string", " COMMENT 'marker'", " COMMENT 'marker CHARACTER SET utf8mb4'"],
    ["double-quoted SQL string", ' COMMENT "marker"', ' COMMENT "marker CHARACTER SET utf8mb4"'],
    ["SQL comment", " /* marker */", " /* marker CHARACTER SET utf8mb4 */"],
  ])("never removes a matching phrase inside a %s even with eligible synthetic metadata", async (_label, sourceSuffix, targetSuffix) => {
    const expected = snapshot([1]), actual = snapshot([1]);
    replaceSql(expected, "NOT NULL,", `NOT NULL${sourceSuffix},`);
    replaceSql(actual, "NOT NULL,", `NOT NULL${targetSuffix},`);
    const result = await difference(expected, actual);
    // The old per-column diagnostic is intentionally unchanged; it is not a table-wide oracle.
    expect(result.redundantExplicitCharsetMismatchCount).toBe(1);
    expect(result.tableSqlMismatchCount).toBe(1);
    expect(result.tableSqlOnlyRedundantExplicitCharsetMismatchCount).toBe(0);
  });

  it.each([
    ["multiline literal", " COMMENT 'start\n", "\nend'"],
    ["multiline comment", " /* start\n", "\nend */"],
  ])("uses the full DDL token context rather than treating a %s interior as a column", async (_label, prefix, suffix) => {
    const expected = snapshot([2]), actual = snapshot([2]);
    const fakeColumn = "  `value_1` varchar(64) COLLATE utf8mb4_bin NOT NULL";
    // A raw line can resemble a real metadata-eligible column while still being inside a token
    // that began on the preceding line. Neither image is sent to MySQL by this pure test.
    replaceSql(expected, "NOT NULL,", `NOT NULL${prefix}${fakeColumn}${suffix},`);
    replaceSql(actual, "NOT NULL,", `NOT NULL${prefix}${fakeColumn.replace(" COLLATE", " CHARACTER SET utf8mb4 COLLATE")}${suffix},`);
    const result = await difference(expected, actual);
    expect(result.redundantExplicitCharsetMismatchCount).toBe(1);
    expect(result.tableSqlMismatchCount).toBe(1);
    expect(result.tableSqlOnlyRedundantExplicitCharsetMismatchCount).toBe(0);
  });

  it.each([
    ["charset", "latin1"], ["collation", "utf8mb4_unicode_ci"], ["type", "text"],
    ["default_value", "changed"], ["comment", "changed"], ["ordinal", 2],
  ] as const)("requires complete matching column metadata: %s drift is not table-only", async (field, value) => {
    const actual = snapshot([2], true); mutateColumn(actual, field, value);
    const result = await difference(snapshot([2]), actual);
    expect(result.tableSqlMismatchCount).toBe(1);
    expect(result.metadataTableMismatchCounts).toEqual({ ...zeros(METADATA_KINDS), columns: 1 });
    expect(result.tableSqlOnlyRedundantExplicitCharsetMismatchCount).toBe(0);
  });

  it.each(METADATA_KINDS)("retains the separate %s metadata diagnostic and cannot conceal it as charset-only", async kind => {
    const actual = snapshot([2], true);
    if (kind === "columns") mutateColumn(actual, "nullable", "YES");
    else actual.metadata[kind].set("sample_0", JSON.stringify([{ synthetic_changed: true }]));
    const result = await difference(snapshot([2]), actual);
    expect(result.metadataTableMismatchCounts).toEqual({ ...zeros(METADATA_KINDS), [kind]: 1 });
    expect(result.tableSqlOnlyRedundantExplicitCharsetMismatchCount).toBe(0);
    expect(result.triggerFieldMismatchCounts).toEqual(zeros(TRIGGER_FIELDS));
  });

  it.each(TRIGGER_FIELDS)("retains the original independent trigger-field diagnostic: %s", async field => {
    const actual = snapshot(), trigger = actual.triggers.get("sample_trigger");
    if (!trigger) throw new Error("synthetic_schema_fixture_invalid");
    trigger[field] = field === "action_order" ? 2 : "synthetic_changed";
    const result = await difference(snapshot(), actual);
    expect(result.triggerFieldMismatchCounts).toEqual({ ...zeros(TRIGGER_FIELDS), [field]: 1 });
    expect(result.metadataTableMismatchCounts).toEqual(zeros(METADATA_KINDS));
    expect(result.tableSqlMismatchCount).toBe(0);
    expect(result.tableSqlOnlyRedundantExplicitCharsetMismatchCount).toBe(0);
  });

  it("keeps connection, object-presence and SQL classification diagnostics independent", async () => {
    const actual = snapshot(); actual.connectionCollation = "utf8mb4_bin"; actual.connectionSqlMode = "ANSI_QUOTES";
    actual.tables.delete("sample_0"); actual.tables.set("unrelated", "CREATE TABLE `unrelated` (`id` int)");
    actual.triggers.delete("sample_trigger"); actual.triggers.set("unrelated_trigger", { body: "SET @x=1" });
    const result = await difference(snapshot(), actual);
    expect(result).toMatchObject({ sourceTableCount: 1, targetTableCount: 1, missingTables: 1, extraTables: 1,
      sourceTriggerCount: 1, targetTriggerCount: 1, missingTriggers: 1, extraTriggers: 1,
      connectionCollationEqual: false, connectionSqlModeEqual: false,
      tableSqlMismatchCount: 0, redundantExplicitCharsetMismatchCount: 0, tableSqlOnlyRedundantExplicitCharsetMismatchCount: 0,
      triggerFieldMismatchCounts: zeros(TRIGGER_FIELDS) });
  });
});
