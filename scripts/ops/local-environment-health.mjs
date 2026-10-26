import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { verifyVmReleaseDirectory } from "../lib/vm-release.mjs";

const need = (value, code) => { if (!value) throw new Error(code); };

// Only explicit private profile credentials are used. Queries are read-only;
// SAVE is the single durability command, after both application roles stop.
export async function createLocalEnvironmentHooks(profile) {
  const requireFrom = createRequire(join(profile.roles.runner.cwd, "dist/main.js"));
  const mysql = requireFrom("mysql2/promise"), Redis = requireFrom("ioredis");
  const identity = profile.dataIdentity;
  async function sql(work, root = false) {
    let connection; const sockets = new Set(), closes = [];
    const options = root ? { ...identity.mysql.root, database: identity.mysql.database }
      : { uri: profile.roles.runner.env.MYSQL_URL };
    const timer = setTimeout(() => { connection?.destroy(); for (const socket of sockets) socket.destroy(); }, 8000);
    try {
      connection = await mysql.createConnection({ ...options, connectTimeout: 5000,
        stream: ({ config }) => {
          const socket = config.socketPath ? createConnection(config.socketPath) : createConnection({ host: config.host, port: config.port });
          sockets.add(socket); closes.push(new Promise(done => socket.once("close", () => { sockets.delete(socket); done(); }))); return socket;
        } });
      return await work(connection);
    } finally {
      connection?.destroy(); for (const socket of sockets) socket.destroy();
      await Promise.all(closes); clearTimeout(timer);
    }
  }
  async function redis(uri, work) {
    const client = new Redis(uri, { lazyConnect: true, retryStrategy: null, maxRetriesPerRequest: 0,
      connectTimeout: 5000, commandTimeout: 5000, enableOfflineQueue: false });
    client.on("error", () => {});
    let closed;
    try { await client.connect(); closed = new Promise(done => client.once("end", done)); return await work(client); }
    finally {
      const socket = client.connector?.stream;
      const nativeClosed = !socket || socket.closed ? Promise.resolve() : new Promise(done => socket.once("close", done));
      client.disconnect(); await nativeClosed; if (closed) await closed;
    }
  }
  async function mysqlIdentity() {
    return sql(async connection => {
      const [[row]] = await connection.query("SELECT @@server_uuid AS uuid, @@datadir AS datadir, @@port AS port, DATABASE() AS db");
      need(row.uuid === identity.mysql.uuid && row.datadir === identity.mysql.datadir
        && Number(row.port) === profile.infrastructure.mysql.port && row.db === identity.mysql.database, "mysql_identity_changed");
      return row;
    });
  }
  async function redisIdentity(entry) {
    return redis(identity.redis.identityUrl, async client => {
      const info = await client.info("server"), fields = Object.fromEntries(info.split("\r\n").filter(x => x.includes(":"))
        .map(x => { const at = x.indexOf(":"); return [x.slice(0, at), x.slice(at + 1)]; }));
      const config = await client.config("GET", "dir", "dbfilename"), values = Object.fromEntries(Array.from({ length: config.length / 2 }, (_, i) => [config[i * 2], config[i * 2 + 1]]));
      need(Number(fields.process_id) === entry.witness.pid && Number(fields.tcp_port) === profile.infrastructure.redis.port
        && values.dir === identity.redis.directory && values.dbfilename === "dump.rdb", "redis_identity_changed");
      return { runId: fields.run_id, pid: Number(fields.process_id) };
    });
  }
  async function checkIdle() {
    try {
      await mysqlIdentity();
      return await sql(async connection => {
        const [[turns]] = await connection.query("SELECT COUNT(*) AS n FROM turns WHERE status = 'inProgress'");
        const [[sessions]] = await connection.query("SELECT COUNT(*) AS n FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(status, '$.type')) = 'active'");
        return Number(turns.n) === 0 && Number(sessions.n) === 0;
      });
    } catch { return false; }
  }
  async function ready(name, entry) {
    const deadline = performance.now() + 45_000;
    do {
      try {
        if (name === "mysql") { await mysqlIdentity(); return; }
        if (name === "redis") { await redisIdentity(entry); return; }
        await new Promise((done, reject) => {
          const req = request({ hostname: "127.0.0.1", port: profile.roles[name].port, path: "/readyz", method: "GET", agent: false }, response => {
            response.resume(); response.once("end", () => response.statusCode === 200 ? done() : reject(new Error("service_not_ready")));
          });
          req.setTimeout(2000, () => req.destroy()); req.on("error", reject); req.end();
        }); return;
      } catch { await pause(150); }
    } while (performance.now() < deadline);
    throw new Error("readiness_timeout_retained");
  }
  async function beforeInfrastructureStop(name, entry) {
    // Root observer sees the entire dedicated instance, including non-H5 writers.
    await mysqlIdentity();
    await sql(async connection => {
      const [[tx]] = await connection.query("SELECT COUNT(*) AS n FROM information_schema.innodb_trx");
      const [[clients]] = await connection.query("SELECT COUNT(*) AS n FROM information_schema.processlist WHERE ID <> CONNECTION_ID() AND USER NOT IN ('event_scheduler','system user')");
      need(Number(tx.n) === 0 && Number(clients.n) === 0, "database_clients_remaining");
    }, true);
    if (name === "redis") {
      await redisIdentity(entry);
      await redis(identity.redis.operatorUrl, async client => {
        const info = await client.info("server"), fields = Object.fromEntries(info.split("\r\n").filter(x => x.includes(":"))
          .map(x => { const at = x.indexOf(":"); return [x.slice(0, at), x.slice(at + 1)]; }));
        const config = await client.config("GET", "dir", "dbfilename"), values = Object.fromEntries(Array.from({ length: config.length / 2 }, (_, i) => [config[i * 2], config[i * 2 + 1]]));
        need(fields.run_id === entry.runId && Number(fields.process_id) === entry.witness.pid
          && Number(fields.tcp_port) === profile.infrastructure.redis.port
          && values.dir === identity.redis.directory && values.dbfilename === "dump.rdb", "redis_identity_changed");
        const ownId = String(await client.call("CLIENT", "ID"));
        const clients = String(await client.call("CLIENT", "LIST")).trim().split("\n").map(line => Object.fromEntries(line.trim().split(" ").map(part => {
          const at = part.indexOf("="); return [part.slice(0, at), part.slice(at + 1)];
        })));
        // The separately pinned identity ACL only allows read-only observation.
        need(clients.every(value => value.id === ownId || value.user === "identity"), "redis_clients_remaining");
        need(await client.save() === "OK", "redis_save_failed");
      });
    }
  }
  async function beforeAction(_action, entries) {
    for (const binding of profile.releaseBindings) {
      const manifest = await verifyVmReleaseDirectory(binding.directory, binding.role, binding.manifestSha256);
      need(manifest.source.sourceCommit === profile.acceptedCommit && manifest.source.sourceDirty === false
        && manifest.publishable === true, "release_identity_changed");
    }
    if (["ready", "running", "observed"].includes(entries.mysql?.state)) await mysqlIdentity();
    if (["ready", "running", "observed"].includes(entries.redis?.state)) {
      const observed = await redisIdentity(entries.redis);
      need(observed.runId === entries.redis.runId, "redis_generation_changed");
    }
  }
  async function observe(entries) {
    const result = {};
    await Promise.all(Object.entries(entries).map(async ([name, entry]) => {
      if (entry.state !== "ready") return;
      try {
        if (name === "mysql") await mysqlIdentity();
        else if (name === "redis") { const value = await redisIdentity(entry); need(value.runId === entry.runId, "redis_generation_changed"); }
        else {
          const response = await fetch(`http://127.0.0.1:${profile.roles[name].port}/readyz`, { signal: AbortSignal.timeout(2000), redirect: "error" });
          try { need(response.status === 200, "service_not_ready"); } finally { await response.body?.cancel(); }
        }
        result[name] = true;
      } catch { result[name] = false; }
    }));
    return result;
  }
  return { observe, checkIdle, ready, beforeAction, beforeInfrastructureStop, afterInfrastructureStart: async entries => {
    await mysqlIdentity(); const observed = await redisIdentity(entries.redis);
    return { redis: { runId: observed.runId } };
  } };
}
