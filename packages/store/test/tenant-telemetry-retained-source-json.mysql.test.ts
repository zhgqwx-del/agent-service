import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantTelemetryRetainedSourceCanonicalJson } from "../src/tenant-telemetry-retained-source.js";
import {
  buildDiagnose0054T1Entry,
  DIAGNOSE_0054_NUMERIC_INPUTS,
  diagnose0054JsonGuardFixture,
  diagnose0054JsonGuardSourcePlan,
  parseDiagnose0054BaseUrl,
} from "./fixtures/diagnose0054-json-guard.js";

// This suite tests MySQL's SELECT-only JSON/numeric semantics against the
// reviewed 0054 T1 predicate. It is not a source-authority, migration,
// deletion, fleet, S3, or grant test. No .env file or Store is loaded.
const rawBase = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL;
const integrationEnabled = Boolean(process.env.AGENT_SERVICE_INTEGRATION && rawBase);
const describeMysql = integrationEnabled ? describe : describe.skip;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const MATRIX_MODES = ["bound_parameters", "actual_ddl_types", "varchar96_probe"] as const;
const MATRIX_CASES = [false, true].flatMap((epoch) =>
  (["written_ack", "pending"] as const).flatMap((state) =>
    MATRIX_MODES.map((scalarMode) => ({ epoch, state, scalarMode })),
  ),
).map((value, offset) => ({ ...value, index: offset + 1 }));
const DATABASE_NAME = /^agent_service_test_0054_json_[0-9]+_[0-9a-f]{20}$/;

function exactRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("0054 JSON diagnostic returned a non-object row");
  }
  return value as Record<string, unknown>;
}
function exactArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("0054 JSON diagnostic returned a non-array result");
  return value;
}
function isolatedDatabaseName(): string {
  if (!Number.isSafeInteger(process.pid) || process.pid < 1 || process.pid > 2_147_483_647) {
    throw new Error("unsafe 0054 JSON fixture process identifier");
  }
  const name = `agent_service_test_0054_json_${process.pid}_${randomBytes(10).toString("hex")}`;
  if (name.length > 64 || !DATABASE_NAME.test(name)) {
    throw new Error("unsafe 0054 JSON fixture database name");
  }
  return name;
}

describeMysql("0054 real-MySQL SELECT-only JSON guard contract", () => {
  let admin: Connection | undefined;
  let databaseName = "";
  let created = false;
  let diagnostic: Record<string, unknown> | undefined;
  let sourceSql = "";
  let plan: ReturnType<typeof diagnose0054JsonGuardSourcePlan> | undefined;

  function requiredPlan(): ReturnType<typeof diagnose0054JsonGuardSourcePlan> {
    if (!plan) throw new Error("0054 reviewed SQL predicate plan was not loaded");
    return plan;
  }

  function proof(): Record<string, unknown> {
    if (!diagnostic) throw new Error("0054 JSON diagnostic did not complete");
    expect(diagnostic).toMatchObject({
      schema: "agent-service-diagnose0054-json-guard-fixture-v1",
      readOnly: true,
      fixtureOnly: true,
      databaseMutated: false,
      businessTablesRead: false,
      productionAccepted: false,
      success: true,
      conjunctionCount: 24,
      matrixCaseCount: 12,
      numericInputCount: 13,
    });
    expect(diagnostic.sourceSha256).toBe(sha(sourceSql));
    expect(diagnostic.guardActionSha256).toBe(requiredPlan().actionSha256);
    const sourceConditionSha256 = sha(requiredPlan().dynamicCounterInvalidCondition);
    expect(sourceConditionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnostic.dynamicConditionSha256).toBe(sourceConditionSha256);
    return diagnostic;
  }

  beforeAll(async () => {
    if (!rawBase) throw new Error("MYSQL_MIGRATION_TEST_URL or MYSQL_TEST_URL is required");
    const base = parseDiagnose0054BaseUrl(rawBase);
    sourceSql = readFileSync(new URL("../migrations/0054_tenant_telemetry_retained_source.sql", import.meta.url), "utf8");
    plan = diagnose0054JsonGuardSourcePlan(sourceSql);
    expect(plan.predicates).toHaveLength(24);
    databaseName = isolatedDatabaseName();
    const adminUrl = new URL(base);
    adminUrl.pathname = "/mysql";
    admin = await mysql.createConnection(adminUrl.toString());
    const [before] = await admin.query<RowDataPacket[]>(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [databaseName],
    );
    expect(before).toHaveLength(0);
    // No IF NOT EXISTS: a competing owner of this exact random name must make
    // CREATE fail, never be silently adopted and later dropped.
    const [ack] = await admin.query<mysql.ResultSetHeader>(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4`,
    );
    created = true;
    expect(ack.warningStatus).toBe(0);
    const [after] = await admin.query<RowDataPacket[]>(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [databaseName],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe(databaseName);
    const fixtureUrl = new URL(base);
    fixtureUrl.pathname = `/${databaseName}`;
    diagnostic = await diagnose0054JsonGuardFixture(fixtureUrl.toString());
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    try {
      if (created) {
        if (databaseName.length > 64 || !DATABASE_NAME.test(databaseName)) {
          throw new Error("refusing to remove an unowned 0054 JSON fixture database");
        }
        await admin.query(`DROP DATABASE \`${databaseName}\``);
      }
    } finally {
      await admin.end();
    }
  }, 120_000);

  it.each(MATRIX_CASES)(
    "checks all 24 SQL predicates and exact preimage for matrix case $index ($scalarMode)",
    ({ index, epoch, state, scalarMode }) => {
      const result = exactArray(proof().results);
      expect(result).toHaveLength(12);
      const row = exactRecord(result[index - 1]);
      expect(row.index).toBe(index);
      expect(row.epoch).toBe(epoch);
      expect(row.nullable).toBe(state === "pending");
      expect(row.scalarMode).toBe(scalarMode);
      const checks = exactArray(row.checks);
      expect(checks).toHaveLength(24);
      for (const [offset, rawCheck] of checks.entries()) {
        const check = exactRecord(rawCheck);
        expect(check.index).toBe(offset + 1);
        expect(check.expressionSha256).toBe(sha(requiredPlan().predicates[offset]!));
        expect(check.value).toBe(1);
      }
      expect(row.allConjunctsTrue).toBe(true);
      const entry = buildDiagnose0054T1Entry({ epoch, state });
      const { receiptSha256, ...body } = entry;
      const preimage = `${entry.scope}\0${tenantTelemetryRetainedSourceCanonicalJson(body)}`;
      expect(row.expectedHash).toBe(receiptSha256);
      expect(row.expectedPreimageHash).toBe(sha(preimage));
      expect(row.actualHash).toBe(receiptSha256);
      expect(row.hashMatches).toBe(true);
      expect(row.expectedPreimageLength).toBe(Buffer.byteLength(preimage));
      expect(row.actualPreimageLength).toBe(Buffer.byteLength(preimage));
      const types = exactRecord(row.numericJsonTypes);
      expect(types.subjectGeneration).toBe("INTEGER");
      expect(types.sourceHighWater).toBe(epoch ? "UNSIGNED INTEGER" : "INTEGER");
      expect(types.capturedAt).toBe(epoch ? "UNSIGNED INTEGER" : "INTEGER");
      // The former INTEGER-only guard rejects epoch millisecond values even
      // though the bounded INTEGER-or-UNSIGNED INTEGER contract accepts them.
      expect(row.capturedTypePassesIntegerOnly).toBe(epoch ? 0 : 1);
      expect(row.capturedTypePassesCompatibleInteger).toBe(1);
    },
  );

  it.each(DIAGNOSE_0054_NUMERIC_INPUTS)(
    "checks bounded MySQL numeric vector $index independently of fixture success",
    (input) => {
      const result = exactArray(proof().numericInputs);
      expect(result).toHaveLength(13);
      const row = exactRecord(result[input.index - 1]);
      expect(row.index).toBe(input.index);
      expect(row.inputSha256).toBe(sha(input.json));
      expect(row.inputLength).toBe(Buffer.byteLength(input.json));
      expect(row.expectedAccepted).toBe(input.expectedAccepted);
      expect(row.boundedCounter).toBe(input.expectedAccepted ? 1 : 0);
      const expectedDynamicInvalid = input.index <= 5 ? 0 : 1;
      expect(input.expectedAccepted).toBe(expectedDynamicInvalid === 0);
      expect(row.expectedDynamicInvalid).toBe(expectedDynamicInvalid);
      // This is the observed MySQL result of the exact negative condition
      // extracted from the source trigger, not a parser-only acceptance claim.
      expect(row.dynamicInvalid).toBe(expectedDynamicInvalid);
      expect(row.dynamicInvalid).toBe(row.expectedDynamicInvalid);
      const sourceConditionSha256 = sha(requiredPlan().dynamicCounterInvalidCondition);
      expect(row.dynamicConditionSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.dynamicConditionSha256).toBe(sourceConditionSha256);
      expect(row.dynamicConditionSha256).toBe(proof().dynamicConditionSha256);
      if (input.index === 4) {
        expect(row.jsonType).toBe("UNSIGNED INTEGER");
        expect(row.integerOnly).toBe(0);
      }
    },
  );
});
