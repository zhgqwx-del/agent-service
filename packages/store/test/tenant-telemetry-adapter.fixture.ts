import {
  MemorySessionStore,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  type EnqueueTenantTelemetryArtifactInput,
  type TenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteClaim,
} from "../src/index.js";
import {
  createStructuredTelemetry,
  type StructuredTelemetryRecord,
} from "@agent-service/protocol";

const D = (character: string) => character.repeat(64);

export function trustedRunnerTelemetryRecord(
  timestampMs: number,
  options: {
    level?: "info" | "warn";
    statusCode?: number;
    retryable?: boolean;
    attempt?: number;
    opaqueRefKey?: Uint8Array;
    tenantValue?: string;
    ownerKind?: "tenant" | "user" | "session";
    ownerValue?: string;
    subjectKind?: "tenant" | "user" | "session";
    subjectValue?: string;
  } = {},
): Readonly<StructuredTelemetryRecord> {
  let record: Readonly<StructuredTelemetryRecord> | undefined;
  const telemetry = createStructuredTelemetry({
    component: "runner",
    opaqueRefKey: options.opaqueRefKey ?? Buffer.alloc(32, 0x74),
    now: () => timestampMs,
    sink: { write(value) { record = value; } },
  });
  const ownerKind = options.ownerKind ?? "tenant";
  const tenantBoundOwner = options.tenantValue !== undefined
    && options.ownerValue !== undefined
    && ownerKind !== "tenant";
  const fields = {
    ...(options.tenantValue !== undefined
      ? { ownerRef: telemetry.opaqueRef("tenant", options.tenantValue) }
      : options.ownerValue === undefined
      ? {}
      : { ownerRef: telemetry.opaqueRef(ownerKind, options.ownerValue) }),
    ...(tenantBoundOwner
      ? { subjectRef: telemetry.opaqueRef(ownerKind, options.ownerValue!) }
      : options.subjectValue === undefined
      ? {}
      : { subjectRef: telemetry.opaqueRef(
          options.subjectKind ?? "tenant",
          options.subjectValue,
        ) }),
    ...(tenantBoundOwner && options.subjectValue !== undefined
      ? { targetRef: telemetry.opaqueRef(
          options.subjectKind ?? "tenant",
          options.subjectValue,
        ) }
      : {}),
    ...(options.statusCode === undefined ? {} : { statusCode: options.statusCode }),
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
  };
  if (options.level === "warn") telemetry.warn("runner.runtime.warning", fields);
  else telemetry.info("runner.runtime.info", fields);
  if (!record) throw new Error("trusted telemetry fixture did not emit a record");
  return record;
}

export function statefulTelemetryEnqueueCaptureFixture(
  base: EnqueueTenantTelemetryArtifactInput,
): {
  input: EnqueueTenantTelemetryArtifactInput;
  topLevelReads: ReadonlyMap<string, number>;
  payloadReads: ReadonlyMap<string, number>;
  recordArrayReads: ReadonlyMap<string, number>;
  injectedLiteralAttempt: number;
} {
  const trustedPayload = base.payload;
  const trustedRecord = trustedPayload.records[0];
  if (!trustedRecord) throw new Error("stateful telemetry fixture requires one record");
  const injectedLiteralAttempt = 2;
  const literalRecord = structuredClone(trustedRecord) as StructuredTelemetryRecord;
  literalRecord.fields = { ...literalRecord.fields, attempt: injectedLiteralAttempt };

  const recordArrayReads = new Map<string, number>();
  const statefulRecords = new Proxy([...trustedPayload.records], {
    get(target, property, receiver) {
      if (property === "length" || property === "0") {
        const key = String(property);
        const reads = (recordArrayReads.get(key) ?? 0) + 1;
        recordArrayReads.set(key, reads);
        if (property === "0" && reads > 1) return literalRecord;
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const payloadReads = new Map<string, number>();
  const statefulPayload: Record<string, unknown> = {};
  for (const key of ["schema", "domain", "records"] as const) {
    Object.defineProperty(statefulPayload, key, {
      enumerable: true,
      get() {
        const reads = (payloadReads.get(key) ?? 0) + 1;
        payloadReads.set(key, reads);
        if (key === "records") {
          return reads === 1 ? statefulRecords : [literalRecord];
        }
        return trustedPayload[key];
      },
    });
  }

  const topLevelReads = new Map<string, number>();
  const statefulInput: Record<string, unknown> = {};
  for (const key of Object.keys(base) as Array<keyof EnqueueTenantTelemetryArtifactInput>) {
    Object.defineProperty(statefulInput, key, {
      enumerable: true,
      get() {
        topLevelReads.set(String(key), (topLevelReads.get(String(key)) ?? 0) + 1);
        return key === "payload" ? statefulPayload : base[key];
      },
    });
  }
  return {
    input: statefulInput as unknown as EnqueueTenantTelemetryArtifactInput,
    topLevelReads,
    payloadReads,
    recordArrayReads,
    injectedLiteralAttempt,
  };
}

export interface TelemetryAdapterFixture {
  store: MemorySessionStore;
  claim: TenantTelemetryWriteClaim;
  input: TenantTelemetryWriteAdapterInput;
}

export async function telemetryAdapterFixture(
  adapterProtocol: string,
  tenantId = "telemetry-adapter-tenant",
  artifactIdSha256 = D("5"),
  statusCode = 202,
): Promise<TelemetryAdapterFixture> {
  let nowMs = 1_000;
  const refKey = new Uint8Array(32).fill(21);
  const store = new MemorySessionStore(
    { now: () => nowMs },
    { tenantTelemetryRefKey: refKey },
  );
  await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: [
      {
        domain: "logs",
        backendKind: "fixture",
        adapterProtocol,
        namespaceSha256: D("1"),
        failureDomainSha256: D("2"),
      },
      {
        domain: "traces",
        backendKind: "fixture",
        adapterProtocol,
        namespaceSha256: D("3"),
        failureDomainSha256: D("4"),
      },
    ],
  });
  nowMs = 1_100;
  await store.createApiKey(tenantId, "telemetry-adapter-key", "hash");
  await store.enqueueTenantTelemetryArtifact({
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256,
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
        statusCode,
      })],
    },
  });
  const [claim] = await store.claimTenantTelemetryWriteJobs({
    limit: 1,
    leaseMs: 10_000,
    claimToken: "telemetry-adapter-claim",
    adapterProtocol,
  });
  if (!claim) throw new Error("telemetry adapter fixture claim is missing");
  return {
    store,
    claim,
    input: {
      writeOperationSha256: claim.writeOperationSha256,
      target: claim.target,
      inventory: claim.inventory,
      payload: claim.payload,
    },
  };
}
