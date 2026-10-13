import { randomUUID } from "node:crypto";
import { MysqlSessionStore } from "@agent-service/store";

// Copied into the immutable published 0043 archive by the historical fixture.
// Only that archive's product code may interpret the genuine 0042 database.
const mysqlUrl = process.env.MYSQL_URL;
const tenantId = process.env.HISTORICAL_TENANT_ID;
const requestId = process.env.HISTORICAL_REQUEST_ID;
const expectedStatus = process.env.HISTORICAL_EXPECTED_STATUS;
const expectedCatalogReceipt = process.env.HISTORICAL_CATALOG_RECEIPT;
const expectedTargetReceipt = process.env.HISTORICAL_TARGET_RECEIPT;
const expectedWriteOperation = process.env.HISTORICAL_WRITE_OPERATION;
const expectedClosureReceipt = process.env.HISTORICAL_CLOSURE_RECEIPT;
if (!mysqlUrl || !tenantId || !requestId || !expectedCatalogReceipt
  || !new Set(["unknown", "local_source_candidate"]).has(expectedStatus ?? "")
  || (expectedStatus === "unknown" && (!expectedTargetReceipt || !expectedWriteOperation))
  || (expectedStatus === "local_source_candidate" && !expectedClosureReceipt)) {
  throw new Error("published 0043 read probe requires exact historical inputs");
}

const store = await MysqlSessionStore.connect({
  url: mysqlUrl, migrationMode: "verify", tenantTelemetryRefKey: Buffer.alloc(32, 0x42),
});
try {
  const catalog = await store.getTenantTelemetryPlanArtifactTargetReceipt(tenantId, requestId);
  const targets = await store.getTenantTelemetryPlanArtifactTargets(tenantId, requestId);
  const closure = await store.getTenantTelemetryOwnerClosureReceipt(tenantId, requestId);
  const source = await store.getTenantTelemetrySourceEligibility(tenantId, requestId);
  if (!catalog || catalog.receiptSha256 !== expectedCatalogReceipt
    || catalog.executionReady !== false) {
    throw new Error("published 0043 catalog read disagrees with historical evidence");
  }
  if (expectedStatus === "unknown") {
    if (catalog.targetCount !== 1 || targets.length !== 1
      || targets[0]?.receiptSha256 !== expectedTargetReceipt
      || targets[0]?.writeOperationSha256 !== expectedWriteOperation
      || closure !== null || source?.status !== "unknown"
      || source.managedArtifactCount !== null) {
      throw new Error("published 0043 nonempty source read disagrees with historical evidence");
    }
  } else if (catalog.targetCount !== 0 || targets.length !== 0
    || !closure || closure.receiptSha256 !== expectedClosureReceipt || closure.entryCount !== 0
    || source?.status !== "local_source_candidate" || source.managedArtifactCount !== 0) {
    throw new Error("published 0043 zero-target source read disagrees with historical evidence");
  }
  if (source?.executionReady !== false || source.externalAuthorityVerified !== false
    || await store.getTenantTelemetrySourceEligibility(`foreign-${tenantId}`, requestId) !== null
    || await store.getTenantTelemetrySourceEligibility(tenantId, `erase_${randomUUID()}`) !== null) {
    throw new Error("published 0043 source read crossed its safety or tenant boundary");
  }
  process.stdout.write("published-0043-read-accepted");
} finally {
  await store.close();
}
