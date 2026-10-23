import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MysqlSessionStore, type MysqlRestoreJournalMaintenanceProfile } from "../src/index.js";

const stopped = () => ({ kind: "stopped-fleet-maintenance", fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" } as const);

// These are entry/refusal tests only. They never synthesize successful SQL or a branded facade.
describe("explicit stopped operator maintenance profile boundaries", () => {
  it("rejects missing or extra stopped-profile authority fields before creating a pool", async () => {
    const create = vi.spyOn(mysql, "createPool");
    try {
      for (const profile of [
        { ...stopped(), fleetStoppedAck: "wrong" },
        { ...stopped(), schemaMetadata: {} },
        { kind: "stopped-fleet-maintenance", fleetStoppedAck: "fleet-stopped-v1" },
      ]) await expect(MysqlSessionStore.connectRestoreJournalMaintenance({ url: "mysql://unused@127.0.0.1/unused_test" },
        profile as MysqlRestoreJournalMaintenanceProfile)).rejects.toThrow("Stopped maintenance profile is invalid.");
      expect(create).not.toHaveBeenCalled();
    } finally { create.mockRestore(); }
  });

  it("captures stopped-profile descriptors without invoking an ACK accessor", async () => {
    const profile = { ...stopped() }, getter = vi.fn(() => { throw Error("caller accessor must not run"); });
    Object.defineProperty(profile, "fleetStoppedAck", { enumerable: true, get: getter });
    const create = vi.spyOn(mysql, "createPool");
    try {
      await expect(MysqlSessionStore.connectRestoreJournalMaintenance({ url: "mysql://unused@127.0.0.1/unused_test" }, profile))
        .rejects.toThrow("Stopped maintenance profile is invalid.");
      expect(getter).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    } finally { create.mockRestore(); }
  });

  it("rejects the stopped local profile in production before native work", async () => {
    const create = vi.spyOn(mysql, "createPool"); vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(MysqlSessionStore.connectRestoreJournalMaintenance({ url: "mysql://unused@127.0.0.1/unused_test" }, stopped()))
        .rejects.toThrow("Stopped maintenance profile is invalid.");
      expect(create).not.toHaveBeenCalled();
    } finally { create.mockRestore(); vi.unstubAllEnvs(); }
  });

  it("accepts real key absence for the stopped backup-source entry without creating a substitute key", async () => {
    const failure = Error("native pool boundary"), create = vi.spyOn(mysql, "createPool").mockImplementation(() => { throw failure; });
    try {
      await expect(MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance({ url: "mysql://unused@127.0.0.1/unused_test",
        fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" }, stopped())).rejects.toBe(failure);
      expect(create).toHaveBeenCalledOnce();
    } finally { create.mockRestore(); }
  });

  it("does not accept a runtime profile as the backup-source operator capability", async () => {
    const create = vi.spyOn(mysql, "createPool");
    try {
      await expect(MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance({ url: "mysql://unused@127.0.0.1/unused_test",
        fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" },
      { kind: "runtime-maintenance", schemaMetadata: { metadataSchema: "agent_service_test_metadata", trustedDefiner: { user: "fixture_definer", host: "localhost" } } } as never))
        .rejects.toThrow("Backup source requires its stopped operator profile.");
      expect(create).not.toHaveBeenCalled();
    } finally { create.mockRestore(); }
  });

  it("keeps binding initialize preflight confirm and epoch activation unavailable without the real fixed operator context", async () => {
    const getConnection = vi.fn(async () => { throw Error("binding operation borrowed without its fixed operator context"); });
    const end = vi.fn(async () => {});
    const store = Reflect.construct(MysqlSessionStore, [{ getConnection, end }]) as MysqlSessionStore;
    Reflect.set(store, "sessionAuthoritySchemaInstalled", true);
    try {
      for (const operation of [() => store.initializeSessionAuthorityBinding(), () => store.preflightSessionAuthorityBinding(),
        () => store.confirmSessionAuthorityBinding(), () => store.activateTenantRestoreRuntime({ restoreRunId: `restore_${randomUUID()}`, expectedControlGeneration: 1 })]) {
        await expect(operation()).rejects.toThrow("explicit operator maintenance profile");
      }
      expect(getConnection).not.toHaveBeenCalled();
    } finally { await store.close(); }
    expect(end).toHaveBeenCalledOnce();
  });
});
