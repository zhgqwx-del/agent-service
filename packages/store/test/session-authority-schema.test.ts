import type { PoolConnection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { SessionAuthorityError } from "../src/session-authority.js";
import * as RestoreJournal from "../src/tenant-restore-journal.js";
import { advanceSessionAuthorityBinding, captureSessionAuthorityBindingCommand,
  prepareSessionAuthorityActivationRequest, captureSessionAuthorityActivationRequest, assertSessionAuthorityActivationRequest,
  prepareSessionAuthorityBindingTransition, initializeSessionAuthorityBinding,
  prepareSessionAuthorityBindingCommand, sessionAuthorityAccountsSha256 } from "../src/mysql/session-authority-binding.js";
import type { SessionAuthorityBindingCommandInput, SessionAuthorityBindingSource, PreparedSessionAuthorityBindingTransition } from "../src/mysql/session-authority-binding-types.js";
import { buildSchemaMetadataProcedure } from "../src/mysql/schema-metadata-codec.js";
import { assertSchemaRuntimeGrantSet, SchemaRuntimePrivilegesError } from "../src/mysql/schema-runtime-privileges.js";
import { sessionAuthorityFingerprintStatement, SESSION_AUTHORITY_DCR_PREDECESSOR_ROOT_SHA256,
  SESSION_AUTHORITY_SESSIONS_PREDECESSOR_ROOT_SHA256, SESSION_AUTHORITY_FINGERPRINT_ROOT_SHA256 } from "../src/mysql/session-authority-schema.js";

// Pure capture/grant tests only; these are not real MySQL, account isolation or migration proof.
const config={metadataSchema:"fixture_metadata",trustedDefiner:{user:"fixture_definer",host:"localhost"}};
const inactive={kind:"inactive",runtimeControlGeneration:0,runtimeControlEvidenceSha256:null,
  runtimeEpochSha256:null,restoreRunId:null,replayReceiptSha256:null} as const;
function fixture(): SessionAuthorityBindingCommandInput {
  return {bindingId:"11111111-1111-4111-8111-111111111111",activationId:"22222222-2222-4222-8222-222222222222",
    expectedBindingId:null,expectedSequence:0,serverUuid:"33333333-3333-4333-8333-333333333333",
    applicationDatabase:"fixture_app",newAccounts:[{user:"new_runtime",host:"localhost"}],
    oldAccountNames:["old_runtime"],activationEvidenceSha256:"a".repeat(64),expectedSource:{...inactive},nextEpoch:null};
}
function primaryInput(): RestoreJournal.ActivateTenantRestoreJournalControlInput {
  const target={targetOrdinal:0,targetSha256:"d".repeat(64),failureDomainSha256:"e".repeat(64),
    adapterProtocol:"fixture-v1",journalNamespaceSha256:"f".repeat(64)};
  return {adapterProtocol:target.adapterProtocol,journalNamespaceSha256:target.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256:"b".repeat(64),runtimeEpochSha256:"c".repeat(64),targets:[{...target}],
    observedHeads:[{...target,logicalDatabaseNamespaceSha256:"b".repeat(64),sealedRemoteSequence:0,
      sealedHeadRootSha256:RestoreJournal.EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256}]};
}
function transitionCommand(request=prepareSessionAuthorityActivationRequest("primary_activation",primaryInput())) {
  const captured=captureSessionAuthorityActivationRequest(request);
  return prepareSessionAuthorityBindingCommand({...fixture(),expectedBindingId:"44444444-4444-4444-8444-444444444444",expectedSequence:1,
    nextEpoch:{kind:"primary_activation",runtimeEpochSha256:"c".repeat(64),restoreRunId:null,
      activationRequestSha256:captured.activationRequestSha256,sealedReplayReceiptSha256:null}});
}

describe("session authority schema capture and closed grants (pure)",()=>{
  it("accepts only the exact native-calibrated root and rejects an uncalibrated or replaced fingerprint",async()=>{
    const raw=await readFile(new URL("../migrations/0066_mysql_live_session_authority.sql",import.meta.url),"utf8");
    expect(SESSION_AUTHORITY_DCR_PREDECESSOR_ROOT_SHA256).toBe("a20e7b93367a13ff601a1d1e749ace263d4a385a8c839b64ecbc6bc7f24373c1");
    expect(SESSION_AUTHORITY_SESSIONS_PREDECESSOR_ROOT_SHA256).toBe("95f6761fb8f3e570c4d00d5ad82261bed1c7f588e6389a2cfd31344cd2b75dc3");
    expect(SESSION_AUTHORITY_FINGERPRINT_ROOT_SHA256).toBe("5fb0f89b628dc0841ce83bb3a0edb03a37db233c97380d66b2e5646e14bdad4e");
    expect(raw).toContain("'"+SESSION_AUTHORITY_SESSIONS_PREDECESSOR_ROOT_SHA256+"'");
    expect(sessionAuthorityFingerprintStatement(raw)).toContain("'"+SESSION_AUTHORITY_FINGERPRINT_ROOT_SHA256+"'");
    expect(()=>sessionAuthorityFingerprintStatement(raw.replace("'"+SESSION_AUTHORITY_FINGERPRINT_ROOT_SHA256+"'",()=>"'"+"b".repeat(64)+"'"))).toThrow(SessionAuthorityError);
    expect(()=>sessionAuthorityFingerprintStatement(raw+"\n__session_authority_native_root_not_calibrated__")).toThrow(SessionAuthorityError);
  });
  it("keeps the complete forward SQL statement order and unique trigger set compatible with the published migrator",async()=>{
    const raw=await readFile(new URL("../migrations/0066_mysql_live_session_authority.sql",import.meta.url),"utf8");
    // Same split as the published mysqlMigrationStatements; no multipleStatements shortcut.
    const statements=raw.replace(/^\s*--.*$/gm,"").split(/;\s*\n/).map(x=>x.trim()).filter(Boolean);
    const describe=(statement:string)=>{
      const ddl=/^(CREATE TABLE|ALTER TABLE|CREATE TRIGGER|DROP TRIGGER|INSERT INTO|PREPARE|EXECUTE|DEALLOCATE PREPARE)\s+([a-zA-Z0-9_]+)/.exec(statement);
      if(ddl)return ddl[1]+":"+ddl[2];
      const set=/^SET\s+(?:SESSION\s+)?(@?[a-zA-Z0-9_]+)\s*=/.exec(statement);return set?"SET:"+set[1]:"UNRECOGNIZED";
    };
    const guard=["SET:@migration_sql","PREPARE:migration_stmt","EXECUTE:migration_stmt","DEALLOCATE PREPARE:migration_stmt"];
    const expected=[...guard,"SET:@session_authority_previous_gcml","SET:group_concat_max_len","SET:@skill_registry_triggers_ok",...guard,
      "SET:@skill_registry_triggers_ok",...guard,"CREATE TABLE:session_authority_control","CREATE TABLE:session_authority_bindings",
      "CREATE TABLE:session_authority_runtime_accounts","ALTER TABLE:session_authority_control","INSERT INTO:session_authority_control","ALTER TABLE:sessions",
      ...["control_bi","control_bd","bindings_bu","bindings_bd","accounts_bu","accounts_bd","bindings_bi","accounts_bi","control_bu",
        "sessions_bi","sessions_bu","subagent_tasks_bi"].map(name=>"CREATE TRIGGER:trg_session_authority_"+name),
      "DROP TRIGGER:trg_subagent_sessions_bu","CREATE TRIGGER:trg_subagent_sessions_bu","SET:@skill_registry_triggers_ok",...guard,"SET:group_concat_max_len"];
    const hasCalibrationBlock=raw.includes("__session_authority_native_root_not_calibrated__");
    expect(statements.map(describe)).toEqual(hasCalibrationBlock?expected:expected.slice(4));
    const triggers=statements.filter(x=>x.startsWith("CREATE TRIGGER "));
    expect(triggers).toHaveLength(13);expect(new Set(triggers.map(x=>/^CREATE TRIGGER (\w+)/.exec(x)?.[1])).size).toBe(13);
    expect(triggers.every(x=>!x.includes("\n")&&/\bEND$/.test(x)&&(x.match(/\bCREATE TRIGGER\b/g)??[]).length===1)).toBe(true);
    expect(statements.filter(x=>x.startsWith("CREATE TABLE "))).toHaveLength(3);
    expect(statements.filter(x=>x.startsWith("DROP TRIGGER "))).toHaveLength(1);
    expect(raw.split("-- agent-service-runtime-fingerprint:session-authority:start")).toHaveLength(2);
    expect(raw.split("-- agent-service-runtime-fingerprint:session-authority:end")).toHaveLength(2);
  });
  it("captures dense native arrays before any caller getter or custom map can run",()=>{
    let read=0;const values=fixture();
    Object.defineProperty(values.newAccounts,"0",{enumerable:true,get(){read++;throw Error("must not execute");}});
    expect(()=>prepareSessionAuthorityBindingCommand(values)).toThrow(SessionAuthorityError);
    expect(read).toBe(0);
    const custom=fixture();Object.defineProperty(custom.oldAccountNames,"map",{value(){read++;throw Error("must not execute");}});
    expect(()=>prepareSessionAuthorityBindingCommand(custom)).toThrow(SessionAuthorityError);
    expect(read).toBe(0);
    const nested=fixture(),nestedAccount=nested.newAccounts[0];if(!nestedAccount)throw Error("fixture account missing");
    Object.defineProperty(nestedAccount,"user",{enumerable:true,get(){read++;throw Error("must not execute");}});
    expect(()=>prepareSessionAuthorityBindingCommand(nested)).toThrow(SessionAuthorityError);expect(read).toBe(0);
  });

  it("rejects sparse, symbolic and subclass arrays without silently omitting entries",()=>{
    const sparse=fixture(),hole=new Array(1);expect(()=>prepareSessionAuthorityBindingCommand({...sparse,newAccounts:hole})).toThrow(SessionAuthorityError);
    const symbolic=fixture();Object.defineProperty(symbolic.oldAccountNames,Symbol("extra"),{value:"unknown"});
    expect(()=>prepareSessionAuthorityBindingCommand(symbolic)).toThrow(SessionAuthorityError);
    class Foreign extends Array<string>{}
    expect(()=>prepareSessionAuthorityBindingCommand({...fixture(),oldAccountNames:new Foreign("old_runtime")})).toThrow(SessionAuthorityError);
  });

  it("deep-captures the fixed command and hashes old names, expected source and exact account set",()=>{
    const source={...inactive},names=["old_runtime"],account={user:"new_runtime",host:"localhost"};
    const input={...fixture(),newAccounts:[account],oldAccountNames:names,expectedSource:source};
    const captured=captureSessionAuthorityBindingCommand(prepareSessionAuthorityBindingCommand(input));
    account.user="changed";names[0]="changed";Object.defineProperty(source,"runtimeControlGeneration",{value:99});
    expect(captured.newAccounts).toEqual([{user:"new_runtime",host:"localhost"}]);
    expect(captured.oldAccountNames).toEqual(["old_runtime"]);expect(captured.expectedSource).toEqual(inactive);
    expect(Object.isFrozen(captured.expectedSource)).toBe(true);
    const different=captureSessionAuthorityBindingCommand(prepareSessionAuthorityBindingCommand({...fixture(),oldAccountNames:["another_old"]}));
    expect(different.commandSha256).not.toBe(captured.commandSha256);
    expect(sessionAuthorityAccountsSha256([{user:"b",host:"%"},{user:"a",host:"localhost"}]))
      .toBe(sessionAuthorityAccountsSha256([{user:"a",host:"localhost"},{user:"b",host:"%"}]));
  });

  it("rejects a forged transition token before issuing any native query",async()=>{
    const query=vi.fn(),admission=vi.fn();
    const other:SessionAuthorityBindingSource={kind:"primary_activation",runtimeControlGeneration:1,
      runtimeControlEvidenceSha256:"b".repeat(64),runtimeEpochSha256:"c".repeat(64),restoreRunId:null,replayReceiptSha256:null};
    await expect(advanceSessionAuthorityBinding({query} as unknown as PoolConnection,
      {command:prepareSessionAuthorityBindingCommand(fixture()),schemaMetadata:config,assertNativeAdmission:admission},{} as PreparedSessionAuthorityBindingTransition,other))
      .rejects.toThrow(SessionAuthorityError);
    expect(query).not.toHaveBeenCalled();expect(admission).not.toHaveBeenCalled();
  });

  it("permits a genuinely fresh zero-old-name command without inventing a retired username",()=>{
    expect(captureSessionAuthorityBindingCommand(prepareSessionAuthorityBindingCommand({...fixture(),oldAccountNames:[]})).oldAccountNames).toEqual([]);
    // Actual empty namespace/source/native admission is checked later in the real activation TX.
  });

  it("uses the exact fixture v3 initial command vector including nextEpoch null",()=>{
    const value=captureSessionAuthorityBindingCommand(prepareSessionAuthorityBindingCommand({...fixture(),
      applicationDatabase:"agent_service_test_cli",newAccounts:[{user:"fixture_runtime",host:"127.0.0.1"}],oldAccountNames:[]}));
    expect(value.commandSha256).toBe("8b44c1c556c931adf3858b06bb4444a734cce2393951c8b7568ac3d3b2814d26");
  });

  it("captures next intent descriptors without evaluating getters or admitting missing future fields",()=>{
    let reads=0;const value=captureSessionAuthorityBindingCommand(transitionCommand());
    const next={...value.nextEpoch};Object.defineProperty(next,"activationRequestSha256",{enumerable:true,get(){reads++;throw Error("must not run");}});
    expect(()=>prepareSessionAuthorityBindingCommand({...fixture(),expectedBindingId:value.expectedBindingId,expectedSequence:1,nextEpoch:next as never})).toThrow(SessionAuthorityError);
    expect(reads).toBe(0);
    expect(()=>prepareSessionAuthorityBindingCommand({...fixture(),nextEpoch:{} as never})).toThrow(SessionAuthorityError);
    expect(()=>prepareSessionAuthorityBindingCommand({...fixture(),expectedBindingId:value.expectedBindingId,expectedSequence:1,nextEpoch:null})).toThrow(SessionAuthorityError);
  });

  it("captures complete primary input before its getters, array methods or later mutations can run",()=>{
    let reads=0;const bad=primaryInput();Object.defineProperty(bad.targets[0],"adapterProtocol",{enumerable:true,get(){reads++;throw Error("must not run");}});
    expect(()=>prepareSessionAuthorityActivationRequest("primary_activation",bad)).toThrow(SessionAuthorityError);expect(reads).toBe(0);
    const arrayMethod=primaryInput();Object.defineProperty(arrayMethod.observedHeads,"map",{value(){reads++;throw Error("must not run");}});
    expect(()=>prepareSessionAuthorityActivationRequest("primary_activation",arrayMethod)).toThrow(SessionAuthorityError);expect(reads).toBe(0);
    const original=primaryInput(),prepared=prepareSessionAuthorityActivationRequest("primary_activation",original);
    const first=captureSessionAuthorityActivationRequest(prepared);original.targets[0]!.failureDomainSha256="1".repeat(64);
    expect(first.kind).toBe("primary_activation");if(first.kind!=="primary_activation")throw Error("wrong request kind");
    expect(first.input.targets[0]!.failureDomainSha256).toBe("e".repeat(64));expect(Object.isFrozen(first.input.targets[0])).toBe(true);
    const changed=primaryInput();changed.targets[0]!.failureDomainSha256="1".repeat(64);changed.observedHeads[0]!.failureDomainSha256="1".repeat(64);
    expect(captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest("primary_activation",changed)).activationRequestSha256).not.toBe(first.activationRequestSha256);
  });

  it("includes the exact restore expected generation in its immutable request hash",()=>{
    const input={restoreRunId:"restore_55555555-5555-4555-8555-555555555555",expectedControlGeneration:8};
    const a=captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest("restore_activation",input));
    const b=captureSessionAuthorityActivationRequest(prepareSessionAuthorityActivationRequest("restore_activation",{...input,expectedControlGeneration:9}));
    expect(a.activationRequestSha256).not.toBe(b.activationRequestSha256);input.expectedControlGeneration=99;
    expect(a.input).toEqual({restoreRunId:input.restoreRunId,expectedControlGeneration:8});
  });

  it("rejects another valid primary request before any SQL and never uses initialization as a token bypass",async()=>{
    const request=prepareSessionAuthorityActivationRequest("primary_activation",primaryInput()),command=transitionCommand(request),query=vi.fn(),admission=vi.fn();
    const context={command,schemaMetadata:config,assertNativeAdmission:admission},different=primaryInput();
    different.logicalDatabaseNamespaceSha256="1".repeat(64);different.observedHeads[0]!.logicalDatabaseNamespaceSha256="1".repeat(64);
    const changed=prepareSessionAuthorityActivationRequest("primary_activation",different);
    expect(()=>assertSessionAuthorityActivationRequest(context,changed)).toThrow(SessionAuthorityError);
    await expect(prepareSessionAuthorityBindingTransition({query} as unknown as PoolConnection,context,changed)).rejects.toThrow(SessionAuthorityError);
    await expect(initializeSessionAuthorityBinding({query} as unknown as PoolConnection,context)).rejects.toThrow(SessionAuthorityError);
    expect(query).not.toHaveBeenCalled();expect(admission).not.toHaveBeenCalled();
  });

  it("confirms an exact already-applied result before comparing the changed current source with its fixed old source",async()=>{
    const request=prepareSessionAuthorityActivationRequest("primary_activation",primaryInput()),command=transitionCommand(request);
    const captured=captureSessionAuthorityBindingCommand(command),empty=RestoreJournal.EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256;
    const source:SessionAuthorityBindingSource={kind:"primary_activation",runtimeControlGeneration:1,runtimeControlEvidenceSha256:"9".repeat(64),
      runtimeEpochSha256:"c".repeat(64),restoreRunId:null,replayReceiptSha256:null};
    const fields=(value:SessionAuthorityBindingSource,prefix="source_")=>({[prefix+"kind"]:value.kind,[prefix+"runtime_control_generation"]:value.runtimeControlGeneration,
      [prefix+"runtime_control_evidence_sha256"]:value.runtimeControlEvidenceSha256,[prefix+"runtime_epoch_sha256"]:value.runtimeEpochSha256,
      [prefix+"restore_run_id"]:value.restoreRunId,[prefix+"replay_receipt_sha256"]:value.replayReceiptSha256});
    const row={control_id:1,protocol:"mysql-live-session-v1",current_binding_id:captured.bindingId,control_binding_sequence:2,
      binding_id:captured.bindingId,binding_sequence:2,predecessor_binding_id:captured.expectedBindingId,activation_id:captured.activationId,
      server_uuid:captured.serverUuid,application_database:captured.applicationDatabase,accounts_sha256:captured.accountsSha256,
      activation_evidence_sha256:captured.activationEvidenceSha256,command_sha256:captured.commandSha256,...fields(source),...fields(inactive,"expected_source_"),
      next_epoch_kind:"primary_activation",next_epoch_sha256:source.runtimeEpochSha256,next_restore_run_id:null,
      activation_request_sha256:captured.nextEpoch!.activationRequestSha256,sealed_replay_receipt_sha256:null,
      transition_predecessor_control_generation:0,transition_predecessor_control_evidence_sha256:empty};
    const query=vi.fn(async(sql:string,values?:unknown[])=>{
      if(sql.startsWith("SELECT protocol,current_binding_id"))return [[{protocol:row.protocol,current_binding_id:row.binding_id,binding_sequence:2}]];
      if(sql.includes("SELECT c.control_id"))return [[row]];
      if(sql.startsWith("SELECT @@GLOBAL.server_uuid"))return [[{server_uuid:captured.serverUuid,application_database:captured.applicationDatabase}]];
      if(sql.startsWith("SELECT account_user,account_host"))return [[{account_user:"new_runtime",account_host:"localhost"}]];
      if(sql.startsWith("SELECT state,control_generation,runtime_epoch_sha256"))return [[{state:"active",control_generation:1,runtime_epoch_sha256:source.runtimeEpochSha256}]];
      if(sql.includes("SELECT update_kind,lineage_kind"))return [[{update_kind:source.kind,lineage_kind:"primary",runtime_epoch_sha256:source.runtimeEpochSha256,
        activation_epoch_sha256:source.runtimeEpochSha256,evidence_sha256:source.runtimeControlEvidenceSha256,restore_run_id:null,replay_receipt_sha256:null}]];
      if(sql.startsWith("SELECT * FROM session_authority_bindings"))return [[values?.[0]===row.binding_id?row:{binding_sequence:1,...fields(inactive)}]];
      if(sql.startsWith("SELECT previous_control_evidence_sha256"))return [[{previous_control_evidence_sha256:empty}]];
      throw Error("unexpected synthetic query");
    }),conn={query} as unknown as PoolConnection,admission=vi.fn(async()=>{}),context={command,schemaMetadata:config,assertNativeAdmission:admission};
    const token=await prepareSessionAuthorityBindingTransition(conn,context,request);
    expect((await advanceSessionAuthorityBinding(conn,context,token,source)).bindingId).toBe(captured.bindingId);
    expect(query.mock.calls.every(([sql])=>sql.startsWith("SELECT "))).toBe(true);
    await expect(advanceSessionAuthorityBinding(conn,context,token,source)).rejects.toThrow(SessionAuthorityError);
    expect(admission).toHaveBeenCalled();
  });

  it("binds a restore result to the actual mutable head M rather than immutable activation generation K",async()=>{
    const restoreRunId="restore_55555555-5555-4555-8555-555555555555",request=prepareSessionAuthorityActivationRequest("restore_activation",{restoreRunId,expectedControlGeneration:4});
    const old:SessionAuthorityBindingSource={kind:"primary_activation",runtimeControlGeneration:1,runtimeControlEvidenceSha256:"1".repeat(64),runtimeEpochSha256:"2".repeat(64),restoreRunId:null,replayReceiptSha256:null};
    const source:SessionAuthorityBindingSource={kind:"restore_activation",runtimeControlGeneration:5,runtimeControlEvidenceSha256:"3".repeat(64),runtimeEpochSha256:"4".repeat(64),restoreRunId,replayReceiptSha256:"5".repeat(64)};
    const command=prepareSessionAuthorityBindingCommand({...fixture(),expectedBindingId:"44444444-4444-4444-8444-444444444444",expectedSequence:1,expectedSource:old,
      nextEpoch:{kind:"restore_activation",runtimeEpochSha256:source.runtimeEpochSha256,restoreRunId,
        activationRequestSha256:captureSessionAuthorityActivationRequest(request).activationRequestSha256,sealedReplayReceiptSha256:source.replayReceiptSha256}});
    const captured=captureSessionAuthorityBindingCommand(command),headEvidence="6".repeat(64);
    const fields=(value:SessionAuthorityBindingSource)=>({source_kind:value.kind,source_runtime_control_generation:value.runtimeControlGeneration,
      source_runtime_control_evidence_sha256:value.runtimeControlEvidenceSha256,source_runtime_epoch_sha256:value.runtimeEpochSha256,
      source_restore_run_id:value.restoreRunId,source_replay_receipt_sha256:value.replayReceiptSha256});
    let transitioned=false,pointer=captured.expectedBindingId,sequence=1,inserted:Record<string,unknown>|undefined;
    const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
      const current=transitioned?source:old;
      if(sql.startsWith("SELECT protocol,current_binding_id"))return [[{protocol:"mysql-live-session-v1",current_binding_id:pointer,binding_sequence:sequence}]];
      if(sql.startsWith("SELECT a.account_user"))return [[{account_user:"old_runtime"}]];
      if(sql.startsWith("SELECT * FROM session_authority_bindings"))return [[values[0]===captured.bindingId?inserted:{binding_sequence:1,...fields(old)}]];
      if(sql.startsWith("SELECT @@GLOBAL.server_uuid"))return [[{server_uuid:captured.serverUuid,application_database:captured.applicationDatabase}]];
      if(sql.startsWith("SELECT state,control_generation,runtime_epoch_sha256"))return [[{state:"active",control_generation:transitioned?5:4,runtime_epoch_sha256:current.runtimeEpochSha256}]];
      if(sql.startsWith("SELECT state,control_generation,evidence_sha256"))return [[{state:"active",control_generation:4,evidence_sha256:headEvidence}]];
      if(sql.includes("SELECT update_kind,lineage_kind")){
        const event=values[0]===1?old:source;
        return [[{update_kind:event.kind,lineage_kind:event.kind==="primary_activation"?"primary":"restore",runtime_epoch_sha256:event.runtimeEpochSha256,
          activation_epoch_sha256:event.runtimeEpochSha256,evidence_sha256:event.runtimeControlEvidenceSha256,restore_run_id:event.restoreRunId,replay_receipt_sha256:event.replayReceiptSha256}]];
      }
      if(sql.startsWith("SELECT phase,runtime_epoch_sha256"))return [[{phase:"replay_sealed",runtime_epoch_sha256:source.runtimeEpochSha256,terminal_receipt_sha256:source.replayReceiptSha256}]];
      if(sql.startsWith("SELECT runtime_epoch_sha256,phase,terminal_receipt_sha256"))return [[{phase:"active",runtime_epoch_sha256:source.runtimeEpochSha256,terminal_receipt_sha256:source.replayReceiptSha256}]];
      if(sql.startsWith("SELECT runtime_epoch_sha256,evidence_sha256"))return [[{runtime_epoch_sha256:old.runtimeEpochSha256,evidence_sha256:headEvidence}]];
      if(sql.startsWith("SELECT previous_control_evidence_sha256"))return [[{previous_control_evidence_sha256:headEvidence}]];
      if(sql.startsWith("SET "))return [[]];
      if(sql.startsWith("INSERT INTO session_authority_bindings(")){
        const columns=sql.slice(sql.indexOf("(")+1,sql.indexOf(")")).split(",");inserted=Object.fromEntries(columns.map((key,i)=>[key,values[i]]));return [{}];
      }
      if(sql.startsWith("INSERT INTO session_authority_runtime_accounts"))return [{}];
      if(sql.startsWith("UPDATE session_authority_control")){pointer=String(values[0]);sequence=Number(values[1]);return [{affectedRows:1}];}
      if(sql.includes("SELECT c.control_id"))return [[{...inserted,control_id:1,protocol:"mysql-live-session-v1",current_binding_id:pointer,control_binding_sequence:sequence}]];
      if(sql.startsWith("SELECT account_user,account_host"))return [[{account_user:"new_runtime",account_host:"localhost"}]];
      throw Error("unexpected synthetic query");
    }),conn={query} as unknown as PoolConnection,context={command,schemaMetadata:config,assertNativeAdmission:vi.fn(async()=>{})};
    const token=await prepareSessionAuthorityBindingTransition(conn,context,request);transitioned=true;
    expect((await advanceSessionAuthorityBinding(conn,context,token,source)).bindingId).toBe(captured.bindingId);
    expect(inserted?.expected_source_runtime_control_generation).toBe(1);
    expect(inserted?.transition_predecessor_control_generation).toBe(4);expect(inserted?.transition_predecessor_control_evidence_sha256).toBe(headEvidence);
    expect(inserted?.source_runtime_control_generation).toBe(5);expect(query.mock.calls.some(([sql])=>/^COMMIT|^ROLLBACK/.test(sql))).toBe(false);
  });

  it("allows exactly SELECT on the three authority control tables and retains ordinary table IUD",()=>{
    const tables=["schema_migrations","sessions","session_authority_control","session_authority_bindings","session_authority_runtime_accounts"];
    const account="`fixture_runtime`@`localhost`",procedure=buildSchemaMetadataProcedure("fixture_app",config.metadataSchema);
    const grants=[`GRANT USAGE ON *.* TO ${account}`,`GRANT SHOW_ROUTINE ON *.* TO ${account}`,
      `GRANT EXECUTE ON PROCEDURE \`fixture_metadata\`.\`${procedure.routineName}\` TO ${account}`,
      ...tables.map(t=>`GRANT ${t==="sessions"?"SELECT, INSERT, UPDATE, DELETE":"SELECT"} ON \`fixture_app\`.\`${t}\` TO ${account}`)];
    const evidence={applicationDatabase:"fixture_app",currentUser:"fixture_runtime@localhost",baseTables:tables,grants};
    expect(()=>assertSchemaRuntimeGrantSet(evidence,config)).not.toThrow();
    for(const table of tables.slice(2))for(const right of ["INSERT","UPDATE","DELETE"]){
      expect(()=>assertSchemaRuntimeGrantSet({...evidence,grants:[...grants,`GRANT ${right} ON \`fixture_app\`.\`${table}\` TO ${account}`]},config))
        .toThrow(SchemaRuntimePrivilegesError);
    }
    expect(()=>assertSchemaRuntimeGrantSet({...evidence,grants:grants.map(x=>x.includes(".`sessions`")?`GRANT SELECT ON \`fixture_app\`.\`sessions\` TO ${account}`:x)},config))
      .toThrow(SchemaRuntimePrivilegesError);
    const lookalike={...evidence,baseTables:[...tables,"session_authority_other"],
      grants:[...grants,`GRANT SELECT ON \`fixture_app\`.\`session_authority_other\` TO ${account}`]};
    expect(()=>assertSchemaRuntimeGrantSet(lookalike,config)).toThrow(SchemaRuntimePrivilegesError);
    expect(()=>assertSchemaRuntimeGrantSet({...lookalike,grants:[...lookalike.grants,
      `GRANT INSERT, UPDATE, DELETE ON \`fixture_app\`.\`session_authority_other\` TO ${account}`]},config)).not.toThrow();
  });
});
