import { createHash, randomUUID } from "node:crypto";
import {
  addUsage,
  emptyUsage,
  emptyUsageAccumulator,
  type Item,
  type PersistedEvent,
  type Usage,
} from "@agent-service/protocol";
import type {
  AnonymizeSessionUsageInput,
  BillingUsageFact,
  ReconcileSessionUsageInput,
  UsageLedgerEntry,
  UsageReconciliationSummary,
  UsageTokenColumns,
} from "./types.js";

const USAGE_ID = /^usg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACCOUNTING_PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const MAX_BILLING_COST_CNY = 1_000_000_000_000_000;

export class UsageIdentityConflictError extends Error {
  constructor(public readonly usageId: string) {
    super(`usage identity ${usageId} is already assigned to another operational row or billing fact`);
    this.name = "UsageIdentityConflictError";
  }
}

export class UsageLifecycleGenerationError extends Error {
  constructor(public readonly sessionId: string, public readonly deletionGeneration: number) {
    super(`session ${sessionId} is not tombstoned at deletion generation ${deletionGeneration}`);
    this.name = "UsageLifecycleGenerationError";
  }
}

export class UsageReconciliationError extends Error {
  constructor(message = "operational usage and billing facts did not reconcile") {
    super(message);
    this.name = "UsageReconciliationError";
  }
}

export class UsageAnonymizationDisabledError extends Error {
  constructor() {
    super("usage anonymization is disabled unless explicitly enabled");
    this.name = "UsageAnonymizationDisabledError";
  }
}

export class UsageLegalHoldError extends Error {
  constructor() {
    super("usage anonymization is blocked by a durable legal hold");
    this.name = "UsageLegalHoldError";
  }
}

/** Opaque random identity: no tenant, user, session, timestamp, or business key is encoded in it. */
export function newUsageId(): string {
  return `usg_${randomUUID()}`;
}

export function isUsageId(value: unknown): value is string {
  return typeof value === "string" && USAGE_ID.test(value);
}

/** Historical JSON may encode an unknown price as null; current protocol rows omit the field. */
export function normalizeHistoricalUsageCost(
  usage: UsageLedgerEntry["usage"],
): UsageLedgerEntry["usage"] {
  const historical = usage as Partial<UsageLedgerEntry["usage"]> & { costCNY?: number | null };
  // Early ledgers did not always serialize the three cache/reasoning counters. Zero-fill only
  // missing counters; malformed present values still flow into the validators and fail closed.
  const normalized = {
    ...emptyUsage(),
    ...historical,
  } as UsageLedgerEntry["usage"] & { costCNY?: number | null };
  if (normalized.costCNY === null) delete normalized.costCNY;
  return normalized;
}

/**
 * A freshly-created projection has no constituent provider rows, so known zero is its additive
 * identity. Pre-0011 callers used `emptyUsage()` and omitted costCNY; normalize only at a boundary
 * that proves the projection is new/rowless. Never apply this heuristic to an arbitrary aggregate:
 * a real zero-token provider response can still have unknown price.
 */
export function normalizeRowlessUsageProjection(usage: Usage): Usage {
  if (
    usage.costCNY === undefined
    && usage.inputTokens === 0
    && usage.outputTokens === 0
    && usage.cacheReadTokens === 0
    && usage.cacheWriteTokens === 0
    && usage.reasoningTokens === 0
    && usage.totalTokens === 0
  ) {
    return { ...usage, costCNY: 0 };
  }
  return usage;
}

export interface UsageProjectionLedgerRow {
  usageId?: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  turnId: string;
  step: number;
  usage: Usage;
}

export interface UsageProjectionSummary {
  rowCount: number;
  ownerRowCount: number;
  pricedRowCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costCNY: number;
}

export function emptyUsageProjectionSummary(): UsageProjectionSummary {
  return {
    rowCount: 0,
    ownerRowCount: 0,
    pricedRowCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costCNY: 0,
  };
}

/**
 * Before usage_id existed Pi encoded an unconfigured price as numeric zero, indistinguishable from
 * a genuinely free model. Fail closed while that provenance is still visible: a NULL identity plus
 * zero cost is unknown. Reconciliation must apply this before assigning the row its new identity.
 */
export function normalizeOperationalUsageCost(
  usage: Usage,
  usageId: string | undefined,
): Usage {
  const normalized = normalizeHistoricalUsageCost(usage);
  if (usageId !== undefined || normalized.costCNY !== 0) return normalized;
  const ambiguous = { ...normalized };
  delete ambiguous.costCNY;
  return ambiguous;
}

/** Rebuild one aggregate from its operational facts. Unknown is sticky through addUsage(). */
export function aggregateUsageProjection(rows: readonly UsageProjectionLedgerRow[]): Usage {
  let aggregate = emptyUsageAccumulator();
  for (const row of rows) {
    aggregate = addUsage(aggregate, normalizeOperationalUsageCost(row.usage, row.usageId));
  }
  return aggregate;
}

export function summarizeUsageProjectionRows(
  rows: readonly UsageProjectionLedgerRow[],
  owner: { tenantId: string; userId: string },
): UsageProjectionSummary {
  const summary: UsageProjectionSummary = {
    rowCount: rows.length,
    ownerRowCount: 0,
    pricedRowCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costCNY: 0,
  };
  for (const row of rows) {
    if (row.tenantId !== owner.tenantId || row.userId !== owner.userId) continue;
    const usage = normalizeOperationalUsageCost(row.usage, row.usageId);
    summary.ownerRowCount += 1;
    summary.inputTokens += usage.inputTokens;
    summary.outputTokens += usage.outputTokens;
    summary.cacheReadTokens += usage.cacheReadTokens;
    summary.cacheWriteTokens += usage.cacheWriteTokens;
    summary.reasoningTokens += usage.reasoningTokens;
    summary.totalTokens += usage.totalTokens;
    if (usage.costCNY !== undefined) {
      summary.pricedRowCount += 1;
      summary.costCNY += usage.costCNY;
    }
  }
  return summary;
}

export function usageProjectionFromSummary(stored: Usage, summary: UsageProjectionSummary): Usage {
  if (summary.rowCount === 0) {
    return canonicalUsageProjection(stored, [], { tenantId: "", userId: "" });
  }
  return {
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
    reasoningTokens: summary.reasoningTokens,
    totalTokens: summary.totalTokens,
    ...(summary.ownerRowCount === summary.rowCount && summary.pricedRowCount === summary.rowCount
      ? { costCNY: summary.costCNY }
      : {}),
  };
}

export function mergeUsageProjectionSummaries(
  left: UsageProjectionSummary | undefined,
  right: UsageProjectionSummary | undefined,
): UsageProjectionSummary {
  const empty = emptyUsageProjectionSummary();
  const a = left ?? empty;
  const b = right ?? empty;
  return {
    rowCount: a.rowCount + b.rowCount,
    ownerRowCount: a.ownerRowCount + b.ownerRowCount,
    pricedRowCount: a.pricedRowCount + b.pricedRowCount,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costCNY: a.costCNY + b.costCNY,
  };
}

export function isUsageProjectionCostComplete(summary: UsageProjectionSummary): boolean {
  return summary.rowCount > 0
    && summary.ownerRowCount === summary.rowCount
    && summary.pricedRowCount === summary.rowCount;
}

/**
 * Keep historical counters, but expose their cost only when the current authoritative ledger
 * proves that every constituent row is owner-valid and priced. This is used for immutable
 * intermediate event snapshots whose counters cannot be reconstructed from the final aggregate.
 */
export function failClosedUsageProjectionCost(
  stored: Usage,
  summary: UsageProjectionSummary,
): Usage {
  if (summary.rowCount === 0) {
    return canonicalUsageProjection(stored, [], { tenantId: "", userId: "" });
  }
  const normalized = normalizeHistoricalUsageCost(stored);
  if (isUsageProjectionCostComplete(summary)) return normalized;
  const result = { ...normalized };
  delete result.costCNY;
  return result;
}

export function usageProjectionStepKey(turnId: string, step: number): string {
  return JSON.stringify([turnId, step]);
}

/** A compaction usage snapshot is the exact provider fact recorded at its synthetic turn step 0. */
export function canonicalizeUsageItem(
  item: Item,
  exactRow: UsageProjectionLedgerRow | undefined,
): Item {
  if (item.type !== "contextCompaction" || item.usageSnapshot === undefined) return item;
  return {
    ...item,
    usageSnapshot: exactRow
      ? normalizeOperationalUsageCost(exactRow.usage, exactRow.usageId)
      : failClosedUsageProjectionCost(item.usageSnapshot, emptyUsageProjectionSummary()),
  };
}

export interface UsageEventProjectionSummaries {
  session: UsageProjectionSummary;
  turns: ReadonlyMap<string, UsageProjectionSummary>;
  turnPrefixes: ReadonlyMap<string, UsageProjectionSummary>;
  exactRows: ReadonlyMap<string, UsageProjectionLedgerRow>;
}

/** SQL-backed equivalent of canonicalizePersistedUsageEvent that needs only aggregate summaries. */
export function canonicalizePersistedUsageEventFromSummaries(
  event: PersistedEvent,
  summaries: UsageEventProjectionSummaries,
): PersistedEvent {
  if (event.type === "item/started" || event.type === "item/completed") {
    return {
      ...event,
      item: canonicalizeUsageItem(
        event.item,
        summaries.exactRows.get(usageProjectionStepKey(event.item.turnId, 0)),
      ),
    };
  }
  if (event.type === "turn/started") {
    return {
      ...event,
      turn: {
        ...event.turn,
        usage: usageProjectionFromSummary(event.turn.usage, emptyUsageProjectionSummary()),
      },
    };
  }
  if (event.type === "turn/completed") {
    return {
      ...event,
      turn: {
        ...event.turn,
        usage: usageProjectionFromSummary(
          event.turn.usage,
          summaries.turns.get(event.turn.id) ?? emptyUsageProjectionSummary(),
        ),
      },
    };
  }
  if (event.type !== "usage/updated") return event;

  const exact = summaries.exactRows.get(usageProjectionStepKey(event.turnId, event.step));
  return {
    ...event,
    stepUsage: exact
      ? normalizeOperationalUsageCost(exact.usage, exact.usageId)
      : failClosedUsageProjectionCost(event.stepUsage, emptyUsageProjectionSummary()),
    turnUsage: failClosedUsageProjectionCost(
      usageProjectionFromSummary(
        event.turnUsage,
        summaries.turnPrefixes.get(usageProjectionStepKey(event.turnId, event.step))
          ?? emptyUsageProjectionSummary(),
      ),
      summaries.turnPrefixes.get(usageProjectionStepKey(event.turnId, event.step))
        ?? emptyUsageProjectionSummary(),
    ),
    sessionUsage: failClosedUsageProjectionCost(event.sessionUsage, summaries.session),
  };
}

/**
 * Operational facts are authoritative for a current session/turn projection. Owner-corrupt rows
 * never contribute counters and make cost fail closed. With no facts, only a genuinely empty stored
 * projection can be upgraded to the known-zero aggregation identity.
 *
 * A legacy NULL-usage-id `costCNY: 0` is conservatively unknown because pre-0011 Pi used that value
 * for unconfigured prices. New identified rows can still represent a genuinely known zero.
 */
export function canonicalUsageProjection(
  stored: Usage,
  rows: readonly UsageProjectionLedgerRow[],
  owner: { tenantId: string; userId: string },
): Usage {
  const summary = summarizeUsageProjectionRows(rows, owner);
  if (summary.rowCount === 0) {
    const normalizedStored = normalizeHistoricalUsageCost(stored);
    let result = normalizeRowlessUsageProjection(normalizedStored);
    // No fact can support a non-empty aggregate cost. Preserve counters for diagnosis, but never
    // publish a legacy subtotal merely because the old projection happened to contain one.
    if (result.costCNY !== 0 || result.totalTokens !== 0 || result.inputTokens !== 0
      || result.outputTokens !== 0 || result.cacheReadTokens !== 0
      || result.cacheWriteTokens !== 0 || result.reasoningTokens !== 0) {
      result = { ...result };
      delete result.costCNY;
    }
    return result;
  }
  return usageProjectionFromSummary(stored, summary);
}

function stripCostUnlessComplete(
  stored: Usage,
  rows: readonly UsageProjectionLedgerRow[],
  ownerValid: boolean,
): Usage {
  const normalized = normalizeHistoricalUsageCost(stored);
  if (
    rows.length > 0
    && ownerValid
    && rows.every((row) => normalizeOperationalUsageCost(row.usage, row.usageId).costCNY !== undefined)
  ) {
    return normalized;
  }
  const rowless = normalizeRowlessUsageProjection(normalized);
  if (
    rows.length === 0
    && rowless.costCNY === 0
    && rowless.inputTokens === 0
    && rowless.outputTokens === 0
    && rowless.cacheReadTokens === 0
    && rowless.cacheWriteTokens === 0
    && rowless.reasoningTokens === 0
    && rowless.totalTokens === 0
  ) return rowless;
  const failClosed = { ...normalized };
  delete failClosed.costCNY;
  return failClosed;
}

/**
 * Legacy events are immutable historical snapshots, but their old aggregate cost could be a known
 * subtotal. Repair replay at the read boundary: full turn snapshots are rebuilt; time-scoped usage
 * event counters stay unchanged while their cost is removed unless the ledger proves completeness.
 */
export function canonicalizePersistedUsageEvent(
  event: PersistedEvent,
  rows: readonly UsageProjectionLedgerRow[],
  owner: { tenantId: string; userId: string },
): PersistedEvent {
  const owned = rows.filter((row) => row.tenantId === owner.tenantId && row.userId === owner.userId);
  const ownerValid = owned.length === rows.length;
  if (event.type === "item/started" || event.type === "item/completed") {
    const exact = owned.find((row) => row.turnId === event.item.turnId && row.step === 0);
    return { ...event, item: canonicalizeUsageItem(event.item, exact) };
  }
  if (event.type === "turn/started") {
    return {
      ...event,
      turn: { ...event.turn, usage: canonicalUsageProjection(event.turn.usage, [], owner) },
    };
  }
  if (event.type === "turn/completed") {
    const turnRows = rows.filter((row) => row.turnId === event.turn.id);
    return {
      ...event,
      turn: {
        ...event.turn,
        usage: canonicalUsageProjection(event.turn.usage, turnRows, owner),
      },
    };
  }
  if (event.type !== "usage/updated") return event;

  const exactStep = owned.find((row) => row.turnId === event.turnId && row.step === event.step);
  const throughStep = rows.filter((row) => row.turnId === event.turnId && row.step <= event.step);
  return {
    ...event,
    stepUsage: exactStep ? normalizeOperationalUsageCost(exactStep.usage, exactStep.usageId) : stripCostUnlessComplete(event.stepUsage, [], false),
    turnUsage: canonicalUsageProjection(event.turnUsage, throughStep, owner),
    // Using the whole current session is deliberately conservative for an old intermediate event:
    // a later unknown row can remove a formerly complete cost, but can never expose a partial total.
    sessionUsage: stripCostUnlessComplete(event.sessionUsage, owned, ownerValid),
  };
}

export function usageAccountingPeriodUtc(createdAtMs: number): string {
  assertTimestamp(createdAtMs, "usage creation timestamp");
  return new Date(createdAtMs).toISOString().slice(0, 7);
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new Error(`invalid ${name}`);
  }
}

function assertToken(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
}

function assertCost(value: number | undefined): void {
  if (value !== undefined) normalizeBillingCostCNY(value);
}

/** Match DECIMAL(24,9) deliberately; never rely on an implicit database rounding side effect. */
export function normalizeBillingCostCNY(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= MAX_BILLING_COST_CNY) {
    throw new Error("invalid usage cost");
  }
  const normalized = Number(value.toFixed(9));
  return Object.is(normalized, -0) ? 0 : normalized;
}

/** Canonical wire/storage form for a DECIMAL(24,9) billing amount and its integrity checksum. */
export function canonicalBillingCostCNY(value: number): string {
  return normalizeBillingCostCNY(value).toFixed(9);
}

function billingCostNano(value: number): bigint {
  const [whole, fraction] = canonicalBillingCostCNY(value).split(".") as [string, string];
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction);
}

function billingCostFromNano(value: bigint): number {
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0");
  const result = Number(`${whole}.${fraction}`);
  return normalizeBillingCostCNY(result);
}

function assertTokenColumns(value: UsageTokenColumns): void {
  assertToken("input token count", value.inputTokens);
  assertToken("output token count", value.outputTokens);
  assertToken("cache-read token count", value.cacheReadTokens);
  assertToken("cache-write token count", value.cacheWriteTokens);
  assertToken("reasoning token count", value.reasoningTokens);
  assertToken("total token count", value.totalTokens);
}

function canonicalFactFields(fact: Omit<BillingUsageFact, "factSha256">): unknown[] {
  return [
    "billing-usage-fact/v1",
    fact.usageId,
    fact.tenantId,
    fact.accountingPeriod,
    fact.provider,
    fact.model,
    fact.inputTokens,
    fact.outputTokens,
    fact.cacheReadTokens,
    fact.cacheWriteTokens,
    fact.reasoningTokens,
    fact.totalTokens,
    fact.costCNY === undefined ? ["unknown"] : ["known", canonicalBillingCostCNY(fact.costCNY)],
    fact.currency,
  ];
}

function factContent(fact: BillingUsageFact): Omit<BillingUsageFact, "factSha256"> {
  const { factSha256: _factSha256, ...content } = fact;
  return content;
}

export function computeBillingUsageFactSha256(
  fact: Omit<BillingUsageFact, "factSha256">,
): string {
  return createHash("sha256").update(JSON.stringify(canonicalFactFields(fact))).digest("hex");
}

/** Build the long-lived whitelisted fact for one operational row. */
export function billingUsageFactFromLedger(
  entry: UsageLedgerEntry & { usageId: string },
): BillingUsageFact {
  if (!isUsageId(entry.usageId)) throw new Error("invalid usage id");
  if (!entry.tenantId || entry.tenantId.length > 128) throw new Error("invalid usage tenant id");
  if (!entry.provider || entry.provider.length > 128) throw new Error("invalid usage provider");
  if (!entry.model || entry.model.length > 128) throw new Error("invalid usage model");
  assertTimestamp(entry.createdAtMs, "usage creation timestamp");
  assertTokenColumns(entry.usage);
  assertCost(entry.usage.costCNY);

  const content: Omit<BillingUsageFact, "factSha256"> = {
    usageId: entry.usageId,
    tenantId: entry.tenantId,
    accountingPeriod: usageAccountingPeriodUtc(entry.createdAtMs),
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    cacheReadTokens: entry.usage.cacheReadTokens,
    cacheWriteTokens: entry.usage.cacheWriteTokens,
    reasoningTokens: entry.usage.reasoningTokens,
    totalTokens: entry.usage.totalTokens,
    ...(entry.usage.costCNY === undefined ? {} : { costCNY: normalizeBillingCostCNY(entry.usage.costCNY) }),
    currency: "CNY",
  };
  return {
    ...content,
    factSha256: computeBillingUsageFactSha256(content),
  };
}

/** Validate both the whitelist values and the fact's self-checksum before trusting a stored row. */
export function assertBillingUsageFact(fact: BillingUsageFact): void {
  if (!isUsageId(fact.usageId)) throw new Error("invalid billing usage id");
  if (!fact.tenantId || fact.tenantId.length > 128) throw new Error("invalid billing tenant id");
  if (!ACCOUNTING_PERIOD.test(fact.accountingPeriod)) throw new Error("invalid billing accounting period");
  if (!fact.provider || fact.provider.length > 128) throw new Error("invalid billing provider");
  if (!fact.model || fact.model.length > 128) throw new Error("invalid billing model");
  if (fact.currency !== "CNY") throw new Error("invalid billing currency");
  assertTokenColumns(fact);
  assertCost(fact.costCNY);
  if (!SHA256.test(fact.factSha256)) throw new Error("invalid billing fact checksum");
  if (computeBillingUsageFactSha256(factContent(fact)) !== fact.factSha256) {
    throw new UsageReconciliationError("billing fact checksum does not match its whitelisted fields");
  }
}

/** Reconciliation retries may reuse an existing first-write fact, but never replace conflicting data. */
export function billingUsageFactContentEquals(left: BillingUsageFact, right: BillingUsageFact): boolean {
  assertBillingUsageFact(left);
  assertBillingUsageFact(right);
  return JSON.stringify(canonicalFactFields(factContent(left)))
    === JSON.stringify(canonicalFactFields(factContent(right)));
}

function addSafe(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new UsageReconciliationError(`${name} exceeds safe integer range`);
  return result;
}

/** Aggregate facts using the same canonical algorithm in Memory and MySQL implementations. */
export function summarizeBillingUsageFacts(facts: readonly BillingUsageFact[]): UsageReconciliationSummary {
  const seen = new Set<string>();
  const totals: UsageTokenColumns = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
  let knownCostRows = 0;
  let costNano = 0n;
  const identities: [string, string][] = [];
  for (const fact of facts) {
    assertBillingUsageFact(fact);
    if (seen.has(fact.usageId)) throw new UsageIdentityConflictError(fact.usageId);
    seen.add(fact.usageId);
    totals.inputTokens = addSafe(totals.inputTokens, fact.inputTokens, "input token total");
    totals.outputTokens = addSafe(totals.outputTokens, fact.outputTokens, "output token total");
    totals.cacheReadTokens = addSafe(totals.cacheReadTokens, fact.cacheReadTokens, "cache-read token total");
    totals.cacheWriteTokens = addSafe(totals.cacheWriteTokens, fact.cacheWriteTokens, "cache-write token total");
    totals.reasoningTokens = addSafe(totals.reasoningTokens, fact.reasoningTokens, "reasoning token total");
    totals.totalTokens = addSafe(totals.totalTokens, fact.totalTokens, "token total");
    if (fact.costCNY !== undefined) {
      knownCostRows += 1;
      costNano += billingCostNano(fact.costCNY);
    }
    identities.push([fact.usageId, fact.factSha256]);
  }
  identities.sort(([left], [right]) => left.localeCompare(right));
  const checksum = createHash("sha256")
    .update(JSON.stringify(["billing-usage-reconciliation/v1", identities]))
    .digest("hex");
  return {
    rowCount: facts.length,
    ...totals,
    knownCostRows,
    ...(knownCostRows === 0 ? {} : { costCNY: billingCostFromNano(costNano) }),
    checksum,
  };
}

export function usageReconciliationSummariesEqual(
  left: UsageReconciliationSummary,
  right: UsageReconciliationSummary,
): boolean {
  return left.rowCount === right.rowCount
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.reasoningTokens === right.reasoningTokens
    && left.totalTokens === right.totalTokens
    && left.knownCostRows === right.knownCostRows
    && (
      left.costCNY === undefined
        ? right.costCNY === undefined
        : right.costCNY !== undefined
          && canonicalBillingCostCNY(left.costCNY) === canonicalBillingCostCNY(right.costCNY)
    )
    && left.checksum === right.checksum;
}

export function validateReconcileSessionUsageInput(input: ReconcileSessionUsageInput): void {
  if (!input.tenantId || input.tenantId.length > 128) throw new Error("invalid usage lifecycle tenant id");
  if (!input.userId || input.userId.length > 128) throw new Error("invalid usage lifecycle user id");
  if (!input.sessionId) throw new Error("invalid usage lifecycle session id");
  if (!Number.isSafeInteger(input.deletionGeneration) || input.deletionGeneration <= 0) {
    throw new UsageLifecycleGenerationError(input.sessionId, input.deletionGeneration);
  }
  assertTimestamp(input.nowMs, "usage lifecycle timestamp");
}

/**
 * Store code must obtain legalHoldActive from its own durable lifecycle state. It must never trust a
 * caller-supplied `legalHold: false`; the destructive input intentionally has no such field.
 */
export function assertUsageAnonymizationAllowed(
  input: AnonymizeSessionUsageInput,
  legalHoldActive: boolean,
): void {
  validateReconcileSessionUsageInput(input);
  if ((input as { enabled?: unknown }).enabled !== true) throw new UsageAnonymizationDisabledError();
  if (!SHA256.test(input.expectedChecksum)) throw new UsageReconciliationError("invalid expected reconciliation checksum");
  if (legalHoldActive) throw new UsageLegalHoldError();
}
