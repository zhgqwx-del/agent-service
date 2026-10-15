import { MysqlSessionStore } from "@agent-service/store";

// Copied into the exact published 2932318 archive with isolation-checked deps.
const url = process.env.MYSQL_URL;
const expected = process.env.EXPECT_0054_FINGERPRINT_REJECTION;
if (!url || expected !== "0" && expected !== "1") throw new Error("frozen 0054 verify inputs invalid");
let rejected = false;
try {
  const store = await MysqlSessionStore.connect({ url, migrationMode: "verify",
    tenantTelemetryRefKey: Buffer.alloc(32, 0x43), tenantTelemetryPersistedProviderCaptureLocalOnly: true });
  await store.close();
} catch (error) {
  // New additive 0055 guards change the exact complete trigger inventory. Only
  // this old-binary strict error is accepted; a key/network/startup failure is not.
  rejected = error instanceof Error && error.message === "0054 retained telemetry source fingerprint verification failed";
  if (!rejected) { process.stderr.write("pre0055-frozen-verify-unexpected-stage\n"); process.exitCode = 1; }
}
if (!process.exitCode) {
  if (rejected !== (expected === "1")) { process.stderr.write("pre0055-frozen-verify-result-mismatch\n"); process.exitCode = 1; }
  else process.stdout.write(rejected ? "frozen-0054-verify-fingerprint-rejected" : "frozen-0054-verify-accepted");
}
