import type { SchemaMetadataReaderConfig } from "@agent-service/store";

export class MysqlSchemaRuntimeConfigError extends Error {
  readonly code = "mysql_schema_config_invalid";
  constructor() { super("MySQL schema runtime configuration is invalid."); this.name = "MysqlSchemaRuntimeConfigError"; }
}

const PREFIX = "MYSQL_SCHEMA_METADATA_";
const KEYS = ["MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"] as const;
function invalid(): never { throw new MysqlSchemaRuntimeConfigError(); }
function accountPart(value: unknown, maximum: number): value is string {
  return typeof value === "string" && [...value].length >= 1 && [...value].length <= maximum
    && Buffer.byteLength(value, "utf8") <= maximum * 4 && Buffer.from(value, "utf8").toString("utf8") === value
    && !/[\u0000-\u001f\u007f@]/.test(value);
}

/** Resource-free parsing only: no defaults, operator connection/ACK, I/O or migration-directory authority. */
export function loadMysqlSchemaRuntimeConfig(env: Readonly<NodeJS.ProcessEnv>,
  store: "memory" | "mysql"): SchemaMetadataReaderConfig | undefined {
  try {
    if (env === null || typeof env !== "object" || Array.isArray(env) || store !== "memory" && store !== "mysql") invalid();
    const names = Reflect.ownKeys(env).filter((key): key is string => typeof key === "string");
    // Presence is authority here, even an empty/undefined/hidden value or an accessor: never read it.
    if (names.some(key => key.startsWith("SCHEMA_") || key === "AGENT_SERVICE_MIGRATIONS_DIR")) invalid();
    const keys = names.filter(key => key.startsWith(PREFIX));
    if (store === "memory") {
      if (keys.length !== 0) invalid();
      return undefined;
    }
    if (keys.length !== KEYS.length || keys.some(key => !KEYS.some(allowed => key === allowed))) invalid();
    const values: Record<string, unknown> = Object.create(null);
    for (const key of KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(env, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      values[key] = descriptor.value;
    }
    const schema = values.MYSQL_SCHEMA_METADATA_SCHEMA, user = values.MYSQL_SCHEMA_METADATA_DEFINER_USER,
      host = values.MYSQL_SCHEMA_METADATA_DEFINER_HOST;
    if (typeof schema !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(schema)
      || !accountPart(user, 32) || !accountPart(host, 255)) invalid();
    return Object.freeze({ metadataSchema: schema, trustedDefiner: Object.freeze({ user, host }) });
  } catch {
    // Do not expose a key/value, URL, account, path, native cause or accessor error.
    throw new MysqlSchemaRuntimeConfigError();
  }
}
