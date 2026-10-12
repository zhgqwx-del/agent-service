import { MysqlSessionStore } from "@agent-service/store";

const mysqlUrl = process.env.MYSQL_URL;
const expectRejection = process.env.EXPECT_0041_FINGERPRINT_REJECTION;
if (!mysqlUrl || !["0", "1"].includes(expectRejection ?? "")) {
  throw new Error("frozen 0041 verify probe requires fixed inputs");
}
let rejectedBy0041Fingerprint = false;
try {
  const store = await MysqlSessionStore.connect({
    url: mysqlUrl, migrationMode: "verify", tenantTelemetryRefKey: Buffer.alloc(32, 0x42),
  });
  await store.close();
} catch (error) {
  rejectedBy0041Fingerprint = error instanceof Error
    && /0041 target manifest fingerprint verification failed/.test(error.message);
  if (!rejectedBy0041Fingerprint) throw new Error("frozen 0041 verify failed unexpectedly");
}
if (rejectedBy0041Fingerprint !== (expectRejection === "1")) {
  throw new Error("frozen 0041 verify-only startup result differed from expected schema");
}
process.stdout.write(expectRejection === "1"
  ? "frozen-0041-verify-fingerprint-rejected"
  : "frozen-0041-verify-accepted");
