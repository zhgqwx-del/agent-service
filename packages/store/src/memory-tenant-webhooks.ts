import * as W from "./tenant-webhooks.js";
import * as S from "./tenant-webhook-state.js";

type Access = ReturnType<typeof W.assertTenantWebhookAccess>;
function fail(): never { throw new W.TenantWebhookIntegrityError(); }
export class MemoryTenantWebhooks {
  private readonly images = new Map<string, S.TenantWebhookImage>();
  constructor(private readonly gate: (access: Access) => void, private readonly clock: () => number,
    private readonly invocationGate: (intent: W.TenantWebhookIntent, access: W.TenantWebhookAccess, readonlyTerminal: boolean) => void) {}
  private image(access: W.TenantWebhookAccess, name: string, mode?: "admin" | "runtime") {
    const authority = W.assertTenantWebhookAccess(access, mode); this.gate(authority);
    const key = W.tenantWebhookId(authority.tenantId, name), before = this.images.get(key) ?? S.emptyTenantWebhookImage();
    S.validateTenantWebhookImage(before); return { authority, key, image: structuredClone(before) };
  }
  private publish(key: string, image: S.TenantWebhookImage) { S.validateTenantWebhookImage(image); Map.prototype.set.call(this.images, key, image); }
  async upsertTenantWebhook(input: W.UpsertTenantWebhookInput) {
    const c = this.image(input.access, input.name, "admin"), result = S.upsertWebhook(c.image, input, this.clock());
    if ([...this.images.values()].filter(i => i.slot?.tenantId === c.authority.tenantId && i.slot.state === "enabled" && i.slot.webhookId !== c.key).length >= 8) throw new W.TenantWebhookConflictError();
    this.publish(c.key, c.image); return result;
  }
  async setTenantWebhookState(input: Parameters<W.TenantWebhookStore["setTenantWebhookState"]>[0]) {
    const c = this.image(input.access, input.name, "admin"), result = S.setWebhookState(c.image, input, this.clock());
    if (result.state === "enabled" && [...this.images.values()].filter(i => i.slot?.tenantId === c.authority.tenantId && i.slot.state === "enabled" && i.slot.webhookId !== c.key).length >= 8) throw new W.TenantWebhookConflictError();
    this.publish(c.key, c.image); return result;
  }
  async getTenantWebhook(input: W.TenantWebhookNameInput) {
    W.tenantWebhookClosed(input, ["access", "name"]); const c = this.image(input.access, input.name);
    return c.image.slot ? structuredClone({ slot: c.image.slot, version: c.image.versions.find(v => v.configVersionId === c.image.slot!.currentVersionId) ?? null }) : null;
  }
  registrations(access: W.TenantWebhookAccess, snapshots?: readonly W.TenantWebhookInvocationSnapshot[]): W.TenantWebhookRegistration[] {
    const authority = W.assertTenantWebhookAccess(access); this.gate(authority);
    return [...this.images.values()].filter(i => i.slot?.tenantId === authority.tenantId).map(i => {
      S.validateTenantWebhookImage(i); const selected = snapshots?.find(s => s.webhookId === i.slot!.webhookId);
      return structuredClone({ slot: i.slot!, version: i.versions.find(v => v.configVersionId === (selected?.configVersionId ?? i.slot!.currentVersionId)) ?? null });
    }).sort((a, b) => a.slot.webhookId < b.slot.webhookId ? -1 : 1);
  }
  async listTenantWebhooks(input: Parameters<W.TenantWebhookStore["listTenantWebhooks"]>[0]) {
    W.tenantWebhookClosed(input, ["access", "cursor", "limit"]); W.assertTenantWebhookAccess(input.access, "admin"); this.page(input.cursor, input.limit);
    const rows = this.registrations(input.access).filter(r => r.slot.webhookId > (input.cursor ?? ""));
    return { items: rows.slice(0, input.limit), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.slot.webhookId : null };
  }
  async getTenantWebhookRuntimePolicy(input: Parameters<W.TenantWebhookStore["getTenantWebhookRuntimePolicy"]>[0]) {
    W.tenantWebhookClosed(input, ["access"]); W.assertTenantWebhookAccess(input.access, "runtime");
    const active = this.registrations(input.access).filter(r => r.slot.state === "enabled" && r.version);
    if (active.length > 8) fail();
    return active.map(r => ({ configVersionId: r.version!.configVersionId, configSha256: r.version!.configSha256, phase: r.version!.config.phase }));
  }
  snapshots(access: W.TenantWebhookAccess, callItemId: string) {
    const authority = W.assertTenantWebhookAccess(access, "runtime"); this.gate(authority);
    return [...this.images.values()].flatMap(i => i.snapshots).filter(s => s.callItemId === callItemId && S.webhookSame(s.subject, authority.principal)).map(s => structuredClone(s));
  }
  stageMilestone(input: W.TenantWebhookMilestoneAdmissionInput, current: W.TenantWebhookSourceValue) {
    const staged: Array<[string, S.TenantWebhookImage]> = [], intents: W.TenantWebhookIntent[] = [];
    this.gate({ mode: "runtime", tenantId: current.principal.tenantId, principal: current.principal, apiKeyId: null });
    if (input.kind !== "post" && !S.webhookSame(input.source.value.registrations, current.registrations)) throw new W.TenantWebhookConflictError();
    for (const selected of current.registrations) {
      const key = selected.slot.webhookId, image = structuredClone(this.images.get(key) ?? S.emptyTenantWebhookImage());
      S.validateTenantWebhookImage(image); intents.push(...S.applyWebhookMilestone(image, input, current, this.clock())); S.validateTenantWebhookImage(image); staged.push([key, image]);
    }
    return { intents: structuredClone(intents), publish: () => { for (const [key, image] of staged) Map.prototype.set.call(this.images, key, image); } };
  }
  private intentContext(access: W.TenantWebhookAccess, intentId: string, allowTerminalRead = false) {
    W.tenantWebhookSha(intentId); const authority = W.assertTenantWebhookAccess(access); this.gate(authority);
    for (const [key, original] of this.images) {
      const intent = original.intents.find(i => i.intentId === intentId); if (!intent) continue;
      if (intent.tenantId !== authority.tenantId || authority.mode === "runtime" && !S.webhookSame(intent.subject, authority.principal)) return null;
      const readonlyTerminal = allowTerminalRead && intent.state !== "prepared" && intent.state !== "sending";
      if (authority.mode === "runtime") this.invocationGate(intent, access, readonlyTerminal);
      S.validateTenantWebhookImage(original); return { key, image: structuredClone(original), authority, readonlyTerminal };
    }
    return null;
  }
  async getTenantWebhookDelivery(input: Parameters<W.TenantWebhookStore["getTenantWebhookDelivery"]>[0]) {
    W.tenantWebhookClosed(input, ["access", "intentId"]); const c = this.intentContext(input.access, input.intentId, true); if (!c) return null;
    const at = c.image.intents.findIndex(i => i.intentId === input.intentId);
    if (c.readonlyTerminal) return structuredClone(c.image.intents[at]!);
    c.image.intents[at] = S.settleExpiredWebhookIntent(c.image.intents[at]!, this.clock());
    this.publish(c.key, c.image); return structuredClone(c.image.intents[at]!);
  }
  async claimTenantWebhookDelivery(input: Parameters<W.TenantWebhookStore["claimTenantWebhookDelivery"]>[0]) {
    W.tenantWebhookClosed(input, ["access", "intentId", "timeoutMs"]); W.assertTenantWebhookAccess(input.access, "runtime");
    const c = this.intentContext(input.access, input.intentId); if (!c) return null;
    const result = S.claimWebhook(c.image, input.intentId, this.clock(), input.timeoutMs); this.publish(c.key, c.image); return result;
  }
  async abandonPreparedTenantWebhookDelivery(input: Parameters<W.TenantWebhookStore["abandonPreparedTenantWebhookDelivery"]>[0]) {
    W.tenantWebhookClosed(input,["access","intentId"]); W.assertTenantWebhookAccess(input.access,"runtime");
    const c=this.intentContext(input.access,input.intentId);if(!c)return null;
    const result=S.abandonPreparedWebhook(c.image,input.intentId,this.clock());this.publish(c.key,c.image);return result;
  }
  async finishTenantWebhookDelivery(input: Parameters<W.TenantWebhookStore["finishTenantWebhookDelivery"]>[0]) {
    W.tenantWebhookClosed(input, ["access", "intentId", "claimToken", "outcome", "resultSha256"]); W.assertTenantWebhookAccess(input.access, "runtime");
    const c = this.intentContext(input.access, input.intentId); if (!c) throw new W.TenantWebhookConflictError();
    const result = S.finishWebhook(c.image, input, this.clock()); this.publish(c.key, c.image); return result;
  }
  async listTenantWebhookDeliveries(input: Parameters<W.TenantWebhookStore["listTenantWebhookDeliveries"]>[0]) {
    W.tenantWebhookClosed(input, ["access", "name", "cursor", "limit"]); const c = this.image(input.access, input.name, "admin"); this.page(input.cursor, input.limit);
    const rows = c.image.intents.filter(i => i.intentId > (input.cursor ?? "")).sort((a, b) => a.intentId < b.intentId ? -1 : 1);
    return { items: structuredClone(rows.slice(0, input.limit)), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.intentId : null };
  }
  async reconcileTenantWebhookDeliveries(input: Parameters<W.TenantWebhookStore["reconcileTenantWebhookDeliveries"]>[0]) {
    W.tenantWebhookClosed(input, ["cursor", "limit"]); this.page(input.cursor, input.limit); const now = this.clock();
    const rows = [...this.images.values()].flatMap(i => i.intents).filter(i => i.intentId > (input.cursor ?? "") && ["prepared", "sending"].includes(i.state))
      .sort((a, b) => a.intentId < b.intentId ? -1 : 1).slice(0, input.limit + 1); let changed = 0;
    for (const row of rows.slice(0, input.limit)) { const image = structuredClone(this.images.get(row.webhookId)!); const at = image.intents.findIndex(i => i.intentId === row.intentId);
      const next = S.settleExpiredWebhookIntent(image.intents[at]!, now); if (!S.webhookSame(next, row)) { image.intents[at] = next; this.publish(row.webhookId, image); changed++; } }
    return { changed, nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.intentId : null };
  }
  hasTenantFootprint(tenantId: string) { return [...this.images.values()].some(i => i.slot?.tenantId === tenantId); }
  hasEnabledTenant(tenantId?: string) { return [...this.images.values()].some(i => i.slot?.state === "enabled" && (tenantId === undefined || i.slot.tenantId === tenantId)); }
  async assertTenantWebhookRuntimeGate(enabled: boolean) { if (typeof enabled !== "boolean" || !enabled && this.hasEnabledTenant()) fail(); }
  private page(cursor: string | null, limit: number) { if (cursor !== null) W.tenantWebhookSha(cursor); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(); }
}
