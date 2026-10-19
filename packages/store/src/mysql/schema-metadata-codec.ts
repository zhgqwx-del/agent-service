import { createHash } from "node:crypto";

export const SCHEMA_TRIGGER_METADATA_PROFILE = "schema-trigger-metadata-v1" as const;
export const SCHEMA_TRIGGER_METADATA_VARIABLE = "@agent_service_schema_trigger_metadata_v1" as const;

export interface SchemaTriggerMetadataField {
  readonly name: string;
  readonly sqlType: string;
  readonly nullable: boolean;
}

/**
 * Closed fields consumed by the formal schema verifiers, calibrated against MySQL 8.0.26 I_S.
 * The procedure returns the complete trigger row set, not a filter for old trigger names. CREATED is
 * deliberately absent: do not guess date serialization or manufacture a missing column as NULL.
 * JSON_TABLE syntax/type/collation fidelity still requires the real-server acceptance test.
 */
export const SCHEMA_TRIGGER_METADATA_FIELDS: readonly SchemaTriggerMetadataField[] = Object.freeze([
  { name: "TRIGGER_SCHEMA", sqlType: "VARCHAR(64) CHARACTER SET utf8 COLLATE utf8_tolower_ci", nullable: false },
  { name: "TRIGGER_NAME", sqlType: "VARCHAR(64) CHARACTER SET utf8 COLLATE utf8_general_ci", nullable: false },
  { name: "EVENT_MANIPULATION", sqlType: "VARCHAR(6) CHARACTER SET utf8 COLLATE utf8_bin", nullable: false },
  { name: "EVENT_OBJECT_TABLE", sqlType: "VARCHAR(64) CHARACTER SET utf8 COLLATE utf8_tolower_ci", nullable: false },
  { name: "ACTION_ORDER", sqlType: "INT UNSIGNED", nullable: false },
  { name: "ACTION_CONDITION", sqlType: "VARBINARY(0)", nullable: true },
  { name: "ACTION_STATEMENT", sqlType: "LONGTEXT CHARACTER SET utf8 COLLATE utf8_bin", nullable: false },
  { name: "ACTION_ORIENTATION", sqlType: "VARCHAR(3) CHARACTER SET utf8 COLLATE utf8_general_ci", nullable: false },
  { name: "ACTION_TIMING", sqlType: "VARCHAR(6) CHARACTER SET utf8 COLLATE utf8_bin", nullable: false },
].map(field => Object.freeze(field)));

export class SchemaMetadataCodecError extends Error {
  readonly code = "schema_metadata_invalid";
  constructor() { super("Schema metadata verifier input is invalid."); this.name = "SchemaMetadataCodecError"; }
}

function invalid(): never { throw new SchemaMetadataCodecError(); }

export interface SchemaMetadataProcedure {
  readonly profile: typeof SCHEMA_TRIGGER_METADATA_PROFILE;
  readonly metadataSchema: string;
  readonly applicationDatabaseSha256: string;
  readonly routineName: string;
  readonly createSql: string;
  readonly callSql: string;
  readonly expectedDefinition: string;
  readonly expectedAttributes: Readonly<{
    ROUTINE_SCHEMA: string; ROUTINE_NAME: string; ROUTINE_TYPE: "PROCEDURE";
    ROUTINE_BODY: "SQL"; IS_DETERMINISTIC: "NO"; SQL_DATA_ACCESS: "READS SQL DATA";
    SECURITY_TYPE: "DEFINER"; ROUTINE_COMMENT: typeof SCHEMA_TRIGGER_METADATA_PROFILE;
  }>;
  readonly fields: typeof SCHEMA_TRIGGER_METADATA_FIELDS;
}

/**
 * actualDatabase must come from SELECT DATABASE() on the authenticated app connection, not a DSN
 * or a caller-supplied query. The caller separately pins the trusted DEFINER and zero parameters.
 * The expected definition is exact: this helper does not strip whitespace or quoted body text.
 */
export function buildSchemaMetadataProcedure(actualDatabase: string, metadataSchema: string): SchemaMetadataProcedure {
  if (typeof actualDatabase !== "string" || actualDatabase.length < 1 || actualDatabase.length > 64
    || /[\u0000-\u001f\u007f/\\]/.test(actualDatabase) || actualDatabase === "." || actualDatabase === ".."
    || Buffer.from(actualDatabase, "utf8").toString("utf8") !== actualDatabase
    || typeof metadataSchema !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(metadataSchema)
    || actualDatabase.toLowerCase() === metadataSchema) invalid();
  const databaseBytes = Buffer.from(actualDatabase, "utf8");
  const routineName = createHash("sha256").update(databaseBytes).digest("hex");
  const qualified = `\`${metadataSchema}\`.\`${routineName}\``;
  const expectedDefinition = "SELECT\n  " + SCHEMA_TRIGGER_METADATA_FIELDS.map(field => `\`${field.name}\``).join(",\n  ")
    + "\nFROM `information_schema`.`TRIGGERS`\nWHERE BINARY `TRIGGER_SCHEMA` = X'" + databaseBytes.toString("hex")
    + "'\nORDER BY BINARY `TRIGGER_NAME`";
  return Object.freeze({
    profile: SCHEMA_TRIGGER_METADATA_PROFILE, metadataSchema, applicationDatabaseSha256: routineName, routineName,
    createSql: `CREATE PROCEDURE ${qualified}()\nLANGUAGE SQL\nNOT DETERMINISTIC\nREADS SQL DATA\nSQL SECURITY DEFINER\nCOMMENT '${SCHEMA_TRIGGER_METADATA_PROFILE}'\n${expectedDefinition}`,
    callSql: `CALL ${qualified}()`, expectedDefinition,
    expectedAttributes: Object.freeze({ ROUTINE_SCHEMA: metadataSchema, ROUTINE_NAME: routineName,
      ROUTINE_TYPE: "PROCEDURE", ROUTINE_BODY: "SQL", IS_DETERMINISTIC: "NO", SQL_DATA_ACCESS: "READS SQL DATA",
      SECURITY_TYPE: "DEFINER", ROUTINE_COMMENT: SCHEMA_TRIGGER_METADATA_PROFILE }),
    fields: SCHEMA_TRIGGER_METADATA_FIELDS,
  });
}

/** Missing members are errors; JSON null stays SQL NULL on the supported MySQL version. */
export const SCHEMA_TRIGGER_METADATA_RELATION = `JSON_TABLE(${SCHEMA_TRIGGER_METADATA_VARIABLE}, '$[*]' COLUMNS (\n`
  + SCHEMA_TRIGGER_METADATA_FIELDS.map(field => `  \`${field.name}\` ${field.sqlType} PATH '$.${field.name}' ERROR ON EMPTY ERROR ON ERROR`).join(",\n")
  + "\n))";

interface Token {
  readonly kind: "word" | "identifier" | "literal" | "symbol";
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function lex(sql: string, backslashEscapes: boolean): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < sql.length;) {
    const start = i, c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "#" || c === "-" && sql[i + 1] === "-" && (i + 2 === sql.length || /\s/.test(sql[i + 2]!))) {
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      // Executable comments and optimizer hints are not this verifier's supported SQL shape.
      if (sql[i + 2] === "!" || sql[i + 2] === "+") invalid();
      const end = sql.indexOf("*/", i + 2); if (end < 0) invalid(); i = end + 2; continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      // ANSI_QUOTES changes double quotes from strings to identifiers. The closed verifier
      // sources use single quotes/backticks; do not guess an ambient SQL mode here.
      if (c === '"') invalid();
      i++; let closed = false, value = "";
      while (i < sql.length) {
        const at = sql[i]!;
        if (at === "\\") {
          if (c === "`") invalid();
          if (backslashEscapes) { if (i + 1 >= sql.length) invalid(); i += 2; continue; }
        }
        if (at === c) {
          if (sql[i + 1] === c) { value += c; i += 2; continue; }
          i++; closed = true; break;
        }
        value += at; i++;
      }
      if (!closed) invalid();
      tokens.push({ kind: c === "`" ? "identifier" : "literal", value: c === "`" ? value : sql.slice(start, i), start, end: i }); continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      i++; while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      tokens.push({ kind: "word", value: sql.slice(start, i), start, end: i }); continue;
    }
    tokens.push({ kind: "symbol", value: c, start, end: ++i });
  }
  return tokens;
}

const word = (token: Token | undefined, value: string) => token?.kind === "word" && token.value.toUpperCase() === value;
function identifier(token: Token | undefined): token is Token { return token?.kind === "word" || token?.kind === "identifier"; }
const named = (token: Token | undefined, value: string) => identifier(token) && token.value.toUpperCase() === value.toUpperCase();
const clauses = new Set(["WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "NATURAL", "ON", "USING", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "FOR", "LOCK", "OFFSET", "STRAIGHT_JOIN"]);
const forbidden = new Set(["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "TRUNCATE", "GRANT", "REVOKE", "CALL", "DO", "HANDLER", "LOAD", "OUTFILE", "DUMPFILE", "PREPARE", "EXECUTE", "DEALLOCATE", "LOCK", "UNLOCK", "SIGNAL", "RESIGNAL", "USE", "KILL", "SHUTDOWN"]);
const fields = new Set(SCHEMA_TRIGGER_METADATA_FIELDS.map(field => field.name));
const verifierWords = new Set(("SELECT SET AS FROM JOIN LEFT RIGHT INNER OUTER CROSS NATURAL ON USING WHERE AND OR NOT IS NULL IN LIKE ESCAPE BETWEEN EXISTS "
  + "CASE WHEN THEN ELSE END BINARY COLLATE DISTINCT ALL GROUP BY ORDER ASC DESC HAVING LIMIT OFFSET UNION INTERSECT EXCEPT SEPARATOR "
  + "COUNT SUM MIN MAX IF IFNULL NULLIF COALESCE CONCAT CONCAT_WS GROUP_CONCAT REPLACE TRIM LTRIM RTRIM LOWER UPPER LENGTH OCTET_LENGTH CHAR_LENGTH CHARACTER_LENGTH "
  + "SHA2 CHAR CAST CONVERT UNSIGNED SIGNED INTEGER DECIMAL NUMERIC CHARSET CHARACTER ASCII HEX UNHEX ABS MOD TRUE FALSE X B N "
  + "DATABASE REGEXP_REPLACE").split(" "));
const verifierFunctions = new Set(("COUNT SUM MIN MAX IF IFNULL NULLIF COALESCE CONCAT CONCAT_WS GROUP_CONCAT REPLACE TRIM LTRIM RTRIM LOWER UPPER "
  + "LENGTH OCTET_LENGTH CHAR_LENGTH CHARACTER_LENGTH SHA2 CHAR CAST CONVERT CHARSET ASCII HEX UNHEX ABS MOD DATABASE REGEXP_REPLACE").split(" "));

function aliasIdentifier(token: Token | undefined): token is Token {
  return identifier(token) && (token.kind === "identifier"
    || !clauses.has(token.value.toUpperCase()) && !verifierWords.has(token.value.toUpperCase())
      && !forbidden.has(token.value.toUpperCase()));
}

function checkColumns(tokens: readonly Token[], targets: readonly { index: number; alias: string }[]): void {
  const scopes: (number | undefined)[] = [], stack: (number | undefined)[] = [];
  const parents = new Map<number, number | undefined>();
  let current: number | undefined, nextScope = 0;
  for (const [i, token] of tokens.entries()) {
    if (token.kind === "symbol" && token.value === "(") stack.push(current);
    if (word(token, "SELECT")) { const parent = current; current = nextScope++; parents.set(current, parent); }
    scopes[i] = current;
    if (token.kind === "symbol" && token.value === ")") current = stack.pop();
  }
  const targetScopes = new Set(targets.map(target => scopes[target.index]));
  const targetAliases = new Set(targets.map(target => target.alias.toUpperCase()));
  if (targetScopes.has(undefined)) invalid();
  const hasTargetScope = (scope: number | undefined): boolean => {
    while (scope !== undefined) { if (targetScopes.has(scope)) return true; scope = parents.get(scope); }
    return false;
  };
  const declarations = new Set<number>(), qualified = new Set<number>();
  const qualifiers = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (word(tokens[i], "AS") && identifier(tokens[i + 1])) declarations.add(i + 1);
    if ((word(tokens[i], "FROM") || word(tokens[i], "JOIN")) && identifier(tokens[i + 1])) {
      declarations.add(i + 1);
      qualifiers.add(tokens[i + 1]!.value.toUpperCase());
      let end = i + 1;
      if (tokens[i + 2]?.value === "." && identifier(tokens[i + 3])) {
        declarations.add(i + 3); qualifiers.add(tokens[i + 3]!.value.toUpperCase()); end = i + 3;
      }
      const aliasIndex = word(tokens[end + 1], "AS") ? end + 2 : end + 1;
      if (aliasIdentifier(tokens[aliasIndex])) { declarations.add(aliasIndex); qualifiers.add(tokens[aliasIndex]!.value.toUpperCase()); }
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (identifier(tokens[i]) && tokens[i + 1]?.value === "." && identifier(tokens[i + 2])) {
      qualified.add(i); qualified.add(i + 2);
      // Also reject unknown correlated references in a nested SELECT. Alias shadowing is not a
      // reason to accept an uncalibrated field: such an ambiguous shape must fail closed.
      const matching = targetAliases.has(tokens[i]!.value.toUpperCase());
      if (matching && !fields.has(tokens[i + 2]!.value.toUpperCase())) invalid();
      if (!matching && !qualifiers.has(tokens[i]!.value.toUpperCase()) && tokens[i - 1]?.value !== "@") invalid();
    }
    // A wildcard projection would implicitly request the omitted, uncalibrated I_S columns.
    // COUNT(*) is the sole existing verifier wildcard shape and does not project those columns.
    if (hasTargetScope(scopes[i]) && tokens[i]?.value === "*"
      && !(word(tokens[i - 2], "COUNT") && tokens[i - 1]?.value === "(" && tokens[i + 1]?.value === ")")) invalid();
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!hasTargetScope(scopes[i]) || !identifier(token) || declarations.has(i) || qualified.has(i)
      || tokens[i - 1]?.value === "@") continue;
    if (token.kind === "word" && verifierFunctions.has(token.value.toUpperCase()) && tokens[i + 1]?.value !== "(") invalid();
    if (!fields.has(token.value.toUpperCase()) && !(token.kind === "word" && verifierWords.has(token.value.toUpperCase()))) invalid();
  }
}

function verifierTokens(sql: string): Token[] {
  if (typeof sql !== "string" || sql.length === 0 || Buffer.byteLength(sql, "utf8") > 1024 * 1024 || sql.includes("\0")) invalid();
  const tokens = lex(sql, true), otherMode = lex(sql, false);
  // Do not guess the session's NO_BACKSLASH_ESCAPES setting when quote boundaries differ.
  if (JSON.stringify(tokens) !== JSON.stringify(otherMode)) invalid();
  return tokens;
}

/**
 * An explicit no-relation result is the only permitted passthrough decision in the private
 * schema verifier facade. True also includes unsupported non-FROM/JOIN references, which the
 * rewriter must reject. A codec error is never permission to execute the original query.
 */
export function hasSchemaTriggerMetadataRelation(sql: string): boolean {
  const tokens = verifierTokens(sql);
  return tokens.some((token, i) => named(token, "INFORMATION_SCHEMA") && tokens[i + 1]?.value === "."
    && named(tokens[i + 2], "TRIGGERS"));
}

/**
 * Internal schema-verifier scope only, never a generic connection/query wrapper. Supports the
 * existing read SELECT / single-user-variable SET verifier shapes, not caller SQL or query IDs.
 * Only relation identifier tokens change. All original literals, comments and predicates survive.
 * Unknown/ambiguous shapes throw; there is deliberately no direct-I_S fallback.
 */
export function rewriteSchemaMetadataVerifierSql(sql: string): string {
  const tokens = verifierTokens(sql);
  if (!word(tokens[0], "SELECT") && !word(tokens[0], "SET")) invalid();
  if (word(tokens[0], "SET") && (tokens[1]?.value !== "@" || tokens[2]?.kind !== "word"
    || tokens[3]?.value !== "=" && !(tokens[3]?.value === ":" && tokens[4]?.value === "="))) invalid();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "symbol") {
      if (token.value === "(") { if (++depth > 128) invalid(); }
      if (token.value === ")" && --depth < 0) invalid();
      if (token.value === ";" && i !== tokens.length - 1) invalid();
      if (word(tokens[0], "SET") && depth === 0 && token.value === ",") invalid();
    }
    if (token.kind === "word" && forbidden.has(token.value.toUpperCase())) invalid();
    if (token.value === "@" && named(tokens[i + 1], SCHEMA_TRIGGER_METADATA_VARIABLE.slice(1))) invalid();
  }
  if (depth !== 0) invalid();
  const edits: { start: number; end: number; value: string }[] = [];
  const targets: { index: number; alias: string }[] = [];
  let replacements = 0;
  for (let i = 0; i < tokens.length - 2; i++) {
    if (!named(tokens[i], "INFORMATION_SCHEMA") || tokens[i + 1]?.value !== "." || !named(tokens[i + 2], "TRIGGERS")) continue;
    if (!word(tokens[i - 1], "FROM") && !word(tokens[i - 1], "JOIN") || tokens[i + 3]?.value === ".") invalid();
    const schema = tokens[i]!, dot = tokens[i + 1]!, table = tokens[i + 2]!, next = tokens[i + 3];
    let alias = false;
    let aliasName = table.value;
    if (word(next, "AS")) {
      const target = tokens[i + 4];
      if (!aliasIdentifier(target)) invalid();
      alias = true; aliasName = target.value;
    } else if (identifier(next) && !(next?.kind === "word" && clauses.has(next.value.toUpperCase()))) {
      if (!aliasIdentifier(next) || word(next, "PARTITION") || word(next, "FORCE") || word(next, "IGNORE") || word(next, "INDEX")) invalid();
      alias = true; aliasName = next.value;
    } else if (next && next.kind === "literal") invalid();
    edits.push({ start: schema.start, end: schema.end, value: SCHEMA_TRIGGER_METADATA_RELATION },
      { start: dot.start, end: dot.end, value: "" },
      { start: table.start, end: table.end, value: alias ? "" : ` AS \`${table.value}\`` });
    targets.push({ index: i, alias: aliasName });
    replacements++;
  }
  if (replacements === 0) invalid();
  checkColumns(tokens, targets);
  let result = sql;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}
