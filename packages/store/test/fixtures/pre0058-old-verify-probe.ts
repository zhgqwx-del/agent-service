import { MysqlSessionStore, PersistedProviderCaptureIntegrityError, TenantTelemetryWriteIntegrityError } from "@agent-service/store";

// Executed only inside the exact published 3414b43 archive. An accepted old
// runtime is a pre-upgrade proof; the exact 0057 fingerprint rejection after
// migration must not be confused with an unrelated pending-runtime error.
const url = process.env.MYSQL_URL, expected = process.env.EXPECT_0057_OUTCOME;
if (!url || expected !== "accepted" && expected !== "pending" && expected !== "fingerprint") throw new Error("frozen 0057 verify inputs invalid");
const address = new URL(url);
if (address.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
  || !/^agent_service_migration_test_0058_[0-9]+_[0-9a-f]{8}$/.test(decodeURIComponent(address.pathname.slice(1)))) {
  throw new Error("frozen 0057 verify database invalid");
}
let outcome: "accepted" | "pending" | "fingerprint" | "unexpected" = "accepted";
let errorClass = "none", messageCategory = "none";
try {
  const store = await MysqlSessionStore.connect({ url, migrationMode: "verify", tenantTelemetryRefKey: Buffer.alloc(32, 0x43),
    tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true });
  try {
    const proof = await store.getTenantTelemetryPersistedProviderCaptureBinding();
    if (!proof) throw new Error("frozen accepted runtime proof absent");
  } finally { await store.close(); }
} catch (error) {
  errorClass = error instanceof TenantTelemetryWriteIntegrityError ? "TenantTelemetryWriteIntegrityError"
    : error instanceof PersistedProviderCaptureIntegrityError ? "PersistedProviderCaptureIntegrityError"
      : error instanceof Error ? "Error" : "non_error";
  messageCategory = error instanceof TenantTelemetryWriteIntegrityError && error.message === "tenant telemetry write evidence is invalid"
    ? "writer_integrity_default"
    : error instanceof PersistedProviderCaptureIntegrityError && error.message === "persisted provider capture evidence is invalid"
      ? "capture_integrity_default"
      : error instanceof Error && error.message === "0057 capture epoch cutover fingerprint verification failed" ? "0057_fingerprint" : "other";
  if (error instanceof Error && error.message === "0057 capture epoch cutover fingerprint verification failed") outcome = "fingerprint";
  else if (error instanceof TenantTelemetryWriteIntegrityError && error.message === "tenant telemetry write evidence is invalid") outcome = "pending";
  else outcome = "unexpected";
}
if (outcome !== expected) {
  process.stderr.write(`pre0058-frozen-verify-diagnostic:${JSON.stringify({ schema: "pre0058-frozen-verify-diagnostic-v1",
    expected, observed: outcome, errorClass, messageCategory })}\n`);
  process.exitCode = 1;
}
else process.stdout.write(`frozen-0057-verify-${outcome === "accepted" ? "runtime-accepted" : `${outcome}-rejected`}`);
