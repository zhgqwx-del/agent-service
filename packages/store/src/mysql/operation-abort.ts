import type { Pool } from "mysql2/promise";
import net, { type Socket } from "node:net";

function cancellationError(): Error {
  return Object.assign(new Error("MySQL maintenance operation aborted"), {
    name: "AbortError", code: "ABORT_ERR",
  });
}

/** Own the native transport: mysql2.destroy() only half-closes its socket. */
export function createMysqlOperationAbortTransport(signal: AbortSignal): {
  stream(options: { config: {
    host: string; port: number; socketPath?: string;
    enableKeepAlive?: boolean; keepAliveInitialDelay?: number;
  } }): Socket;
  close(): void;
  /** Await actual native close, including sockets mysql2 removed from its pool. */
  settled(): Promise<void>;
} {
  const sockets = new Set<Socket>();
  const closes = new Set<Promise<void>>();
  const abort = () => {
    // destroy(error), rather than FIN/end, interrupts the current native query
    // and lets mysql2 reject its pending command and queued callbacks.
    for (const socket of sockets) socket.destroy(cancellationError());
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    stream({ config }) {
      const socket = config.socketPath
        ? net.createConnection(config.socketPath)
        : net.createConnection(config.port, config.host);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const closed = new Promise<void>(resolve => { socket.once("close", () => resolve()); });
      closes.add(closed);
      void closed.then(() => closes.delete(closed));
      if (!config.socketPath) {
        socket.setNoDelay(true);
        if (config.enableKeepAlive) {
          socket.once("connect", () => socket.setKeepAlive(true, config.keepAliveInitialDelay));
        }
      }
      // The driver attaches error handlers immediately after the factory
      // returns; defer only this already-aborted creation to that boundary.
      if (signal.aborted) queueMicrotask(() => socket.destroy(cancellationError()));
      return socket;
    },
    close() {
      signal.removeEventListener("abort", abort);
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    async settled() {
      while (closes.size) await Promise.all([...closes]);
    },
  };
}

/** One-shot maintenance cancellation; an already sent COMMIT may still have committed. */
export function bindMysqlOperationAbort(pool: Pool, signal: AbortSignal, transport?: { close(): void }): {
  close(): Promise<void>;
} {
  const connections = new Set<{ destroy(): void }>();
  let shutdown: Promise<void> | undefined;
  const endOnce = () => shutdown ??= pool.end();
  const track = (connection: { destroy(): void }) => {
    if (signal.aborted) connection.destroy();
    else connections.add(connection);
  };
  const abort = () => {
    for (const connection of connections) connection.destroy();
    connections.clear();
    // Mark the pool closed synchronously, including connections still completing handshake.
    // Do not wait for remote rollback/QUIT before refusing new queued operations.
    void endOnce().catch(() => {});
  };
  pool.on("connection", track);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    async close() {
      try { await endOnce(); }
      finally {
        signal.removeEventListener("abort", abort);
        pool.removeListener("connection", track);
        connections.clear();
        transport?.close();
      }
    },
  };
}
