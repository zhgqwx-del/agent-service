import { randomUUID } from "node:crypto";
import { MysqlSessionStore } from "@agent-service/store";

// This is run only inside the published 0042 archive. It records an old-code limitation,
// not a simulated T3f completion: a nonzero 0042 telemetry plan fails closed at T3e claim.
const mysqlUrl = process.env.MYSQL_URL;
const tenantId = process.env.HISTORICAL_TENANT_ID;
const requestId = process.env.HISTORICAL_REQUEST_ID;
if (!mysqlUrl || !tenantId || !requestId) {
  throw new Error("frozen 0042 T3e probe requires exact inputs");
}
const store = await MysqlSessionStore.connect({
  url: mysqlUrl, migrationMode: "verify", tenantTelemetryRefKey: Buffer.alloc(32, 0x42),
});
try {
  const catalog = await store.getTenantTelemetryPlanArtifactTargetReceipt(tenantId, requestId);
  const targets = await store.getTenantTelemetryPlanArtifactTargets(tenantId, requestId);
  if (!catalog || catalog.targetCount !== 1 || catalog.logsTargetCount !== 1
    || catalog.tracesTargetCount !== 0 || targets.length !== 1) {
    throw new Error("frozen 0042 nonzero T3d catalog is missing");
  }
  if (await store.materializeTenantPurgeExecutionJobs({ limit: 10 }) !== 1) {
    throw new Error("frozen 0042 T3e materialization failed");
  }
  const claims = await store.claimTenantPurgeExecutions({
    limit: 10, leaseMs: 120_000, claimToken: `pre0043-t3e-${randomUUID()}`,
  });
  const job = await store.getTenantPurgeExecutionJob(tenantId, requestId);
  if (claims.length !== 0 || job?.phase !== "blocked"
    || job.blockedReasonCode !== "integrity_conflict") {
    throw new Error("frozen 0042 nonzero T3d did not fail closed at T3e");
  }
  if (await store.getTenantDatabasePurgeJob(tenantId, requestId) !== null) {
    throw new Error("frozen 0042 unexpectedly generated a T3f job");
  }
  process.stdout.write(JSON.stringify({
    requestId, tenantId, catalogReceiptSha256: catalog.receiptSha256,
    targetReceiptSha256: targets[0]!.receiptSha256,
    writeOperationSha256: targets[0]!.writeOperationSha256,
    t3ePhase: job.phase, t3eBlockedReasonCode: job.blockedReasonCode,
  }));
} finally {
  await store.close();
}
