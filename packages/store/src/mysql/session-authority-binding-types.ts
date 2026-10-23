import type { ActivateTenantRestoreJournalControlInput, ActivateTenantRestoreRuntimeInput } from "../tenant-restore-journal.js";
import type { PoolConnection } from "mysql2/promise";
import type { SchemaMetadataReaderConfig } from "./schema-metadata.js";

/** INTERNAL operator/runtime contract; not an HTTP DTO or generated SDK surface. */
export interface SessionAuthorityRuntimeAccount { readonly user: string; readonly host: string }
export interface SessionAuthorityBindingCommandInput {
  readonly bindingId: string;
  readonly activationId: string;
  readonly expectedBindingId: string | null;
  readonly expectedSequence: number;
  readonly serverUuid: string;
  readonly applicationDatabase: string;
  readonly newAccounts: readonly SessionAuthorityRuntimeAccount[];
  /** Every host-qualified mysql.user row for these names must be locked, USAGE-only and idle. */
  readonly oldAccountNames: readonly string[];
  readonly activationEvidenceSha256: string;
  readonly expectedSource: SessionAuthorityBindingSource;
  /** Fixed known request intent; never a future DB timestamp/event hash. */
  readonly nextEpoch: SessionAuthorityNextEpoch | null;
}
declare const preparedBindingBrand: unique symbol;
export interface PreparedSessionAuthorityBindingCommand { readonly [preparedBindingBrand]: true }
export interface CapturedSessionAuthorityBindingCommand extends SessionAuthorityBindingCommandInput {
  readonly accountsSha256: string;
  readonly commandSha256: string;
}
/** Values are independently re-read from native source tables in the caller's original TX. */
export type SessionAuthorityBindingSource =
  | { readonly kind: "inactive"; readonly runtimeControlGeneration: 0;
      readonly runtimeControlEvidenceSha256: null; readonly runtimeEpochSha256: null;
      readonly restoreRunId: null; readonly replayReceiptSha256: null }
  | { readonly kind: "primary_activation"; readonly runtimeControlGeneration: number;
      readonly runtimeControlEvidenceSha256: string; readonly runtimeEpochSha256: string;
      readonly restoreRunId: null; readonly replayReceiptSha256: null }
  | { readonly kind: "restore_activation"; readonly runtimeControlGeneration: number;
      readonly runtimeControlEvidenceSha256: string; readonly runtimeEpochSha256: string;
      readonly restoreRunId: string; readonly replayReceiptSha256: string };

export interface ActiveSessionAuthorityBinding {
  readonly bindingId: string;
  readonly bindingSequence: number;
  readonly serverUuid: string;
  readonly applicationDatabase: string;
  readonly accountsSha256: string;
}

/**
 * Root-owned native operator module supplies this private dependency; no public/environment
 * boolean or caller-provided evidence can replace its actual native checks. Called again inside
 * the activation TX, before any binding/account mutation. It reads CURRENT_USER/roles/proxy,
 * mysql.user/all old-name host variants/grants/threads/transactions, proves old names disjoint
 * from the new list, and checks each new account's closed table grants plus exact metadata EXECUTE.
 * It must not GRANT, KILL, install DDL, or commit/rollback the caller's transaction.
 */
export type AssertSessionAuthorityActivationAdmission = (
  conn: PoolConnection,
  command: Readonly<CapturedSessionAuthorityBindingCommand>,
  schemaMetadata: SchemaMetadataReaderConfig,
) => Promise<void>;

export interface SessionAuthorityBindingOperatorContext {
  readonly command: PreparedSessionAuthorityBindingCommand;
  readonly schemaMetadata: SchemaMetadataReaderConfig;
  readonly assertNativeAdmission: AssertSessionAuthorityActivationAdmission;
}

export type SessionAuthorityActivationKind = "primary_activation" | "restore_activation";
export type SessionAuthorityNextEpoch =
  | Readonly<{ kind: "primary_activation"; runtimeEpochSha256: string; restoreRunId: null;
      activationRequestSha256: string; sealedReplayReceiptSha256: null }>
  | Readonly<{ kind: "restore_activation"; runtimeEpochSha256: string; restoreRunId: string;
      activationRequestSha256: string; sealedReplayReceiptSha256: string }>;
declare const preparedActivationRequestBrand: unique symbol;
export interface PreparedSessionAuthorityActivationRequest { readonly [preparedActivationRequestBrand]: true }
export type CapturedSessionAuthorityActivationRequest =
  | Readonly<{ kind: "primary_activation"; input: Readonly<ActivateTenantRestoreJournalControlInput>; activationRequestSha256: string }>
  | Readonly<{ kind: "restore_activation"; input: Readonly<ActivateTenantRestoreRuntimeInput>; activationRequestSha256: string }>;
declare const preparedBindingTransitionBrand: unique symbol;
/** Kept only inside the original trusted Store transaction; never exposed by the maintenance facade. */
export interface PreparedSessionAuthorityBindingTransition { readonly [preparedBindingTransitionBrand]: true }
