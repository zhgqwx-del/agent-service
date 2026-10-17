import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, parse, sep } from "node:path";
import { ApiError, Principal } from "@agent-service/protocol";
import { parseSkillDocument } from "./document.js";
import type { TenantRuntimeCoordinator } from "../lifecycle/tenant-runtime-coordinator.js";

export interface StaticSkillMount {
  readonly id: string;
  readonly directory: string;
  readonly subjects: readonly Readonly<Principal>[];
}
export interface StaticSkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string | null;
  /** SHA-256 of the exact UTF-8 SKILL.md bytes, including frontmatter. */
  readonly contentSha256: string;
  /** Binds the parser profile, mount, exact ACL and complete document bytes. */
  readonly versionSha256: string;
  readonly disableModelInvocation: boolean;
  readonly userInvocable: boolean;
  readonly dependencies: Readonly<{ tools: readonly string[] }>;
}
export interface LoadedStaticSkill extends StaticSkillSummary {
  readonly body: string;
}
export interface StaticSkillLoadInput {
  readonly name: string;
  readonly invocation: "model" | "user";
  /** Already-authorized tools from the actual session; never an additional grant. */
  readonly availableTools: readonly string[];
  readonly expectedVersionSha256: string;
}
/** Request-local immutable registry versions; never an extra mount or permission. */
export interface SkillResolution {
  readonly overrides: readonly Readonly<{ name: string; versionId: string }>[];
}
export interface StaticSkillSource {
  readonly enabled: boolean;
  validateMounts(principal: Principal, ids: readonly string[]): void | Promise<void>;
  list(principal: Principal, ids: readonly string[], signal: AbortSignal, resolution?: SkillResolution): Promise<readonly StaticSkillSummary[]>;
  load(principal: Principal, ids: readonly string[], input: StaticSkillLoadInput, signal: AbortSignal, resolution?: SkillResolution): Promise<LoadedStaticSkill>;
  close(): Promise<void>;
}
export interface StaticSkillSourceOptions {
  readonly skills: readonly StaticSkillMount[];
  readonly timeoutMs?: number;
  readonly maxConcurrentPerUser?: number;
  readonly tenantRuntime?: TenantRuntimeCoordinator;
  /** Product-owned current tenant/user lifecycle check, not a skill callback. */
  readonly authorizeSubject?: (principal: Principal) => Promise<void>;
}
export type ConfiguredStaticSkillSourceOptions = StaticSkillSourceOptions;

const MESSAGE = "Skill request failed.";
const MAX_FILE = 65_536;
const MAX_CATALOG_BYTES = 16_384;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{64}$/;
const ownerKey = (p: Readonly<Principal>) => JSON.stringify([p.tenantId, p.userId]);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function bad(): never { throw new ApiError("invalid_request", MESSAGE); }
function missing(): never { throw new ApiError("not_found", "Skill not found."); }
function unavailable(): never { throw new ApiError("draining", "Skill request unavailable.", undefined, true); }
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) bad();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(d => !("value" in d) || !d.enumerable)) bad();
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) bad();
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, d]) => key !== "length" && (!("value" in d) || !d.enumerable))) bad();
  return value;
}
function text(value: unknown, maximum: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || (!multiline && /[\r\n\t<>]/.test(value))) bad();
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) bad();
  return value;
}
function principal(value: Principal): Readonly<Principal> {
  const p = plain(value); closed(p, ["tenantId", "userId"], ["tenantId", "userId"]);
  const result = Principal.safeParse({ tenantId: text(p.tenantId, 512), userId: text(p.userId, 128) });
  if (!result.success) bad();
  return Object.freeze(result.data);
}
function directory(value: unknown): string {
  const p = text(value, 4096);
  if (!isAbsolute(p) || normalize(p) !== p || p === parse(p).root || p.endsWith(sep) || p.includes("\\")) bad();
  return p;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function positive(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) bad();
  return value;
}

/** The shared parser preserves the original operator-static digest and ACL binding. */
function document(bytes: Uint8Array, mount: StaticSkillMount): LoadedStaticSkill {
  const parsed = parseSkillDocument(bytes);
  const versionSha256 = hash(JSON.stringify({ scope: "operator-static-skill-v1", id: mount.id,
    subjects: mount.subjects.map(ownerKey).sort(), contentSha256: parsed.contentSha256 }));
  return freeze({ id: mount.id, ...parsed.metadata, contentSha256: parsed.contentSha256, versionSha256, body: parsed.body });
}

type Operation = { abort: AbortController; done: Promise<void> };

/** Operator-deployed Markdown only. No upload, resource traversal, templates,
 * scripts, remote fetch, cache, executable code or new tool permission.
 * Native filesystem/authorization work is cooperative: cancellation prevents
 * further work/results, but close/drain waits for the actual pending work. */
export class ConfiguredStaticSkillSource implements StaticSkillSource {
  readonly enabled: boolean;
  private readonly mounts = new Map<string, StaticSkillMount>();
  private readonly users = new Map<string, number>();
  private readonly pending = new Set<Operation>();
  private readonly timeout: number;
  private readonly maximum: number;
  private readonly runtime?: TenantRuntimeCoordinator;
  private readonly authorize?: (principal: Principal) => Promise<void>;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: StaticSkillSourceOptions) {
    const o = plain(options); closed(o, ["skills", "timeoutMs", "maxConcurrentPerUser", "tenantRuntime", "authorizeSubject"], ["skills"]);
    this.timeout = positive(o.timeoutMs, 5000, 30_000);
    this.maximum = positive(o.maxConcurrentPerUser, 4, 16);
    this.runtime = options.tenantRuntime;
    if (o.authorizeSubject !== undefined && typeof o.authorizeSubject !== "function") bad();
    this.authorize = options.authorizeSubject;
    for (const value of array(o.skills, 32)) {
      const raw = plain(value); closed(raw, ["id", "directory", "subjects"], ["id", "directory", "subjects"]);
      const id = identifier(raw.id), subjects = array(raw.subjects, 64).map(value => principal(value as Principal));
      if (!subjects.length || new Set(subjects.map(ownerKey)).size !== subjects.length || this.mounts.has(id)) bad();
      this.mounts.set(id, freeze({ id, directory: directory(raw.directory), subjects }));
    }
    this.enabled = this.mounts.size > 0;
  }

  validateMounts(owner: Principal, ids: readonly string[]): void { this.selection(owner, ids); }

  private selection(owner: Principal, ids: readonly string[]): { owner: Readonly<Principal>; mounts: readonly StaticSkillMount[] } {
    const p = principal(owner), selected = array(ids, 16).map(identifier);
    if (new Set(selected).size !== selected.length) bad();
    const mounts = selected.map(id => {
      const mount = this.mounts.get(id);
      if (!mount || !mount.subjects.some(subject => ownerKey(subject) === ownerKey(p))) missing();
      return mount;
    });
    return { owner: p, mounts };
  }

  async list(owner: Principal, ids: readonly string[], signal: AbortSignal): Promise<readonly StaticSkillSummary[]> {
    const selected = this.selection(owner, ids);
    return this.operation(selected.owner, signal, async check => {
      const loaded = await this.catalog(selected.mounts, check);
      return freeze(loaded.map(({ body: _body, ...summary }) => summary));
    });
  }

  async load(owner: Principal, ids: readonly string[], input: StaticSkillLoadInput, signal: AbortSignal): Promise<LoadedStaticSkill> {
    const selected = this.selection(owner, ids), r = plain(input);
    closed(r, ["name", "invocation", "availableTools", "expectedVersionSha256"], ["name", "invocation", "availableTools", "expectedVersionSha256"]);
    const name = text(r.name, 64); if (!NAME.test(name)) bad();
    const invocation = r.invocation; if (invocation !== "model" && invocation !== "user") bad();
    const expected = r.expectedVersionSha256; if (typeof expected !== "string" || !SHA.test(expected)) bad();
    const tools = array(r.availableTools, 256).map(identifier);
    if (new Set(tools).size !== tools.length) bad();
    return this.operation(selected.owner, signal, async check => {
      const skill = (await this.catalog(selected.mounts, check)).find(skill => skill.name === name);
      if (!skill || (invocation === "model" && skill.disableModelInvocation) || (invocation === "user" && !skill.userInvocable)) missing();
      if (skill.versionSha256 !== expected || skill.dependencies.tools.some(tool => !tools.includes(tool))) bad();
      return skill;
    });
  }

  private async catalog(mounts: readonly StaticSkillMount[], check: () => Promise<void>): Promise<LoadedStaticSkill[]> {
    const loaded: LoadedStaticSkill[] = [], names = new Set<string>(); let total = 0;
    for (const mount of mounts) {
      const skill = await this.read(mount, check);
      if (names.has(skill.name)) bad(); names.add(skill.name);
      total += Buffer.byteLength(JSON.stringify({ ...skill, body: undefined }));
      if (total > MAX_CATALOG_BYTES) bad(); loaded.push(skill);
    }
    return loaded.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  private async read(mount: StaticSkillMount, check: () => Promise<void>): Promise<LoadedStaticSkill> {
    const walk = async () => {
      let current = parse(mount.directory).root;
      for (const segment of mount.directory.slice(current.length).split(sep)) {
        await check(); current = join(current, segment);
        const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) bad();
      }
    };
    await walk(); await check();
    const file = join(mount.directory, "SKILL.md");
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE) bad();
    await check();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const initial = await handle.stat();
      if (!initial.isFile() || initial.dev !== before.dev || initial.ino !== before.ino || initial.size > MAX_FILE) bad();
      const chunks: Buffer[] = []; let size = 0;
      for (;;) {
        await check(); const chunk = Buffer.alloc(Math.min(8192, MAX_FILE + 1 - size));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead)); size += bytesRead; if (size > MAX_FILE) bad();
      }
      await check(); await walk();
      const after = await handle.stat(), named = await lstat(file);
      if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || await realpath(file) !== file
        || after.dev !== initial.dev || after.ino !== initial.ino || after.size !== size || after.size !== initial.size
        || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs
        || named.dev !== initial.dev || named.ino !== initial.ino) bad();
      await check(); return document(Buffer.concat(chunks, size), mount);
    } finally { await handle.close(); }
  }

  private async operation<T>(owner: Readonly<Principal>, caller: AbortSignal, work: (check: () => Promise<void>) => Promise<T>): Promise<T> {
    if (this.closed || caller.aborted) unavailable();
    const key = ownerKey(owner), active = this.users.get(key) ?? 0;
    if (active >= this.maximum) unavailable();
    let lease: ReturnType<TenantRuntimeCoordinator["enter"]> | undefined;
    try { lease = this.runtime?.enter(owner.tenantId, "provider"); } catch { return unavailable(); }
    const abort = new AbortController(), signal = AbortSignal.any([caller, abort.signal, ...(lease ? [lease.signal] : [])]);
    const until = performance.now() + this.timeout;
    const timer = setTimeout(() => abort.abort(), this.timeout);
    let finish!: () => void;
    const operation = { abort, done: new Promise<void>(resolve => { finish = resolve; }) };
    this.pending.add(operation); this.users.set(key, active + 1);
    const check = async () => {
      if (this.closed || signal.aborted || performance.now() >= until) unavailable(); lease?.assertOpen();
    };
    try {
      await check(); await this.authorize?.(owner); await check();
      const result = await work(check);
      await check(); await this.authorize?.(owner); await check(); return result;
    }
    catch (error) {
      if (this.closed || signal.aborted || performance.now() >= until) unavailable();
      if (error instanceof ApiError && ((error.code === "invalid_request" && error.message === MESSAGE)
        || (error.code === "not_found" && error.message === "Skill not found.")
        || (error.code === "draining" && error.message === "Skill request unavailable."))) throw error;
      if (error instanceof ApiError && error.code === "subject_deleting") throw new ApiError("subject_deleting", "Skill request unavailable.");
      return bad();
    } finally {
      clearTimeout(timer); lease?.release(); this.pending.delete(operation);
      const count = (this.users.get(key) ?? 1) - 1; if (count) this.users.set(key, count); else this.users.delete(key);
      finish();
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      const pending = [...this.pending]; for (const operation of pending) operation.abort.abort();
      this.closePromise = Promise.all(pending.map(operation => operation.done)).then(() => {});
    }
    return this.closePromise;
  }
}
