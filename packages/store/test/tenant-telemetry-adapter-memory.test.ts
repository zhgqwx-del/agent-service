import { afterEach, describe, expect, it } from "vitest";
import {
  MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  MemoryTenantTelemetryWriteAdapter,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TenantTelemetryWriteAdapterConflictError,
  createMemoryTenantTelemetryWriteAdapterState,
} from "../src/index.js";
import {
  telemetryAdapterFixture,
  trustedRunnerTelemetryRecord,
} from "./tenant-telemetry-adapter.fixture.js";

const adapters: MemoryTenantTelemetryWriteAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

function adapter(
  options: Partial<ConstructorParameters<typeof MemoryTenantTelemetryWriteAdapter>[0]> = {},
): MemoryTenantTelemetryWriteAdapter {
  const value = new MemoryTenantTelemetryWriteAdapter({
    nonProductionFixture: true,
    ...options,
  });
  adapters.push(value);
  return value;
}

describe("MemoryTenantTelemetryWriteAdapter", () => {
  it("creates one immutable artifact and inspects an exact replay", async () => {
    const fixture = await telemetryAdapterFixture(
      MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    );
    const sink = adapter();

    await expect(sink.inspectWrite(fixture.input)).resolves.toEqual({ status: "absent" });
    await expect(sink.createWrite(fixture.input)).resolves.toMatchObject({
      outcome: "written",
      replayed: false,
      writeOperationSha256: fixture.input.writeOperationSha256,
      targetSha256: fixture.input.target.targetSha256,
      artifactIdSha256: fixture.input.inventory.artifactIdSha256,
      payloadSha256: fixture.input.inventory.payloadSha256,
      manifestSha256: fixture.input.inventory.manifestSha256,
    });
    await expect(sink.inspectWrite(fixture.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
    await expect(sink.createWrite(fixture.input)).resolves.toMatchObject({
      outcome: "already_present",
      replayed: true,
    });
  });

  it("makes a committed response loss recoverable through exact inspection", async () => {
    const fixture = await telemetryAdapterFixture(
      MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    );
    let loseResponse = true;
    const sink = adapter({
      afterWriteCommit: () => {
        if (loseResponse) {
          loseResponse = false;
          throw new Error("simulated response loss with secret remote detail");
        }
      },
    });

    await expect(sink.createWrite(fixture.input)).rejects.toThrow(/simulated response loss/);
    await expect(sink.inspectWrite(fixture.input)).resolves.toMatchObject({
      status: "exact",
      result: {
        outcome: "already_present",
        replayed: true,
        writeOperationSha256: fixture.input.writeOperationSha256,
      },
    });
  });

  it("reports conflicts for an occupied artifact slot instead of overwriting it", async () => {
    const first = await telemetryAdapterFixture(
      MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
      "telemetry-slot-first",
    );
    await first.store.enqueueTenantTelemetryArtifact({
      tenantId: first.claim.tenantId,
      expectedControlGeneration: 1,
      domain: "logs",
      artifactIdSha256: first.claim.inventory.artifactIdSha256,
      artifactGeneration: first.claim.inventory.artifactGeneration,
      ownerKind: "tenant",
      ownerId: first.claim.tenantId,
      ownerUserId: null,
      sourceSchema: "structured-log-batch-v1",
      sourceGeneration: 2,
      sourceHighWaterDbMs: 1_100,
      payload: {
        schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
        domain: "logs",
        records: [trustedRunnerTelemetryRecord(1_100, {
          opaqueRefKey: new Uint8Array(32).fill(21),
          ownerKind: "tenant",
          ownerValue: first.claim.tenantId,
          level: "warn",
          statusCode: 503,
        })],
      },
    });
    const [second] = await first.store.claimTenantTelemetryWriteJobs({
      limit: 1,
      leaseMs: 10_000,
      claimToken: "telemetry-adapter-second-claim",
      adapterProtocol: MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    });
    expect(second).toBeDefined();
    const conflictInput = {
      writeOperationSha256: second!.writeOperationSha256,
      target: second!.target,
      inventory: second!.inventory,
      payload: second!.payload,
    };
    const sink = adapter();
    await sink.createWrite(first.input);
    await expect(sink.inspectWrite(conflictInput)).resolves.toEqual({ status: "conflict" });
    await expect(sink.createWrite(conflictInput))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    await expect(sink.inspectWrite(first.input)).resolves.toMatchObject({ status: "exact" });
  });

  it("shares durable-looking fixture state explicitly and cannot run in production", async () => {
    const fixture = await telemetryAdapterFixture(
      MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    );
    const state = createMemoryTenantTelemetryWriteAdapterState();
    const writer = adapter({ state });
    await writer.createWrite(fixture.input);
    const reader = adapter({ state });
    await expect(reader.inspectWrite(fixture.input)).resolves.toMatchObject({ status: "exact" });

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new MemoryTenantTelemetryWriteAdapter({ nonProductionFixture: true }))
        .toThrow(/non-production fixture/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
