import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "mysql2/promise";

const fixture = vi.hoisted(() => ({
  migrationSql: "",
  getConnection: vi.fn(),
  query: vi.fn(),
  end: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", async (loadOriginal) => ({
  ...await loadOriginal<typeof import("node:fs/promises")>(),
  readdir: vi.fn(async () => ["0001_initial.sql", "0054_tenant_telemetry_retained_source.sql"]),
  readFile: vi.fn(async () => fixture.migrationSql),
}));
vi.mock("mysql2/promise", () => ({
  default: {
    createPool: () => ({
      getConnection: fixture.getConnection,
      query: fixture.query,
      end: fixture.end,
    }) as unknown as Pool,
  },
}));

import { MysqlSessionStore } from "../src/mysql/store.js";

const block = (kind: "schema" | "triggers", body =
  `SET @tt_retained_source_${kind}_ok=(SHA2('unit-metadata',256)='${"1".repeat(64)}');`) =>
  `-- agent-service-runtime-fingerprint:tenant-telemetry-retained-source-${kind}:start\n${body}\n`
  + `-- agent-service-runtime-fingerprint:tenant-telemetry-retained-source-${kind}:end\n`;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.getConnection.mockRejectedValue(new Error("test must never acquire a database connection"));
  fixture.query.mockRejectedValue(new Error("test must never issue SQL"));
});

describe("retained-source migration source preflight, no database", () => {
  it.each([
    { name: "unfinished source", sql: "CREATE TABLE draft (id INT);", error: /0054 schema fingerprint markers/ },
    { name: "duplicate schema markers", sql: block("schema") + block("schema") + block("triggers"), error: /0054 schema fingerprint markers/ },
    { name: "multiple statements in schema block", sql: block("schema", "SET @tt_retained_source_schema_ok=1; CREATE TABLE draft (id INT);") + block("triggers"), error: /0054 schema fingerprint block/ },
    { name: "wrong schema variable", sql: block("schema", "SET @unrelated_ok=1;") + block("triggers"), error: /0054 schema fingerprint block/ },
    { name: "missing trigger block", sql: block("schema"), error: /0054 triggers fingerprint markers/ },
    { name: "duplicate trigger markers", sql: block("schema") + block("triggers") + block("triggers"), error: /0054 triggers fingerprint markers/ },
    { name: "multiple statements in trigger block", sql: block("schema") + block("triggers", "SET @tt_retained_source_triggers_ok=1; SELECT 1;"), error: /0054 triggers fingerprint block/ },
    { name: "wrong trigger variable", sql: block("schema") + block("triggers", "SET @unrelated_ok=1;"), error: /0054 triggers fingerprint block/ },
    { name: "uncommitted zero schema root", sql: block("schema", `SET @tt_retained_source_schema_ok=(SHA2('unit-metadata',256)='${"0".repeat(64)}');`) + block("triggers"), error: /0054 schema fingerprint block is not committed/ },
    { name: "uncommitted zero trigger root", sql: block("schema") + block("triggers", `SET @tt_retained_source_triggers_ok=(SHA2('unit-metadata',256)='${"0".repeat(64)}');`), error: /0054 triggers fingerprint block is not committed/ },
    { name: "schema derive sentinel", sql: block("schema", `SET @tt_retained_source_schema_ok=('DERIVE_SCHEMA'='${"1".repeat(64)}');`) + block("triggers"), error: /0054 schema fingerprint block is not committed/ },
    { name: "trigger derive sentinel", sql: block("schema") + block("triggers", `SET @tt_retained_source_triggers_ok=('DERIVE_TRIGGERS'='${"1".repeat(64)}');`), error: /0054 triggers fingerprint block is not committed/ },
    { name: "unconditional schema truth", sql: block("schema", "SET @tt_retained_source_schema_ok=1;") + block("triggers"), error: /0054 schema fingerprint block is not committed/ },
    { name: "unconditional trigger truth", sql: block("schema") + block("triggers", "SET @tt_retained_source_triggers_ok=1;"), error: /0054 triggers fingerprint block is not committed/ },
  ])("rejects $name before even the migration lock or predecessor DDL", async ({ sql, error }) => {
    fixture.migrationSql = sql;
    await expect(MysqlSessionStore.connect({
      url: "mysql://preflight-test@127.0.0.1:1/not_a_database",
      migrationsDir: "/preflight-unit-fixture",
    })).rejects.toThrow(error);
    expect(fixture.getConnection).not.toHaveBeenCalled();
    expect(fixture.query).not.toHaveBeenCalled();
    expect(fixture.end).toHaveBeenCalledTimes(1);
  });

  it("does not inspect an unrelated business placeholder outside the immutable fingerprint blocks", async () => {
    fixture.migrationSql = block("schema") + block("triggers")
      + `SET @unit_business_placeholder='${"0".repeat(64)}';\n`;
    await expect(MysqlSessionStore.connect({
      url: "mysql://preflight-test@127.0.0.1:1/not_a_database",
      migrationsDir: "/preflight-unit-fixture",
    })).rejects.toThrow("test must never acquire a database connection");
    // The mock, not a real database, proves the valid source passed the pre-connection gate.
    expect(fixture.getConnection).toHaveBeenCalledTimes(1);
    expect(fixture.query).not.toHaveBeenCalled();
    expect(fixture.end).toHaveBeenCalledTimes(1);
  });
});
