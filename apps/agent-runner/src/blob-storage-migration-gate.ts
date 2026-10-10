import {
  MysqlBlobStorageMigrationCoordinator,
  isBlobStorageMigrationRuntimeBlocked,
  type BlobStorageMigrationControlRecord,
  type MysqlBlobStorageMigrationCoordinatorOptions,
} from "@agent-service/store";

export type BlobStorageMigrationRuntimeGateErrorCode =
  | "migration_active"
  | "control_unavailable"
  | "close_failed";

export class BlobStorageMigrationRuntimeGateError extends Error {
  constructor(readonly code: BlobStorageMigrationRuntimeGateErrorCode) {
    super(code);
    this.name = "BlobStorageMigrationRuntimeGateError";
  }
}

export interface BlobStorageMigrationRuntimeControlReader {
  getControl(): Promise<BlobStorageMigrationControlRecord>;
  close(): Promise<void>;
}

export type ConnectBlobStorageMigrationRuntimeControl = (
  options: MysqlBlobStorageMigrationCoordinatorOptions,
) => Promise<BlobStorageMigrationRuntimeControlReader>;

const defaultConnect: ConnectBlobStorageMigrationRuntimeControl = (options) => (
  MysqlBlobStorageMigrationCoordinator.connect(options)
);

/**
 * Runtime may only start before a migration, after an audited abort, or after source cleanup.
 * Every other phase deliberately keeps all writers and workers offline.
 */
export function assertBlobStorageMigrationRuntimeAllowed(
  control: BlobStorageMigrationControlRecord,
): void {
  if (isBlobStorageMigrationRuntimeBlocked(control)) {
    throw new BlobStorageMigrationRuntimeGateError("migration_active");
  }
}

/**
 * Read migration control through an independent one-connection coordinator and close it before
 * runtime startup continues. Connection/read/close uncertainty all fail closed with bounded errors.
 */
export async function assertBlobStorageMigrationRuntimeReady(
  mysqlUrl: string,
  connect: ConnectBlobStorageMigrationRuntimeControl = defaultConnect,
): Promise<void> {
  let coordinator: BlobStorageMigrationRuntimeControlReader | undefined;
  let operationError: BlobStorageMigrationRuntimeGateError | undefined;
  try {
    coordinator = await connect({ url: mysqlUrl, connectionLimit: 1, exclusive: false });
    assertBlobStorageMigrationRuntimeAllowed(await coordinator.getControl());
  } catch (error) {
    operationError = error instanceof BlobStorageMigrationRuntimeGateError
      ? error
      : new BlobStorageMigrationRuntimeGateError("control_unavailable");
  }

  if (coordinator !== undefined) {
    const reader = coordinator;
    try {
      await Promise.resolve().then(() => reader.close());
    } catch {
      operationError ??= new BlobStorageMigrationRuntimeGateError("close_failed");
    }
  }

  if (operationError !== undefined) throw operationError;
}
