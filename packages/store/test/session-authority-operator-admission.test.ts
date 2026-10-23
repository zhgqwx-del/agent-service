import { createHash } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { captureSessionAuthorityBindingCommand, prepareSessionAuthorityBindingCommand } from "../src/mysql/session-authority-binding.js";
import { SchemaRuntimePrivilegesError } from "../src/mysql/schema-runtime-privileges.js";
import { assertSessionAuthorityActivationAdmission, SessionAuthorityActivationAdmissionError } from "../src/mysql/session-authority-operator-admission.js";

// Synthetic native-query refusal tests. Actual grants/visibility/DDL semantics require MySQL.
const UUID = "33333333-3333-4333-8333-333333333333", DB = "authority_operator_test";
const config = { metadataSchema: "authority_metadata_test", trustedDefiner: { user: "metadata_definer", host: "localhost" } };
const account = (name: string) => "`" + name + "`@`localhost`";
const currentCommand = () => captureSessionAuthorityBindingCommand(prepareSessionAuthorityBindingCommand({
  bindingId: "11111111-1111-4111-8111-111111111111", activationId: "22222222-2222-4222-8222-222222222222",
  expectedBindingId: null, expectedSequence: 0, serverUuid: UUID, applicationDatabase: DB,
  newAccounts: [{ user: "runtime_new", host: "localhost" }], oldAccountNames: ["runtime_old"],
  activationEvidenceSha256: "a".repeat(64), nextEpoch: null,
  expectedSource: { kind: "inactive", runtimeControlGeneration: 0, runtimeControlEvidenceSha256: null,
    runtimeEpochSha256: null, restoreRunId: null, replayReceiptSha256: null },
}));
type Fault = "none" | "visibility" | "old-unlocked" | "old-grant" | "old-thread" | "unknown-transaction"
  | "role" | "reverse-proxy" | "new-readonly-write" | "namespace";
function fixture(fault: Fault = "none") {
  const statements: string[] = [];
  const tables = ["schema_migrations", "session_authority_control", "session_authority_bindings", "session_authority_runtime_accounts", "sessions"];
  const routine = createHash("sha256").update(DB).digest("hex");
  const readonly = new Set(tables.slice(0, 4));
  const runtimeGrants = ["GRANT USAGE ON *.* TO " + account("runtime_new"),
    "GRANT SHOW_ROUTINE ON *.* TO " + account("runtime_new"),
    ...tables.map(table => "GRANT " + (readonly.has(table) ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE")
      + " ON `" + DB + "`.`" + table + "` TO " + account("runtime_new")),
    "GRANT EXECUTE ON PROCEDURE `" + config.metadataSchema + "`.`" + routine + "` TO " + account("runtime_new")];
  if (fault === "new-readonly-write") runtimeGrants.push("GRANT UPDATE ON `" + DB + "`.`session_authority_control` TO " + account("runtime_new"));
  const conn = { async query(sql: string) {
    statements.push(sql);
    let rows: unknown[];
    if (sql.startsWith("SELECT DATABASE()")) rows = [{ application_database: fault === "namespace" ? "other_test" : DB,
      server_uuid: UUID, current_account: "operator@localhost", login_account: "operator@localhost",
      active_roles: "NONE", mandatory_roles: "", proxy_account: null }];
    else if (sql.includes("Process_priv")) rows = [{ User: "operator", Host: "localhost", account_locked: "N", Process_priv: fault === "visibility" ? "N" : "Y" }];
    else if (sql.startsWith("SHOW GRANTS")) {
      const name = sql.includes("`runtime_old`") ? "runtime_old" : "runtime_new";
      const grants = name === "runtime_old" ? ["GRANT USAGE ON *.* TO " + account(name),
        ...(fault === "old-grant" ? ["GRANT SELECT ON `" + DB + "`.`sessions` TO " + account(name)] : [])] : runtimeGrants;
      rows = grants.map(grant => ({ ["Grants for " + name + "@localhost"]: grant }));
    } else if (sql.includes("FROM mysql.user") && sql.includes("password_expired")) rows = [{ User: "runtime_new", Host: "localhost", account_locked: "N", password_expired: "N" }];
    else if (sql.includes("FROM mysql.user")) rows = [{ User: "runtime_old", Host: "localhost", account_locked: fault === "old-unlocked" ? "N" : "Y" }];
    else if (sql.includes("FROM mysql.role_edges")) rows = fault === "role" ? [{ FROM_USER: "role", FROM_HOST: "%", TO_USER: "runtime_old", TO_HOST: "localhost" }] : [];
    else if (sql.includes("FROM mysql.default_roles")) rows = [];
    else if (sql.includes("FROM mysql.proxies_priv")) rows = fault === "reverse-proxy" && sql.includes("OR BINARY Proxied_user")
      ? [{ User: "another", Host: "localhost", Proxied_user: "runtime_old", Proxied_host: "localhost" }] : [];
    else if (sql.includes("FROM information_schema.INNODB_TRX")) rows = fault === "unknown-transaction" ? [{ trx_id: "11", trx_mysql_thread_id: 99 }] : [];
    else if (sql.includes("FROM performance_schema.threads")) rows = fault === "old-thread" ? [{ PROCESSLIST_ID: 99, PROCESSLIST_USER: "runtime_old" }] : [];
    else if (sql.includes("FROM information_schema.TABLES")) rows = tables.map(base_table_name => ({ base_table_name }));
    else throw Error("unexpected synthetic query");
    return [rows, []];
  } } as unknown as PoolConnection;
  return { conn, statements };
}
describe("native session authority activation admission", () => {
  it("uses read-only native evidence twice and never performs transaction control or account mutation", async () => {
    const f = fixture();
    await assertSessionAuthorityActivationAdmission(f.conn, currentCommand(), config);
    expect(f.statements.filter(sql => sql.startsWith("SELECT DATABASE()"))).toHaveLength(2);
    expect(f.statements.filter(sql => sql.includes("FROM information_schema.INNODB_TRX"))).toHaveLength(2);
    expect(f.statements.filter(sql => sql.includes("FROM information_schema.TABLES"))).toHaveLength(2);
    expect(f.statements.every(sql => /^(?:SELECT|SHOW GRANTS)\b/.test(sql))).toBe(true);
  });
  it.each([
    ["visibility", "operator_visibility"], ["old-unlocked", "retired_account_active"], ["old-grant", "retired_account_grants"],
    ["old-thread", "retired_connection"], ["unknown-transaction", "retired_connection"],
    ["role", "role_or_proxy_path"], ["reverse-proxy", "role_or_proxy_path"], ["namespace", "namespace_changed"],
  ] as const)("refuses %s native evidence with an exact reason", async (fault, reason) => {
    const f = fixture(fault);
    await expect(assertSessionAuthorityActivationAdmission(f.conn, currentCommand(), config))
      .rejects.toMatchObject({ code: "session_authority_activation_admission_failed", reason });
  });
  it("refuses a new runtime principal with control UPDATE authority", async () => {
    const f = fixture("new-readonly-write");
    await expect(assertSessionAuthorityActivationAdmission(f.conn, currentCommand(), config)).rejects.toBeInstanceOf(SchemaRuntimePrivilegesError);
    expect(f.statements.some(sql => sql.startsWith("SHOW GRANTS FOR `runtime_new`"))).toBe(true);
    // The exact closed-grant validator owns this failure; no mutation is used to repair it.
    expect(f.statements.every(sql => /^(?:SELECT|SHOW GRANTS)\b/.test(sql))).toBe(true);
  });
  it("never serializes queried grants, accounts or native errors in its own error message", () => {
    const error = new SessionAuthorityActivationAdmissionError("retired_connection");
    expect(error.message).toBe("Session authority activation admission failed.");
    expect(error.code).toBe("session_authority_activation_admission_failed");
  });
});
