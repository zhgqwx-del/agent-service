import {
  TenantTelemetryWriteAdapterConflictError,
  sameTenantTelemetryWriteAdapterInput,
  tenantTelemetryWriteAdapterResult,
  validateTenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteAdapter,
  type TenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteInspection,
} from "./common.js";
import type { TenantTelemetryWriteAdapterResult } from "../tenant-telemetry-writer.js";

export const MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL =
  "telemetry-memory-v1" as const;

interface StoredMemoryTenantTelemetryWrite {
  input: TenantTelemetryWriteAdapterInput;
}

export interface MemoryTenantTelemetryWriteAdapterState {
  readonly operations: Map<string, StoredMemoryTenantTelemetryWrite>;
  readonly artifactSlots: Map<string, string>;
}

export function createMemoryTenantTelemetryWriteAdapterState():
MemoryTenantTelemetryWriteAdapterState {
  return {
    operations: new Map(),
    artifactSlots: new Map(),
  };
}

export interface MemoryTenantTelemetryWriteAdapterOptions {
  /** Mandatory acknowledgement that this fake is process-local and not a durable sink. */
  nonProductionFixture: true;
  state?: MemoryTenantTelemetryWriteAdapterState;
  /** Runs after the immutable write is committed, allowing response-loss tests. */
  afterWriteCommit?: (
    input: TenantTelemetryWriteAdapterInput,
    result: TenantTelemetryWriteAdapterResult,
  ) => void | Promise<void>;
}

function cloneInput(input: TenantTelemetryWriteAdapterInput): TenantTelemetryWriteAdapterInput {
  return structuredClone(input);
}

function artifactSlot(input: TenantTelemetryWriteAdapterInput): string {
  return [
    input.target.targetSha256,
    input.inventory.artifactIdSha256,
    input.inventory.artifactGeneration,
  ].join(":");
}

/** Explicit in-process fake. It provides protocol semantics, not durability or a failure domain. */
export class MemoryTenantTelemetryWriteAdapter implements TenantTelemetryWriteAdapter {
  readonly adapterProtocol = MEMORY_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;
  readonly state: MemoryTenantTelemetryWriteAdapterState;

  private readonly afterWriteCommit?: MemoryTenantTelemetryWriteAdapterOptions["afterWriteCommit"];
  private closed = false;

  constructor(options: MemoryTenantTelemetryWriteAdapterOptions) {
    if (options.nonProductionFixture !== true || process.env.NODE_ENV === "production") {
      throw new Error("memory tenant telemetry sink is a non-production fixture only");
    }
    this.state = options.state ?? createMemoryTenantTelemetryWriteAdapterState();
    this.afterWriteCommit = options.afterWriteCommit;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("memory tenant telemetry sink is closed");
  }

  private assertInput(input: TenantTelemetryWriteAdapterInput): void {
    this.assertOpen();
    validateTenantTelemetryWriteAdapterInput(input);
    if (input.target.adapterProtocol !== this.adapterProtocol) {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
  }

  private inspect(input: TenantTelemetryWriteAdapterInput): TenantTelemetryWriteInspection {
    const stored = this.state.operations.get(input.writeOperationSha256);
    const occupiedBy = this.state.artifactSlots.get(artifactSlot(input));
    if (!stored) {
      return occupiedBy === undefined ? { status: "absent" } : { status: "conflict" };
    }
    if (occupiedBy !== input.writeOperationSha256
      || !sameTenantTelemetryWriteAdapterInput(stored.input, input)) {
      return { status: "conflict" };
    }
    return {
      status: "exact",
      result: tenantTelemetryWriteAdapterResult(
        this.adapterProtocol,
        input,
        "already_present",
        true,
      ),
    };
  }

  async inspectWrite(
    input: TenantTelemetryWriteAdapterInput,
  ): Promise<TenantTelemetryWriteInspection> {
    this.assertInput(input);
    return structuredClone(this.inspect(input));
  }

  async createWrite(
    input: TenantTelemetryWriteAdapterInput,
  ): Promise<TenantTelemetryWriteAdapterResult> {
    this.assertInput(input);
    const inspection = this.inspect(input);
    if (inspection.status === "conflict") throw new TenantTelemetryWriteAdapterConflictError();
    if (inspection.status === "exact") return structuredClone(inspection.result);

    const result = tenantTelemetryWriteAdapterResult(
      this.adapterProtocol,
      input,
      "written",
      false,
    );
    const staged = cloneInput(input);
    // Both indexes are published synchronously so no observer can see a partially-created slot.
    this.state.operations.set(input.writeOperationSha256, { input: staged });
    this.state.artifactSlots.set(artifactSlot(input), input.writeOperationSha256);
    await this.afterWriteCommit?.(cloneInput(input), structuredClone(result));
    this.assertOpen();
    return structuredClone(result);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
