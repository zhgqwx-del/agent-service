import { describe, expect, it } from "vitest";
import {
  createTenantTelemetryApplicationDualWrite,
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
  TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
} from "@agent-service/core";
import {
  MemorySessionStore,
  captureTrustedEnqueueTenantTelemetryArtifactInput,
  type EnqueueTenantTelemetryArtifactInput,
  type TenantTelemetryWriteJobRecord,
} from "@agent-service/store";
import type { StructuredTelemetryRecord } from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

const REF_KEY = new Uint8Array(32).fill(47);
const MASTER_KEY = "12".repeat(32);

describe("ProviderService durable telemetry integration", () => {
  it("uses the owner-scoped writer for tenant provider failures", async () => {
    const processRecords: Readonly<StructuredTelemetryRecord>[] = [];
    const processFailures: string[] = [];
    const enqueued: EnqueueTenantTelemetryArtifactInput[] = [];
    const tenantTelemetry = createTenantTelemetryApplicationDualWrite({
      component: "provider",
      producerProtocol: TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_PROTOCOL,
      producerContractSha256: TENANT_TELEMETRY_PROVIDER_LOG_PRODUCER_CONTRACT_SHA256,
      opaqueRefKey: REF_KEY,
      processSink: {
        write(record) {
          processRecords.push(record);
          throw new Error("process sink failure must not replace provider failure");
        },
      },
      store: {
        enqueueTenantTelemetryArtifact(input) {
          captureTrustedEnqueueTenantTelemetryArtifactInput(input, REF_KEY);
          enqueued.push(input);
          return Promise.resolve({} as TenantTelemetryWriteJobRecord);
        },
      },
      durableEnabled: () => true,
      onProcessSinkFailure: () => processFailures.push("failed"),
      now: () => 1_234,
      artifactIdentitySeed: new Uint8Array(32).fill(48),
    });
    const providerStore = new MemorySessionStore();
    const service = new ProviderService({
      store: providerStore,
      cipher: new LocalAesGcmCipher(MASTER_KEY),
      assertBaseUrl: async () => {},
      platform: [ProviderService.preset("deepseek", "provider-secret")],
      telemetry: tenantTelemetry.telemetry,
      tenantTelemetry,
      fetch: async () => {
        throw new TypeError("raw provider error for tenant-private");
      },
    });
    const tenantId = "tenant-private";
    const model = await service.resolve(
      { tenantId, userId: "user-private" },
      { provider: "deepseek", model: "deepseek-chat" },
    );

    await expect(model.fetch!("https://provider.example/fail"))
      .rejects.toThrow("raw provider error");
    await tenantTelemetry.drain();

    expect(processRecords).toHaveLength(0);
    expect(processFailures).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      tenantId,
      ownerKind: "tenant",
      ownerId: tenantId,
      ownerUserId: null,
      domain: "logs",
      sourceHighWaterDbMs: 0,
    });
    const encoded = JSON.stringify(enqueued[0]!.payload.records);
    expect(encoded).not.toContain(tenantId);
    expect(encoded).not.toContain("user-private");
    expect(encoded).not.toContain("raw provider error");
    expect(encoded).not.toContain("provider-secret");
  });
});
