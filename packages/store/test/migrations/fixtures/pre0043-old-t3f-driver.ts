import { randomUUID } from "node:crypto";
import { MysqlSessionStore } from "@agent-service/store";

// Copied into the exact published 0042 checkout. Product imports stay frozen at 0042.
const mysqlUrl = process.env.MYSQL_URL;
const tenantId = process.env.HISTORICAL_TENANT_ID;
const requestId = process.env.HISTORICAL_REQUEST_ID;
if (!mysqlUrl || !tenantId || !requestId) {
  throw new Error("frozen 0042 T3f fixture requires exact inputs");
}
const stage = (name: string) => process.stderr.write(`PRE0043_STAGE=${name}\n`);

stage("connect");
const store = await MysqlSessionStore.connect({
  url: mysqlUrl, migrationMode: "verify", tenantTelemetryRefKey: Buffer.alloc(32, 0x42),
});
try {
  stage("read_plan");
  const plan = await store.getTenantPurgePlanReceipt(tenantId, requestId);
  const catalog = await store.getTenantTelemetryPlanArtifactTargetReceipt(tenantId, requestId);
  const targets = await store.getTenantTelemetryPlanArtifactTargets(tenantId, requestId);
  if (!plan || !catalog || catalog.targetCount !== 0 || catalog.logsTargetCount !== 0
    || catalog.tracesTargetCount !== 0 || targets.length !== 0 || plan.executionReady) {
    throw new Error("frozen 0042 T3d zero-target catalog is missing");
  }

  stage("materialize_t3e");
  if (await store.materializeTenantPurgeExecutionJobs({ limit: 10 }) !== 1) {
    throw new Error("frozen 0042 T3e materialization failed");
  }
  stage("claim_t3e");
  const execution = (await store.claimTenantPurgeExecutions({
    limit: 10, leaseMs: 120_000, claimToken: `pre0043-t3e-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!execution) {
    const job = await store.getTenantPurgeExecutionJob(tenantId, requestId);
    stage(job?.phase === "blocked" ? "claim_t3e_blocked" : "claim_t3e_absent");
    throw new Error("frozen 0042 T3e claim is missing");
  }
  const executionAuth = {
    requestId, tenantId, subjectGeneration: execution.subjectGeneration,
    planBuildGeneration: execution.planBuildGeneration,
    executionGeneration: execution.executionGeneration,
    claimAttempt: execution.claimAttempt, claimToken: execution.claimToken,
  };
  stage("execute_t3e");
  if (!await store.executeTenantPurgeLocalCutover(executionAuth)) {
    throw new Error("frozen 0042 T3e local cutover is missing");
  }
  stage("seal_t3e");
  if (!await store.sealTenantPurgeLocalPhysicalAcks(executionAuth)) {
    throw new Error("frozen 0042 T3e local physical receipt is missing");
  }
  stage("materialize_t3f");
  if (await store.materializeTenantDatabasePurgeJobs({ limit: 10 }) !== 1) {
    throw new Error("frozen 0042 T3f materialization failed");
  }
  stage("claim_t3f");
  const database = (await store.claimTenantDatabasePurges({
    limit: 10, leaseMs: 120_000, claimToken: `pre0043-t3f-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!database) throw new Error("frozen 0042 T3f claim is missing");
  const authorization = {
    requestId, tenantId, subjectGeneration: database.subjectGeneration,
    planBuildGeneration: database.planBuildGeneration,
    executionGeneration: database.executionGeneration,
    databasePurgeGeneration: database.databasePurgeGeneration,
    claimAttempt: database.claimAttempt, claimToken: database.claimToken,
  };
  stage("execute_t3f");
  const terminal = await store.executeTenantDatabasePurge(authorization);
  const closure = await store.getTenantTelemetryOwnerClosureReceipt(tenantId, requestId);
  const closureEntries = await store.getTenantTelemetryOwnerClosureEntries(tenantId, requestId);
  if (!terminal || !terminal.localDatabasePurgeComplete || terminal.allDomainsComplete
    || terminal.contentPurgeExecuted || !closure || closure.entryCount !== 0
    || closureEntries.length !== 0
    || closure.t3fReceiptSha256 !== terminal.receiptSha256) {
    throw new Error("frozen 0042 T3f zero-target closure is invalid");
  }
  stage("replay_t3f");
  const replay = await store.executeTenantDatabasePurge(authorization);
  if (replay?.receiptSha256 !== terminal.receiptSha256) {
    throw new Error("frozen 0042 T3f exact replay failed");
  }
  process.stdout.write(JSON.stringify({
    requestId, tenantId, catalogReceiptSha256: catalog.receiptSha256,
    terminalReceiptSha256: terminal.receiptSha256,
    closureReceiptSha256: closure.receiptSha256,
    closureEntryCount: closure.entryCount,
  }));
} finally {
  await store.close();
}
