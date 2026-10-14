import { MysqlSessionStore } from "@agent-service/store";

// Copied into e411143 and run with its compiled/isolation-checked dependencies.
const url = process.env.MYSQL_URL;
const expected = process.env.EXPECT_0053_FINGERPRINT_REJECTION;
if (!url || !["0", "1"].includes(expected ?? "")) throw new Error("frozen 0053 verify probe requires fixed inputs");
let rejected = false;
try {
  const store = await MysqlSessionStore.connect({ url, migrationMode: "verify",
    tenantTelemetryRefKey: Buffer.alloc(32, 0x43), tenantTelemetryPersistedProviderCaptureLocalOnly: true });
  await store.close();
} catch (error) {
  // 0054 preserves the published 0053 schema but rotates exact guards. This
  // oracle is a single precise old fingerprint error, not any startup failure.
  rejected = error instanceof Error
    && error.message === "0053 persisted provider capture fingerprint verification failed";
  if (!rejected) {
    process.stderr.write("pre0054-frozen-verify-unexpected-stage\n");
    process.exitCode = 1;
  }
}
if (!process.exitCode) {
  if (rejected !== (expected === "1")) {
    process.stderr.write("pre0054-frozen-verify-result-mismatch\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(rejected ? "frozen-0053-verify-fingerprint-rejected" : "frozen-0053-verify-accepted");
  }
}
