import { randomUUID } from "node:crypto";
import mysql, { type RowDataPacket } from "mysql2/promise";
import type { ProviderConfig } from "@agent-service/protocol";
import { MysqlSessionStore, newErasureRequestId, tenantErasureRequestHash } from "@agent-service/store";

// This file is copied into, compiled, and run only from the exact frozen 0058
// archive. It never imports the live 0059 implementation or its sidecar types.
const SOURCE_COMMIT = "24d5ae4247b356696e984d95e47b99c20388cd2d";
const STAGES = ["input", "connect", "activate", "provider", "request", "claim", "t3a", "proof"] as const;
const CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_ENTRY",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"] as const;
let stage: typeof STAGES[number] = "input";
function diagnostic(error: unknown, field: "code" | "name", allowed: readonly string[], absent: string): string {
  try {
    if (typeof error !== "object" || error === null || !(field in error)) return absent;
    const value: unknown = (error as Record<string, unknown>)[field];
    return typeof value === "string" && allowed.includes(value) ? value : "other";
  } catch { return "other"; }
}
function provider(tenantId: string): ProviderConfig {
  const now = Date.now();
  return { tenantId, id: "provider", api: "openai-completions",
    baseUrl: "https://frozen0058-provider.invalid/v1", apiKeyRef: "secret:frozen0058",
    headers: {}, models: [{ id: "model", contextWindow: 1_000, maxOutputTokens: 10,
      input: ["text"], reasoning: false }], quota: {}, fallback: [], createdAtMs: now, updatedAtMs: now };
}
async function run() {
  const url = process.env.MYSQL_URL;
  if (!url) throw new Error("frozen 0058 URL missing");
  const address = new URL(url);
  if (address.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
    || !/^agent_service_migration_test_0059_[0-9]+_[0-9a-f]{8}$/.test(decodeURIComponent(address.pathname.slice(1)))) {
    throw new Error("frozen 0058 database invalid");
  }
  const tenantId = `frozen-tenant-${randomUUID()}`, requestId = newErasureRequestId();
  stage = "connect";
  const store = await MysqlSessionStore.connect({ url });
  let conn: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
  try {
    stage = "activate";
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    stage = "provider";
    await store.upsertProviderConfig(provider(tenantId),
      { ciphertext: Buffer.from("encrypted-frozen0058-fixture"), keyId: "shared-fixture-key" }, null);
    const observedRevision = (await store.getProviderConfig(tenantId, "provider"))?.credentialSourceRevision;
    if (observedRevision !== 1) {
      throw new Error("frozen provider source revision differed");
    }
    stage = "request";
    await store.requestTenantErasure({ requestId, tenantId, requestedByKeyId: "frozen0058-admin",
      idempotencyKey: `frozen0058-${randomUUID()}`, requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
    stage = "claim";
    const deadline = Date.now() + 2_000;
    let claim: Awaited<ReturnType<MysqlSessionStore["claimTenantCredentialRevocations"]>>[number] | undefined;
    while (!claim && Date.now() < deadline) {
      claim = (await store.claimTenantCredentialRevocations({ limit: 100, leaseMs: 120_000,
        claimToken: `frozen0058-${randomUUID()}` })).find((candidate) => candidate.requestId === requestId);
      if (!claim) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (!claim) throw new Error("frozen T3a claim absent");
    stage = "t3a";
    const t3a = await store.revokeTenantCredentialMaterial({ requestId, tenantId,
      subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken });
    if (!t3a || await store.getProviderConfig(tenantId, "provider") !== null) throw new Error("frozen T3a not terminal");
    stage = "proof";
    const receipt = await store.getTenantCredentialRevocationReceipt(tenantId, requestId);
    if (!receipt || receipt.receiptSha256 !== t3a.receiptSha256) throw new Error("frozen T3a receipt differed");
    conn = await mysql.createConnection(url);
    const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
    const [guards] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
    const [versions] = await conn.query<RowDataPacket[]>("SELECT credential_version_id FROM tenant_credential_versions WHERE tenant_id=?", [tenantId]);
    const [inventory] = await conn.query<RowDataPacket[]>("SELECT receipt_sha256 FROM tenant_credential_inventory_receipts WHERE tenant_id=? AND request_id=?", [tenantId, requestId]);
    if (markers.at(-1)?.name !== "0058_tenant_telemetry_capture_repeat_restore.sql"
      || Number(guards[0]?.n) !== 735 || versions.length !== 1 || inventory.length !== 1) {
      throw new Error("frozen 0058 SQL proof differed");
    }
    return { scope: "frozen0058-credential-upgrade-v1", sourceCommit: SOURCE_COMMIT,
      marker: markers.at(-1)!.name, triggerCount: 735, tenantId, requestId,
      credentialVersionId: String(versions[0]!.credential_version_id),
      t3aReceiptSha256: receipt.receiptSha256, inventoryReceiptSha256: String(inventory[0]!.receipt_sha256),
      versionCount: 1, providerDeleted: true, externalRevocationExecuted: false,
      physicalRestoreExecuted: false, productionAccepted: false };
  } finally { await conn?.end(); await store.close(); }
}
try { process.stdout.write(JSON.stringify(await run())); }
catch (error) {
  process.stderr.write(`pre0059-frozen-writer-diagnostic:${JSON.stringify({ schema: "pre0059-frozen-writer-diagnostic-v1",
    stage, code: diagnostic(error, "code", CODES, "none"),
    name: diagnostic(error, "name", ["Error", "TypeError", "RangeError", "TenantErasureIntegrityError"], "other") })}\n`);
  process.exitCode = 1;
}
