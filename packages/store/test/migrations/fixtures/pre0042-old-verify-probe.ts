import { MysqlSessionStore } from "@agent-service/store";

const mysqlUrl = process.env.MYSQL_URL;
const stage = process.env.EXPECT_FINGERPRINT_STAGE;
if (!mysqlUrl || !["accepted", "target", "full-tail"].includes(stage ?? "")) {
  throw new Error("frozen 0041 verify probe requires fixed inputs");
}
const expectedMessage = stage === "target"
  ? "0041 target manifest fingerprint verification failed"
  : "0035 tenant telemetry application capture schema fingerprint verification failed";
let rejected = false;
try {
  const store = await MysqlSessionStore.connect({
    url: mysqlUrl, migrationMode: "verify", tenantTelemetryRefKey: Buffer.alloc(32, 0x42),
  });
  await store.close();
} catch (error) {
  rejected = stage !== "accepted" && error instanceof Error && error.message === expectedMessage;
  if (!rejected) throw new Error("frozen 0041 verify failed unexpectedly");
}
if (rejected !== (stage !== "accepted")) {
  throw new Error("frozen 0041 verify-only startup result differed from expected schema");
}
process.stdout.write(stage === "accepted" ? "frozen-0041-verify-accepted"
  : stage === "target" ? "frozen-0041-verify-fingerprint-rejected"
    : "frozen-0041-verify-0035-fingerprint-rejected");
