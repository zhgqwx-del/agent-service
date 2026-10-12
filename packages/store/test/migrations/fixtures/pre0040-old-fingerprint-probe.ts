import { MysqlSessionStore } from "@agent-service/store";

const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("old fingerprint probe requires MYSQL_URL");
let rejectedBy0039Fingerprint = false;
try {
  const store = await MysqlSessionStore.connect({ url: mysqlUrl });
  await store.close();
} catch (error) {
  rejectedBy0039Fingerprint = error instanceof Error
    && /0039 tenant telemetry owner closure fingerprint verification failed/.test(error.message);
}
if (!rejectedBy0039Fingerprint) throw new Error("frozen 0039 store did not reject 0040 schema");
process.stdout.write("frozen-0039-fingerprint-rejected");
