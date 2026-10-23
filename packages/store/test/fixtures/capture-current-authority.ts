import type { MemorySessionStore, CommitPersistedProviderStepFailureInput } from "../../src/index.js";
import type { captureCurrentStepFixture } from "../persisted-provider-capture.fixture.js";

type CurrentCaptureStep = Awaited<ReturnType<typeof captureCurrentStepFixture>>;

/** Current Memory consumers only: caller fixes business content before the explicit real proof.
 * No numeric proof lookup, acquire/retry, key/record clone, epoch activation or product export. */
export function admitCaptureFixtureInput(
  step: Pick<CurrentCaptureStep, "input" | "lease">,
  input: CommitPersistedProviderStepFailureInput = step.input,
): CommitPersistedProviderStepFailureInput {
  return { ...input, batch: step.lease.admit({ ...input.batch }) };
}

/** Actual Memory containers, plain control/receipt records and authority tuple/binding state.
 * Constructor clocks/options/key and process-local class/WeakMap capabilities are not durable rows.
 * Original receipts/canonical rows remain bytes from real consumers, never synthesized here. */
export function currentCaptureMemorySnapshot(store: MemorySessionStore) {
  const containers = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(store))
    .filter(([key, descriptor]) => !["storeClock", "memoryOptions", "tenantTelemetryRefKey"].includes(key)
      && "value" in descriptor && (descriptor.value instanceof Map
        || descriptor.value instanceof Set || Array.isArray(descriptor.value) || descriptor.value === null
        || ["string", "number", "boolean", "undefined"].includes(typeof descriptor.value)
        || typeof descriptor.value === "object" && descriptor.value !== null
          && [Object.prototype, null].includes(Object.getPrototypeOf(descriptor.value))))
    .map(([key, descriptor]) => [key, descriptor.value]));
  return structuredClone({ containers, authority: store.sessionAuthority.snapshot() });
}
