import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildClusterChildEnv } from "./harness.js";

function readChildEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): Record<string, string | null> {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const keys=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key)=>[key,process.env[key]??null]))));",
      JSON.stringify(keys),
    ],
    { env, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string | null>;
}

describe("cluster child environment isolation", () => {
  it("removes all explicit schema operator and ambient directory authority from both roles", () => {
    const operator = { SCHEMA_MYSQL_URL: "fixture-operator-dsn", SCHEMA_FLEET_STOPPED_ACK: "fixture-operator-ack",
      SCHEMA_METADATA_SCHEMA: "fixture-operator-metadata", SCHEMA_FUTURE_AUTHORITY: "fixture-future-authority",
      AGENT_SERVICE_MIGRATIONS_DIR: "fixture-never-read-directory" };
    const runtime = { MYSQL_URL: "fixture-runtime-dsn", MYSQL_SCHEMA_METADATA_SCHEMA: "fixture_metadata",
      MYSQL_SCHEMA_METADATA_DEFINER_USER: "fixture_definer", MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost" };
    for (const role of ["runner", "router"] as const) {
      const child = buildClusterChildEnv({ PATH: process.env.PATH }, { ...operator, ...runtime }, role);
      expect(readChildEnv(child, Object.keys(operator))).toEqual(Object.fromEntries(Object.keys(operator).map(key => [key, null])));
      expect(readChildEnv(child, Object.keys(runtime))).toEqual(role === "runner" ? runtime
        : Object.fromEntries(Object.keys(runtime).map(key => [key, null])));
    }
  });
  it("retains only the two runtime-extension activation flags in a router child", () => {
    const explicit = { LIFECYCLE_HOOKS_ENABLED: "1", SUBAGENTS_ENABLED: "1", LIFECYCLE_HOOKS_CONFIG_JSON: "fixture-only-json",
      LIFECYCLE_HOOKS_TIMEOUT_MS: "1000", SUBAGENTS_MAX_DEPTH: "3", SUBAGENTS_MAX_CONCURRENT: "2", SUBAGENTS_MAX_TASKS: "8",
      LIFECYCLE_HOOKS_FUTURE_AUTHORITY: "fixture-only-authority", SUBAGENTS_FUTURE_AUTHORITY: "fixture-only-authority" };
    const router = buildClusterChildEnv({ PATH: process.env.PATH }, explicit, "router");
    expect(readChildEnv(router, Object.keys(explicit))).toEqual(Object.fromEntries(Object.keys(explicit).map(key => [key,
      key === "LIFECYCLE_HOOKS_ENABLED" || key === "SUBAGENTS_ENABLED" ? "1" : null])));
    const runner = buildClusterChildEnv({ PATH: process.env.PATH }, explicit, "runner");
    expect(readChildEnv(runner, Object.keys(explicit))).toEqual(explicit);
  });
  it("removes inherited external authority before applying an explicit runner fixture", () => {
    const inherited: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      API_KEY: "inherited-provider-marker",
      AWS_PROFILE: "inherited-aws-marker",
      BLOB_S3_ENDPOINT: "https://inherited-blob.invalid",
      MINIO_ROOT_PASSWORD: "inherited-minio-marker",
      MYSQL_URL: "mysql://inherited.invalid/cluster",
      RESTORE_JOURNAL_ADAPTER: "inherited-adapter",
      RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY: "inherited-journal-marker",
      S3_TEST_ENDPOINT: "https://inherited-test.invalid",
      TENANT_DATABASE_PURGE_WORKER_ENABLED: "1",
      TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "1",
      TENANT_ERASURE_OPERATOR_TOKEN: "inherited-router-marker",
      UNLISTED_APPLICATION_GATE: "inherited-unlisted-marker",
    };
    const env = buildClusterChildEnv(inherited, {
      API_KEY: "fixture-provider-marker",
      BLOB_S3_ENDPOINT: "http://fixture-blob.invalid",
      MYSQL_URL: "mysql://fixture.invalid/cluster",
      RESTORE_JOURNAL_ADAPTER: "s3",
      TENANT_DATABASE_PURGE_WORKER_ENABLED: "0",
      TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "0",
    }, "runner");

    expect(readChildEnv(env, [
      "API_KEY",
      "AWS_PROFILE",
      "BLOB_S3_ENDPOINT",
      "MINIO_ROOT_PASSWORD",
      "MYSQL_URL",
      "NODE_ENV",
      "RESTORE_JOURNAL_ADAPTER",
      "RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY",
      "S3_TEST_ENDPOINT",
      "TENANT_DATABASE_PURGE_WORKER_ENABLED",
      "TENANT_ERASURE_OPERATOR_TOKEN",
      "TENANT_RESTORE_JOURNAL_WORKER_ENABLED",
      "UNLISTED_APPLICATION_GATE",
    ])).toEqual({
      API_KEY: "fixture-provider-marker",
      AWS_PROFILE: null,
      BLOB_S3_ENDPOINT: "http://fixture-blob.invalid",
      MINIO_ROOT_PASSWORD: null,
      MYSQL_URL: "mysql://fixture.invalid/cluster",
      NODE_ENV: "test",
      RESTORE_JOURNAL_ADAPTER: "s3",
      RESTORE_JOURNAL_S3_SECRET_ACCESS_KEY: null,
      S3_TEST_ENDPOINT: null,
      TENANT_DATABASE_PURGE_WORKER_ENABLED: "0",
      TENANT_ERASURE_OPERATOR_TOKEN: null,
      TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "0",
      UNLISTED_APPLICATION_GATE: null,
    });
  });

  it("keeps only explicit router-safe Blob and restore-journal identity", () => {
    const inherited: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      AWS_ACCESS_KEY_ID: "inherited-aws-marker",
      BLOB_S3_ACCESS_KEY_ID: "inherited-blob-marker",
      BLOB_S3_BUCKET: "inherited-bucket",
      MINIO_ROOT_USER: "inherited-minio-marker",
      MYSQL_URL: "mysql://inherited.invalid/cluster",
      RESTORE_JOURNAL_NAMESPACE_SHA256: "0".repeat(64),
      RESTORE_JOURNAL_S3_ENDPOINT: "https://inherited-journal.invalid",
      TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "1",
    };
    const env = buildClusterChildEnv(inherited, {
      BLOB_S3_BUCKET: "fixture-bucket",
      BLOB_S3_PREFIX: "fixture-prefix",
      RESTORE_JOURNAL_ADAPTER: "s3",
      RESTORE_JOURNAL_NAMESPACE_SHA256: "1".repeat(64),
      RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256: "2".repeat(64),
      RESTORE_JOURNAL_TARGET_ROOT_SHA256: "3".repeat(64),
      TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED: "0",
    }, "router");

    expect(readChildEnv(env, [
      "AWS_ACCESS_KEY_ID",
      "BLOB_S3_ACCESS_KEY_ID",
      "BLOB_S3_BUCKET",
      "BLOB_S3_PREFIX",
      "MINIO_ROOT_USER",
      "MYSQL_URL",
      "RESTORE_JOURNAL_ADAPTER",
      "RESTORE_JOURNAL_NAMESPACE_SHA256",
      "RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256",
      "RESTORE_JOURNAL_S3_ENDPOINT",
      "RESTORE_JOURNAL_TARGET_ROOT_SHA256",
      "TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED",
      "TENANT_RESTORE_JOURNAL_WORKER_ENABLED",
    ])).toEqual({
      AWS_ACCESS_KEY_ID: null,
      BLOB_S3_ACCESS_KEY_ID: null,
      BLOB_S3_BUCKET: "fixture-bucket",
      BLOB_S3_PREFIX: "fixture-prefix",
      MINIO_ROOT_USER: null,
      MYSQL_URL: null,
      RESTORE_JOURNAL_ADAPTER: null,
      RESTORE_JOURNAL_NAMESPACE_SHA256: "1".repeat(64),
      RESTORE_JOURNAL_RUNTIME_EPOCH_SHA256: "2".repeat(64),
      RESTORE_JOURNAL_S3_ENDPOINT: null,
      RESTORE_JOURNAL_TARGET_ROOT_SHA256: "3".repeat(64),
      TENANT_RESTORE_JOURNAL_EXECUTION_ENABLED: "0",
      TENANT_RESTORE_JOURNAL_WORKER_ENABLED: null,
    });
  });
});
