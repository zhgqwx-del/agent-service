import { MysqlSessionStore } from "@agent-service/store";

const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("frozen 0042 verify probe requires MYSQL_URL");
const store = await MysqlSessionStore.connect({
  url: mysqlUrl, migrationMode: "verify", tenantTelemetryRefKey: Buffer.alloc(32, 0x42),
});
await store.close();
process.stdout.write("frozen-0042-verify-accepted");
