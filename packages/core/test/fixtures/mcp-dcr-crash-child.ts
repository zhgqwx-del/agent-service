/** Test-only IPC child. It is never a product entry point or migration caller. */
import { MysqlSessionStore, createMcpRegistryAccess, type McpCoordination, type McpRegistrationOwner } from "@agent-service/store";
import { McpCredentialCipher } from "../../src/mcp/cipher.js";
import { RegisteredMcpService } from "../../src/mcp/registered.js";

interface Packet {
  protocol: "mcp-dcr-native-crash-v1";
  storeOptions: Parameters<typeof MysqlSessionStore.connect>[0];
  origin: string;
}
const owner: McpRegistrationOwner = { scope: "tenant", tenantId: "dcr-crash-tenant", userId: null };
const principal = { tenantId: owner.tenantId!, userId: "dcr-crash-admin" };
const coordination = (): McpCoordination => ({
  namespaceSha256: "9".repeat(64),
  async enter(_input, signal) { return { signal, async assertOpen() { signal.throwIfAborted(); }, async release() {} }; },
  async publishInvalidation() {}, onInvalidation() { return () => {}; }, async close() {},
});
async function send(value: object): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error("DCR test IPC unavailable"));
    process.send(value, error => error ? reject(new Error("DCR test IPC failed")) : resolve());
  });
}
async function run(input: Packet): Promise<void> {
  let store: MysqlSessionStore | undefined, service: RegisteredMcpService | undefined;
  try {
    if (input.protocol !== "mcp-dcr-native-crash-v1" || input.storeOptions.migrationMode !== "verify"
      || !input.storeOptions.schemaMetadata) throw new Error("DCR child requires restricted verify-only runtime");
    const database = new URL(input.storeOptions.url);
    if (database.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)
      || !/^agent_service_dcr_crash_test_[a-f0-9]{24}$/.test(decodeURIComponent(database.pathname.slice(1)))) throw new Error("DCR child database rejected");
    const origin = new URL(input.origin);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== input.origin) throw new Error("DCR child peer rejected");
    store = await MysqlSessionStore.connect(input.storeOptions);
    service = new RegisteredMcpService({ store, coordination: coordination(),
      cipher: new McpCredentialCipher({ keyId: "dcr-crash-fixture-v1", key: new Uint8Array(32).fill(9) }),
      callbackUrl: `${input.origin}/v1/mcp/oauth/callback`, timeoutMs: 1_000, allowLoopbackForTests: true,
      // This case proves SQL/native process-death semantics. Fleet proof has separate vertical tests.
      authorizeFleet: async () => {}, authorizeDcrFleet: async () => {} });
    const access = createMcpRegistryAccess({ principal, owner, authority: "tenant_admin", access: "manage" });
    const configured = await service.upsert(owner, { access, name: "crash", expectedRevision: 0, idempotencyKey: "crash-config",
      config: { endpoint: `${input.origin}/mcp`, description: "Native crash fixture", protocolVersion: "2026-07-28",
        authentication: { kind: "oauth_dynamic", issuer: `${input.origin}/oauth`, clientAuthentication: "none", scopes: [] } } });
    await send({ phase: "intent", configVersionId: configured.version.configVersionId, revision: configured.slot.revision });
    await service.registerDynamicClient(owner, "crash", { access, configVersionId: configured.version.configVersionId,
      expectedRevision: configured.slot.revision, idempotencyKey: "crash-registration" });
    throw new Error("DCR native crash window was missed");
  } catch {
    await send({ phase: "failed" }).catch(() => {});
    await service?.close().catch(() => {}); await store?.close().catch(() => {});
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
process.once("message", value => { void run(value as Packet); });
await send({ phase: "ready" });
