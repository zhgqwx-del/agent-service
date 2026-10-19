interface RedisSelectionClient {
  on(event: "error", listener: (error: unknown) => void): unknown;
  disconnect(reconnect?: boolean): unknown;
  readonly stream?: { destroy(): unknown };
}

const guarded = new WeakSet<RedisSelectionClient>();

function selectFailed(error: unknown): boolean {
  try {
    if (!error || typeof error !== "object") return false;
    const command = Object.getOwnPropertyDescriptor(error, "command");
    if (!command || !("value" in command) || !command.value || typeof command.value !== "object") return false;
    const name = Object.getOwnPropertyDescriptor(command.value, "name");
    return name !== undefined && "value" in name && name.value === "select";
  } catch { return false; }
}

/**
 * A failed SELECT must never let the driver continue on its connection's default database.
 * Install on every actual client, including duplicates, before exposing it to callers.
 * This only fences writes; the client owner must still await its actual native close.
 */
export function guardRedisDatabaseSelection<T extends RedisSelectionClient>(client: T): T {
  if (guarded.has(client)) return client;
  client.on("error", (error: unknown) => {
    if (!selectFailed(error)) return;
    let stream: RedisSelectionClient["stream"];
    try { stream = client.stream; } catch { /* Still attempt the client's disconnect. */ }
    try { client.disconnect(false); } catch { /* Native destruction below remains mandatory. */ }
    finally {
      // disconnect() may only end gracefully; destroy before any ready/offline-queue continuation.
      try { stream?.destroy(); } catch { /* Never emit the original error or claim close settlement. */ }
    }
  });
  guarded.add(client);
  return client;
}
