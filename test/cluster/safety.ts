export function assertDisposableClusterTargets(mysqlUrl: string, redisUrl: string, allowDestructive = false): void {
  if (allowDestructive) return;
  const mysqlDb = new URL(mysqlUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (!/(?:^|[_-])(test|cluster)(?:$|[_-])/i.test(mysqlDb)) {
    throw new Error(
      `refusing to DROP database "${mysqlDb}": CLUSTER_MYSQL_URL must name a test/cluster database ` +
      `(set AGENT_SERVICE_ALLOW_DESTRUCTIVE_TEST_DB=1 only for an isolated disposable database)`,
    );
  }
  const redisDb = Number(new URL(redisUrl).pathname.slice(1) || "0");
  if (!Number.isInteger(redisDb) || redisDb <= 0) {
    throw new Error(
      "refusing to FLUSHDB Redis database 0: CLUSTER_REDIS_URL must select an isolated non-zero database " +
      "(or set AGENT_SERVICE_ALLOW_DESTRUCTIVE_TEST_DB=1 for a disposable Redis instance)",
    );
  }
}
