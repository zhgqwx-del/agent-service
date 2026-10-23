import { queryDb } from "./harness.js";

export interface ClusterAuthoritySnapshot {
  fence: number;
  ownerId: string | null;
  ownerAddr: string | null;
  expiresAtDbMs: number | null;
  observedAtDbMs: number;
  deleted: boolean;
  /** Content-free tuple comparison within the fixture; never emitted as process telemetry. */
  tupleKey: string | null;
}
interface AuthorityRow {
  fence_token: unknown; authority_binding_id: unknown; authority_runner_id: unknown; authority_runner_addr: unknown;
  authority_boot_id: unknown; authority_acquisition_sha256: unknown; authority_source_sha256: unknown; authority_expires_at_db_ms: unknown;
  deleted_at_ms: unknown; protocol: unknown; current_binding_id: unknown; native_binding: unknown; now_ms: unknown;
}
function natural(value: unknown): number {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw Error("cluster_authority_observation_invalid"); return parsed;
}
/** Independent fresh native SQL observation only. It neither acquires nor refreshes an owner. */
export async function readClusterAuthority(sessionId: string): Promise<ClusterAuthoritySnapshot> {
  const rows = await queryDb<AuthorityRow>(`SELECT s.fence_token,s.authority_binding_id,s.authority_runner_id,s.authority_runner_addr,
    s.authority_boot_id,s.authority_acquisition_sha256,s.authority_source_sha256,s.authority_expires_at_db_ms,s.deleted_at_ms,
    c.protocol,c.current_binding_id,(b.server_uuid=@@GLOBAL.server_uuid AND BINARY b.application_database=BINARY DATABASE()
      AND b.binding_sequence=c.binding_sequence) AS native_binding,
    CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms
    FROM sessions s JOIN session_authority_control c ON c.control_id=1
    LEFT JOIN session_authority_bindings b ON BINARY b.binding_id=BINARY c.current_binding_id
    WHERE s.session_id=? AND BINARY s.session_id=BINARY ?`, [sessionId, sessionId]);
  if (rows.length !== 1) throw Error("cluster_authority_observation_invalid");
  const row = rows[0]!;
  if (row.protocol !== "mysql-live-session-v1" || typeof row.current_binding_id !== "string" || Number(row.native_binding) !== 1) throw Error("cluster_authority_observation_invalid");
  const tuple = [row.authority_binding_id,row.authority_runner_id,row.authority_runner_addr,row.authority_boot_id,
    row.authority_acquisition_sha256,row.authority_source_sha256,row.authority_expires_at_db_ms];
  if (!tuple.every(value => value === null) && (tuple.some(value => value === null) || row.authority_binding_id !== row.current_binding_id
    || tuple.slice(0,6).some(value => typeof value !== "string" || !value))) throw Error("cluster_authority_observation_invalid");
  return { fence: natural(row.fence_token), ownerId: row.authority_runner_id as string | null, ownerAddr: row.authority_runner_addr as string | null,
    expiresAtDbMs: row.authority_expires_at_db_ms === null ? null : natural(row.authority_expires_at_db_ms),
    observedAtDbMs: natural(row.now_ms), deleted: row.deleted_at_ms !== null,
    tupleKey: tuple.every(value => value === null) ? null : JSON.stringify([...tuple.slice(0,6),natural(row.fence_token)]) };
}
export function liveClusterOwner(value: ClusterAuthoritySnapshot): string | undefined {
  return !value.deleted && value.ownerAddr !== null && value.expiresAtDbMs !== null && value.expiresAtDbMs > value.observedAtDbMs ? value.ownerAddr : undefined;
}
