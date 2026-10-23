import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { SessionAuthorityError } from "../session-authority.js";
import { SESSION_AUTHORITY_MIGRATION } from "./session-authority-binding.js";
export { SESSION_AUTHORITY_MIGRATION, loadActiveSessionAuthorityBinding,
  assertSessionAuthorityRuntimeConnection } from "./session-authority-binding.js";

export const SESSION_AUTHORITY_DCR_PREDECESSOR_ROOT_SHA256 = "a20e7b93367a13ff601a1d1e749ace263d4a385a8c839b64ecbc6bc7f24373c1";
export const SESSION_AUTHORITY_SESSIONS_PREDECESSOR_ROOT_SHA256 = "95f6761fb8f3e570c4d00d5ad82261bed1c7f588e6389a2cfd31344cd2b75dc3";
// Native MySQL metadata root after restoring the original subagent session guard.
export const SESSION_AUTHORITY_FINGERPRINT_ROOT_SHA256 = "5fb0f89b628dc0841ce83bb3a0edb03a37db233c97380d66b2e5646e14bdad4e";

function fail(): never { throw new SessionAuthorityError(); }
export function sessionAuthorityFingerprintStatement(raw: string): string {
  const start="-- agent-service-runtime-fingerprint:session-authority:start";
  const end="-- agent-service-runtime-fingerprint:session-authority:end";
  const a=raw.indexOf(start),b=raw.indexOf(end);
  if(a<0||b<=a||raw.indexOf(start,a+1)>=0||raw.indexOf(end,b+1)>=0
    ||raw.includes("__session_authority_native_root_not_calibrated__"))fail();
  const statements=raw.slice(a+start.length,b).replace(/^\s*--.*$/gm,"").split(/;\s*\n/).map(x=>x.trim()).filter(Boolean);
  const statement=statements[0],roots=statement?.match(/'[a-f0-9]{64}'/g)??[];
  if(statements.length!==1||!statement?.startsWith("SET @skill_registry_triggers_ok=")||statement.includes(";")
    ||roots.length!==1||roots[0]!=="'"+SESSION_AUTHORITY_FINGERPRINT_ROOT_SHA256+"'"||["0","1","2"].some(c=>roots[0]===`'${c.repeat(64)}'`))fail();
  return statement;
}
/** Complete latest root, including sessions/authority metadata and all native trigger definitions. */
export async function assertMysqlSessionAuthorityFingerprint(conn: PoolConnection,directory: string,
  installedMarker=true): Promise<void> {
  const [markers]=await conn.query<RowDataPacket[]>(
    "SELECT name FROM schema_migrations WHERE name IN (?,?,?) ORDER BY name",
    ["0064_subagents.sql","0065_mcp_dcr.sql",SESSION_AUTHORITY_MIGRATION]);
  if(markers.length!==(installedMarker?3:2)
    ||!markers.some(r=>r.name==="0064_subagents.sql")||!markers.some(r=>r.name==="0065_mcp_dcr.sql")
    ||markers.some(r=>r.name===SESSION_AUTHORITY_MIGRATION)!==installedMarker)fail();
  const statement=sessionAuthorityFingerprintStatement(await readFile(join(directory,SESSION_AUTHORITY_MIGRATION),"utf8"));
  await conn.query("SET @session_authority_verifier_previous_gcml=@@SESSION.group_concat_max_len");
  let hasError=false,firstError:unknown;
  const remember=(error:unknown)=>{if(!hasError){hasError=true;firstError=error;}};
  try {
    await conn.query("SET SESSION group_concat_max_len=1048576");
    await conn.query(statement);
    const [rows]=await conn.query<RowDataPacket[]>("SELECT @skill_registry_triggers_ok AS ok");
    if(rows.length!==1||Number(rows[0]!.ok)!==1)fail();
  } catch(error){remember(error);}
  try { await conn.query("SET SESSION group_concat_max_len=@session_authority_verifier_previous_gcml"); }
  catch(error){remember(error);}
  if(hasError)throw firstError;
}
