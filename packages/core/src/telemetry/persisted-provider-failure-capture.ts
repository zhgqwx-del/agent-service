import {
  createStructuredTelemetry,
  type PersistedProviderCaptureFleetProof,
  type PersistedProviderCaptureFleetRequest,
  type StructuredTelemetryRecord,
} from "@agent-service/protocol";
import {
  PersistedProviderCaptureConflictError,
  type CommitBatch,
  type CommitPersistedProviderStepFailureInput,
  type CommitPersistedProviderStepFailureResult,
  type PersistedProviderStepFailureSource,
  type TenantTelemetryPersistedProviderCaptureStore,
} from "@agent-service/store";

export interface PersistedProviderFailureCaptureOptions {
  store: Pick<TenantTelemetryPersistedProviderCaptureStore, "getTenantTelemetryPersistedProviderCaptureBinding"> & {
    commitPersistedProviderStepFailure(input: CommitPersistedProviderStepFailureInput): Promise<CommitPersistedProviderStepFailureResult>;
  };
  opaqueRefKey: Uint8Array;
  /** The caller obtains a new all-configured observation for each immediate boundary. */
  requireFreshFleet(binding: PersistedProviderCaptureFleetProof, boundary: PersistedProviderCaptureFleetRequest["boundary"]): Promise<PersistedProviderCaptureFleetProof>;
}

/** Product assembly shared by runner main and real-Pi/MySQL/MinIO integration tests. */
export function createPersistedProviderFailureCapture(options: PersistedProviderFailureCaptureOptions) {
  const key = Buffer.from(options.opaqueRefKey);
  if (key.byteLength !== 32) throw new TypeError("persisted provider capture requires an exact 32-byte ref key");
  return Object.freeze({
    async commit(batch: CommitBatch, source: PersistedProviderStepFailureSource): Promise<CommitPersistedProviderStepFailureResult> {
      const binding = await options.store.getTenantTelemetryPersistedProviderCaptureBinding();
      if (!binding) throw new PersistedProviderCaptureConflictError("provider capture is not active");
      const item = batch.items?.find((candidate) => candidate.id === source.itemId);
      if (!item || item.type !== "agentMessage" || item.status !== "failed"
        || item.step !== source.stepIndex || item.completedAtMs === undefined) {
        throw new PersistedProviderCaptureConflictError("provider capture requires the original failed item commit");
      }
      let record: Readonly<StructuredTelemetryRecord> | undefined;
      const telemetry = createStructuredTelemetry({
        component: "provider", opaqueRefKey: key, now: () => item.completedAtMs!,
        // This producer has no unmanaged output path. The source/model/provider/error body is
        // intentionally absent, even when the business failed item contains partial model text.
        sink: { write(value) { record = value; } },
      });
      telemetry.warn("provider.upstream_request_failed", {
        subjectRef: telemetry.opaqueRef("tenant", source.tenantId),
        ownerRef: telemetry.opaqueRef("session", batch.sessionId),
        errorKind: "unknown",
      });
      if (!record) throw new PersistedProviderCaptureConflictError("provider capture record was not generated");
      const freshProof = await options.requireFreshFleet(binding, "capture");
      return options.store.commitPersistedProviderStepFailure({ batch, source, record, freshProof });
    },
  });
}
