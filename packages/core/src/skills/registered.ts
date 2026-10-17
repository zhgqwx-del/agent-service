import { createHash } from "node:crypto";
import { ApiError, Principal } from "@agent-service/protocol";
import {
  assertSkillRegistryAccess, createSkillPackageAdmission, createSkillRegistryAccess,
  SkillRegistryConflictError, SubjectDeletingError, skillRegistryDigest, validateSkillPackageMetadata,
  type BlobDescriptor, type BlobStore, type SkillOwner, type SkillRegistryAccess,
  type SkillRegistryStore, type SkillSlot, type SkillSlotPage, type SkillVersion, type SkillVersionPage,
} from "@agent-service/store";
import type { TenantRuntimeCoordinator } from "../lifecycle/tenant-runtime-coordinator.js";
import { parseSkillDocument, MAX_SKILL_DOCUMENT_BYTES, SKILL_PARSER_PROFILE } from "./document.js";
import { guardSkillDocument, SKILL_GUARD_PROFILE } from "./guard.js";
import { exportRegisteredUserSkills } from "./export.js";
import type { LoadedStaticSkill, SkillResolution, StaticSkillLoadInput, StaticSkillSource, StaticSkillSummary } from "./static.js";

export interface RegisteredSkillServiceOptions {
  readonly store: SkillRegistryStore;
  readonly blobs: BlobStore;
  /** Actual dedicated registry namespace, not a session Blob control identity. */
  readonly namespaceSha256: string;
  readonly legacySource?: StaticSkillSource;
  readonly tenantRuntime?: TenantRuntimeCoordinator;
  readonly authorizeSubject?: (principal: Principal) => Promise<void>;
  readonly authorizeTenant?: (tenantId: string) => Promise<void>;
  readonly timeoutMs?: number;
  readonly maxConcurrentPerUser?: number;
}
interface AccessInput { readonly access: SkillRegistryAccess }
interface PageInput extends AccessInput { readonly cursor?: string; readonly limit?: number }
interface OperationContext {
  readonly signal: AbortSignal;
  check(): Promise<void>;
  io<T>(work: () => Promise<T>): Promise<T>;
}
interface Pending { readonly abort: AbortController; readonly done: Promise<void> }
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CONTENT_TYPE = "text/markdown; charset=utf-8";
const failure = () => new ApiError("invalid_request", "Skill request failed.");
function bad(): never { throw failure(); }
function missing(): never { throw new ApiError("not_found", "Skill not found."); }
function unavailable(): never { throw new ApiError("draining", "Skill request unavailable.", undefined, true); }
/** Driver identities only: never classify by SQL/error text or expose its fields. */
function mysqlContention(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  try {
    const errno = Object.getOwnPropertyDescriptor(error, "errno"), code = Object.getOwnPropertyDescriptor(error, "code");
    return !!(errno && "value" in errno && (errno.value === 1205 || errno.value === 1213)
      || code && "value" in code && (code.value === "ER_LOCK_WAIT_TIMEOUT" || code.value === "ER_LOCK_DEADLOCK"));
  } catch { return false; }
}
function name(value: unknown): asserts value is string { if (typeof value !== "string" || value.length > 64 || !NAME.test(value)) bad(); }
function positive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) bad(); return value;
}
function plain(value: unknown, allowed: readonly string[], required: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) bad();
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== "string" || !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) bad();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable)) bad();
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
function principal(value: Principal): Readonly<Principal> {
  plain(value, ["tenantId", "userId"], ["tenantId", "userId"]);
  const p = Principal.safeParse(value); if (!p.success) bad(); return Object.freeze(p.data);
}
function userOwner(p: Principal): SkillOwner { return { scope: "user", tenantId: p.tenantId, userId: p.userId }; }
function candidates(p: Principal): readonly SkillOwner[] { return [userOwner(p), { scope: "tenant", tenantId: p.tenantId, userId: null }, { scope: "platform", tenantId: null, userId: null }]; }
function readonlyAccess(p: Principal, owner: SkillOwner): SkillRegistryAccess { return createSkillRegistryAccess({ principal: p, owner, authority: "user_self", access: "read" }); }
function selection(ids: readonly string[], resolution?: SkillResolution): { legacy: string[]; names: string[]; overrides: ReadonlyMap<string, string> } {
  if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length) bad();
  const legacy: string[] = [], names: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") bad();
    if (id.startsWith("registry:")) { const n = id.slice(9); name(n); names.push(n); }
    else { if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) bad(); legacy.push(id); }
  }
  const overrides = new Map<string, string>();
  if (resolution !== undefined) {
    plain(resolution, ["overrides"], ["overrides"]);
    if (!Array.isArray(resolution.overrides) || resolution.overrides.length > 8) bad();
    for (const override of resolution.overrides) {
      plain(override, ["name", "versionId"], ["name", "versionId"]); name(override.name);
      if (typeof override.versionId !== "string" || !UUID.test(override.versionId) || !names.includes(override.name) || overrides.has(override.name)) bad();
      overrides.set(override.name, override.versionId);
    }
  }
  return { legacy, names, overrides };
}

/** Metadata/immutable Markdown registry plus the unchanged operator-static source.
 * No package scripts, references, remote downloads or additional tool authority.
 * Blob/DB cancellation is cooperative: leases and close wait for real I/O settle.
 */
export class RegisteredSkillService implements StaticSkillSource {
  readonly enabled = true;
  private readonly timeout: number;
  private readonly maximum: number;
  private readonly users = new Map<string, number>();
  private readonly pending = new Set<Pending>();
  private readonly options: RegisteredSkillServiceOptions;
  private closed = false;
  private closing?: Promise<void>;
  constructor(options: RegisteredSkillServiceOptions) {
    plain(options, ["store", "blobs", "namespaceSha256", "legacySource", "tenantRuntime", "authorizeSubject", "authorizeTenant", "timeoutMs", "maxConcurrentPerUser"], ["store", "blobs", "namespaceSha256"]);
    if (!SHA.test(options.namespaceSha256) || !options.blobs || typeof options.blobs.backend !== "string"
      || options.authorizeSubject !== undefined && typeof options.authorizeSubject !== "function"
      || options.authorizeTenant !== undefined && typeof options.authorizeTenant !== "function") bad();
    this.timeout = positive(options.timeoutMs, 5000, 30_000);
    this.maximum = positive(options.maxConcurrentPerUser, 4, 16);
    this.options = Object.freeze({ ...options });
  }

  private access(owner: SkillOwner, access: SkillRegistryAccess, manage: boolean): Readonly<Principal> {
    try { return assertSkillRegistryAccess(access, owner, manage); } catch { return bad(); }
  }
  private async operation<T>(p: Readonly<Principal>, mode: SkillOwner["scope"], caller: AbortSignal | undefined,
    work: (context: OperationContext) => Promise<T>): Promise<T> {
    if (this.closed || caller?.aborted) unavailable();
    const key = JSON.stringify([mode, p.tenantId, mode === "tenant" ? null : p.userId]);
    const active = this.users.get(key) ?? 0; if (active >= this.maximum) unavailable();
    let lease: ReturnType<TenantRuntimeCoordinator["enter"]> | undefined;
    try { if (mode !== "platform") lease = this.options.tenantRuntime?.enter(p.tenantId, "provider"); } catch { return unavailable(); }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, ...(caller ? [caller] : []), ...(lease ? [lease.signal] : [])]);
    const deadline = performance.now() + this.timeout, timer = setTimeout(() => abort.abort(), this.timeout);
    let finish!: () => void;
    const pending = { abort, done: new Promise<void>(resolve => { finish = resolve; }) };
    this.users.set(key, active + 1); this.pending.add(pending);
    const assertOpen = () => { if (this.closed || signal.aborted || performance.now() >= deadline) unavailable(); lease?.assertOpen(); };
    const check = async () => {
      assertOpen();
      if (mode === "user") await this.options.authorizeSubject?.(p);
      else if (mode === "tenant") await this.options.authorizeTenant?.(p.tenantId);
      assertOpen();
    };
    const context: OperationContext = { signal, check, io: async work => { await check(); const result = await work(); await check(); return result; } };
    try {
      await check();
      // S3 API deadlines can win before native SDK/body promises acknowledge
      // cancellation. Keep this operation and its tenant lease until the exact
      // adapter-owned I/O scope has really settled, including late body work.
      const result = this.options.blobs.withIoSettlement
        ? await this.options.blobs.withIoSettlement(() => work(context))
        : await work(context);
      await check(); return result;
    }
    catch (error) {
      if (this.closed || signal.aborted || performance.now() >= deadline) unavailable();
      // Native transactions have rolled back. Preserve exact caller retry rather
      // than presenting transient lock contention as a permanent input failure.
      // This boundary does not retry a request or assume an external write failed.
      if (mysqlContention(error)) unavailable();
      if (error instanceof SkillRegistryConflictError || error instanceof ApiError && (error.code === "state_conflict" || error.code === "idempotency_conflict")) {
        throw new ApiError("state_conflict", "Skill revision or idempotency conflict.");
      }
      if (error instanceof SubjectDeletingError || error instanceof ApiError && error.code === "subject_deleting") throw new ApiError("subject_deleting", "Skill request unavailable.");
      if (error instanceof ApiError && error.code === "not_found") return missing();
      if (error instanceof ApiError && error.code === "draining") return unavailable();
      return bad();
    } finally {
      clearTimeout(timer); lease?.release(); this.pending.delete(pending);
      const remaining = (this.users.get(key) ?? 1) - 1; if (remaining) this.users.set(key, remaining); else this.users.delete(key);
      finish();
    }
  }

  async install(owner: SkillOwner, input: AccessInput & { readonly document: Uint8Array; readonly expectedRevision: number; readonly idempotencyKey: string }, signal?: AbortSignal): Promise<SkillVersion> {
    plain(input, ["access", "document", "expectedRevision", "idempotencyKey"], ["access", "document", "expectedRevision", "idempotencyKey"]);
    const p = this.access(owner, input.access, true);
    if (!(input.document instanceof Uint8Array) || input.document.byteLength === 0 || input.document.byteLength > MAX_SKILL_DOCUMENT_BYTES) bad();
    return this.operation(p, owner.scope, signal, async ctx => {
      await ctx.check();
      const bytes = Buffer.from(input.document);
      const parsed = parseSkillDocument(bytes), scan = guardSkillDocument(bytes);
      if (!scan.allowed || scan.contentSha256 !== parsed.contentSha256) bad();
      await ctx.check();
      const admission = createSkillPackageAdmission({ owner, metadata: parsed.metadata, sha256: parsed.contentSha256, sizeBytes: parsed.sizeBytes,
        parserProfile: SKILL_PARSER_PROFILE, guardProfile: SKILL_GUARD_PROFILE });
      const stage = await ctx.io(() => this.options.store.prepareSkillInstallation({ owner, access: input.access, name: parsed.metadata.name,
        expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey, admission, backend: this.options.blobs.backend,
        storageNamespaceSha256: this.options.namespaceSha256 }));
      if (stage.state === "ready") {
        if (!stage.versionId) bad();
        const version = await ctx.io(() => this.options.store.getReadableSkillVersion({ owner, access: input.access, name: stage.name, versionId: stage.versionId }));
        if (!version) missing(); await this.readPackage(version, ctx);
        await this.recheckVersion(p, owner, version, input.access, ctx); return version;
      }
      const descriptor = await ctx.io(() => this.options.blobs.putIfAbsent(stage.storageKey, bytes, {
        uploadToken: stage.uploadToken, maxBytes: MAX_SKILL_DOCUMENT_BYTES, contentType: CONTENT_TYPE,
      }));
      this.descriptor(descriptor, stage);
      // A create-only adapter's response is not proof of bytes. Read the actual
      // immutable object before publishing metadata; failure retains exact stage.
      await this.readPackage({ ...stage, versionId: "staging", versionSha256: "", createdAtMs: stage.createdAtMs }, ctx, true);
      const version = await ctx.io(() => this.options.store.publishSkillInstallation({ owner, access: input.access,
        installationId: stage.installationId, uploadToken: stage.uploadToken, descriptor }));
      this.version(version); await this.recheckVersion(p, owner, version, input.access, ctx); return version;
    });
  }
  async listInstalled(owner: SkillOwner, input: PageInput, signal?: AbortSignal): Promise<SkillSlotPage> {
    plain(input, ["access", "cursor", "limit"], ["access"]); const p = this.access(owner, input.access, false);
    return this.operation(p, owner.scope, signal, ctx => ctx.io(() => this.options.store.listSkillSlots({ owner, access: input.access, cursor: input.cursor ?? null, limit: input.limit ?? 25 })));
  }
  async getInstalled(owner: SkillOwner, skillName: string, input: AccessInput, signal?: AbortSignal): Promise<SkillSlot | null> {
    plain(input, ["access"], ["access"]); const p = this.access(owner, input.access, false); name(skillName);
    return this.operation(p, owner.scope, signal, ctx => ctx.io(() => this.options.store.getSkillSlot({ owner, access: input.access, name: skillName })));
  }
  async listVersions(owner: SkillOwner, skillName: string, input: PageInput, signal?: AbortSignal): Promise<SkillVersionPage> {
    plain(input, ["access", "cursor", "limit"], ["access"]); const p = this.access(owner, input.access, false); name(skillName);
    return this.operation(p, owner.scope, signal, ctx => ctx.io(() => this.options.store.listSkillVersions({ owner, access: input.access, name: skillName, cursor: input.cursor ?? null, limit: input.limit ?? 25 })));
  }
  async readVersion(owner: SkillOwner, skillName: string, versionId: string | null, input: AccessInput, signal?: AbortSignal): Promise<{ version: SkillVersion; document: string }> {
    plain(input, ["access"], ["access"]); const p = this.access(owner, input.access, false); name(skillName);
    if (versionId !== null && !UUID.test(versionId)) bad();
    return this.operation(p, owner.scope, signal, async ctx => {
      const version = await ctx.io(() => this.options.store.getReadableSkillVersion({ owner, access: input.access, name: skillName, versionId }));
      if (!version) missing(); const document = await this.readPackage(version, ctx);
      await this.recheckVersion(p, owner, version, input.access, ctx); return { version, document };
    });
  }
  async deleteInstalled(owner: SkillOwner, skillName: string, input: AccessInput & { readonly expectedRevision: number; readonly idempotencyKey: string }, signal?: AbortSignal): Promise<SkillSlot> {
    plain(input, ["access", "expectedRevision", "idempotencyKey"], ["access", "expectedRevision", "idempotencyKey"]);
    const p = this.access(owner, input.access, true); name(skillName);
    return this.operation(p, owner.scope, signal, ctx => ctx.io(() => this.options.store.deleteSkillSlot({ owner, name: skillName, ...input })));
  }
  async exportInstalled(owner: SkillOwner, input: AccessInput & { readonly limit: number; readonly cursor?: string; readonly snapshotSha256?: string }, signal?: AbortSignal): ReturnType<typeof exportRegisteredUserSkills> {
    plain(input, ["access", "limit", "cursor", "snapshotSha256"], ["access", "limit"]);
    const p = this.access(owner, input.access, false);
    return this.operation(p, owner.scope, signal, ctx => ctx.io(() => exportRegisteredUserSkills({ store: this.options.store, blobs: this.options.blobs, namespaceSha256: this.options.namespaceSha256, owner, access: input.access },
      { limit: input.limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.snapshotSha256 === undefined ? {} : { snapshotSha256: input.snapshotSha256 }) }, ctx.signal)));
  }

  async validateMounts(owner: Principal, ids: readonly string[]): Promise<void> {
    const p = principal(owner), selected = selection(ids);
    if (selected.legacy.length) { if (!this.options.legacySource?.enabled) missing(); await this.options.legacySource.validateMounts(p, selected.legacy); }
    // Resolve all current registry references under the real session subject.
    await this.list(p, ids, new AbortController().signal);
  }
  async list(owner: Principal, ids: readonly string[], signal: AbortSignal, resolution?: SkillResolution): Promise<readonly StaticSkillSummary[]> {
    const p = principal(owner), selected = selection(ids, resolution);
    return this.operation(p, "user", signal, ctx => this.catalog(p, selected, ctx));
  }
  private async catalog(p: Principal, selected: ReturnType<typeof selection>, ctx: OperationContext): Promise<readonly StaticSkillSummary[]> {
      const legacy = selected.legacy.length ? await ctx.io(async () => {
        if (!this.options.legacySource?.enabled) missing(); return this.options.legacySource.list(p, selected.legacy, ctx.signal);
      }) : [];
      const registry: SkillVersion[] = [];
      for (const skillName of selected.names) registry.push(await this.resolve(p, skillName, selected.overrides.get(skillName), ctx));
      const catalog = [...legacy, ...registry.map(version => this.summary(version))];
      if (new Set(catalog.map(s => s.name)).size !== catalog.length || Buffer.byteLength(JSON.stringify(catalog)) > 16_384) bad();
      // Priority changes, delete/recreate and revoked subjects cannot publish a
      // stale catalog just because an earlier await read an authorized version.
      for (const version of registry) {
        const current = await this.resolve(p, version.name, selected.overrides.get(version.name), ctx);
        if (current.versionSha256 !== version.versionSha256) bad();
      }
      return freeze(catalog.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  async load(owner: Principal, ids: readonly string[], input: StaticSkillLoadInput, signal: AbortSignal, resolution?: SkillResolution): Promise<LoadedStaticSkill> {
    const p = principal(owner), selected = selection(ids, resolution);
    plain(input, ["name", "invocation", "availableTools", "expectedVersionSha256"], ["name", "invocation", "availableTools", "expectedVersionSha256"]);
    name(input.name);
    if (!SHA.test(input.expectedVersionSha256) || input.invocation !== "model" && input.invocation !== "user"
      || !Array.isArray(input.availableTools) || input.availableTools.length > 256 || new Set(input.availableTools).size !== input.availableTools.length
      || input.availableTools.some(t => typeof t !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(t))) bad();
    return this.operation(p, "user", signal, async ctx => {
      // Re-list both sources to reject registry/static name ambiguity, even on
      // explicit input. Overrides only apply to already mounted registry names.
      const catalog = await this.catalog(p, selected, ctx);
      const expected = catalog.find(s => s.name === input.name); if (!expected) missing();
      if (expected.versionSha256 !== input.expectedVersionSha256) bad();
      if (input.invocation === "model" && expected.disableModelInvocation || input.invocation === "user" && !expected.userInvocable) missing();
      if (expected.dependencies.tools.some(t => !input.availableTools.includes(t))) bad();
      if (!selected.names.includes(input.name)) {
        if (!this.options.legacySource) missing();
        return ctx.io(() => this.options.legacySource!.load(p, selected.legacy, input, ctx.signal));
      }
      const version = await this.resolve(p, input.name, selected.overrides.get(input.name), ctx);
      if (version.versionSha256 !== expected.versionSha256) bad();
      const document = await this.readPackage(version, ctx), parsed = parseSkillDocument(Buffer.from(document));
      const current = await this.resolve(p, input.name, selected.overrides.get(input.name), ctx);
      if (current.versionSha256 !== version.versionSha256) bad();
      return freeze({ ...this.summary(version), body: parsed.body });
    });
  }
  private async resolve(p: Principal, skillName: string, versionId: string | undefined, ctx: OperationContext): Promise<SkillVersion> {
    for (const owner of candidates(p)) {
      const version = await ctx.io(() => this.options.store.getReadableSkillVersion({ owner, access: readonlyAccess(p, owner), name: skillName, versionId: versionId ?? null }));
      if (version) { this.version(version); return version; }
    }
    return missing();
  }
  private summary(version: SkillVersion): StaticSkillSummary {
    this.version(version); return freeze({ id: version.slotId, ...version.metadata, contentSha256: version.sha256, versionSha256: version.versionSha256 });
  }
  private version(version: SkillVersion): void {
    if (version.backend !== this.options.blobs.backend || version.storageNamespaceSha256 !== this.options.namespaceSha256
      || version.parserProfile !== SKILL_PARSER_PROFILE || version.guardProfile !== SKILL_GUARD_PROFILE || version.contentType !== CONTENT_TYPE
      || !SHA.test(version.sha256) || !SHA.test(version.versionSha256) || !UUID.test(version.versionId)) bad();
    validateSkillPackageMetadata(version.metadata);
    const { versionSha256, ...core } = version;
    if (skillRegistryDigest("skill-registry-version-v1", core) !== versionSha256) bad();
  }
  private descriptor(actual: BlobDescriptor, expected: { storageKey: string; sha256: string; sizeBytes: number; contentType: string }): void {
    if (actual.storageKey !== expected.storageKey || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes || actual.contentType !== expected.contentType) bad();
  }
  private async readPackage(version: SkillVersion, ctx: OperationContext, staging = false): Promise<string> {
    if (!staging) this.version(version);
    if (version.backend !== this.options.blobs.backend || version.storageNamespaceSha256 !== this.options.namespaceSha256) bad();
    const object = await ctx.io(() => this.options.blobs.get(version.storageKey, { maxBytes: MAX_SKILL_DOCUMENT_BYTES }));
    if (!object) bad(); this.descriptor(object, version);
    if (object.data.byteLength !== version.sizeBytes || createHash("sha256").update(object.data).digest("hex") !== version.sha256) bad();
    const parsed = parseSkillDocument(object.data), scan = guardSkillDocument(object.data);
    if (parsed.contentSha256 !== version.sha256 || !scan.allowed
      || skillRegistryDigest("skill-package-metadata-v1", parsed.metadata) !== skillRegistryDigest("skill-package-metadata-v1", version.metadata)) bad();
    return object.data.toString("utf8");
  }
  private async recheckVersion(_p: Principal, owner: SkillOwner, version: SkillVersion, access: SkillRegistryAccess, ctx: OperationContext): Promise<void> {
    const current = await ctx.io(() => this.options.store.getReadableSkillVersion({ owner, access, name: version.name, versionId: version.versionId }));
    if (!current || current.versionSha256 !== version.versionSha256) missing();
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true; const pending = [...this.pending]; for (const op of pending) op.abort.abort();
      const legacy = this.options.legacySource?.close();
      this.closing = Promise.all([...pending.map(op => op.done), ...(legacy ? [legacy] : [])]).then(() => {});
    }
    return this.closing;
  }
}
