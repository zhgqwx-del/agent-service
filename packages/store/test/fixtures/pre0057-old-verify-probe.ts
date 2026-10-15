import { MysqlSessionStore, PersistedProviderCaptureIntegrityError, TenantTelemetryWriteIntegrityError } from "@agent-service/store";

// Exact b8b8984 archive. Both prepared and active-history capture databases are
// refused by old ordinary startup; that gate is not new-schema proof.
const url = process.env.MYSQL_URL, expected = process.env.EXPECT_0056_REJECTION;
if (!url || expected !== "pending" && expected !== "fingerprint") throw new Error("frozen 0056 verify inputs invalid");
const address = new URL(url);
if (address.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
  || !/^agent_service_migration_test_0057_[0-9]+_[0-9a-f]{8}$/.test(decodeURIComponent(address.pathname.slice(1)))) {
  throw new Error("frozen 0056 verify database invalid");
}
let outcome: "accepted" | "pending" | "fingerprint" | "unexpected" = "accepted";
let errorClass = "none", messageCategory = "none";
try {
  const store = await MysqlSessionStore.connect({ url, migrationMode: "verify", tenantTelemetryRefKey: Buffer.alloc(32, 0x43),
    tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true });
  await store.close();
} catch (error) {
  errorClass = error instanceof TenantTelemetryWriteIntegrityError ? "TenantTelemetryWriteIntegrityError"
    : error instanceof PersistedProviderCaptureIntegrityError ? "PersistedProviderCaptureIntegrityError"
      : error instanceof Error ? "Error" : "non_error";
  messageCategory = error instanceof TenantTelemetryWriteIntegrityError && error.message === "tenant telemetry write evidence is invalid"
    ? "writer_integrity_default"
    : error instanceof PersistedProviderCaptureIntegrityError && error.message === "persisted provider capture evidence is invalid"
      ? "capture_integrity_default"
      : error instanceof Error && error.message === "0056 restore history fingerprint verification failed" ? "0056_fingerprint"
        : error instanceof Error && error.message === "0055 capture checkpoint fingerprint verification failed" ? "0055_fingerprint"
          : error instanceof Error && error.message === "0053 persisted provider capture fingerprint verification failed" ? "0053_fingerprint" : "other";
  if (error instanceof Error && error.message === "0056 restore history fingerprint verification failed") outcome = "fingerprint";
  // Normal cold startup first audits write-job relations. Their boundary wraps
  // capturePrerequisites' exact pending-run rejection in this default writer
  // integrity class; the same-instance direct getBinding path does not.
  else if (error instanceof TenantTelemetryWriteIntegrityError && error.message === "tenant telemetry write evidence is invalid") outcome = "pending";
  else outcome = "unexpected";
}
if (outcome !== expected) {
  process.stderr.write(`pre0057-frozen-verify-diagnostic:${JSON.stringify({ schema: "pre0057-frozen-verify-diagnostic-v1",
    expected, observed: outcome, errorClass, messageCategory })}\n`);
  process.exitCode = 1;
}
else process.stdout.write(outcome === "fingerprint" ? "frozen-0056-verify-fingerprint-rejected" : "frozen-0056-verify-pending-rejected");
