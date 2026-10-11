import {
  tenantTelemetryArtifactPayloadCanonicalJson,
  type TenantTelemetryArtifactPayload,
  type TenantTelemetryWriteAdapterResult,
} from "../tenant-telemetry-writer.js";
import {
  TenantTelemetryWriteAdapterConflictError,
  TenantTelemetryWriteAdapterTemporaryError,
  assertExactTenantTelemetryWriteAdapterResult,
  validateTenantTelemetryWriteAdapterInput,
  validateTenantTelemetryWriteInspection,
  type TenantTelemetryWriteAdapter,
  type TenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteInspection,
} from "./common.js";

export const HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL =
  "telemetry-http-v1" as const;
export const HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL =
  "agent-service.telemetry-http-sink.v1" as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_RESPONSE_BYTES = 1_048_576;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface HttpTenantTelemetryWriteRequest {
  protocol: typeof HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL;
  action: "inspect" | "create";
  adapterProtocol: typeof HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;
  targetSha256: string;
  targetReceiptSha256: string;
  writeOperationSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  payloadSha256: string;
  manifestSha256: string;
  payload?: Readonly<TenantTelemetryArtifactPayload>;
}

export type HttpTenantTelemetryWriteResponse = {
  protocol: typeof HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL;
  targetSha256: string;
  targetReceiptSha256: string;
} & TenantTelemetryWriteInspection;

export interface HttpTenantTelemetryTargetIdentity {
  targetSha256: string;
  targetReceiptSha256: string;
}

export interface HttpTenantTelemetryWriteAdapterOptions {
  /** Base URL only. Query strings, fragments and embedded credentials are rejected. */
  endpointUrl: string;
  /** Exact immutable lifecycle targets that this endpoint is allowed to serve. */
  expectedTargets: readonly HttpTenantTelemetryTargetIdentity[];
  authorizationToken?: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Test-only opt in; cleartext HTTP remains limited to loopback names. */
  allowInsecureHttpForLocalTest?: true;
  fetchImpl?: typeof fetch;
}

const SHA256 = /^[a-f0-9]{64}$/;

function configuredTargets(
  targets: readonly HttpTenantTelemetryTargetIdentity[],
): ReadonlyMap<string, string> {
  try {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2) {
      throw new Error("invalid target count");
    }
    const configured = new Map<string, string>();
    for (const target of targets) {
      if (typeof target !== "object" || target === null || Array.isArray(target)
        || !exactKeys(target, ["targetSha256", "targetReceiptSha256"])
        || !SHA256.test(target.targetSha256)
        || !SHA256.test(target.targetReceiptSha256)
        || configured.has(target.targetSha256)) {
        throw new Error("invalid target identity");
      }
      configured.set(target.targetSha256, target.targetReceiptSha256);
    }
    return configured;
  } catch {
    throw new Error("tenant telemetry HTTP sink target configuration is invalid");
  }
}

function positiveInteger(value: number, name: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    throw new Error(`tenant telemetry HTTP sink ${name} is invalid`);
  }
  return value;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function endpointBase(value: string, allowInsecure: boolean): URL {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:"
      && !(allowInsecure && parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname)))
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.search !== ""
      || parsed.hash !== "") {
      throw new Error("invalid endpoint");
    }
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
    return parsed;
  } catch {
    throw new Error("tenant telemetry HTTP sink endpoint configuration is invalid");
  }
}

function configuredHeaders(options: HttpTenantTelemetryWriteAdapterOptions): ReadonlyArray<
readonly [string, string]> {
  try {
    const values: Array<readonly [string, string]> = [];
    if (options.headers !== undefined
      && (typeof options.headers !== "object"
        || options.headers === null
        || Array.isArray(options.headers))) {
      throw new Error("invalid headers");
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const normalized = name.toLowerCase();
      if (!HEADER_NAME.test(name)
        || typeof value !== "string"
        || value.length > 8_192
        || /[\0\r\n]/.test(value)
        || ["authorization", "content-length", "content-type", "host"].includes(normalized)) {
        throw new Error("invalid header");
      }
      values.push(Object.freeze([name, value] as const));
    }
    if (options.authorizationToken !== undefined) {
      if (typeof options.authorizationToken !== "string"
        || options.authorizationToken.length < 1
        || options.authorizationToken.length > 8_192
        || /[\0\r\n]/.test(options.authorizationToken)) {
        throw new Error("invalid token");
      }
      values.push(Object.freeze(["authorization", `Bearer ${options.authorizationToken}`] as const));
    }
    return Object.freeze(values);
  } catch {
    throw new Error("tenant telemetry HTTP sink header configuration is invalid");
  }
}

function requestFor(
  action: "inspect" | "create",
  input: TenantTelemetryWriteAdapterInput,
  expectedTargets: ReadonlyMap<string, string>,
): HttpTenantTelemetryWriteRequest {
  const payload = validateTenantTelemetryWriteAdapterInput(input);
  if (input.target.adapterProtocol !== HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  if (expectedTargets.get(input.target.targetSha256) !== input.target.receiptSha256) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  return {
    protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
    action,
    adapterProtocol: HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    targetSha256: input.target.targetSha256,
    targetReceiptSha256: input.target.receiptSha256,
    writeOperationSha256: input.writeOperationSha256,
    artifactIdSha256: input.inventory.artifactIdSha256,
    artifactGeneration: input.inventory.artifactGeneration,
    payloadSha256: input.inventory.payloadSha256,
    manifestSha256: input.inventory.manifestSha256,
    ...(action === "create" ? { payload } : {}),
  };
}

function canonicalRequestJson(request: HttpTenantTelemetryWriteRequest): string {
  // The payload already has a canonical byte representation. Reparse it so the emitted JSON
  // cannot inherit caller-controlled property insertion order or optional undefined values.
  const payload = request.payload === undefined
    ? undefined
    : JSON.parse(tenantTelemetryArtifactPayloadCanonicalJson(request.payload)) as unknown;
  return JSON.stringify({
    protocol: request.protocol,
    action: request.action,
    adapterProtocol: request.adapterProtocol,
    targetSha256: request.targetSha256,
    targetReceiptSha256: request.targetReceiptSha256,
    writeOperationSha256: request.writeOperationSha256,
    artifactIdSha256: request.artifactIdSha256,
    artifactGeneration: request.artifactGeneration,
    payloadSha256: request.payloadSha256,
    manifestSha256: request.manifestSha256,
    ...(payload === undefined ? {} : { payload }),
  });
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = /^\d+$/.test(declared) ? Number(declared) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
      await discard(response);
      throw new TenantTelemetryWriteAdapterConflictError();
    }
  }
  const mediaType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    await discard(response);
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  if (!response.body) throw new TenantTelemetryWriteAdapterConflictError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => {});
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof TenantTelemetryWriteAdapterConflictError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TenantTelemetryWriteAdapterTemporaryError();
    }
    throw new TenantTelemetryWriteAdapterConflictError();
  } finally {
    reader.releaseLock();
  }
}

function parseResponse(
  value: unknown,
  input: TenantTelemetryWriteAdapterInput,
): TenantTelemetryWriteInspection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  const response = value as Record<string, unknown>;
  if (response.protocol !== HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  if (response.targetSha256 !== input.target.targetSha256
    || response.targetReceiptSha256 !== input.target.receiptSha256) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  let inspection: TenantTelemetryWriteInspection;
  if (response.status === "absent" || response.status === "conflict") {
    if (!exactKeys(response, [
      "protocol", "targetSha256", "targetReceiptSha256", "status",
    ])) {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    inspection = { status: response.status };
  } else if (response.status === "exact") {
    if (!exactKeys(response, [
      "protocol", "targetSha256", "targetReceiptSha256", "status", "result",
    ])) {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    inspection = {
      status: "exact",
      result: response.result as TenantTelemetryWriteAdapterResult,
    };
  } else {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  validateTenantTelemetryWriteInspection(
    HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    input,
    inspection,
  );
  return inspection;
}

export class HttpTenantTelemetryWriteAdapter implements TenantTelemetryWriteAdapter {
  readonly adapterProtocol = HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;

  private readonly base: URL;
  private readonly expectedTargets: ReadonlyMap<string, string>;
  private readonly headers: ReadonlyArray<readonly [string, string]>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(options: HttpTenantTelemetryWriteAdapterOptions) {
    this.base = endpointBase(
      options.endpointUrl,
      options.allowInsecureHttpForLocalTest === true && process.env.NODE_ENV !== "production",
    );
    this.expectedTargets = configuredTargets(options.expectedTargets);
    this.headers = configuredHeaders(options);
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeout",
      60_000,
    );
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "response limit",
      MAX_RESPONSE_BYTES,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private assertOpen(): void {
    if (this.closed) throw new TenantTelemetryWriteAdapterTemporaryError();
  }

  private async request(
    action: "inspect" | "create",
    input: TenantTelemetryWriteAdapterInput,
  ): Promise<TenantTelemetryWriteInspection> {
    this.assertOpen();
    const request = requestFor(action, input, this.expectedTargets);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(
        new URL(`v1/tenant-telemetry/writes/${action}`, this.base),
        {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "accept": "application/json",
            ...Object.fromEntries(this.headers),
          },
          body: canonicalRequestJson(request),
        },
      );
      if (response.status === 408 || response.status === 425 || response.status === 429
        || response.status >= 500) {
        await discard(response);
        throw new TenantTelemetryWriteAdapterTemporaryError();
      }
      if (response.status === 409) {
        const conflict = parseResponse(
          await readBoundedJson(response, this.maxResponseBytes),
          input,
        );
        if (conflict.status !== "conflict") {
          throw new TenantTelemetryWriteAdapterConflictError();
        }
        return conflict;
      }
      if (response.status !== 200 && !(action === "create" && response.status === 201)) {
        await discard(response);
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      return parseResponse(
        await readBoundedJson(response, this.maxResponseBytes),
        input,
      );
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterTemporaryError
        || error instanceof TenantTelemetryWriteAdapterConflictError) throw error;
      throw new TenantTelemetryWriteAdapterTemporaryError();
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  async inspectWrite(
    input: TenantTelemetryWriteAdapterInput,
  ): Promise<TenantTelemetryWriteInspection> {
    return this.request("inspect", input);
  }

  async createWrite(
    input: TenantTelemetryWriteAdapterInput,
  ): Promise<TenantTelemetryWriteAdapterResult> {
    const inspection = await this.request("create", input);
    if (inspection.status !== "exact") throw new TenantTelemetryWriteAdapterConflictError();
    assertExactTenantTelemetryWriteAdapterResult(this.adapterProtocol, input, inspection.result);
    return inspection.result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
