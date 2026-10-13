import { MysqlSessionStore } from "@agent-service/store";

const mysqlUrl = process.env.MYSQL_URL;
const stage = process.env.EXPECT_FINGERPRINT_STAGE;
if (!mysqlUrl || !["target", "full-tail"].includes(stage ?? "")) {
  throw new Error("old fingerprint probe requires fixed inputs");
}
const expectedMessage = stage === "target"
  ? "0039 tenant telemetry owner closure fingerprint verification failed"
  : "0035 tenant telemetry application capture schema fingerprint verification failed";
let rejected = false;
try {
  const store = await MysqlSessionStore.connect({ url: mysqlUrl, migrationMode: "verify" });
  await store.close();
} catch (error) {
  rejected = error instanceof Error && error.message === expectedMessage;
  if (!rejected) throw new Error("frozen 0039 verify failed outside its expected fingerprint");
}
if (!rejected) throw new Error("frozen 0039 store did not reject upgraded schema");
process.stdout.write(stage === "target"
  ? "frozen-0039-fingerprint-rejected"
  : "frozen-0039-0035-fingerprint-rejected");
