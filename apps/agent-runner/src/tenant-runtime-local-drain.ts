import {
  TenantRuntimeDrainRunnerRequest,
  TenantRuntimeRevocationLocalReceipt,
  tenantRuntimeLocalReceiptSha256,
  type TenantRuntimeRevocationLocalReceiptBody,
} from "@agent-service/protocol";
import type { TenantRuntimeCoordinator } from "@agent-service/core";
import {
  validateTenantCredentialRevocationReceipt,
  type TenantCredentialRevocationStore,
} from "@agent-service/store";

export interface LocalTenantRuntimeDrainOptions {
  runnerId: string;
  bootId: string;
  timeoutMs: number;
}

const RUNTIME_IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Converts an immutable T3a receipt into authority for one process-local T3b drain. The durable
 * receipt is checked both before and after the irreversible local fence, so a corrupt or incomplete
 * store can never produce affirmative local evidence.
 */
export class LocalTenantRuntimeDrain {
  readonly bootId: string;

  constructor(
    private readonly store: Pick<
      TenantCredentialRevocationStore,
      "getTenantCredentialRevocationReceipt"
    >,
    private readonly runtime: TenantRuntimeCoordinator,
    private readonly options: LocalTenantRuntimeDrainOptions,
  ) {
    if (!RUNTIME_IDENTITY.test(options.runnerId)) {
      throw new Error("runnerId is not a valid tenant runtime identity");
    }
    if (!RUNTIME_IDENTITY.test(options.bootId)) {
      throw new Error("bootId is not a valid tenant runtime identity");
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error("tenant runtime drain timeout must be a positive safe integer");
    }
    this.bootId = options.bootId;
  }

  async drain(input: TenantRuntimeDrainRunnerRequest): Promise<TenantRuntimeRevocationLocalReceipt> {
    const request = TenantRuntimeDrainRunnerRequest.parse(input);
    await this.assertT3aAuthority(request);

    const result = await this.runtime.drain({
      requestId: request.requestId,
      tenantId: request.tenantId,
      subjectGeneration: request.subjectGeneration,
      t3aReceiptSha256: request.t3aReceiptSha256,
    }, this.options.timeoutMs);

    // A response can be lost after the local fence. This second read is deliberately repeatable:
    // exact retries return the coordinator's frozen result and re-prove the immutable T3a source.
    await this.assertT3aAuthority(request);
    const body: TenantRuntimeRevocationLocalReceiptBody = {
      targetSha256: request.targetSha256,
      runnerId: this.options.runnerId,
      bootId: this.options.bootId,
      requestId: request.requestId,
      tenantId: request.tenantId,
      subjectGeneration: request.subjectGeneration,
      t3aReceiptSha256: request.t3aReceiptSha256,
      cacheEntryCountBefore: result.cacheEntryCountBefore,
      cacheEntryCountAfter: 0,
      activeOperationCountBefore: result.activeOperationCountBefore,
      activeOperationCountAfter: 0,
      activeTurnCountBefore: result.activeTurnCountBefore,
      activeTurnCountAfter: 0,
      completedAtMs: result.completedAtMs,
    };
    return TenantRuntimeRevocationLocalReceipt.parse({
      ...body,
      receiptSha256: tenantRuntimeLocalReceiptSha256(body),
    });
  }

  private async assertT3aAuthority(request: TenantRuntimeDrainRunnerRequest): Promise<void> {
    const receipt = await this.store.getTenantCredentialRevocationReceipt(
      request.tenantId,
      request.requestId,
    );
    if (!receipt) throw new Error("tenant runtime drain has no completed T3a receipt");
    validateTenantCredentialRevocationReceipt(receipt);
    if (
      receipt.requestId !== request.requestId
      || receipt.tenantId !== request.tenantId
      || receipt.subjectGeneration !== request.subjectGeneration
      || receipt.receiptSha256 !== request.t3aReceiptSha256
    ) throw new Error("tenant runtime drain T3a authority does not match the request");
  }
}
