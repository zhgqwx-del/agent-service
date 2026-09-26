#!/usr/bin/env node
import mysql from "mysql2/promise";

const args = new Set(process.argv.slice(2));
const valueOf = (name, fallback) => {
  const prefix = `${name}=`;
  const raw = [...args].find((arg) => arg.startsWith(prefix));
  if (!raw) return fallback;
  const value = Number(raw.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

const allowed = new Set([
  "--dry-run",
  "--delete-legacy-pending-after-drain",
]);
for (const arg of args) {
  if (allowed.has(arg) || arg.startsWith("--batch-size=") || arg.startsWith("--max-batches=")) continue;
  throw new Error(`unknown argument: ${arg}`);
}

const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("MYSQL_URL is required");

const dryRun = args.has("--dry-run");
const deleteLegacyPending = args.has("--delete-legacy-pending-after-drain");
const batchSize = valueOf("--batch-size", 1_000);
const maxBatches = valueOf("--max-batches", 100);
const cutoffMs = Date.now();

async function countRows(conn, predicate) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS count FROM idempotency_keys WHERE expires_at_ms < ? AND ${predicate}`,
    [cutoffMs],
  );
  return Number(rows[0]?.count ?? 0);
}

async function deleteBatches(conn, predicate) {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const [result] = await conn.query(
      `DELETE FROM idempotency_keys WHERE expires_at_ms < ? AND ${predicate} ORDER BY expires_at_ms LIMIT ?`,
      [cutoffMs, batchSize],
    );
    deleted += result.affectedRows;
    if (result.affectedRows < batchSize) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}

const conn = await mysql.createConnection(mysqlUrl);
try {
  const completed = await countRows(conn, "value IS NOT NULL");
  const pending = await countRows(conn, "value IS NULL");
  if (dryRun) {
    console.log(`expired completed receipts: ${completed}`);
    console.log(`expired legacy pending rows: ${pending}`);
    console.log("dry run: nothing deleted");
  } else {
    const completedResult = await deleteBatches(conn, "value IS NOT NULL");
    console.log(`deleted expired completed receipts: ${completedResult.deleted}${completedResult.capped ? " (batch cap reached; run again)" : ""}`);

    if (deleteLegacyPending) {
      const pendingResult = await deleteBatches(conn, "value IS NULL");
      console.log(`deleted expired legacy pending rows: ${pendingResult.deleted}${pendingResult.capped ? " (batch cap reached; run again)" : ""}`);
    } else if (pending > 0) {
      console.log(`kept expired legacy pending rows: ${pending} (drain every legacy runner first, then use --delete-legacy-pending-after-drain)`);
    }
  }
} finally {
  await conn.end();
}
