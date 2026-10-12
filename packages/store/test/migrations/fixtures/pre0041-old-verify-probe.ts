import { MysqlSessionStore } from "@agent-service/store";

const mysqlUrl = process.env.MYSQL_URL;
const expectRejection = process.env.EXPECT_0040_FINGERPRINT_REJECTION;
if (!mysqlUrl || !["0", "1"].includes(expectRejection ?? "")) {
  throw new Error("frozen 0040 verify probe requires fixed inputs");
}
let rejectedBy0040Fingerprint = false;
try {
  const store = await MysqlSessionStore.connect({ url: mysqlUrl, migrationMode: "verify" });
  await store.close();
} catch (error) {
  rejectedBy0040Fingerprint = error instanceof Error
    && /0040 telemetry source fingerprint verification failed/.test(error.message);
  if (!rejectedBy0040Fingerprint) throw new Error("frozen 0040 verify failed unexpectedly");
}
if (rejectedBy0040Fingerprint !== (expectRejection === "1")) {
  throw new Error("frozen 0040 verify-only startup result differed from expected schema");
}
process.stdout.write(expectRejection === "1"
  ? "frozen-0040-verify-fingerprint-rejected"
  : "frozen-0040-verify-accepted");
