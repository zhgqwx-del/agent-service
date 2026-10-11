import { createHash } from "node:crypto";
import {
  assertTrustedStructuredTelemetryRecord,
  assertTrustedStructuredTelemetryRecordOwnerBinding,
  validateStructuredTelemetryRecord,
  type StructuredTelemetryRecord,
} from "@agent-service/protocol";
import {
  TENANT_TELEMETRY_DOMAINS,
  validateRegisterTenantTelemetryArtifactInput,
  validateTenantTelemetryArtifactInventory,
  validateTenantTelemetryLifecycleTarget,
  type RegisterTenantTelemetryArtifactInput,
  type TenantTelemetryArtifactInventoryRecord,
  type TenantTelemetryDomain,
  type TenantTelemetryLifecycleTargetRecord,
  type TenantTelemetryOwnerKind,
} from "./tenant-telemetry-lifecycle.js";

export const TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA =
  "agent-service.telemetry-artifact.v1" as const;
export const TENANT_TELEMETRY_WRITE_PROTOCOL = "tenant-telemetry-write-v1" as const;
export const TENANT_TELEMETRY_WRITE_ACK_SCOPE = "tenant-telemetry-write-ack-v1" as const;
export const TENANT_TELEMETRY_EXTERNAL_MUTATION_RESERVATION_SCOPE =
  "tenant-telemetry-external-mutation-reservation-v1" as const;
export const TENANT_TELEMETRY_ARTIFACT_MAX_RECORDS = 100 as const;
export const TENANT_TELEMETRY_ARTIFACT_MAX_BYTES = 262_144 as const;

const SHA256 = /^[0-9a-f]{64}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const ADAPTER_PROTOCOL = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256(value: unknown): string {
  return sha256Bytes(JSON.stringify(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function digest(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function tenantId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error("tenant telemetry write tenant id is invalid");
  }
}

function timestamp(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function positive(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function claimToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CLAIM_TOKEN.test(value)) {
    throw new Error("tenant telemetry write claim token is invalid");
  }
}

function adapterProtocol(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ADAPTER_PROTOCOL.test(value)) {
    throw new Error("tenant telemetry write adapter protocol is invalid");
  }
}

function domain(value: unknown): asserts value is TenantTelemetryDomain {
  if (!(TENANT_TELEMETRY_DOMAINS as readonly unknown[]).includes(value)) {
    throw new Error("tenant telemetry write domain is invalid");
  }
}

export interface TenantTelemetryArtifactPayload {
  schema: typeof TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA;
  domain: TenantTelemetryDomain;
  records: ReadonlyArray<Readonly<StructuredTelemetryRecord>>;
}

/**
 * Validate the only durable telemetry payload wire shape and return a detached immutable copy.
 * This is used for persisted reads, claims and adapter hashing; producer provenance is established
 * only by captureTrustedEnqueueTenantTelemetryArtifactInput at live enqueue admission.
 */
export function canonicalizeTenantTelemetryArtifactPayload(
  value: unknown,
): Readonly<TenantTelemetryArtifactPayload> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tenant telemetry artifact payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  exactKeys(payload, ["schema", "domain", "records"], "tenant telemetry artifact payload");
  if (payload.schema !== TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA) {
    throw new Error("tenant telemetry artifact payload schema is invalid");
  }
  domain(payload.domain);
  if (!Array.isArray(payload.records)
    || payload.records.length < 1
    || payload.records.length > TENANT_TELEMETRY_ARTIFACT_MAX_RECORDS) {
    throw new Error("tenant telemetry artifact record count is invalid");
  }
  const records = payload.records.map((record) => validateStructuredTelemetryRecord(record));
  const canonical = Object.freeze({
    schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
    domain: payload.domain,
    records: Object.freeze(records),
  });
  if (Buffer.byteLength(canonicalJson(canonical), "utf8")
    > TENANT_TELEMETRY_ARTIFACT_MAX_BYTES) {
    throw new Error("tenant telemetry artifact payload exceeds the durable byte limit");
  }
  return canonical;
}

/**
 * Capture every payload field and record exactly once, require each captured original record to be
 * an object emitted by createStructuredTelemetry, then detach that same captured value through the
 * closed persisted-schema validator. Producer provenance is intentionally process-local and does
 * not survive this canonical copy.
 */
function captureTrustedTenantTelemetryArtifactPayloadAdmission(
  value: unknown,
  ownerBinding: {
    tenantId: string;
    ownerKind: TenantTelemetryOwnerKind;
    ownerId: string;
    refKey: Uint8Array;
  },
): Readonly<TenantTelemetryArtifactPayload> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("tenant telemetry artifact payload admission must be an object");
  }
  exactKeys(value, ["schema", "domain", "records"], "tenant telemetry artifact payload");
  const source = value as {
    schema?: unknown;
    domain?: unknown;
    records?: unknown;
  };
  const schema = source.schema;
  const capturedDomain = source.domain;
  const sourceRecords = source.records;
  if (!Array.isArray(sourceRecords)) {
    throw new TypeError("tenant telemetry artifact payload admission records must be an array");
  }
  const recordCount = sourceRecords.length;
  if (!Number.isSafeInteger(recordCount)
    || recordCount < 1
    || recordCount > TENANT_TELEMETRY_ARTIFACT_MAX_RECORDS) {
    throw new Error("tenant telemetry artifact record count is invalid");
  }
  const records: Readonly<StructuredTelemetryRecord>[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    const record = sourceRecords[index];
    assertTrustedStructuredTelemetryRecord(record);
    assertTrustedStructuredTelemetryRecordOwnerBinding(
      record,
      ownerBinding.tenantId,
      ownerBinding.ownerKind,
      ownerBinding.ownerId,
      ownerBinding.refKey,
    );
    records.push(record);
  }
  return canonicalizeTenantTelemetryArtifactPayload({
    schema,
    domain: capturedDomain,
    records,
  });
}

export function tenantTelemetryArtifactPayloadCanonicalJson(
  payload: TenantTelemetryArtifactPayload,
): string {
  return canonicalJson(canonicalizeTenantTelemetryArtifactPayload(payload));
}

export function tenantTelemetryArtifactPayloadSha256(
  payload: TenantTelemetryArtifactPayload,
): string {
  return sha256Bytes(tenantTelemetryArtifactPayloadCanonicalJson(payload));
}

export function tenantTelemetryArtifactPayloadByteLength(
  payload: TenantTelemetryArtifactPayload,
): number {
  return Buffer.byteLength(tenantTelemetryArtifactPayloadCanonicalJson(payload), "utf8");
}

export interface TenantTelemetryArtifactManifestInput {
  tenantId: string;
  controlGeneration: 1;
  domain: TenantTelemetryDomain;
  targetSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  ownerKind: TenantTelemetryOwnerKind;
  tenantRefSha256: string;
  ownerRefSha256: string;
  holdSubjectRefSha256: string;
  coverageEvidenceSha256: string;
  sourceSchema: string;
  sourceGeneration: number;
  sourceHighWaterDbMs: number;
  payloadSha256: string;
}

const MANIFEST_KEYS = [
  "tenantId",
  "controlGeneration",
  "domain",
  "targetSha256",
  "artifactIdSha256",
  "artifactGeneration",
  "ownerKind",
  "tenantRefSha256",
  "ownerRefSha256",
  "holdSubjectRefSha256",
  "coverageEvidenceSha256",
  "sourceSchema",
  "sourceGeneration",
  "sourceHighWaterDbMs",
  "payloadSha256",
] as const;

export function tenantTelemetryArtifactManifestSha256(
  input: TenantTelemetryArtifactManifestInput,
): string {
  exactKeys(input, MANIFEST_KEYS, "tenant telemetry artifact manifest");
  tenantId(input.tenantId);
  if (input.controlGeneration !== 1) {
    throw new Error("tenant telemetry artifact manifest control generation is invalid");
  }
  domain(input.domain);
  for (const [value, name] of [
    [input.targetSha256, "target"],
    [input.artifactIdSha256, "artifact id"],
    [input.tenantRefSha256, "tenant ref"],
    [input.ownerRefSha256, "owner ref"],
    [input.holdSubjectRefSha256, "hold subject ref"],
    [input.coverageEvidenceSha256, "coverage evidence"],
    [input.payloadSha256, "payload"],
  ] as const) digest(value, `tenant telemetry artifact manifest ${name}`);
  positive(input.artifactGeneration, "tenant telemetry artifact manifest generation");
  if (input.ownerKind !== "tenant" && input.ownerKind !== "user"
    && input.ownerKind !== "session") {
    throw new Error("tenant telemetry artifact manifest owner kind is invalid");
  }
  if (typeof input.sourceSchema !== "string"
    || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(input.sourceSchema)) {
    throw new Error("tenant telemetry artifact manifest source schema is invalid");
  }
  timestamp(input.sourceGeneration, "tenant telemetry artifact manifest source generation");
  timestamp(input.sourceHighWaterDbMs, "tenant telemetry artifact manifest source high-water");
  return sha256([
    "tenant-telemetry-artifact-manifest-v1",
    ...MANIFEST_KEYS.map((key) => input[key]),
  ]);
}

export type EnqueueTenantTelemetryArtifactInput = Omit<
  RegisterTenantTelemetryArtifactInput,
  "payloadSha256" | "manifestSha256"
> & {
  payload: TenantTelemetryArtifactPayload;
};

const ENQUEUE_KEYS = [
  "tenantId",
  "expectedControlGeneration",
  "domain",
  "artifactIdSha256",
  "artifactGeneration",
  "ownerKind",
  "ownerId",
  "ownerUserId",
  "sourceSchema",
  "sourceGeneration",
  "sourceHighWaterDbMs",
  "payload",
] as const;

function validateCapturedEnqueueTenantTelemetryArtifactInput(
  input: EnqueueTenantTelemetryArtifactInput,
  payload: Readonly<TenantTelemetryArtifactPayload>,
): void {
  if (payload.domain !== input.domain) {
    throw new Error("tenant telemetry artifact payload domain does not match");
  }
  if (typeof input.sourceSchema !== "string") {
    throw new Error("tenant telemetry artifact source schema is invalid");
  }
  // Reuse the 0033 owner/source validator with hashes computed only after protected staging.
  const placeholder = "0".repeat(64);
  const registration: RegisterTenantTelemetryArtifactInput = {
    tenantId: input.tenantId,
    expectedControlGeneration: input.expectedControlGeneration,
    domain: input.domain,
    artifactIdSha256: input.artifactIdSha256,
    artifactGeneration: input.artifactGeneration,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    ownerUserId: input.ownerUserId,
    sourceSchema: input.sourceSchema,
    sourceGeneration: input.sourceGeneration,
    sourceHighWaterDbMs: input.sourceHighWaterDbMs,
    payloadSha256: placeholder,
    manifestSha256: placeholder,
  };
  validateRegisterTenantTelemetryArtifactInput(registration);
}

/** Validate a detached/plain enqueue shape; this function does not grant live producer authority. */
export function validateEnqueueTenantTelemetryArtifactInput(
  input: EnqueueTenantTelemetryArtifactInput,
): Readonly<TenantTelemetryArtifactPayload> {
  exactKeys(input, ENQUEUE_KEYS, "enqueue tenant telemetry artifact input");
  const payload = canonicalizeTenantTelemetryArtifactPayload(input.payload);
  validateCapturedEnqueueTenantTelemetryArtifactInput(input, payload);
  return payload;
}

export interface CapturedEnqueueTenantTelemetryArtifactInput {
  input: Readonly<EnqueueTenantTelemetryArtifactInput>;
  payload: Readonly<TenantTelemetryArtifactPayload>;
}

/**
 * Take one validated snapshot of a live enqueue call without ever cloning or re-reading caller
 * objects. Every top-level field, the payload field set and every record slot are read once; only
 * the detached payload and copied scalar fields may be used after this function returns.
 */
export function captureTrustedEnqueueTenantTelemetryArtifactInput(
  value: unknown,
  refKey: Uint8Array,
): Readonly<CapturedEnqueueTenantTelemetryArtifactInput> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("enqueue tenant telemetry artifact input must be an object");
  }
  exactKeys(value, ENQUEUE_KEYS, "enqueue tenant telemetry artifact input");
  const source = value as EnqueueTenantTelemetryArtifactInput;
  const tenantId = source.tenantId;
  const expectedControlGeneration = source.expectedControlGeneration;
  const domain = source.domain;
  const artifactIdSha256 = source.artifactIdSha256;
  const artifactGeneration = source.artifactGeneration;
  const ownerKind = source.ownerKind;
  const ownerId = source.ownerId;
  const ownerUserId = source.ownerUserId;
  const sourceSchema = source.sourceSchema;
  const sourceGeneration = source.sourceGeneration;
  const sourceHighWaterDbMs = source.sourceHighWaterDbMs;
  const sourcePayload = source.payload;
  const payload = captureTrustedTenantTelemetryArtifactPayloadAdmission(sourcePayload, {
    tenantId,
    ownerKind,
    ownerId,
    refKey,
  });
  const input: EnqueueTenantTelemetryArtifactInput = {
    tenantId,
    expectedControlGeneration,
    domain,
    artifactIdSha256,
    artifactGeneration,
    ownerKind,
    ownerId,
    ownerUserId,
    sourceSchema,
    sourceGeneration,
    sourceHighWaterDbMs,
    payload,
  };
  validateCapturedEnqueueTenantTelemetryArtifactInput(input, payload);
  return Object.freeze({ input: Object.freeze(input), payload });
}

export function tenantTelemetryWriteOperationSha256(
  manifestSha256: string,
): string {
  digest(manifestSha256, "tenant telemetry write manifest");
  return sha256(["tenant-telemetry-write-operation-v1", manifestSha256]);
}

export type TenantTelemetryWriteJobPhase = "queued" | "written" | "blocked";
export type TenantTelemetryWriteRetryErrorCode = "temporary_failure" | "dependency_pending";
export type TenantTelemetryWriteBlockReasonCode = "integrity_conflict";
export type TenantTelemetryWriteOutcome = "written" | "already_present";

interface TenantTelemetryWriteJobBase {
  writeOperationSha256: string;
  tenantId: string;
  protocol: typeof TENANT_TELEMETRY_WRITE_PROTOCOL;
  phase: TenantTelemetryWriteJobPhase;
  target: TenantTelemetryLifecycleTargetRecord;
  inventory: TenantTelemetryArtifactInventoryRecord;
  recordCount: number;
  payloadByteLength: number;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
  reservation?: TenantTelemetryExternalMutationReservation;
}

export interface TenantTelemetryExternalMutationReservationBody {
  scope: typeof TENANT_TELEMETRY_EXTERNAL_MUTATION_RESERVATION_SCOPE;
  protocol: typeof TENANT_TELEMETRY_WRITE_PROTOCOL;
  writeOperationSha256: string;
  tenantId: string;
  adapterProtocol: string;
  inventorySha256: string;
  manifestSha256: string;
  startedClaimAttempt: number;
  startedClaimTokenSha256: string;
  startedAtDbMs: number;
}

export interface TenantTelemetryExternalMutationReservation
  extends TenantTelemetryExternalMutationReservationBody {
  receiptSha256: string;
}

const RESERVATION_BODY_KEYS = [
  "scope", "protocol", "writeOperationSha256", "tenantId", "adapterProtocol",
  "inventorySha256", "manifestSha256", "startedClaimAttempt",
  "startedClaimTokenSha256", "startedAtDbMs",
] as const;

export function tenantTelemetryExternalMutationReservationSha256(
  reservation: TenantTelemetryExternalMutationReservationBody,
): string {
  exactKeys(reservation, RESERVATION_BODY_KEYS,
    "tenant telemetry external mutation reservation");
  if (reservation.scope !== TENANT_TELEMETRY_EXTERNAL_MUTATION_RESERVATION_SCOPE
    || reservation.protocol !== TENANT_TELEMETRY_WRITE_PROTOCOL) {
    throw new Error("tenant telemetry external mutation reservation protocol is invalid");
  }
  tenantId(reservation.tenantId);
  adapterProtocol(reservation.adapterProtocol);
  for (const [value, name] of [
    [reservation.writeOperationSha256, "operation"],
    [reservation.inventorySha256, "inventory"],
    [reservation.manifestSha256, "manifest"],
    [reservation.startedClaimTokenSha256, "claim token"],
  ] as const) digest(value, `tenant telemetry external mutation reservation ${name}`);
  positive(reservation.startedClaimAttempt,
    "tenant telemetry external mutation reservation claim attempt");
  timestamp(reservation.startedAtDbMs,
    "tenant telemetry external mutation reservation timestamp");
  return sha256([
    "tenant-telemetry-external-mutation-reservation-v1",
    ...RESERVATION_BODY_KEYS.map((key) => reservation[key]),
  ]);
}

export function validateTenantTelemetryExternalMutationReservation(
  reservation: TenantTelemetryExternalMutationReservation,
): void {
  exactKeys(reservation, [...RESERVATION_BODY_KEYS, "receiptSha256"],
    "tenant telemetry external mutation reservation record");
  const { receiptSha256, ...body } = reservation;
  digest(receiptSha256, "tenant telemetry external mutation reservation receipt");
  if (receiptSha256 !== tenantTelemetryExternalMutationReservationSha256(body)) {
    throw new Error("tenant telemetry external mutation reservation receipt does not match");
  }
}

export type TenantTelemetryWriteJobRecord = TenantTelemetryWriteJobBase & (
  | {
      phase: "queued";
      availableAtMs: number;
      claimToken?: string;
      leaseUntilMs?: number;
      lastErrorCode?: TenantTelemetryWriteRetryErrorCode;
      writeAckReceiptSha256?: never;
      writtenAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "written";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      writeAckReceiptSha256: string;
      writtenAtDbMs: number;
      completedClaimAttempt: number;
      completedClaimTokenSha256: string;
      blockedAtDbMs?: never;
      blockedReasonCode?: never;
    }
  | {
      phase: "blocked";
      availableAtMs?: never;
      claimToken?: never;
      leaseUntilMs?: never;
      lastErrorCode?: never;
      writeAckReceiptSha256?: never;
      writtenAtDbMs?: never;
      completedClaimAttempt?: never;
      completedClaimTokenSha256?: never;
      blockedAtDbMs: number;
      blockedReasonCode: TenantTelemetryWriteBlockReasonCode;
    }
);

export interface TenantTelemetryWritePayloadRecord {
  writeOperationSha256: string;
  tenantId: string;
  payload: Readonly<TenantTelemetryArtifactPayload>;
  payloadSha256: string;
  recordCount: number;
  payloadByteLength: number;
  createdAtMs: number;
}

export interface ClaimTenantTelemetryWriteJobsOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
  adapterProtocol: string;
}

export interface RenewTenantTelemetryWriteOptions {
  leaseMs: number;
}

export interface RetryTenantTelemetryWriteOptions {
  delayMs: number;
  errorCode: TenantTelemetryWriteRetryErrorCode;
}

export interface TenantTelemetryWriteClaim {
  writeOperationSha256: string;
  tenantId: string;
  protocol: typeof TENANT_TELEMETRY_WRITE_PROTOCOL;
  phase: "queued";
  target: TenantTelemetryLifecycleTargetRecord;
  inventory: TenantTelemetryArtifactInventoryRecord;
  payload: Readonly<TenantTelemetryArtifactPayload>;
  recordCount: number;
  payloadByteLength: number;
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
  reservation?: TenantTelemetryExternalMutationReservation;
}

export interface TenantTelemetryWriteAuthorization {
  writeOperationSha256: string;
  tenantId: string;
  claimAttempt: number;
  claimToken: string;
}

export function tenantTelemetryWriteClaimTokenSha256(value: string): string {
  claimToken(value);
  return sha256(["tenant-telemetry-write-claim-token-v1", value]);
}

export function validateClaimTenantTelemetryWriteJobsOptions(
  options: ClaimTenantTelemetryWriteJobsOptions,
): void {
  exactKeys(options, ["limit", "leaseMs", "claimToken", "adapterProtocol"],
    "claim tenant telemetry write jobs options");
  positive(options.limit, "tenant telemetry write claim limit");
  if (options.limit > 100) throw new Error("tenant telemetry write claim limit exceeds 100");
  positive(options.leaseMs, "tenant telemetry write lease");
  claimToken(options.claimToken);
  adapterProtocol(options.adapterProtocol);
}

export function validateRenewTenantTelemetryWriteOptions(
  options: RenewTenantTelemetryWriteOptions,
): void {
  exactKeys(options, ["leaseMs"], "renew tenant telemetry write options");
  positive(options.leaseMs, "tenant telemetry write renewal lease");
}

export function validateRetryTenantTelemetryWriteOptions(
  options: RetryTenantTelemetryWriteOptions,
): void {
  exactKeys(options, ["delayMs", "errorCode"], "retry tenant telemetry write options");
  timestamp(options.delayMs, "tenant telemetry write retry delay");
  if (options.errorCode !== "temporary_failure" && options.errorCode !== "dependency_pending") {
    throw new Error("tenant telemetry write retry error code is invalid");
  }
}

export function validateTenantTelemetryWriteAuthorization(
  authorization: TenantTelemetryWriteAuthorization,
): void {
  exactKeys(authorization, ["writeOperationSha256", "tenantId", "claimAttempt", "claimToken"],
    "tenant telemetry write authorization");
  digest(authorization.writeOperationSha256, "tenant telemetry write operation");
  tenantId(authorization.tenantId);
  positive(authorization.claimAttempt, "tenant telemetry write claim attempt");
  claimToken(authorization.claimToken);
}

export function validateTenantTelemetryWriteClaim(claim: TenantTelemetryWriteClaim): void {
  exactKeys(claim, [
    "writeOperationSha256",
    "tenantId",
    "protocol",
    "phase",
    "target",
    "inventory",
    "payload",
    "recordCount",
    "payloadByteLength",
    "claimAttempt",
    "claimToken",
    "leaseUntilMs",
    ...(claim.reservation === undefined ? [] : ["reservation"]),
  ], "tenant telemetry write claim");
  validateTenantTelemetryWriteAuthorization({
    writeOperationSha256: claim.writeOperationSha256,
    tenantId: claim.tenantId,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  });
  if (claim.protocol !== TENANT_TELEMETRY_WRITE_PROTOCOL || claim.phase !== "queued") {
    throw new Error("tenant telemetry write claim protocol is invalid");
  }
  validateTenantTelemetryLifecycleTarget(claim.target);
  validateTenantTelemetryArtifactInventory(claim.inventory);
  const payload = canonicalizeTenantTelemetryArtifactPayload(claim.payload);
  if (claim.tenantId !== claim.inventory.tenantId
    || claim.target.targetSha256 !== claim.inventory.targetSha256
    || claim.target.domain !== claim.inventory.domain
    || payload.domain !== claim.inventory.domain
    || tenantTelemetryWriteOperationSha256(claim.inventory.manifestSha256)
      !== claim.writeOperationSha256
    || tenantTelemetryArtifactPayloadSha256(payload) !== claim.inventory.payloadSha256
    || payload.records.length !== claim.recordCount
    || tenantTelemetryArtifactPayloadByteLength(payload) !== claim.payloadByteLength) {
    throw new Error("tenant telemetry write claim bindings are invalid");
  }
  timestamp(claim.leaseUntilMs, "tenant telemetry write claim lease");
  if (claim.reservation !== undefined) {
    validateTenantTelemetryExternalMutationReservation(claim.reservation);
    if (claim.reservation.writeOperationSha256 !== claim.writeOperationSha256
      || claim.reservation.tenantId !== claim.tenantId
      || claim.reservation.adapterProtocol !== claim.target.adapterProtocol
      || claim.reservation.inventorySha256 !== claim.inventory.inventorySha256
      || claim.reservation.manifestSha256 !== claim.inventory.manifestSha256
      || claim.reservation.startedClaimAttempt > claim.claimAttempt) {
      throw new Error("tenant telemetry write claim reservation binding is invalid");
    }
  }
}

export interface TenantTelemetryWriteAdapterEvidence {
  adapterProtocol: string;
  domain: TenantTelemetryDomain;
  targetSha256: string;
  writeOperationSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  payloadSha256: string;
  manifestSha256: string;
  outcome: TenantTelemetryWriteOutcome;
  replayed: boolean;
}

export interface TenantTelemetryWriteAdapterResult extends TenantTelemetryWriteAdapterEvidence {
  evidenceSha256: string;
}

const ADAPTER_EVIDENCE_KEYS = [
  "adapterProtocol",
  "domain",
  "targetSha256",
  "writeOperationSha256",
  "artifactIdSha256",
  "artifactGeneration",
  "payloadSha256",
  "manifestSha256",
  "outcome",
  "replayed",
] as const;

export function tenantTelemetryWriteAdapterEvidenceSha256(
  evidence: TenantTelemetryWriteAdapterEvidence,
): string {
  exactKeys(evidence, ADAPTER_EVIDENCE_KEYS, "tenant telemetry write adapter evidence");
  adapterProtocol(evidence.adapterProtocol);
  domain(evidence.domain);
  for (const [value, name] of [
    [evidence.targetSha256, "target"],
    [evidence.writeOperationSha256, "operation"],
    [evidence.artifactIdSha256, "artifact id"],
    [evidence.payloadSha256, "payload"],
    [evidence.manifestSha256, "manifest"],
  ] as const) digest(value, `tenant telemetry write adapter ${name}`);
  positive(evidence.artifactGeneration, "tenant telemetry write adapter artifact generation");
  if (evidence.outcome !== "written" && evidence.outcome !== "already_present") {
    throw new Error("tenant telemetry write adapter outcome is invalid");
  }
  if (typeof evidence.replayed !== "boolean") {
    throw new Error("tenant telemetry write adapter replay flag is invalid");
  }
  return sha256([
    "tenant-telemetry-write-adapter-evidence-v1",
    ...ADAPTER_EVIDENCE_KEYS.map((key) => evidence[key]),
  ]);
}

export function validateTenantTelemetryWriteAdapterResult(
  result: TenantTelemetryWriteAdapterResult,
): void {
  exactKeys(result, [...ADAPTER_EVIDENCE_KEYS, "evidenceSha256"],
    "tenant telemetry write adapter result");
  const { evidenceSha256, ...evidence } = result;
  digest(evidenceSha256, "tenant telemetry write adapter evidence");
  if (evidenceSha256 !== tenantTelemetryWriteAdapterEvidenceSha256(evidence)) {
    throw new Error("tenant telemetry write adapter evidence does not match");
  }
}

export interface TenantTelemetryWriteAckBody {
  scope: typeof TENANT_TELEMETRY_WRITE_ACK_SCOPE;
  protocol: typeof TENANT_TELEMETRY_WRITE_PROTOCOL;
  writeOperationSha256: string;
  tenantId: string;
  domain: TenantTelemetryDomain;
  targetSha256: string;
  targetReceiptSha256: string;
  inventorySha256: string;
  inventoryReceiptSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  payloadSha256: string;
  manifestSha256: string;
  adapterProtocol: string;
  outcome: TenantTelemetryWriteOutcome;
  replayed: boolean;
  adapterEvidenceSha256: string;
  reservationReceiptSha256: string;
  mutationStartedAtDbMs: number;
  mutationStartedClaimAttempt: number;
  mutationStartedClaimTokenSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
}

export interface TenantTelemetryWriteAck extends TenantTelemetryWriteAckBody {
  receiptSha256: string;
}

const ACK_BODY_KEYS = [
  "scope",
  "protocol",
  "writeOperationSha256",
  "tenantId",
  "domain",
  "targetSha256",
  "targetReceiptSha256",
  "inventorySha256",
  "inventoryReceiptSha256",
  "artifactIdSha256",
  "artifactGeneration",
  "payloadSha256",
  "manifestSha256",
  "adapterProtocol",
  "outcome",
  "replayed",
  "adapterEvidenceSha256",
  "reservationReceiptSha256",
  "mutationStartedAtDbMs",
  "mutationStartedClaimAttempt",
  "mutationStartedClaimTokenSha256",
  "completedClaimAttempt",
  "completedClaimTokenSha256",
  "storeDbTimestampMs",
] as const;

export function tenantTelemetryWriteAckSha256(ack: TenantTelemetryWriteAckBody): string {
  exactKeys(ack, ACK_BODY_KEYS, "tenant telemetry write ACK");
  if (ack.scope !== TENANT_TELEMETRY_WRITE_ACK_SCOPE
    || ack.protocol !== TENANT_TELEMETRY_WRITE_PROTOCOL) {
    throw new Error("tenant telemetry write ACK protocol is invalid");
  }
  tenantId(ack.tenantId);
  domain(ack.domain);
  for (const [value, name] of [
    [ack.writeOperationSha256, "operation"],
    [ack.targetSha256, "target"],
    [ack.targetReceiptSha256, "target receipt"],
    [ack.inventorySha256, "inventory"],
    [ack.inventoryReceiptSha256, "inventory receipt"],
    [ack.artifactIdSha256, "artifact id"],
    [ack.payloadSha256, "payload"],
    [ack.manifestSha256, "manifest"],
    [ack.adapterEvidenceSha256, "adapter evidence"],
    [ack.reservationReceiptSha256, "reservation receipt"],
    [ack.mutationStartedClaimTokenSha256, "mutation-start claim token"],
    [ack.completedClaimTokenSha256, "claim token"],
  ] as const) digest(value, `tenant telemetry write ACK ${name}`);
  adapterProtocol(ack.adapterProtocol);
  positive(ack.artifactGeneration, "tenant telemetry write ACK artifact generation");
  positive(ack.completedClaimAttempt, "tenant telemetry write ACK claim attempt");
  positive(ack.mutationStartedClaimAttempt,
    "tenant telemetry write ACK mutation-start claim attempt");
  timestamp(ack.mutationStartedAtDbMs,
    "tenant telemetry write ACK mutation-start timestamp");
  timestamp(ack.storeDbTimestampMs, "tenant telemetry write ACK timestamp");
  if (ack.mutationStartedAtDbMs > ack.storeDbTimestampMs
    || ack.mutationStartedClaimAttempt > ack.completedClaimAttempt) {
    throw new Error("tenant telemetry write ACK mutation-start ordering is invalid");
  }
  const adapterEvidenceSha256 = tenantTelemetryWriteAdapterEvidenceSha256({
    adapterProtocol: ack.adapterProtocol,
    domain: ack.domain,
    targetSha256: ack.targetSha256,
    writeOperationSha256: ack.writeOperationSha256,
    artifactIdSha256: ack.artifactIdSha256,
    artifactGeneration: ack.artifactGeneration,
    payloadSha256: ack.payloadSha256,
    manifestSha256: ack.manifestSha256,
    outcome: ack.outcome,
    replayed: ack.replayed,
  });
  if (adapterEvidenceSha256 !== ack.adapterEvidenceSha256) {
    throw new Error("tenant telemetry write ACK adapter evidence is invalid");
  }
  const reservationReceiptSha256 = tenantTelemetryExternalMutationReservationSha256({
    scope: TENANT_TELEMETRY_EXTERNAL_MUTATION_RESERVATION_SCOPE,
    protocol: ack.protocol,
    writeOperationSha256: ack.writeOperationSha256,
    tenantId: ack.tenantId,
    adapterProtocol: ack.adapterProtocol,
    inventorySha256: ack.inventorySha256,
    manifestSha256: ack.manifestSha256,
    startedClaimAttempt: ack.mutationStartedClaimAttempt,
    startedClaimTokenSha256: ack.mutationStartedClaimTokenSha256,
    startedAtDbMs: ack.mutationStartedAtDbMs,
  });
  if (reservationReceiptSha256 !== ack.reservationReceiptSha256) {
    throw new Error("tenant telemetry write ACK reservation evidence is invalid");
  }
  return sha256(["tenant-telemetry-write-ack-v1", ...ACK_BODY_KEYS.map((key) => ack[key])]);
}

export function validateTenantTelemetryWriteAck(ack: TenantTelemetryWriteAck): void {
  exactKeys(ack, [...ACK_BODY_KEYS, "receiptSha256"], "tenant telemetry write ACK record");
  const { receiptSha256, ...body } = ack;
  digest(receiptSha256, "tenant telemetry write ACK receipt");
  if (receiptSha256 !== tenantTelemetryWriteAckSha256(body)) {
    throw new Error("tenant telemetry write ACK receipt does not match");
  }
}

export function validateTenantTelemetryWritePayloadRecord(
  row: TenantTelemetryWritePayloadRecord,
): void {
  exactKeys(row, [
    "writeOperationSha256",
    "tenantId",
    "payload",
    "payloadSha256",
    "recordCount",
    "payloadByteLength",
    "createdAtMs",
  ], "tenant telemetry write payload record");
  digest(row.writeOperationSha256, "tenant telemetry write payload operation");
  tenantId(row.tenantId);
  digest(row.payloadSha256, "tenant telemetry write payload hash");
  const payload = canonicalizeTenantTelemetryArtifactPayload(row.payload);
  if (tenantTelemetryArtifactPayloadSha256(payload) !== row.payloadSha256
    || payload.records.length !== row.recordCount
    || tenantTelemetryArtifactPayloadByteLength(payload) !== row.payloadByteLength) {
    throw new Error("tenant telemetry write payload binding is invalid");
  }
  positive(row.recordCount, "tenant telemetry write payload record count");
  positive(row.payloadByteLength, "tenant telemetry write payload byte length");
  timestamp(row.createdAtMs, "tenant telemetry write payload creation time");
}

export function validateTenantTelemetryWriteJobRecord(
  job: TenantTelemetryWriteJobRecord,
): void {
  digest(job.writeOperationSha256, "tenant telemetry write job operation");
  tenantId(job.tenantId);
  if (job.protocol !== TENANT_TELEMETRY_WRITE_PROTOCOL) {
    throw new Error("tenant telemetry write job protocol is invalid");
  }
  validateTenantTelemetryLifecycleTarget(job.target);
  validateTenantTelemetryArtifactInventory(job.inventory);
  positive(job.recordCount, "tenant telemetry write job record count");
  positive(job.payloadByteLength, "tenant telemetry write job payload byte length");
  timestamp(job.attempts, "tenant telemetry write job attempts");
  timestamp(job.createdAtMs, "tenant telemetry write job creation time");
  timestamp(job.updatedAtMs, "tenant telemetry write job update time");
  if (job.tenantId !== job.inventory.tenantId
    || job.target.domain !== job.inventory.domain
    || job.target.targetSha256 !== job.inventory.targetSha256
    || job.writeOperationSha256
      !== tenantTelemetryWriteOperationSha256(job.inventory.manifestSha256)
    || job.updatedAtMs < job.createdAtMs) {
    throw new Error("tenant telemetry write job bindings are invalid");
  }
    const baseKeys = [
    "writeOperationSha256",
    "tenantId",
    "protocol",
    "phase",
    "target",
    "inventory",
    "recordCount",
    "payloadByteLength",
    "attempts",
    "createdAtMs",
    "updatedAtMs",
    ...(job.reservation === undefined ? [] : ["reservation"]),
  ] as const;
  if (job.reservation !== undefined) {
    validateTenantTelemetryExternalMutationReservation(job.reservation);
    if (job.reservation.writeOperationSha256 !== job.writeOperationSha256
      || job.reservation.tenantId !== job.tenantId
      || job.reservation.adapterProtocol !== job.target.adapterProtocol
      || job.reservation.inventorySha256 !== job.inventory.inventorySha256
      || job.reservation.manifestSha256 !== job.inventory.manifestSha256
      || job.reservation.startedAtDbMs < job.createdAtMs
      || job.reservation.startedAtDbMs > job.updatedAtMs
      || job.reservation.startedClaimAttempt > job.attempts) {
      throw new Error("tenant telemetry write job reservation binding is invalid");
    }
  }
  if (job.phase === "queued") {
    exactKeys(job, [
      ...baseKeys,
      "availableAtMs",
      ...(job.claimToken === undefined ? [] : ["claimToken"]),
      ...(job.leaseUntilMs === undefined ? [] : ["leaseUntilMs"]),
      ...(job.lastErrorCode === undefined ? [] : ["lastErrorCode"]),
    ], "queued tenant telemetry write job");
    timestamp(job.availableAtMs, "tenant telemetry write job availability");
    if ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined)) {
      throw new Error("tenant telemetry write job claim is incomplete");
    }
    if (job.claimToken === undefined) {
      if (job.availableAtMs < job.updatedAtMs) {
        throw new Error("tenant telemetry write job availability predates its update");
      }
    } else {
      claimToken(job.claimToken);
      timestamp(job.leaseUntilMs, "tenant telemetry write job lease");
      if (job.attempts < 1 || job.leaseUntilMs < job.updatedAtMs
        || job.lastErrorCode !== undefined) {
        throw new Error("tenant telemetry write active claim is invalid");
      }
    }
    if (job.lastErrorCode !== undefined
      && job.lastErrorCode !== "temporary_failure"
      && job.lastErrorCode !== "dependency_pending") {
      throw new Error("tenant telemetry write retry error code is invalid");
    }
    return;
  }
  if (job.phase === "written") {
    exactKeys(job, [
      ...baseKeys,
      "writeAckReceiptSha256",
      "writtenAtDbMs",
      "completedClaimAttempt",
      "completedClaimTokenSha256",
    ], "written tenant telemetry write job");
    digest(job.writeAckReceiptSha256, "tenant telemetry write job ACK receipt");
    digest(job.completedClaimTokenSha256, "tenant telemetry write job claim token");
    positive(job.completedClaimAttempt, "tenant telemetry write job completion attempt");
    timestamp(job.writtenAtDbMs, "tenant telemetry write job completion time");
    if (job.completedClaimAttempt !== job.attempts
      || job.writtenAtDbMs > job.updatedAtMs
      || job.writtenAtDbMs < job.createdAtMs) {
      throw new Error("written tenant telemetry write job evidence is invalid");
    }
    return;
  }
  if (job.phase === "blocked") {
    exactKeys(job, [...baseKeys, "blockedAtDbMs", "blockedReasonCode"],
      "blocked tenant telemetry write job");
    timestamp(job.blockedAtDbMs, "tenant telemetry write job blocked time");
    if (job.blockedReasonCode !== "integrity_conflict"
      || job.blockedAtDbMs < job.createdAtMs
      || job.blockedAtDbMs > job.updatedAtMs) {
      throw new Error("blocked tenant telemetry write job evidence is invalid");
    }
    return;
  }
  throw new Error("tenant telemetry write job phase is invalid");
}

export class TenantTelemetryWriteConflictError extends Error {
  constructor(message = "tenant telemetry write state conflicts with the requested operation") {
    super(message);
    this.name = "TenantTelemetryWriteConflictError";
  }
}

export class TenantTelemetryWriteIntegrityError extends Error {
  constructor(message = "tenant telemetry write evidence is invalid") {
    super(message);
    this.name = "TenantTelemetryWriteIntegrityError";
  }
}

export interface TenantTelemetryWriterStore {
  enqueueTenantTelemetryArtifact(
    input: EnqueueTenantTelemetryArtifactInput,
  ): Promise<TenantTelemetryWriteJobRecord>;
  claimTenantTelemetryWriteJobs(
    options: ClaimTenantTelemetryWriteJobsOptions,
  ): Promise<TenantTelemetryWriteClaim[]>;
  renewTenantTelemetryWrite(
    authorization: TenantTelemetryWriteAuthorization,
    options: RenewTenantTelemetryWriteOptions,
  ): Promise<boolean>;
  reserveTenantTelemetryExternalMutation(
    authorization: TenantTelemetryWriteAuthorization,
    adapterProtocol: string,
  ): Promise<TenantTelemetryExternalMutationReservation | null>;
  retryTenantTelemetryWrite(
    authorization: TenantTelemetryWriteAuthorization,
    options: RetryTenantTelemetryWriteOptions,
  ): Promise<boolean>;
  blockTenantTelemetryWrite(
    authorization: TenantTelemetryWriteAuthorization,
    reason?: TenantTelemetryWriteBlockReasonCode,
  ): Promise<boolean>;
  completeTenantTelemetryWrite(
    authorization: TenantTelemetryWriteAuthorization,
    result: TenantTelemetryWriteAdapterResult,
  ): Promise<TenantTelemetryWriteAck | null>;
  getTenantTelemetryWriteJob(
    tenantId: string,
    writeOperationSha256: string,
  ): Promise<TenantTelemetryWriteJobRecord | null>;
  getTenantTelemetryWriteAck(
    tenantId: string,
    writeOperationSha256: string,
  ): Promise<TenantTelemetryWriteAck | null>;
}
