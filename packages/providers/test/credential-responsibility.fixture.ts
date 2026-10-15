import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type ProviderConfigInput,
} from "@agent-service/protocol";
import { TenantRuntimeCoordinator } from "@agent-service/core";
import { MemorySessionStore, newErasureRequestId, tenantErasureRequestHash } from "@agent-service/store";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

export const RESPONSIBILITY_FIXTURE_KEY = "57".repeat(32);
export function responsibilityProvider(overrides: Partial<ProviderConfigInput> = {}): ProviderConfigInput {
  return {
    id: "byok", api: "openai-completions", baseUrl: "https://provider.example/v1",
    headers: {}, quota: {}, fallback: [],
    models: [{ id: "model", contextWindow: 1_000, maxOutputTokens: 100,
      input: ["text"], reasoning: false }],
    apiKey: "responsibility-fixture-customer-key", ...overrides,
  };
}

/** Real Memory business/receipt boundaries and one actual in-process runtime drain.
 * No vendor-management adapter or cloud/full-fleet claim is involved. */
export async function credentialResponsibilityFixture(options: { fetch?: typeof fetch; tracking?: boolean } = {}) {
  const store = new MemorySessionStore();
  if (options.tracking !== false) await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  const coordinator = new TenantRuntimeCoordinator();
  const cipher = new LocalAesGcmCipher(RESPONSIBILITY_FIXTURE_KEY, "shared-fixture-master");
  const providers = new ProviderService({ store, cipher, tenantRuntime: coordinator,
    platform: [ProviderService.preset("dashscope", "responsibility-fixture-platform-key")],
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    assertBaseUrl: async () => {} });
  // Match runner startup: finish participant registration before accepting runtime work.
  coordinator.sealParticipants();
  for (const tenant of ["responsibility-target", "responsibility-neighbor"]) {
    await store.setTenantAuth(tenant, DEFAULT_AUTH_POLICY);
    await store.createApiKey(tenant, "fixture-admin", `fixture-verifier-${tenant}`, ["runtime", "admin"]);
  }
  const tenantId = "responsibility-target";
  let requestId: string | undefined;
  async function admit() {
    requestId = newErasureRequestId();
    const request = await store.requestTenantErasure({ tenantId, requestId,
      requestedByKeyId: "responsibility-platform-operator", idempotencyKey: "fixture-erase",
      requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
    return request;
  }
  async function clearLocal() {
    if (!requestId) throw new Error("fixture requires real admission first");
    const claims = await store.claimTenantCredentialRevocations({ limit: 10, leaseMs: 30_000,
      claimToken: "responsibility-credential-claim" });
    const claim = claims.find((value) => value.requestId === requestId);
    if (!claim) throw new Error("fixture credential claim is missing");
    const receipt = await store.revokeTenantCredentialMaterial({ requestId: claim.requestId,
      tenantId: claim.tenantId, subjectGeneration: claim.subjectGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken });
    if (!receipt) throw new Error("fixture credential receipt is missing");
    return receipt;
  }
  async function drainRuntime() {
    if (!requestId) throw new Error("fixture requires real admission first");
    await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
    const claims = await store.claimTenantRuntimeRevocations({ limit: 10, leaseMs: 30_000,
      claimToken: "responsibility-runtime-claim" });
    const claim = claims.find((value) => value.requestId === requestId);
    if (!claim) throw new Error("fixture runtime claim is missing");
    const t3a = await store.getTenantCredentialRevocationReceipt(tenantId, requestId);
    if (!t3a) throw new Error("fixture actual T3a receipt is missing");
    const local = await coordinator.drain({ requestId, tenantId,
      subjectGeneration: claim.subjectGeneration, t3aReceiptSha256: t3a.receiptSha256 }, 1_000);
    const body = { targetSha256: tenantRuntimeTargetSha256("http://responsibility-runner.internal:8080"),
      runnerId: "responsibility-fixture-runner", bootId: "responsibility-fixture-boot",
      requestId, tenantId, subjectGeneration: claim.subjectGeneration,
      t3aReceiptSha256: t3a.receiptSha256, cacheEntryCountBefore: local.cacheEntryCountBefore,
      cacheEntryCountAfter: 0 as const, activeOperationCountBefore: local.activeOperationCountBefore,
      activeOperationCountAfter: 0 as const, activeTurnCountBefore: local.activeTurnCountBefore,
      activeTurnCountAfter: 0 as const, completedAtMs: local.completedAtMs };
    if (local.cacheEntryCountAfter !== 0 || local.activeOperationCountAfter !== 0 || local.activeTurnCountAfter !== 0) {
      throw new Error("fixture runtime failed to drain");
    }
    const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
    const receipt = await store.completeTenantRuntimeRevocation({ requestId, tenantId,
      subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt,
      claimToken: claim.claimToken }, { targets, fleetSha256: tenantRuntimeFleetSha256(targets),
      targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets) });
    if (!receipt) throw new Error("fixture actual T3b receipt is missing");
    return receipt;
  }
  return { store, providers, coordinator, cipher, tenantId, admit, clearLocal, drainRuntime };
}
