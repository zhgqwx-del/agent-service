import {
  BLOB_STORAGE_MIGRATION_PHASES,
  type BlobStorageMigrationControlRecord,
  type BlobStorageMigrationPhase,
} from "@agent-service/store";
import { describe, expect, it, vi } from "vitest";
import {
  BlobStorageMigrationRuntimeGateError,
  assertBlobStorageMigrationRuntimeAllowed,
  assertBlobStorageMigrationRuntimeReady,
  type BlobStorageMigrationRuntimeControlReader,
} from "../src/blob-storage-migration-gate.js";

const ALLOWED_PHASES = ["inactive", "aborted", "source_cleaned"] as const;
const BLOCKED_PHASES = BLOB_STORAGE_MIGRATION_PHASES.filter(
  (phase) => !ALLOWED_PHASES.includes(phase as (typeof ALLOWED_PHASES)[number]),
);

function control(phase: BlobStorageMigrationPhase): BlobStorageMigrationControlRecord {
  return {
    singletonId: 1,
    controlGeneration: phase === "inactive" ? 0 : 1,
    phase,
    inventoryEntryCount: 0,
    objectAckCount: 0,
    sourceCleanupAckCount: 0,
    targetCleanupAckCount: 0,
  };
}

function reader(
  phase: BlobStorageMigrationPhase,
  overrides: Partial<BlobStorageMigrationRuntimeControlReader> = {},
): BlobStorageMigrationRuntimeControlReader {
  return {
    getControl: vi.fn(async () => control(phase)),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runner Blob storage migration startup gate", () => {
  it.each(ALLOWED_PHASES)("allows the terminal %s phase", (phase) => {
    expect(() => assertBlobStorageMigrationRuntimeAllowed(control(phase))).not.toThrow();
  });

  it.each(BLOCKED_PHASES)("blocks the non-terminal %s phase", (phase) => {
    expect(() => assertBlobStorageMigrationRuntimeAllowed(control(phase))).toThrowError(
      expect.objectContaining({ code: "migration_active" }),
    );
  });

  it.each(ALLOWED_PHASES)("independently reads and closes the %s phase", async (phase) => {
    const coordinator = reader(phase);
    const connect = vi.fn(async () => coordinator);

    await expect(assertBlobStorageMigrationRuntimeReady("mysql://unused", connect)).resolves
      .toBeUndefined();
    expect(connect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({
      url: "mysql://unused",
      connectionLimit: 1,
      exclusive: false,
    });
    expect(coordinator.getControl).toHaveBeenCalledOnce();
    expect(coordinator.close).toHaveBeenCalledOnce();
  });

  it("closes the independent reader when the migration is active", async () => {
    const coordinator = reader("copying");

    await expect(assertBlobStorageMigrationRuntimeReady(
      "mysql://unused",
      async () => coordinator,
    )).rejects.toMatchObject({ code: "migration_active" });
    expect(coordinator.close).toHaveBeenCalledOnce();
  });

  it("fails closed and closes the reader when the control read fails", async () => {
    const coordinator = reader("inactive", {
      getControl: vi.fn(async () => {
        throw new Error("sensitive database detail");
      }),
    });

    await expect(assertBlobStorageMigrationRuntimeReady(
      "mysql://unused",
      async () => coordinator,
    )).rejects.toEqual(new BlobStorageMigrationRuntimeGateError("control_unavailable"));
    expect(coordinator.close).toHaveBeenCalledOnce();
  });

  it("fails closed without a close attempt when connecting fails", async () => {
    await expect(assertBlobStorageMigrationRuntimeReady(
      "mysql://unused",
      async () => {
        throw new Error("sensitive database detail");
      },
    )).rejects.toEqual(new BlobStorageMigrationRuntimeGateError("control_unavailable"));
  });

  it("fails closed when the independent reader cannot close", async () => {
    const coordinator = reader("inactive", {
      close: vi.fn(async () => {
        throw new Error("sensitive database detail");
      }),
    });

    await expect(assertBlobStorageMigrationRuntimeReady(
      "mysql://unused",
      async () => coordinator,
    )).rejects.toEqual(new BlobStorageMigrationRuntimeGateError("close_failed"));
    expect(coordinator.close).toHaveBeenCalledOnce();
  });

  it("preserves the active-migration verdict if closing also fails", async () => {
    const coordinator = reader("verified", {
      close: vi.fn(async () => {
        throw new Error("sensitive database detail");
      }),
    });

    await expect(assertBlobStorageMigrationRuntimeReady(
      "mysql://unused",
      async () => coordinator,
    )).rejects.toEqual(new BlobStorageMigrationRuntimeGateError("migration_active"));
    expect(coordinator.close).toHaveBeenCalledOnce();
  });
});
