import { describe,expect,it } from "vitest";
import * as W from "../src/tenant-webhooks.js";
import * as S from "../src/tenant-webhook-state.js";
import { webhookEnvelope,webhookSha,webhookWrite } from "./fixtures/tenant-webhooks.js";

describe("tenant webhook v2 original-object contracts",()=>{
  const admin=W.createTenantWebhookAdminAccess({tenantId:"tenant",apiKeyId:"actual-admin-key"});
  it("rejects cloned authority and admission before accessing caller getters",()=>{
    expect(()=>W.assertTenantWebhookAccess(structuredClone(admin))).toThrow(W.TenantWebhookIntegrityError);
    const input=webhookWrite(admin);
    expect(()=>W.assertTenantWebhookConfigAdmission(structuredClone(input.admission))).toThrow(W.TenantWebhookIntegrityError);
    let reads=0;
    expect(()=>W.createTenantWebhookAdminAccess({get tenantId(){reads++;return "tenant";},apiKeyId:"key"})).toThrow(W.TenantWebhookIntegrityError);
    expect(reads).toBe(0);
  });
  it("requires exact current admin disclosure for each immutable body-bearing version",()=>{
    const config:W.TenantWebhookConfig={endpoint:"https://hooks.example.test/observe",phase:"postToolUse",bodyScopes:["prompt","tool_arguments","tool_result"]};
    expect(()=>W.createTenantWebhookConfigAdmission({access:admin,name:"observer",expectedRevision:0,generation:1,idempotencyKey:"key",config,signingKey:webhookEnvelope(),keyCommitmentSha256:webhookSha("key"),disclosureAck:null})).toThrow(W.TenantWebhookIntegrityError);
    const image=S.emptyTenantWebhookImage(),input=webhookWrite(admin,"observer",0,"key",config),result=S.upsertWebhook(image,input,1);
    S.validateTenantWebhookImage(image);
    expect(result.version?.adminApiKeyId).toBe("actual-admin-key"); expect(result.version?.disclosureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(()=>S.validateTenantWebhookImage({...image,versions:image.versions.map(v=>({...v,adminApiKeyId:"different-admin"}))})).toThrow(W.TenantWebhookIntegrityError);
  });
  it.each(["http://public.example/","https://user:secret@hooks.example/","https://hooks.example/?x=1","https://hooks.example/#x"])("rejects unsafe or unbound endpoint %s",endpoint=>{
    expect(()=>W.validateTenantWebhookConfig({endpoint,phase:"preToolUse",bodyScopes:[]})).toThrow(W.TenantWebhookIntegrityError);
  });
  it("keeps signing keys exactly raw32 encrypted bytes and purpose/owner/call AAD separate",()=>{
    expect(()=>webhookWrite(admin,"observer",0,"key")).not.toThrow();
    const i=webhookWrite(admin),image=S.emptyTenantWebhookImage(),version=S.upsertWebhook(image,i,1).version!;
    const key=W.tenantWebhookAad(version,"signing_key"),context={principal:{tenantId:"tenant",userId:"owner"},sessionId:"session",turnId:"turn",callItemId:"call"};
    expect(key.subject).toBeNull();expect(W.tenantWebhookAad(version,"invocation_snapshot",context).materialId).not.toBe(W.tenantWebhookAad(version,"delivery_payload",context).materialId);
    expect(()=>W.tenantWebhookAad(version,"delivery_payload",{...context,principal:{tenantId:"foreign",userId:"owner"}})).toThrow(W.TenantWebhookIntegrityError);
    const admitted=W.assertTenantWebhookConfigAdmission(i.admission);
    expect(()=>W.createTenantWebhookConfigAdmission({...admitted,signingKey:webhookEnvelope(33)})).toThrow(W.TenantWebhookIntegrityError);
  });
  it("binds exact management body, permanent revision and generation against ABA",()=>{
    const image=S.emptyTenantWebhookImage(),input=webhookWrite(admin),first=S.upsertWebhook(image,input,10);
    expect(S.upsertWebhook(image,input,11)).toEqual(first);
    expect(()=>S.upsertWebhook(image,webhookWrite(admin,"observer",0,"install",{endpoint:"https://other.example/",phase:"postToolUse",bodyScopes:[]}),11)).toThrow(W.TenantWebhookConflictError);
    const gone=S.setWebhookState(image,{access:admin,name:"observer",expectedRevision:1,idempotencyKey:"delete",state:"deleted"},12);
    expect(()=>S.upsertWebhook(image,input,13)).toThrow(W.TenantWebhookConflictError);
    const recreated=S.upsertWebhook(image,webhookWrite(admin,"observer",gone.revision,"recreate",undefined,2),13);
    expect(recreated.slot).toMatchObject({generation:2,revision:3});expect(recreated.version?.configVersionId).not.toBe(first.version?.configVersionId);
  });
  it("validates a legitimate long Unicode tenant without aliasing another tuple",()=>{
    const tenantId="中".repeat(100),first=W.createTenantWebhookRuntimeAccess({tenantId,userId:"owner"});
    expect(W.assertTenantWebhookAccess(first).principal?.tenantId).toBe(tenantId);
    expect(()=>W.createTenantWebhookRuntimeAccess({tenantId:"中".repeat(129),userId:"owner"})).toThrow(W.TenantWebhookIntegrityError);
    expect(()=>W.createTenantWebhookRuntimeAccess({tenantId,userId:"*"})).toThrow(W.TenantWebhookIntegrityError);
  });
});
