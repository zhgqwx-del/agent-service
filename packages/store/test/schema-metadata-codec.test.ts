import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSchemaMetadataProcedure,
  hasSchemaTriggerMetadataRelation,
  rewriteSchemaMetadataVerifierSql,
  SCHEMA_TRIGGER_METADATA_FIELDS,
  SCHEMA_TRIGGER_METADATA_PROFILE,
  SCHEMA_TRIGGER_METADATA_RELATION,
  SCHEMA_TRIGGER_METADATA_VARIABLE,
  SchemaMetadataCodecError,
} from "../src/mysql/schema-metadata-codec.js";

const relation = SCHEMA_TRIGGER_METADATA_RELATION;
const source = "information_schema.triggers";
const select = "SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY trigger_name";

describe("schema metadata read-only procedure candidate", () => {
  it("binds the full UTF-8 database digest to a fixed no-argument procedure in an independent schema", () => {
    const database = "应用_schema";
    const digest = createHash("sha256").update(database, "utf8").digest("hex");
    const result = buildSchemaMetadataProcedure(database, "agent_service_metadata");
    expect(result.routineName).toBe(digest);
    expect(result.applicationDatabaseSha256).toBe(digest);
    expect(result.routineName).toMatch(/^[a-f0-9]{64}$/);
    expect(result.callSql).toBe(`CALL \`agent_service_metadata\`.\`${digest}\`()`);
    expect(result.createSql).toBe(`CREATE PROCEDURE \`agent_service_metadata\`.\`${digest}\`()\nLANGUAGE SQL\nNOT DETERMINISTIC\nREADS SQL DATA\nSQL SECURITY DEFINER\nCOMMENT 'schema-trigger-metadata-v1'\n${result.expectedDefinition}`);
    expect(result.expectedAttributes).toEqual({
      ROUTINE_SCHEMA: "agent_service_metadata", ROUTINE_NAME: digest, ROUTINE_TYPE: "PROCEDURE",
      ROUTINE_BODY: "SQL", IS_DETERMINISTIC: "NO", SQL_DATA_ACCESS: "READS SQL DATA",
      SECURITY_TYPE: "DEFINER", ROUTINE_COMMENT: SCHEMA_TRIGGER_METADATA_PROFILE,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.expectedAttributes)).toBe(true);
    expect(Object.isFrozen(result.fields)).toBe(true);
    expect(result.fields.every(Object.isFrozen)).toBe(true);
  });

  it("selects every current app trigger row, with no old-name filter or routine-local DATABASE()", () => {
    const result = buildSchemaMetadataProcedure("app_db", "agent_service_metadata");
    expect(result.expectedDefinition).toBe("SELECT\n  `TRIGGER_SCHEMA`,\n  `TRIGGER_NAME`,\n  `EVENT_MANIPULATION`,\n  `EVENT_OBJECT_TABLE`,\n  `ACTION_ORDER`,\n  `ACTION_CONDITION`,\n  `ACTION_STATEMENT`,\n  `ACTION_ORIENTATION`,\n  `ACTION_TIMING`\nFROM `information_schema`.`TRIGGERS`\nWHERE BINARY `TRIGGER_SCHEMA` = X'6170705f6462'\nORDER BY BINARY `TRIGGER_NAME`");
    expect(result.expectedDefinition).not.toMatch(/DATABASE\s*\(|\bLIMIT\b|\bLIKE\b|\bIN\s*\(|trg_/i);
    expect(result.createSql).not.toMatch(/CREATE (?:TABLE|SCHEMA|USER)|\bGRANT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  });

  it("hex-binds punctuation in the actual database name without injecting it into SQL text", () => {
    const database = "app'` ; SELECT canary";
    const result = buildSchemaMetadataProcedure(database, "metadata_schema");
    expect(result.expectedDefinition).toContain(`= X'${Buffer.from(database, "utf8").toString("hex")}'`);
    expect(result.createSql).not.toContain(database);
    expect(result.callSql).not.toContain(database);
    expect(result.expectedDefinition.endsWith("ORDER BY BINARY `TRIGGER_NAME`")).toBe(true);
  });

  it.each(["", ".", "..", "a/b", "a\\b", "a\0b", "a\nb", "a".repeat(65), "\ud800"])("rejects an invalid actual database identifier %j", database => {
    expect(() => buildSchemaMetadataProcedure(database, "metadata_schema")).toThrow(SchemaMetadataCodecError);
  });

  it.each(["", "same_db", "Same_db", "metadata-schema", "x` SELECT canary", "a".repeat(65), "_metadata"])("rejects non-independent or unsupported metadata schema %j", metadataSchema => {
    expect(() => buildSchemaMetadataProcedure("same_db", metadataSchema)).toThrow(SchemaMetadataCodecError);
  });

  it("uses only the closed fields and their calibrated I_S collations; unused fields are not fabricated", () => {
    expect(SCHEMA_TRIGGER_METADATA_FIELDS).toEqual([
      { name: "TRIGGER_SCHEMA", sqlType: "VARCHAR(64) CHARACTER SET utf8 COLLATE utf8_tolower_ci", nullable: false },
      { name: "TRIGGER_NAME", sqlType: "VARCHAR(64) CHARACTER SET utf8 COLLATE utf8_general_ci", nullable: false },
      { name: "EVENT_MANIPULATION", sqlType: "VARCHAR(6) CHARACTER SET utf8 COLLATE utf8_bin", nullable: false },
      { name: "EVENT_OBJECT_TABLE", sqlType: "VARCHAR(64) CHARACTER SET utf8 COLLATE utf8_tolower_ci", nullable: false },
      { name: "ACTION_ORDER", sqlType: "INT UNSIGNED", nullable: false },
      { name: "ACTION_CONDITION", sqlType: "VARBINARY(0)", nullable: true },
      { name: "ACTION_STATEMENT", sqlType: "LONGTEXT CHARACTER SET utf8 COLLATE utf8_bin", nullable: false },
      { name: "ACTION_ORIENTATION", sqlType: "VARCHAR(3) CHARACTER SET utf8 COLLATE utf8_general_ci", nullable: false },
      { name: "ACTION_TIMING", sqlType: "VARCHAR(6) CHARACTER SET utf8 COLLATE utf8_bin", nullable: false },
    ]);
    expect(relation).toContain(`JSON_TABLE(${SCHEMA_TRIGGER_METADATA_VARIABLE}, '$[*]' COLUMNS (`);
    expect(relation.match(/ERROR ON EMPTY ERROR ON ERROR/g)).toHaveLength(9);
    expect(relation).toContain("`ACTION_CONDITION` VARBINARY(0) PATH '$.ACTION_CONDITION'");
    expect(relation).toContain("`ACTION_STATEMENT` LONGTEXT CHARACTER SET utf8 COLLATE utf8_bin");
    expect(relation).not.toMatch(/CREATED|DEFINER|SQL_MODE|utf8mb4_0900_ai_ci|NULL ON EMPTY|COALESCE|SUBSTRING|\bLEFT\s*\(/);
  });
});

describe("schema verifier relation token replacement", () => {
  it("distinguishes an explicit no-relation result from an unsupported real reference", () => {
    expect(hasSchemaTriggerMetadataRelation("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()")).toBe(false);
    expect(hasSchemaTriggerMetadataRelation("SELECT 'FROM information_schema.triggers' AS sample /* JOIN information_schema.triggers */")).toBe(false);
    expect(hasSchemaTriggerMetadataRelation("SELECT 1 -- FROM information_schema.triggers\n# JOIN information_schema.triggers")).toBe(false);
    expect(hasSchemaTriggerMetadataRelation(select)).toBe(true);
    const unsupported = "SELECT information_schema.triggers.trigger_name FROM information_schema.tables";
    expect(hasSchemaTriggerMetadataRelation(unsupported)).toBe(true);
    expect(() => rewriteSchemaMetadataVerifierSql(unsupported)).toThrow(SchemaMetadataCodecError);
    expect(() => hasSchemaTriggerMetadataRelation("SELECT 'unterminated information_schema.triggers")).toThrow(SchemaMetadataCodecError);
  });

  it("replaces an unaliased relation only and retains the exact count, predicates and order", () => {
    expect(rewriteSchemaMetadataVerifierSql(select)).toBe(select.replace(source, `${relation} AS \`triggers\``));
    const count = "SELECT COUNT(*)=842 AND SUM(action_condition IS NULL)=842 FROM information_schema.triggers WHERE trigger_schema=DATABASE()";
    expect(rewriteSchemaMetadataVerifierSql(count)).toBe(count.replace(source, `${relation} AS \`triggers\``));
  });

  it.each([" AS t", " t", " AS `t`"])("preserves the existing explicit alias %j", alias => {
    const sql = `SELECT t.trigger_name,t.action_statement FROM information_schema.triggers${alias} WHERE t.trigger_schema=DATABASE() ORDER BY t.action_order`;
    expect(rewriteSchemaMetadataVerifierSql(sql)).toBe(sql.replace(source, relation));
  });

  it("recognizes quoted and case-varied relation tokens without normalizing other bytes", () => {
    const target = "`InFoRmAtIoN_sChEmA`.`TrIgGeRs`";
    const sql = `SELECT \`triggers\`.\`ACTION_STATEMENT\` FROM ${target} WHERE \`TRIGGER_SCHEMA\` = DATABASE();`;
    expect(rewriteSchemaMetadataVerifierSql(sql)).toBe(sql.replace(target, `${relation} AS \`TrIgGeRs\``));
  });

  it("keeps comments between relation identifier tokens byte-for-byte", () => {
    const sql = "SELECT trigger_name FROM information_schema/* schema */.\n/* relation */triggers WHERE action_condition IS NULL";
    expect(rewriteSchemaMetadataVerifierSql(sql)).toBe(`SELECT trigger_name FROM ${relation}/* schema */\n/* relation */ AS \`triggers\` WHERE action_condition IS NULL`);
  });

  it("replaces every target FROM/JOIN while preserving other metadata relations", () => {
    const sql = "SELECT t.trigger_name,u.action_statement,p.TABLE_NAME FROM information_schema.triggers AS t JOIN information_schema.triggers u ON t.trigger_name=u.trigger_name JOIN information_schema.tables p ON p.TABLE_NAME=t.event_object_table WHERE t.trigger_schema=DATABASE()";
    expect(rewriteSchemaMetadataVerifierSql(sql)).toBe(sql.replaceAll(source, relation));
  });

  it("preserves the single-variable SET root and sibling metadata subqueries", () => {
    const sql = "SET @fingerprint_ok=(SELECT COUNT(*)=17 FROM information_schema.tables WHERE table_schema=DATABASE()) AND (SELECT COUNT(*)=842 AND SUM(OCTET_LENGTH(action_statement))+COUNT(*)-1<=@@SESSION.group_concat_max_len FROM information_schema.triggers WHERE trigger_schema=DATABASE()) AND SHA2(CONCAT_WS('::',(SELECT SHA2(GROUP_CONCAT(CONCAT_WS('~',trigger_name,IFNULL(action_condition,'<NULL>'),LOWER(REPLACE(REGEXP_REPLACE(action_statement,'[[:space:]]',''),CHAR(96),''))) ORDER BY trigger_name SEPARATOR '|'),256) FROM information_schema.triggers WHERE trigger_schema=DATABASE())),256)='exact-root';";
    expect(rewriteSchemaMetadataVerifierSql(sql)).toBe(sql.replaceAll(source, `${relation} AS \`triggers\``));
  });

  it("preserves single-quoted strings and ordinary comments that resemble SQL or trigger bodies", () => {
    const literal = "'CREATE TRIGGER canary BEFORE UPDATE; FROM information_schema.triggers WHERE x=''secret'';'";
    const sql = `/* FROM information_schema.triggers */ SELECT ${literal} AS sample,trigger_name FROM information_schema.triggers -- JOIN information_schema.triggers\nWHERE trigger_schema=DATABASE() # FROM information_schema.triggers\nORDER BY trigger_name`;
    expect(rewriteSchemaMetadataVerifierSql(sql)).toBe(sql.replace(`trigger_name FROM ${source}`, `trigger_name FROM ${relation} AS \`triggers\``));
  });

  it.each(["\r", "\r\n", "\n"])("recognizes physical line-comment endings %j without leaving a real relation untouched", newline => {
    const sql = `SELECT COUNT(*) FROM information_schema.triggers # literal information_schema.triggers${newline}WHERE EXISTS(SELECT trigger_name FROM information_schema.triggers WHERE action_condition IS NULL)`;
    const expected = sql.replace(`FROM ${source} #`, `FROM ${relation} AS \`triggers\` #`).replace(`trigger_name FROM ${source} WHERE`, `trigger_name FROM ${relation} AS \`triggers\` WHERE`);
    expect(rewriteSchemaMetadataVerifierSql(sql)).toBe(expected);
  });

  it("does not truncate or normalize quoted action text larger than a TEXT value", () => {
    const body = `BEGIN ${"x ".repeat(40_000)} FROM information_schema.triggers; END`;
    const sql = `SELECT '${body}' AS expected_body,action_statement FROM information_schema.triggers WHERE action_condition IS NULL`;
    expect(rewriteSchemaMetadataVerifierSql(sql)).toBe(sql.replace(`action_statement FROM ${source}`, `action_statement FROM ${relation} AS \`triggers\``));
  });

  it.each([
    "SELECT CREATED FROM information_schema.triggers",
    "SELECT DEFINER FROM information_schema.triggers",
    "SELECT SQL_MODE FROM information_schema.triggers",
    "SELECT t.CREATED FROM information_schema.triggers t",
    "SELECT T.CREATED FROM information_schema.triggers t",
    "SELECT unknown_alias.CREATED FROM information_schema.triggers t",
    "SELECT `t`.`CREATED` FROM information_schema.triggers AS `t`",
    "SELECT (SELECT t.CREATED) FROM information_schema.triggers AS t",
    "SELECT (SELECT CREATED) FROM information_schema.triggers AS t",
    "SELECT CREATED AS known_alias,action_statement AS CREATED FROM information_schema.triggers",
    "SELECT COUNT FROM information_schema.triggers",
    "SELECT * FROM information_schema.triggers",
    "SELECT t.* FROM information_schema.triggers t",
    "SELECT COUNT(t.*) FROM information_schema.triggers t",
  ])("rejects an uncalibrated column/wildcard rather than fabricating NULL: %s", sql => {
    expect(() => rewriteSchemaMetadataVerifierSql(sql)).toThrow(SchemaMetadataCodecError);
  });

  it.each([
    "",
    "SELECT trigger_name FROM triggers",
    "SELECT trigger_name FROM information_schema.tables",
    "SELECT information_schema.triggers.trigger_name FROM information_schema.triggers",
    "SELECT trigger_name FROM information_schema.triggers AS",
    "SELECT trigger_name FROM information_schema.triggers AS SELECT",
    "SELECT trigger_name FROM information_schema.triggers AS 't'",
    "SELECT trigger_name FROM information_schema.triggers FORCE INDEX (PRIMARY)",
    "SELECT trigger_name FROM information_schema.triggers,information_schema.triggers t",
    "SELECT trigger_name FROM information_schema.triggers; SELECT 1",
    "SELECT trigger_name FROM information_schema.triggers;;",
    "SELECT (trigger_name FROM information_schema.triggers",
    "SELECT trigger_name) FROM information_schema.triggers",
    "SELECT 'unterminated FROM information_schema.triggers",
    "SELECT trigger_name FROM information_schema.triggers /* unterminated",
    "SELECT trigger_name FROM information_schema.triggers /*! WHERE trigger_schema=DATABASE() */",
    "SELECT /*+ hint */ trigger_name FROM information_schema.triggers",
    "SELECT \"CREATED\" FROM information_schema.triggers",
    "SELECT 'a\\'b' AS body,trigger_name FROM information_schema.triggers",
    "UPDATE information_schema.triggers SET trigger_name='canary'",
    "CREATE TRIGGER canary SELECT trigger_name FROM information_schema.triggers",
    "CALL metadata_schema.canary()",
    "WITH t AS (SELECT trigger_name FROM information_schema.triggers) SELECT trigger_name FROM t",
    "SET @@GLOBAL.canary=(SELECT COUNT(*) FROM information_schema.triggers)",
    "SET @a=(SELECT COUNT(*) FROM information_schema.triggers),@b=1",
    "SET @a=COUNT(*) FROM information_schema.triggers",
    "SELECT @agent_service_schema_trigger_metadata_v1 FROM information_schema.triggers",
    "SET @agent_service_schema_trigger_metadata_v1=(SELECT COUNT(*) FROM information_schema.triggers)",
    "SELECT @AGENT_SERVICE_SCHEMA_TRIGGER_METADATA_V1 FROM information_schema.triggers",
    "SET @Agent_Service_Schema_Trigger_Metadata_V1=(SELECT COUNT(*) FROM information_schema.triggers)",
    "SELECT @`Agent_Service_Schema_Trigger_Metadata_V1` FROM information_schema.triggers",
    "SELECT trigger_name\0 FROM information_schema.triggers",
  ])("rejects unsupported or ambiguous verifier input without direct fallback: %s", sql => {
    expect(() => rewriteSchemaMetadataVerifierSql(sql)).toThrow(SchemaMetadataCodecError);
  });

  it("bounds input size and parenthesis nesting", () => {
    expect(() => rewriteSchemaMetadataVerifierSql(`SELECT '${"x".repeat(1024 * 1024)}' FROM information_schema.triggers`)).toThrow(SchemaMetadataCodecError);
    expect(() => rewriteSchemaMetadataVerifierSql(`SELECT ${"(".repeat(129)}COUNT(*)${")".repeat(129)} FROM information_schema.triggers`)).toThrow(SchemaMetadataCodecError);
  });

  it("uses a fixed content-free diagnostic rather than echoing submitted SQL", () => {
    const canary = "sql-secret-canary";
    let error: unknown;
    try { rewriteSchemaMetadataVerifierSql(`DELETE FROM information_schema.triggers WHERE trigger_name='${canary}'`); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SchemaMetadataCodecError);
    expect(error).toMatchObject({ code: "schema_metadata_invalid", message: "Schema metadata verifier input is invalid." });
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
  });
});
