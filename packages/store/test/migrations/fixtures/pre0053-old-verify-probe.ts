import { MysqlSessionStore } from "@agent-service/store";

const url = process.env.MYSQL_URL;
const expected = process.env.EXPECT_0052_FINGERPRINT_REJECTION;
if (!url || !["0", "1"].includes(expected ?? "")) throw new Error("frozen 0052 verify probe requires fixed inputs");
let rejected = false;
try {
  const store = await MysqlSessionStore.connect({ url, migrationMode: "verify" });
  await store.close();
} catch (error) {
  // 0053 adds a column/CHECK to subject_lifecycle. The genuine 0052 binary has no
  // compatibility projection and rejects the exact earlier 0035 schema fingerprint.
  rejected = error instanceof Error
    && error.message === "0035 tenant telemetry application capture schema fingerprint verification failed";
  if (!rejected) throw new Error("frozen 0052 verify failed outside its actual old fingerprint");
}
if (rejected !== (expected === "1")) throw new Error("frozen 0052 startup result differed from its expected schema");
process.stdout.write(rejected ? "frozen-0052-verify-fingerprint-rejected" : "frozen-0052-verify-accepted");
