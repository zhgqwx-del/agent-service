import { afterEach, describe, expect, it, vi } from "vitest";
import { MysqlSessionStore } from "@agent-service/store";
import { startRunner } from "../src/main.js";

const CONFIG = {
  NODE_ENV: "test", STORE: "mysql", SECRETS_MASTER_KEY: "11".repeat(32),
  MYSQL_URL: "mysql://fixture_runtime:fixture-only@127.0.0.1:3306/agent_service_test_main_schema",
  MYSQL_SCHEMA_METADATA_SCHEMA: "fixture_metadata", MYSQL_SCHEMA_METADATA_DEFINER_USER: "fixture_definer",
  MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost",
};

// Bootstrap wiring only: connect is stopped before any SQL/listener/worker exists.
// Real MySQL permissions and full source/dist startup require independent profiles.
describe("ordinary runner schema authority wiring", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("always passes explicit verify and closed metadata to the public Store without operator authority", async () => {
    const sentinel = new Error("fixture startup stopped before SQL");
    const connect = vi.spyOn(MysqlSessionStore, "connect").mockRejectedValueOnce(sentinel);
    const env = { ...CONFIG, MYSQL_MIGRATION_MODE: "apply" };
    await expect(startRunner(env)).rejects.toBe(sentinel);
    expect(connect).toHaveBeenCalledExactlyOnceWith({ url: CONFIG.MYSQL_URL, migrationMode: "verify",
      schemaMetadata: { metadataSchema: "fixture_metadata", trustedDefiner: { user: "fixture_definer", host: "localhost" } } });
    const metadata = connect.mock.calls[0]?.[0].schemaMetadata;
    expect(Object.isFrozen(metadata)).toBe(true); expect(Object.isFrozen(metadata?.trustedDefiner)).toBe(true);
    env.MYSQL_SCHEMA_METADATA_SCHEMA = "changed_after_start";
    expect(metadata?.metadataSchema).toBe("fixture_metadata");
  });

  it.each(["MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"] as const)
    ("rejects absent %s before opening the Store", async key => {
      const connect = vi.spyOn(MysqlSessionStore, "connect");
      const env: NodeJS.ProcessEnv = { ...CONFIG }; delete env[key];
      await expect(startRunner(env)).rejects.toMatchObject({ code: "mysql_schema_config_invalid" });
      expect(connect).not.toHaveBeenCalled();
    });

  it.each(["SCHEMA_MYSQL_URL", "SCHEMA_METADATA_SCHEMA", "SCHEMA_FLEET_STOPPED_ACK", "AGENT_SERVICE_MIGRATIONS_DIR"])
    ("rejects one-shot or ambient authority %s without native SQL even when empty", async key => {
      const connect = vi.spyOn(MysqlSessionStore, "connect");
      await expect(startRunner({ ...CONFIG, [key]: "" })).rejects.toMatchObject({ code: "mysql_schema_config_invalid" });
      expect(connect).not.toHaveBeenCalled();
    });

  it("does not let metadata settings silently enter a Memory runner", async () => {
    const connect = vi.spyOn(MysqlSessionStore, "connect");
    await expect(startRunner({ ...CONFIG, STORE: "memory" })).rejects.toMatchObject({ code: "mysql_schema_config_invalid" });
    expect(connect).not.toHaveBeenCalled();
  });
});
