import {
  EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
  TENANT_TELEMETRY_DISPOSITION_EXTERNAL_EVENT_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_EXTERNAL_HEAD_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TENANT_TELEMETRY_EXTERNAL_AUTHORIZATION_SCOPE,
  TenantTelemetryDispositionConflictError,
  TenantTelemetryDispositionCorruptError,
  tenantTelemetryDispositionExternalEventOperation,
  tenantTelemetryDispositionExternalEventProof,
  tenantTelemetryDispositionExternalEventReceipt,
  tenantTelemetryDispositionExternalEventSha256,
  tenantTelemetryDispositionNextEventRootSha256,
  tenantTelemetryExternalAuthorizationReceiptSha256,
  tenantTelemetryExternalTombstoneReceiptSha256,
  validateTenantTelemetryDispositionEvidence,
  validateTenantTelemetryDispositionEventProof,
  validateTenantTelemetryDispositionExternalEvent,
  validateTenantTelemetryDispositionExternalHead,
  validateTenantTelemetryDispositionJournalIdentity,
  validateTenantTelemetryExternalAuthorizationProof,
  validateTenantTelemetrySameKeyTombstoneAck,
  type TenantTelemetryDispositionEventProof,
  type TenantTelemetryDispositionEvidence,
  type TenantTelemetryDispositionExternalEvent,
  type TenantTelemetryDispositionExternalEventType,
  type TenantTelemetryDispositionExternalHead,
  type TenantTelemetryDispositionIdentity,
  type TenantTelemetryDispositionJournalIdentity,
  type TenantTelemetryExternalAuthorizationBody,
  type TenantTelemetryExternalAuthorizationProof,
  type TenantTelemetryExternalTombstoneBody,
  type TenantTelemetryExternalTombstoneProof,
  type TenantTelemetrySameKeyTombstoneAck,
} from "../tenant-telemetry-disposition.js";

export { TenantTelemetryDispositionConflictError, TenantTelemetryDispositionCorruptError };

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TenantTelemetryDispositionCorruptError(
      "tenant telemetry disposition JSON contains an unsupported value",
    );
  }
  return encoded;
}

export function sameTenantTelemetryDispositionEvent(
  left: TenantTelemetryDispositionExternalEvent,
  right: TenantTelemetryDispositionExternalEvent,
): boolean {
  try {
    validateTenantTelemetryDispositionExternalEvent(left);
    validateTenantTelemetryDispositionExternalEvent(right);
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

export function tenantTelemetryDispositionFenceKey(
  identity: TenantTelemetryDispositionIdentity,
): string {
  return `${identity.domain}:${identity.targetSha256}:${identity.artifactIdSha256}:${identity.artifactGeneration}`;
}

export function emptyTenantTelemetryDispositionHead(
  identity: TenantTelemetryDispositionJournalIdentity,
): TenantTelemetryDispositionExternalHead {
  validateTenantTelemetryDispositionJournalIdentity(identity);
  const head: TenantTelemetryDispositionExternalHead = {
    scope: TENANT_TELEMETRY_DISPOSITION_EXTERNAL_HEAD_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    ...identity,
    journalSequence: 0,
    journalEventRootSha256: EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
  };
  validateTenantTelemetryDispositionExternalHead(head);
  return head;
}

export function nextTenantTelemetryDispositionEventProof(
  previous: TenantTelemetryDispositionExternalHead,
  eventType: TenantTelemetryDispositionExternalEventType,
  dispositionOperationSha256: string,
  eventReceiptSha256: string,
): TenantTelemetryDispositionEventProof {
  validateTenantTelemetryDispositionExternalHead(previous);
  const journalSequence = previous.journalSequence + 1;
  if (!Number.isSafeInteger(journalSequence)) {
    throw new TenantTelemetryDispositionCorruptError(
      "tenant telemetry disposition journal sequence is exhausted",
    );
  }
  const journalEventSha256 = tenantTelemetryDispositionExternalEventSha256({
    eventType,
    dispositionOperationSha256,
    eventReceiptSha256,
  });
  const proof: TenantTelemetryDispositionEventProof = {
    journalSequence,
    previousJournalEventRootSha256: previous.journalEventRootSha256,
    journalEventSha256,
    journalEventRootSha256: tenantTelemetryDispositionNextEventRootSha256({
      previousJournalEventRootSha256: previous.journalEventRootSha256,
      journalSequence,
      journalEventSha256,
    }),
  };
  validateTenantTelemetryDispositionEventProof(proof, journalEventSha256);
  return proof;
}

export function headAfterTenantTelemetryDispositionEvent(
  identity: TenantTelemetryDispositionJournalIdentity,
  event: TenantTelemetryDispositionExternalEvent,
): TenantTelemetryDispositionExternalHead {
  validateTenantTelemetryDispositionJournalIdentity(identity);
  validateTenantTelemetryDispositionExternalEvent(event);
  const proof = tenantTelemetryDispositionExternalEventProof(event);
  const head: TenantTelemetryDispositionExternalHead = {
    scope: TENANT_TELEMETRY_DISPOSITION_EXTERNAL_HEAD_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    ...identity,
    journalSequence: proof.journalSequence,
    journalEventRootSha256: proof.journalEventRootSha256,
  };
  validateTenantTelemetryDispositionExternalHead(head);
  return head;
}

function sameJournalIdentity(
  identity: TenantTelemetryDispositionJournalIdentity,
  value: TenantTelemetryDispositionJournalIdentity,
): boolean {
  return identity.adapterProtocol === value.adapterProtocol
    && identity.journalNamespaceSha256 === value.journalNamespaceSha256
    && identity.journalTargetSha256 === value.journalTargetSha256
    && identity.failureDomainSha256 === value.failureDomainSha256
    && identity.logicalDatabaseNamespaceSha256 === value.logicalDatabaseNamespaceSha256;
}

export function buildTenantTelemetryExternalAuthorizationProof(
  identity: TenantTelemetryDispositionJournalIdentity,
  evidence: TenantTelemetryDispositionEvidence,
  head: TenantTelemetryDispositionExternalHead,
): TenantTelemetryExternalAuthorizationProof {
  validateTenantTelemetryDispositionJournalIdentity(identity);
  validateTenantTelemetryDispositionEvidence(evidence);
  validateTenantTelemetryDispositionExternalHead(head);
  if (!sameJournalIdentity(identity, head)) throw new TenantTelemetryDispositionConflictError();
  const body: TenantTelemetryExternalAuthorizationBody = {
    scope: TENANT_TELEMETRY_EXTERNAL_AUTHORIZATION_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    ...evidence,
    ...identity,
  };
  const authorizationReceiptSha256 =
    tenantTelemetryExternalAuthorizationReceiptSha256(body);
  const proof = nextTenantTelemetryDispositionEventProof(
    head,
    "delete_authorized",
    evidence.dispositionOperationSha256,
    authorizationReceiptSha256,
  );
  const result = { ...body, authorizationReceiptSha256, ...proof };
  validateTenantTelemetryDispositionExternalEvent({
    eventType: "delete_authorized",
    result,
  });
  return result;
}

function evidenceFromAuthorization(
  authorization: TenantTelemetryExternalAuthorizationProof,
): TenantTelemetryDispositionEvidence {
  return {
    domain: authorization.domain,
    targetSha256: authorization.targetSha256,
    artifactIdSha256: authorization.artifactIdSha256,
    artifactGeneration: authorization.artifactGeneration,
    inventorySha256: authorization.inventorySha256,
    inventoryReceiptSha256: authorization.inventoryReceiptSha256,
    writeOperationSha256: authorization.writeOperationSha256,
    writeAckReceiptSha256: authorization.writeAckReceiptSha256,
    payloadSha256: authorization.payloadSha256,
    manifestSha256: authorization.manifestSha256,
    lifecycleCoverageEvidenceSha256: authorization.lifecycleCoverageEvidenceSha256,
    applicationCoverageEvidenceSha256: authorization.applicationCoverageEvidenceSha256,
    applicationWriteBindingReceiptSha256:
      authorization.applicationWriteBindingReceiptSha256,
    t3cReceiptSha256: authorization.t3cReceiptSha256,
    t3dPlanReceiptSha256: authorization.t3dPlanReceiptSha256,
    t3dPlanEntryReceiptSha256: authorization.t3dPlanEntryReceiptSha256,
    dispositionOperationSha256: authorization.dispositionOperationSha256,
  };
}

export function exactTombstoneAckForAuthorization(
  authorization: TenantTelemetryExternalAuthorizationProof,
  ack: TenantTelemetrySameKeyTombstoneAck,
): boolean {
  try {
    validateTenantTelemetryExternalAuthorizationProof(authorization);
    validateTenantTelemetrySameKeyTombstoneAck(ack);
    return authorization.authorizationReceiptSha256 === ack.authorizationReceiptSha256
      && canonicalJson(evidenceFromAuthorization(authorization))
        === canonicalJson(Object.fromEntries(
          Object.keys(evidenceFromAuthorization(authorization)).map(
            (key) => [key, ack[key as keyof TenantTelemetrySameKeyTombstoneAck]],
          ),
        ));
  } catch {
    return false;
  }
}

export function buildTenantTelemetryExternalTombstoneProof(
  identity: TenantTelemetryDispositionJournalIdentity,
  authorization: TenantTelemetryExternalAuthorizationProof,
  ack: TenantTelemetrySameKeyTombstoneAck,
  head: TenantTelemetryDispositionExternalHead,
): TenantTelemetryExternalTombstoneProof {
  validateTenantTelemetryDispositionJournalIdentity(identity);
  validateTenantTelemetryExternalAuthorizationProof(authorization);
  validateTenantTelemetrySameKeyTombstoneAck(ack);
  validateTenantTelemetryDispositionExternalHead(head);
  if (!sameJournalIdentity(identity, head)
    || !sameJournalIdentity(identity, authorization)
    || !exactTombstoneAckForAuthorization(authorization, ack)) {
    throw new TenantTelemetryDispositionConflictError();
  }
  const body: TenantTelemetryExternalTombstoneBody = {
    scope: TENANT_TELEMETRY_DISPOSITION_EXTERNAL_EVENT_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    ...identity,
    authorization,
    tombstoneAck: ack,
  };
  const terminalReceiptSha256 = tenantTelemetryExternalTombstoneReceiptSha256(body);
  const proof = nextTenantTelemetryDispositionEventProof(
    head,
    "delete_tombstoned",
    authorization.dispositionOperationSha256,
    terminalReceiptSha256,
  );
  const result = { ...body, terminalReceiptSha256, ...proof };
  validateTenantTelemetryDispositionExternalEvent({
    eventType: "delete_tombstoned",
    result,
  });
  return result;
}

export function assertTenantTelemetryDispositionEventChain(
  identity: TenantTelemetryDispositionJournalIdentity,
  events: readonly TenantTelemetryDispositionExternalEvent[],
): void {
  validateTenantTelemetryDispositionJournalIdentity(identity);
  let head = emptyTenantTelemetryDispositionHead(identity);
  const authorizations = new Map<string, TenantTelemetryExternalAuthorizationProof>();
  const terminals = new Set<string>();
  const fences = new Map<string, string>();
  for (const event of events) {
    try {
      validateTenantTelemetryDispositionExternalEvent(event);
      const eventIdentity = event.eventType === "delete_authorized"
        ? event.result
        : event.result.authorization;
      if (!sameJournalIdentity(identity, eventIdentity)) {
        throw new TenantTelemetryDispositionCorruptError();
      }
      const proof = tenantTelemetryDispositionExternalEventProof(event);
      if (proof.journalSequence !== head.journalSequence + 1
        || proof.previousJournalEventRootSha256 !== head.journalEventRootSha256) {
        throw new TenantTelemetryDispositionCorruptError();
      }
      const operation = tenantTelemetryDispositionExternalEventOperation(event);
      if (event.eventType === "delete_authorized") {
        if (authorizations.has(operation)) throw new TenantTelemetryDispositionCorruptError();
        const fenceKey = tenantTelemetryDispositionFenceKey(event.result);
        const existingFenceOperation = fences.get(fenceKey);
        if (existingFenceOperation !== undefined && existingFenceOperation !== operation) {
          throw new TenantTelemetryDispositionCorruptError();
        }
        fences.set(fenceKey, operation);
        authorizations.set(operation, event.result);
      } else {
        const authorization = authorizations.get(operation);
        if (!authorization
          || terminals.has(operation)
          || !sameTenantTelemetryDispositionEvent(
            { eventType: "delete_authorized", result: authorization },
            { eventType: "delete_authorized", result: event.result.authorization },
          )) {
          throw new TenantTelemetryDispositionCorruptError();
        }
        terminals.add(operation);
      }
      head = headAfterTenantTelemetryDispositionEvent(identity, event);
    } catch (error) {
      if (error instanceof TenantTelemetryDispositionCorruptError) throw error;
      throw new TenantTelemetryDispositionCorruptError();
    }
  }
}

export function findTenantTelemetryDispositionAuthorization(
  events: readonly TenantTelemetryDispositionExternalEvent[],
  dispositionOperationSha256: string,
): TenantTelemetryExternalAuthorizationProof | undefined {
  const event = events.find((candidate) => candidate.eventType === "delete_authorized"
    && candidate.result.dispositionOperationSha256 === dispositionOperationSha256);
  return event?.eventType === "delete_authorized" ? event.result : undefined;
}

export function findTenantTelemetryDispositionTerminal(
  events: readonly TenantTelemetryDispositionExternalEvent[],
  dispositionOperationSha256: string,
): TenantTelemetryExternalTombstoneProof | undefined {
  const event = events.find((candidate) => candidate.eventType === "delete_tombstoned"
    && candidate.result.authorization.dispositionOperationSha256
      === dispositionOperationSha256);
  return event?.eventType === "delete_tombstoned" ? event.result : undefined;
}
