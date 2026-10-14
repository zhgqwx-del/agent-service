import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  derive0054SourcePlan,
  derive0054DatabaseName,
  parseDerive0054Arguments,
  parseDerive0054BaseUrl,
} from "./fixtures/derive0054-fingerprint.js";

// Importing this fixture must not connect, execute DDL, or require environment
// variables. These tests validate only its closed, fixture-only input grammar.
const sql = readFileSync(new URL("../migrations/0054_tenant_telemetry_retained_source.sql", import.meta.url), "utf8");

describe("0054 fixture-only fingerprint derivation input", () => {
  it("keeps even the largest supported PID below the MySQL identifier limit", () => {
    const name = derive0054DatabaseName(2_147_483_647, "ab".repeat(16));
    expect(name).toHaveLength(61);
    expect(name).toMatch(/^agent_service_derive0054_test_2147483647_[0-9a-f]{20}$/);
    expect(derive0054DatabaseName(1, "01".repeat(16))).not.toBe(name);
  });
  it.each([0, -1, 1.5, 2_147_483_648, Number.NaN])("rejects an unsafe PID %s before CREATE", (pid) => {
    expect(() => derive0054DatabaseName(pid, "a".repeat(32))).toThrow();
  });
  it.each(["a".repeat(31), "A".repeat(32), "../" + "a".repeat(29)])("rejects an unsafe random suffix %s", (value) => {
    expect(() => derive0054DatabaseName(42, value)).toThrow();
  });
  it("requires a single explicit derivation flag and keeps help separate", () => {
    expect(parseDerive0054Arguments(["--derive-isolated-0054"])).toBe("derive");
    expect(parseDerive0054Arguments(["--help"])).toBe("help");
  });

  it.each([
    { args: [] },
    { args: ["--derive"] },
    { args: ["--derive-isolated-0054", "--help"] },
    { args: ["--derive-isolated-0054", "--database=agent_service"] },
    { args: ["--derive-isolated-0054", "--derive-isolated-0054"] },
  ])("rejects ambiguous or extensible arguments $args", ({ args }) => {
    expect(() => parseDerive0054Arguments(args)).toThrow();
  });

  it.each([
    "mysql://root@127.0.0.1:3306/agent_service_test",
    "mysql://root@localhost/agent_service_test_0054_derive",
    "mysql://root@[::1]/agent_service_migration_test",
  ])("accepts only a local disposable base: %s", (raw) => {
    expect(parseDerive0054BaseUrl(raw).toString()).toBe(raw);
  });

  it.each([
    "mysql://root@db.example/agent_service_test",
    "mysql://root@127.0.0.1/agent_service",
    "mysql://root@127.0.0.1/mysql",
    "mysql://root@127.0.0.1/agent_service_test/another",
    "mysql://root@127.0.0.1/agent_service_test%2Fanother",
    "mysql://root@127.0.0.1/agent_service_test?multipleStatements=true",
    "mysql://root@127.0.0.1/agent_service_test#fragment",
    "mysql://root@127.0.0.1/agent_service_test_%ZZ",
    "mysql://root@127.0.0.1/AGENT_SERVICE_TEST",
    "mysql://root@127.0.0.1/agent_service_test-unsafe",
    "postgres://root@127.0.0.1/agent_service_test",
    "not-a-url",
  ])("rejects non-local, non-test, or connection-option input: %s", (raw) => {
    expect(() => parseDerive0054BaseUrl(raw)).toThrow();
  });

  it("extracts only reviewed DDL and observes rather than trusts digest constants", () => {
    const plan = derive0054SourcePlan(sql);
    expect(plan.install.length).toBeGreaterThan(0);
    expect(plan.install.filter((statement) => statement.startsWith("CREATE TABLE "))).toHaveLength(9);
    expect(plan.install.filter((statement) => statement.startsWith("CREATE TRIGGER "))).toHaveLength(62);
    expect(plan.schema).toHaveLength(9);
    expect(plan.schema.filter((query) => query.metrics.some((metric) => metric.hash))).toHaveLength(7);
    expect(plan.triggers.metrics.filter((metric) => metric.hash)).toHaveLength(1);
    expect(plan.install.some((statement) => /schema_migrations|INSERT INTO|DELETE FROM|SET SESSION/.test(statement))).toBe(false);
    for (const projection of [...plan.schema, plan.triggers]) {
      expect(projection.query).toMatch(/^SELECT .+ FROM information_schema\./s);
      expect(projection.query).not.toMatch(/='[0-9a-f]{64}'/);
    }
    const alternate = sql.replaceAll(/'[0-9a-f]{64}'/g, `'${"1".repeat(64)}'`);
    expect(derive0054SourcePlan(alternate)).toEqual(plan);
  });

  it.each([
    { name: "business INSERT", alter: (value: string) => value.replace("SET @tt_retained_source_previous_group_concat_max_len", "INSERT INTO sessions(session_id) VALUES('fixture-invalid');\nSET @tt_retained_source_previous_group_concat_max_len") },
    { name: "unreviewed table", alter: (value: string) => value.replace("CREATE TABLE IF NOT EXISTS tenant_telemetry_retained_source_t1_entries", "CREATE TABLE IF NOT EXISTS unreviewed_table") },
    { name: "unreviewed trigger", alter: (value: string) => value.replace("CREATE TRIGGER trg_tt_retained_admission_bi", "CREATE TRIGGER unreviewed_trigger") },
    { name: "missing schema marker", alter: (value: string) => value.replace("-- agent-service-runtime-fingerprint:tenant-telemetry-retained-source-schema:start", "-- absent-schema-marker") },
    { name: "missing trigger marker", alter: (value: string) => value.replace("-- agent-service-runtime-fingerprint:tenant-telemetry-retained-source-triggers:end", "-- absent-trigger-marker") },
    { name: "duplicate marker", alter: (value: string) => value + "\n-- agent-service-runtime-fingerprint:tenant-telemetry-retained-source-schema:start\n" },
  ])("rejects a changed source plan before any database work: $name", ({ alter }) => {
    expect(() => derive0054SourcePlan(alter(sql))).toThrow();
  });
});
