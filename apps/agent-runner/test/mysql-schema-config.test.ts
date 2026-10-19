import { describe, expect, it, vi } from "vitest";
import { loadMysqlSchemaRuntimeConfig, MysqlSchemaRuntimeConfigError } from "../src/mysql-schema-config.js";

const KEYS = ["MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"] as const;
const CANARY = "private-runtime-authority-canary";
function environment(): NodeJS.ProcessEnv {
  return { MYSQL_SCHEMA_METADATA_SCHEMA: "metadata_fixture", MYSQL_SCHEMA_METADATA_DEFINER_USER: "metadata_reader",
    MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost" };
}
function rejected(env: unknown, ...providedStore: [] | [unknown]) {
  const store = providedStore.length === 0 ? "mysql" : providedStore[0];
  let error: unknown;
  try { loadMysqlSchemaRuntimeConfig(env as NodeJS.ProcessEnv, store as "memory" | "mysql"); }
  catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(MysqlSchemaRuntimeConfigError);
  expect(error).toMatchObject({ name: "MysqlSchemaRuntimeConfigError", code: "mysql_schema_config_invalid",
    message: "MySQL schema runtime configuration is invalid." });
  expect(Object.hasOwn(error as object, "cause")).toBe(false);
  expect(String(error)).not.toContain(CANARY);
  return error;
}

describe("isolated MySQL schema runtime configuration", () => {
  it("requires explicit configuration and returns an independent two-level frozen copy", () => {
    const env = environment(), before = structuredClone(env);
    const config = loadMysqlSchemaRuntimeConfig(env, "mysql");
    expect(config).toEqual({ metadataSchema: "metadata_fixture", trustedDefiner: { user: "metadata_reader", host: "localhost" } });
    expect(Object.isFrozen(config)).toBe(true); expect(Object.isFrozen(config?.trustedDefiner)).toBe(true);
    expect(env).toEqual(before);
    env.MYSQL_SCHEMA_METADATA_SCHEMA = "changed"; env.MYSQL_SCHEMA_METADATA_DEFINER_USER = "changed";
    expect(config?.metadataSchema).toBe("metadata_fixture"); expect(config?.trustedDefiner.user).toBe("metadata_reader");
  });

  it("accepts readonly and null-prototype environments without mutating descriptors", () => {
    const env = Object.freeze(environment()), before = Object.getOwnPropertyDescriptors(env);
    expect(loadMysqlSchemaRuntimeConfig(env, "mysql")?.metadataSchema).toBe("metadata_fixture");
    expect(Object.getOwnPropertyDescriptors(env)).toEqual(before);
    expect(loadMysqlSchemaRuntimeConfig(Object.assign(Object.create(null), env), "mysql"))
      .toEqual(loadMysqlSchemaRuntimeConfig(env, "mysql"));
  });

  it("memory needs no metadata and does not inspect unrelated runtime values", () => {
    const getter = vi.fn(() => { throw new Error(CANARY); }), env: NodeJS.ProcessEnv = { MYSQL_URL: CANARY, REDIS_URL: CANARY };
    Object.defineProperty(env, "UNRELATED_SECRET", { enumerable: true, get: getter });
    expect(loadMysqlSchemaRuntimeConfig(env, "memory")).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
  });

  it.each(KEYS)("memory rejects every provided %s even empty or undefined", key => {
    for (const value of [undefined, "", "metadata_fixture"]) rejected({ [key]: value }, "memory");
  });

  it.each(KEYS)("mysql rejects absent/empty/undefined/non-string %s with no defaults", key => {
    const missing = environment(); delete missing[key]; rejected(missing);
    for (const value of [undefined, "", null, 1, true]) rejected({ ...environment(), [key]: value });
  });

  it.each([
    ["MYSQL_SCHEMA_METADATA_SCHEMA", "Upper"], ["MYSQL_SCHEMA_METADATA_SCHEMA", "1meta"],
    ["MYSQL_SCHEMA_METADATA_SCHEMA", "bad.schema"], ["MYSQL_SCHEMA_METADATA_SCHEMA", "bad-schema"],
    ["MYSQL_SCHEMA_METADATA_SCHEMA", "s".repeat(65)], ["MYSQL_SCHEMA_METADATA_SCHEMA", "中"],
    ["MYSQL_SCHEMA_METADATA_DEFINER_USER", "x".repeat(33)], ["MYSQL_SCHEMA_METADATA_DEFINER_USER", "u@h"],
    ["MYSQL_SCHEMA_METADATA_DEFINER_USER", "bad\nuser"], ["MYSQL_SCHEMA_METADATA_DEFINER_USER", "\ud800"],
    ["MYSQL_SCHEMA_METADATA_DEFINER_HOST", "x".repeat(256)], ["MYSQL_SCHEMA_METADATA_DEFINER_HOST", "h@other"],
    ["MYSQL_SCHEMA_METADATA_DEFINER_HOST", "bad\u007fhost"], ["MYSQL_SCHEMA_METADATA_DEFINER_HOST", "\udc00"],
  ] as const)("rejects malformed %s", (key, value) => { rejected({ ...environment(), [key]: value }); });

  it("preserves exact Unicode/account spelling at reader character and UTF8 bounds", () => {
    const env = { MYSQL_SCHEMA_METADATA_SCHEMA: "s".repeat(64), MYSQL_SCHEMA_METADATA_DEFINER_USER: "😀".repeat(32),
      MYSQL_SCHEMA_METADATA_DEFINER_HOST: "中".repeat(255) };
    expect(loadMysqlSchemaRuntimeConfig(env, "mysql")).toEqual({ metadataSchema: "s".repeat(64),
      trustedDefiner: { user: "😀".repeat(32), host: "中".repeat(255) } });
    const exact = { ...environment(), MYSQL_SCHEMA_METADATA_DEFINER_USER: "é", MYSQL_SCHEMA_METADATA_DEFINER_HOST: "e\u0301" };
    expect(loadMysqlSchemaRuntimeConfig(exact, "mysql")?.trustedDefiner).toEqual({ user: "é", host: "e\u0301" });
  });

  it.each(["MYSQL_SCHEMA_METADATA_FUTURE", "MYSQL_SCHEMA_METADATA_PASSWORD", "MYSQL_SCHEMA_METADATA_"])
    ("rejects unknown metadata family key %s in either Store, including hidden/empty values", key => {
      for (const store of ["memory", "mysql"] as const) {
        rejected({ ...environment(), [key]: "" }, store);
        const hidden = environment(); Object.defineProperty(hidden, key, { value: CANARY }); rejected(hidden, store);
      }
    });

  it.each(KEYS)("rejects getter/hidden %s without evaluating or borrowing inherited authority", key => {
    const getter = vi.fn(() => { throw new Error(CANARY); }), env = environment();
    Object.defineProperty(env, key, { enumerable: true, get: getter }); rejected(env);
    expect(getter).not.toHaveBeenCalled();
    const hidden = environment(); Object.defineProperty(hidden, key, { value: "value", enumerable: false }); rejected(hidden);
    const inherited = environment(); delete inherited[key]; Object.setPrototypeOf(inherited, { [key]: "value" }); rejected(inherited);
  });

  it.each(["SCHEMA_MYSQL_URL", "SCHEMA_FLEET_STOPPED_ACK", "SCHEMA_OPERATION_TIMEOUT_MS", "SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS",
    "SCHEMA_METADATA_SCHEMA", "SCHEMA_FUTURE_AUTHORITY", "AGENT_SERVICE_MIGRATIONS_DIR"])
    ("rejects one-shot/directory authority %s by presence, never by its value", key => {
      for (const store of ["memory", "mysql"] as const) {
        for (const value of [undefined, "", CANARY]) rejected({ ...(store === "mysql" ? environment() : {}), [key]: value }, store);
      }
    });

  it("rejects even hidden or accessor one-shot authority without reading it", () => {
    const getter = vi.fn(() => { throw new Error(CANARY); }), env = environment();
    Object.defineProperty(env, "SCHEMA_MYSQL_URL", { get: getter }); rejected(env);
    const directory = environment(); Object.defineProperty(directory, "AGENT_SERVICE_MIGRATIONS_DIR", { get: getter }); rejected(directory);
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not use operator URLs, raw JSON config, or ordinary connection credentials as metadata defaults", () => {
    rejected({ MYSQL_URL: CANARY });
    rejected({ MYSQL_SCHEMA_METADATA_CONFIG_JSON: JSON.stringify(environment()) });
    const env = environment(); Object.defineProperty(env, "MYSQL_URL", { get: () => { throw new Error(CANARY); } });
    expect(loadMysqlSchemaRuntimeConfig(env, "mysql")?.trustedDefiner.user).toBe("metadata_reader");
  });

  it.each([{ env: null }, { env: undefined }, { env: [] }, { env: "env" }])
    ("rejects invalid environment shapes with fixed diagnostics: %j", ({ env }) => { rejected(env); });
  it.each([undefined, null, "file", "MYSQL", 1])("rejects an invalid Store discriminator: %j", store => { rejected(environment(), store); });

  it("sanitizes descriptor/proxy errors rather than retaining their cause", () => {
    const env = new Proxy({}, { ownKeys: () => { throw new Error(CANARY, { cause: { url: CANARY } }); } });
    const error = rejected(env); expect(Object.keys(error as object)).toEqual(["code", "name"]);
  });
});
