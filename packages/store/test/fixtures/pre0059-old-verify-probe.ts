import { MysqlSessionStore } from "@agent-service/store";

// Run only inside the exact published 0058 archive. The post-upgrade rejection
// must be its own 735-trigger fingerprint, not a current-binary 0059 check.
const url = process.env.MYSQL_URL, expected = process.env.EXPECT_0058_OUTCOME;
const tenantId = process.env.FROZEN_0058_TENANT_ID, requestId = process.env.FROZEN_0058_REQUEST_ID;
if (!url || !tenantId || !requestId || expected !== "accepted" && expected !== "fingerprint") {
  throw new Error("frozen 0058 verify inputs invalid");
}
const address = new URL(url);
if (address.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
  || !/^agent_service_migration_test_0059_[0-9]+_[0-9a-f]{8}$/.test(decodeURIComponent(address.pathname.slice(1)))) {
  throw new Error("frozen 0058 verify database invalid");
}
let observed: "accepted" | "fingerprint" | "unexpected" = "accepted";
let errorClass = "none", messageCategory = "none";
try {
  const store = await MysqlSessionStore.connect({ url, migrationMode: "verify" });
  try {
    const receipt = await store.getTenantCredentialRevocationReceipt(tenantId, requestId);
    if (!receipt) throw new Error("frozen T3a receipt absent");
  } finally { await store.close(); }
} catch (error) {
  errorClass = error instanceof Error ? error.name === "Error" ? "Error" : "other" : "non_error";
  messageCategory = error instanceof Error && error.message === "0058 capture repeat restore fingerprint verification failed"
    ? "0058_fingerprint" : "other";
  observed = messageCategory === "0058_fingerprint" ? "fingerprint" : "unexpected";
}
if (observed !== expected) {
  process.stderr.write(`pre0059-frozen-verify-diagnostic:${JSON.stringify({ schema: "pre0059-frozen-verify-diagnostic-v1",
    expected, observed, errorClass, messageCategory })}\n`);
  process.exitCode = 1;
} else process.stdout.write(`frozen-0058-verify-${observed}`);
