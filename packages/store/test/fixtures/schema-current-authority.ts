import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createMysqlAuthorityCliExecutor } from "../../../../test/fixtures/mysql-authority-cli.mjs";
import type { MysqlFixtureAuthorityInitialCommand } from "../../../../test/fixtures/mysql-runtime.mjs";
import type { SchemaMetadataReaderConfig } from "../../src/mysql/schema-metadata.js";

/** Existing owned current schema/custom account only; no DDL, grants, discovery or fallback here. */
export async function activateCurrentSchemaFixtureAuthority(input: {
  operatorUrl: string; database: string; serverUuid: string; schemaMetadata: SchemaMetadataReaderConfig;
  runtimeAccount: Readonly<{ user: string; host: string }>; signal: AbortSignal;
  /** Caller owns the private raw32 file until this actual CLI operation has settled. */
  tenantTelemetryRefKeyFile?: string;
}): Promise<void> {
  const tenantTelemetryRefKeyFile = input.tenantTelemetryRefKeyFile;
  const command: MysqlFixtureAuthorityInitialCommand = Object.freeze({ bindingId: randomUUID(), activationId: randomUUID(),
    expectedBindingId: null, expectedSequence: 0, serverUuid: input.serverUuid, applicationDatabase: input.database,
    newAccounts: Object.freeze([Object.freeze({ ...input.runtimeAccount })]), oldAccountNames: Object.freeze([] as const),
    activationEvidenceSha256: createHash("sha256").update(JSON.stringify(["current-schema-fixture-initial-authority-v1",
      input.serverUuid, input.database, input.schemaMetadata.metadataSchema, input.runtimeAccount.user, input.runtimeAccount.host])).digest("hex"),
    expectedSource: Object.freeze({ kind: "inactive", runtimeControlGeneration: 0, runtimeControlEvidenceSha256: null,
      runtimeEpochSha256: null, restoreRunId: null, replayReceiptSha256: null }), nextEpoch: null });
  const execute = createMysqlAuthorityCliExecutor({
    entrypoint: fileURLToPath(new URL("../../../../apps/agent-runner/src/main.ts", import.meta.url)), mode: "source",
    cwd: resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
  });
  // The real selected product CLI owns native admission, the private fixed command and exact
  // confirmation. A failed/unknown outcome is retained; never generate a replacement command.
  await execute({ operation: "activate", url: input.operatorUrl, operationAbortSignal: input.signal,
    fleetStoppedAck: "all-application-writers-stopped-v1", exclusiveChangeAck: "exclusive-authority-permissions-window-v1",
    schemaMetadata: input.schemaMetadata, command,
    ...(tenantTelemetryRefKeyFile === undefined ? {} : { tenantTelemetryRefKeyFile }) });
}
