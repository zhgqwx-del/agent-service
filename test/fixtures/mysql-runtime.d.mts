export class MysqlRuntimeFixtureError extends Error { readonly code: "mysql_runtime_fixture_invalid"; }
declare const witnessBrand: unique symbol;
export interface MysqlFixtureDatabaseWitness { readonly [witnessBrand]: true; }
export interface MysqlFixtureSchemaMetadata { readonly metadataSchema: string; readonly trustedDefiner: Readonly<{ user: string; host: string }>; }
export interface MysqlFixtureSchemaOperation {
  readonly operation: "migrate" | "install-metadata" | "verify";
  readonly url: string;
  readonly operationAbortSignal: AbortSignal;
  readonly fleetStoppedAck?: "all-application-writers-stopped-v1";
  readonly schemaMetadata?: MysqlFixtureSchemaMetadata;
}
export interface MysqlFixtureAuthorityInitialCommand {
  readonly bindingId: string; readonly activationId: string; readonly expectedBindingId: null; readonly expectedSequence: 0;
  readonly serverUuid: string; readonly applicationDatabase: string;
  readonly newAccounts: readonly Readonly<{ user: string; host: string }>[];
  readonly oldAccountNames: readonly [];
  readonly activationEvidenceSha256: string;
  readonly expectedSource: Readonly<{ kind: "inactive"; runtimeControlGeneration: 0; runtimeControlEvidenceSha256: null;
    runtimeEpochSha256: null; restoreRunId: null; replayReceiptSha256: null }>;
  readonly nextEpoch: null;
}
export interface MysqlFixtureAuthorityOperation {
  readonly operation: "activate"; readonly url: string; readonly operationAbortSignal: AbortSignal;
  readonly fleetStoppedAck: "all-application-writers-stopped-v1";
  readonly exclusiveChangeAck: "exclusive-authority-permissions-window-v1";
  readonly schemaMetadata: MysqlFixtureSchemaMetadata; readonly command: MysqlFixtureAuthorityInitialCommand;
  /** Explicit caller-owned protected raw32 file; never inherited from ambient environment. */
  readonly tenantTelemetryRefKeyFile?: string;
}
export interface MysqlRuntimeFixture {
  readonly database: string;
  readonly serverUuid: string;
  readonly runtimeEnv: Readonly<{ MYSQL_URL: string; MYSQL_SCHEMA_METADATA_SCHEMA: string;
    MYSQL_SCHEMA_METADATA_DEFINER_USER: string; MYSQL_SCHEMA_METADATA_DEFINER_HOST: string }>;
  readonly runtimeStoreOptions: Readonly<{ url: string; migrationMode: "verify"; schemaMetadata: MysqlFixtureSchemaMetadata }>;
  /** Read-only; never creates, migrates, grants or repairs. */
  assertReusable(operatorUrl: string): Promise<void>;
  /** Caller must first stop and await all consumers. Failure retains resources; app is never dropped. */
  close(input: Readonly<{ successful: boolean }>): Promise<void>;
}
export function witnessAbsentMysqlFixtureDatabase(input: Readonly<{ operatorUrl: string; applicationDatabase: string;
  operationAbortSignal: AbortSignal }>): Promise<MysqlFixtureDatabaseWitness>;
/** Must execute the selected source Store operation or actual dist CLI, and settle its native I/O. No default/fallback. */
export function prepareMysqlRuntimeFixture(witness: MysqlFixtureDatabaseWitness,
  input: Readonly<{ schemaExecutor(operation: MysqlFixtureSchemaOperation): Promise<void>;
    authorityExecutor?(operation: MysqlFixtureAuthorityOperation): Promise<void> }>): Promise<MysqlRuntimeFixture>;
