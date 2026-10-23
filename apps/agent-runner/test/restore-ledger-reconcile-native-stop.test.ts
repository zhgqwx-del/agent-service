import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Native handshake blackhole only: this fixture implements no SQL and cannot mutate a database.
describe("restore reconciliation native signal candidate", () => {
  for (const sig of ["SIGTERM", "SIGINT"] as const) it(`joins a real pending MySQL handshake after ${sig}`, async context => {
    const sockets = new Set<Socket>(), socketCloses = new Set<Promise<void>>();
    let entered!: () => void; const accepted = new Promise<void>(yes => { entered = yes; });
    const server = createServer(socket => {
      sockets.add(socket); const closed = new Promise<void>(yes => socket.once("close", () => { sockets.delete(socket); yes(); }));
      socketCloses.add(closed); void closed.then(() => socketCloses.delete(closed)); socket.on("error", () => {}); entered();
    });
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let nativeClosed = true, stopping: Promise<void> | undefined, forced = false, spawnError: unknown;
    const stop = () => stopping ??= (async () => {
      if (!child || !closed) return;
      if (!nativeClosed) child.kill("SIGTERM");
      const timer = setTimeout(() => { if (!nativeClosed && child?.pid) { forced = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 5_000);
      try { await closed; } finally { clearTimeout(timer); }
    })();
    const cancelled = () => { void stop(); }; context.signal.addEventListener("abort", cancelled, { once: true });
    try {
      context.signal.throwIfAborted();
      await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
      context.signal.throwIfAborted();
      const address = server.address(); if (!address || typeof address === "string") throw Error("missing_handshake_fixture");
      const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      child = spawn(process.execPath, ["--import", "tsx", "apps/agent-runner/src/restore-ledger-reconcile.ts", "status"], {
        cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, NODE_ENV: "test", AWS_EC2_METADATA_DISABLED: "true",
          MYSQL_URL: `mysql://fixture@127.0.0.1:${address.port}/agent_service_test_native_handshake`,
          MYSQL_SCHEMA_METADATA_SCHEMA: "native_handshake_metadata", MYSQL_SCHEMA_METADATA_DEFINER_USER: "native_handshake_definer",
          MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost" },
      });
      nativeClosed = false;
      closed = new Promise(yes => { child!.once("error", error => { spawnError = error; }); child!.once("close", (code, signal) => { nativeClosed = true; yes({ code, signal }); }); });
      let stdout = "", stderr = "", truncated = false;
      child.stdout!.on("data", chunk => { stdout = (stdout + String(chunk)).slice(0, 65_537); if (stdout.length > 65_536) { truncated = true; void stop(); } });
      child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(0, 65_537); if (stderr.length > 65_536) { truncated = true; void stop(); } });
      if (context.signal.aborted) cancelled();
      await Promise.race([accepted, closed.then(() => { throw Error("cli_closed_before_handshake"); })]);
      expect(child.kill(sig)).toBe(true); const result = await closed;
      while (socketCloses.size) await Promise.all([...socketCloses]);
      expect(spawnError).toBeUndefined(); expect(result).toEqual({ code: 1, signal: null }); expect(forced).toBe(false); expect(truncated).toBe(false);
      expect(stdout).toBe(""); expect(stderr.trim()).toBe('{"status":"error","code":"operation_failed"}'); expect(sockets.size).toBe(0);
      let groupGone = false;
      if (child.pid) { try { process.kill(-child.pid, 0); } catch (error) { groupGone = (error as NodeJS.ErrnoException).code === "ESRCH"; } }
      expect(groupGone).toBe(true);
    } finally {
      await stop(); context.signal.removeEventListener("abort", cancelled);
      const done = server.listening ? new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())) : Promise.resolve();
      for (const socket of sockets) socket.destroy(); await done; while (socketCloses.size) await Promise.all([...socketCloses]);
    }
  });
});
