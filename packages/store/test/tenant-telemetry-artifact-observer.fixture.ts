import { createHash } from "node:crypto";
import {
  MemorySessionStore,
  S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  s3TenantTelemetryTargetIdentity,
  type TenantTelemetryWriteAdapterInput,
} from "../src/index.js";
import {
  tenantTelemetryDispositionOperationSha256,
  type TenantTelemetryDispositionEvidence,
} from "../src/tenant-telemetry-disposition.js";
import {
  encodeTenantTelemetryS3Envelope,
} from "../src/tenant-telemetry-adapter/s3-codec.js";
import { encodeTenantTelemetryS3Tombstone } from "../src/tenant-telemetry-adapter/s3-tombstone-codec.js";
import { tenantTelemetryArtifactPayloadCanonicalJson } from "../src/tenant-telemetry-writer.js";
import { trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";
import { dispositionEvidence } from "./tenant-telemetry-disposition.fixture.js";

export interface ObserverFixtureConfig {
  bucket: string;
  prefix: string;
  namespaceId: string;
  failureDomainId: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  tenantId?: string;
  artifactIdSha256?: string;
  statusCode?: number;
}

export async function artifactObserverFixture(config: ObserverFixtureConfig): Promise<{
  input: TenantTelemetryWriteAdapterInput;
  evidence: TenantTelemetryDispositionEvidence;
}> {
  let nowMs = 1_000;
  const tenantId = config.tenantId ?? "private-tenant-artifact-observer";
  const refKey = new Uint8Array(32).fill(49);
  const store = new MemorySessionStore({ now: () => nowMs }, { tenantTelemetryRefKey: refKey });
  await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: (["logs", "traces"] as const).map((domain) => ({
      domain,
      ...s3TenantTelemetryTargetIdentity({
        ...config,
        domain,
        ...(config.endpoint.startsWith("http://")
          ? { allowInsecureHttpForLocalTest: true as const }
          : {}),
      }),
    })),
  });
  nowMs = 1_100;
  await store.createApiKey(tenantId, "artifact-observer-key", "hash");
  await store.enqueueTenantTelemetryArtifact({
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256: config.artifactIdSha256 ?? "5".repeat(64),
    artifactGeneration: 1,
    ownerKind: "tenant",
    ownerId: tenantId,
    ownerUserId: null,
    sourceSchema: "structured-log-batch-v1",
    sourceGeneration: 1,
    sourceHighWaterDbMs: nowMs,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs",
      records: [trustedRunnerTelemetryRecord(nowMs, {
        opaqueRefKey: refKey,
        ownerKind: "tenant",
        ownerValue: tenantId,
        statusCode: config.statusCode ?? 202,
      })],
    },
  });
  const [claim] = await store.claimTenantTelemetryWriteJobs({
    limit: 1,
    leaseMs: 10_000,
    claimToken: "artifact-observer-claim",
    adapterProtocol: S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  });
  if (!claim) throw new Error("artifact observer fixture claim is missing");
  const input = {
    writeOperationSha256: claim.writeOperationSha256,
    target: claim.target,
    inventory: claim.inventory,
    payload: claim.payload,
  };
  const source = {
    ...dispositionEvidence(),
    domain: input.inventory.domain,
    targetSha256: input.target.targetSha256,
    artifactIdSha256: input.inventory.artifactIdSha256,
    artifactGeneration: input.inventory.artifactGeneration,
    inventorySha256: input.inventory.inventorySha256,
    inventoryReceiptSha256: input.inventory.receiptSha256,
    writeOperationSha256: input.writeOperationSha256,
    payloadSha256: input.inventory.payloadSha256,
    manifestSha256: input.inventory.manifestSha256,
  };
  const { dispositionOperationSha256: _unused, ...withoutOperation } = source;
  const evidence = {
    ...withoutOperation,
    dispositionOperationSha256: tenantTelemetryDispositionOperationSha256(withoutOperation),
  };
  return { input, evidence };
}

export function artifactObserverDataBytes(input: TenantTelemetryWriteAdapterInput): Buffer {
  const metadata = {
    protocol: "agent-service.telemetry-s3-sink.v1",
    adapterProtocol: S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    targetSha256: input.target.targetSha256,
    targetReceiptSha256: input.target.receiptSha256,
    domain: input.inventory.domain,
    writeOperationSha256: input.writeOperationSha256,
    artifactIdSha256: input.inventory.artifactIdSha256,
    artifactGeneration: input.inventory.artifactGeneration,
    inventorySha256: input.inventory.inventorySha256,
    inventoryReceiptSha256: input.inventory.receiptSha256,
    payloadSha256: input.inventory.payloadSha256,
    manifestSha256: input.inventory.manifestSha256,
  };
  return encodeTenantTelemetryS3Envelope(
    JSON.stringify(metadata),
    tenantTelemetryArtifactPayloadCanonicalJson(input.payload),
  );
}

export function artifactObserverMarkerBytes(
  evidence: TenantTelemetryDispositionEvidence,
  authorizationReceiptSha256: string,
  originalEtag = '"fixture-original-etag"',
): Buffer {
  return encodeTenantTelemetryS3Tombstone(JSON.stringify({
    protocol: "telemetry-s3-same-key-tombstone-v1",
    ...evidence,
    authorizationReceiptSha256,
    originalObjectEtagSha256: createHash("sha256").update(originalEtag).digest("hex"),
  }));
}
