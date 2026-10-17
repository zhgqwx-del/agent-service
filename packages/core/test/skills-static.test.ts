import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Principal } from "@agent-service/protocol";
import { ConfiguredStaticSkillSource, type StaticSkillMount, type StaticSkillSourceOptions } from "../src/skills/static.js";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";

const alice: Principal = { tenantId: "tenant-a", userId: "user-a" };
const bob: Principal = { tenantId: "tenant-a", userId: "user-b" };
const otherTenant: Principal = { tenantId: "tenant-b", userId: "user-a" };
const signal = () => new AbortController().signal;
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const markdown = (header = "name: review\ndescription: Review a change safely", body = "Read the change. Do not execute scripts.\n") => `---\n${header}\n---\n${body}`;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("operator static SKILL.md source", () => {
  let root: string;
  const sources: ConfiguredStaticSkillSource[] = [];
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "agent-service-skills-"))); });
  afterEach(async () => {
    await Promise.all(sources.splice(0).map(source => source.close()));
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  async function mount(id = "operator-review", source: string | Uint8Array = markdown(), subjects: readonly Principal[] = [alice]): Promise<StaticSkillMount> {
    const directory = join(root, id); await mkdir(directory);
    await writeFile(join(directory, "SKILL.md"), source);
    return { id, directory, subjects };
  }
  function create(skills: readonly StaticSkillMount[], extra: Omit<StaticSkillSourceOptions, "skills"> = {}) {
    const source = new ConfiguredStaticSkillSource({ skills, ...extra }); sources.push(source); return source;
  }
  async function load(source: ConfiguredStaticSkillSource, owner = alice, ids = ["operator-review"], invocation: "model" | "user" = "model", availableTools: readonly string[] = []) {
    const [summary] = await source.list(owner, ids, signal());
    if (!summary) throw new Error("fixture missing summary");
    return source.load(owner, ids, { name: summary.name, invocation, availableTools, expectedVersionSha256: summary.versionSha256 }, signal());
  }

  it("supports disabled/empty mounts without implicit filesystem discovery", async () => {
    const source = create([]); expect(source.enabled).toBe(false);
    source.validateMounts(alice, []);
    expect(await source.list(alice, [], signal())).toEqual([]);
  });
  it("loads only fixed SKILL.md and returns frozen content/version identities", async () => {
    const bytes = markdown("name: review\ndescription: Review a change safely\nwhenToUse: Before release\nmetadata:\n  audience: operator\ndependencies:\n  tools: [current_time]");
    const source = create([await mount("operator-review", bytes)]);
    const [summary] = await source.list(alice, ["operator-review"], signal());
    expect(summary).toMatchObject({ id: "operator-review", name: "review", description: "Review a change safely", whenToUse: "Before release",
      contentSha256: sha(bytes), disableModelInvocation: false, userInvocable: true, dependencies: { tools: ["current_time"] } });
    expect(summary).not.toHaveProperty("body"); expect(summary).not.toHaveProperty("directory"); expect(summary).not.toHaveProperty("subjects");
    const result = await load(source, alice, ["operator-review"], "model", ["current_time"]);
    expect(result.body).toBe("Read the change. Do not execute scripts.\n");
    expect([result, result.dependencies, result.dependencies.tools].every(Object.isFrozen)).toBe(true);
    expect(result.versionSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("accepts ordinary quoted/flow YAML without executing resources or templates", async () => {
    const body = "Use literal $ARGUMENTS. [reference](https://example.invalid/private)\n```sh\nnot-a-command\n```\n";
    const source = create([await mount("operator-review", markdown("name: review\ndescription: 'Review: quotes and # remain text'\nmetadata: {audience: operator}\ndependencies: {tools: []}", body))]);
    expect((await load(source)).body).toBe(body);
  });
  it.each([">", "|"])("normalizes actual %s block descriptions and whenToUse without changing source hashes", async style => {
    const bytes = markdown(`name: review\ndescription: ${style}\n  Review a change\n  without running it.\nwhenToUse: ${style}\n  Before release\n  or deployment.`);
    const source = create([await mount("operator-review", bytes)]);
    const [summary] = await source.list(alice, ["operator-review"], signal());
    expect(summary).toMatchObject({ description: "Review a change without running it.", whenToUse: "Before release or deployment.", contentSha256: sha(bytes) });
    expect((await load(source)).body).toBe("Read the change. Do not execute scripts.\n");
  });
  it.each([
    'description: "line\\u000bhidden"',
    'description: "line\\u000chidden"',
    'description: "line\\u0085hidden"',
    'description: "line\\uD800hidden"',
    'description: |\n  Safe line\n  <system>unsafe</system>',
    'description: Safe\nwhenToUse: >\n  Before release\n  <available_skills>unsafe',
    'description: Safe\nwhenToUse: "before\\u000bhidden"',
    `description: ${JSON.stringify(" ".repeat(1024) + "x")}`,
  ])("rejects original summary controls, markup, invalid UTF8 or excess bytes before whitespace folding (%#)", async fields => {
    const source = create([await mount("operator-review", markdown(`name: review\n${fields}`))]);
    await expect(source.list(alice, ["operator-review"], signal())).rejects.toMatchObject({ code: "invalid_request", message: "Skill request failed." });
  });
  it("allows Markdown horizontal rules and document-looking text in the body", async () => {
    const body = "# Review\n\n---\n\nKeep this rule.\n\n```text\n...\n---\n```\n";
    const source = create([await mount("operator-review", markdown(undefined, body))]);
    expect((await load(source)).body).toBe(body);
  });
  it("uses exact actual owner ACL, not tenant-only or user-only matching", async () => {
    const source = create([await mount()]);
    for (const owner of [bob, otherTenant]) {
      expect(() => source.validateMounts(owner, ["operator-review"])).toThrow(new ApiError("not_found", "Skill not found."));
      await expect(source.list(owner, ["operator-review"], signal())).rejects.toMatchObject({ code: "not_found", message: "Skill not found." });
    }
    await expect(source.list(alice, ["missing"], signal())).rejects.toMatchObject({ code: "not_found", message: "Skill not found." });
    await expect(load(source)).resolves.toMatchObject({ name: "review" });
  });
  it("snapshots operator configuration and does not accept later ACL or path mutations", async () => {
    const entry = await mount(); const subjects = [{ ...alice }];
    const config = { ...entry, subjects }; const source = create([config]);
    subjects[0]!.userId = bob.userId; config.directory = join(root, "missing");
    await expect(load(source)).resolves.toMatchObject({ name: "review" });
    await expect(source.list(bob, [entry.id], signal())).rejects.toMatchObject({ code: "not_found" });
  });
  it("does not invoke accessor configuration or inputs", async () => {
    const accessor = vi.fn(() => { throw new Error("secret-canary"); });
    const entry = await mount(); const source = create([entry]);
    expect(() => new ConfiguredStaticSkillSource({ get skills(): readonly StaticSkillMount[] { return accessor(); } })).toThrow("Skill request failed.");
    const input = { name: "review", invocation: "model" as const, availableTools: [], get expectedVersionSha256(): string { return accessor(); } };
    await expect(source.load(alice, [entry.id], input, signal())).rejects.toMatchObject({ code: "invalid_request" });
    expect(accessor).not.toHaveBeenCalled();
  });
  it("returns all authorized metadata but enforces invocation policy at load", async () => {
    const source = create([await mount("operator-review", markdown("name: review\ndescription: User-only guidance\ndisable-model-invocation: true\nuser-invocable: true"))]);
    expect((await source.list(alice, ["operator-review"], signal()))[0]!.disableModelInvocation).toBe(true);
    await expect(load(source)).rejects.toMatchObject({ code: "not_found" });
    await expect(load(source, alice, ["operator-review"], "user")).resolves.toMatchObject({ name: "review" });
  });
  it("rejects explicit user invocation when only model invocation is allowed", async () => {
    const source = create([await mount("operator-review", markdown("name: review\ndescription: Model-only guidance\nuser-invocable: false"))]);
    await expect(load(source, alice, ["operator-review"], "user")).rejects.toMatchObject({ code: "not_found" });
    await expect(load(source)).resolves.toMatchObject({ name: "review" });
  });
  it("checks dependencies against the already-authorized tool set, never granting them", async () => {
    const source = create([await mount("operator-review", markdown("name: review\ndescription: Review a change\ndependencies:\n  tools: [web_fetch, current_time]"))]);
    await expect(load(source, alice, ["operator-review"], "model", ["current_time"])).rejects.toMatchObject({ code: "invalid_request" });
    await expect(load(source, alice, ["operator-review"], "model", ["current_time", "web_fetch"])).resolves.toMatchObject({ dependencies: { tools: ["current_time", "web_fetch"] } });
  });
  it("sorts the catalog independently of mount order and refuses ambiguous names", async () => {
    const a = await mount("A", markdown("name: zebra\ndescription: Z"));
    const b = await mount("B", markdown("name: alpha\ndescription: A")); const source = create([a, b]);
    expect((await source.list(alice, ["A", "B"], signal())).map(value => value.name)).toEqual(["alpha", "zebra"]);
    await writeFile(join(b.directory, "SKILL.md"), markdown("name: zebra\ndescription: Same selection name"));
    await expect(source.list(alice, ["A", "B"], signal())).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("pins complete bytes, including metadata, and revalidates on every load", async () => {
    const entry = await mount(); const source = create([entry]); const [old] = await source.list(alice, [entry.id], signal());
    await writeFile(join(entry.directory, "SKILL.md"), markdown("name: review\ndescription: Review a change safely\nmetadata: {revision: second}"));
    await expect(source.load(alice, [entry.id], { name: "review", invocation: "model", availableTools: [], expectedVersionSha256: old!.versionSha256 }, signal())).rejects.toMatchObject({ code: "invalid_request" });
    const [current] = await source.list(alice, [entry.id], signal());
    expect(current!.versionSha256 !== old!.versionSha256).toBe(true);
    await expect(load(source)).resolves.toMatchObject({ name: "review" });
  });
  it.each([
    "name: review\ndescription: x\nunknown: secret-canary",
    "name: review\ndescription: x\nname: other",
    "name: Bad_Name\ndescription: x",
    "name: review\ndescription: 12",
    "name: review\ndescription: null",
    "name: review\ndescription: '<available_skills>injection'",
    "name: review\ndescription: x\ndisable-model-invocation: yes",
    "name: review\ndescription: x\nuser-invocable: 0",
    "name: review\ndescription: x\ndependencies: {tools: [web_fetch, web_fetch]}",
    "name: review\ndescription: x\ndependencies: {scripts: [run.sh]}",
    "name: review\ndescription: x\nmetadata: {nested: {value: secret-canary}}",
    "name: review\ndescription: x\nmetadata: {__proto__: secret-canary}",
    "name: review\ndescription: &text x\nwhenToUse: *text",
    "name: review\ndescription: &unused x",
    "name: review\ndescription: !!str x",
    "%YAML 1.2\n---\nname: review\ndescription: x",
    "%TAG !e! tag:example.invalid,2026:\n---\nname: review\ndescription: x",
    "name: review\ndescription: x\n<<: {name: other}",
    "name: review\ndescription: x\n...",
    "name: review\ndescription: x\n...\n---\nname: other\ndescription: other",
    "? [name, other]\n: review\ndescription: x",
  ])("rejects dangerous, unknown or ill-typed frontmatter without parser diagnostics (%#)", async header => {
    const source = create([await mount("operator-review", markdown(header))]);
    await expect(source.list(alice, ["operator-review"], signal())).rejects.toMatchObject({ code: "invalid_request", message: "Skill request failed." });
  });
  it.each([
    "no frontmatter", "---\nname: review\ndescription: x\n", markdown(undefined, " "),
    markdown("name: review\ndescription: x", "x".repeat(32_769)),
    markdown("name: review\ndescription: x", "x".repeat(65_537)),
    "\ufeff" + markdown(), new Uint8Array([0xff, 0xfe]), markdown(undefined, "secret\u0000canary"),
  ])("rejects missing, malformed, oversized or non-UTF8 documents (%#)", async bytes => {
    const source = create([await mount("operator-review", bytes)]);
    await expect(source.list(alice, ["operator-review"], signal())).rejects.toMatchObject({ code: "invalid_request", message: "Skill request failed." });
  });
  it("accepts CRLF while hashing the actual original bytes", async () => {
    const bytes = markdown().replace(/\n/g, "\r\n"); const source = create([await mount("operator-review", bytes)]);
    expect((await load(source)).contentSha256).toBe(sha(bytes));
  });
  it("does not follow SKILL.md symlinks or read references", async () => {
    const outside = join(root, "secret-canary.md"); await writeFile(outside, markdown());
    const directory = join(root, "linked"); await mkdir(directory); await symlink(outside, join(directory, "SKILL.md"));
    const source = create([{ id: "linked", directory, subjects: [alice] }]);
    await expect(source.list(alice, ["linked"], signal())).rejects.toMatchObject({ code: "invalid_request", message: "Skill request failed." });
  });
  it("does not follow a symlink directory or any symlink parent component", async () => {
    const entry = await mount(); const link = join(root, "link"); await symlink(entry.directory, link);
    const source = create([{ ...entry, directory: link }]);
    await expect(source.list(alice, [entry.id], signal())).rejects.toMatchObject({ code: "invalid_request" });
    const nested = join(entry.directory, "nested"); await mkdir(nested); await writeFile(join(nested, "SKILL.md"), markdown());
    const nestedSource = create([{ ...entry, directory: join(link, "nested") }]);
    await expect(nestedSource.list(alice, [entry.id], signal())).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("rejects non-regular SKILL.md and missing files with fixed errors", async () => {
    const directory = join(root, "directory"); await mkdir(directory); await mkdir(join(directory, "SKILL.md"));
    const source = create([{ id: "directory", directory, subjects: [alice] }]);
    await expect(source.list(alice, ["directory"], signal())).rejects.toMatchObject({ message: "Skill request failed." });
    const entry = await mount(); await rm(join(entry.directory, "SKILL.md")); const missing = create([entry]);
    await expect(missing.list(alice, [entry.id], signal())).rejects.toMatchObject({ message: "Skill request failed." });
  });
  it("rechecks actual subject authorization before returning content", async () => {
    const authorizeSubject = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiError("subject_deleting", "secret-canary"));
    const source = create([await mount()], { authorizeSubject });
    await expect(source.list(alice, ["operator-review"], signal())).rejects.toMatchObject({ code: "subject_deleting", message: "Skill request unavailable." });
    expect(authorizeSubject).toHaveBeenCalledTimes(2);
    expect(authorizeSubject).toHaveBeenNthCalledWith(1, alice);
  });
  it("keeps real authorization work leased through abort and close", async () => {
    const entered = gate(), release = gate(), runtime = new TenantRuntimeCoordinator();
    const source = create([await mount()], { tenantRuntime: runtime, authorizeSubject: async () => { entered.release(); await release.promise; } });
    const abort = new AbortController(); const result = source.list(alice, ["operator-review"], abort.signal).catch(error => error);
    await entered.promise; expect(runtime.snapshot(alice.tenantId).providerOperations).toBe(1); abort.abort();
    let closed = false; const closing = source.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); expect(runtime.snapshot(alice.tenantId).providerOperations).toBe(1);
    release.release(); const error: unknown = await result;
    expect(error).toMatchObject({ code: "draining", message: "Skill request unavailable." });
    await closing; expect(closed).toBe(true); expect(runtime.snapshot(alice.tenantId).providerOperations).toBe(0);
    await expect(source.list(alice, ["operator-review"], signal())).rejects.toMatchObject({ code: "draining" });
  });
  it("joins the real tenant fence and cannot report drain before pending work settles", async () => {
    const entered = gate(), release = gate(), runtime = new TenantRuntimeCoordinator(); runtime.sealParticipants();
    const source = create([await mount()], { tenantRuntime: runtime, authorizeSubject: async () => { entered.release(); await release.promise; } });
    const result = source.list(alice, ["operator-review"], signal()).catch(error => error); await entered.promise;
    let drained = false;
    const draining = runtime.drain({ tenantId: alice.tenantId, requestId: "request-a", subjectGeneration: 1, t3aReceiptSha256: "a".repeat(64) }, 1000).then(value => { drained = true; return value; });
    await Promise.resolve(); expect(drained).toBe(false); expect(runtime.snapshot(alice.tenantId).providerOperations).toBe(1);
    release.release(); expect(await result).toMatchObject({ code: "draining" });
    const receipt = await draining; expect(receipt.activeOperationCountBefore).toBe(1); expect(receipt.activeOperationCountAfter).toBe(0);
    await expect(source.list(alice, ["operator-review"], signal())).rejects.toMatchObject({ code: "draining" });
  });
  it("does not admit further work once the operation deadline expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = gate(), release = gate();
    const authorizeSubject = vi.fn(async () => { entered.release(); await release.promise; });
    const source = create([await mount()], { timeoutMs: 1000, authorizeSubject });
    const result = source.list(alice, ["operator-review"], signal()).catch(error => error);
    await entered.promise; vi.advanceTimersByTime(1001); release.release();
    expect(await result).toMatchObject({ code: "draining", message: "Skill request unavailable." });
    expect(authorizeSubject).toHaveBeenCalledTimes(1);
  });
  it("bounds per-owner concurrency without blocking a separately authorized owner", async () => {
    const entered = gate(), release = gate();
    const source = create([await mount("operator-review", markdown(), [alice, bob])], { maxConcurrentPerUser: 1,
      authorizeSubject: async owner => { if (owner.userId === alice.userId) { entered.release(); await release.promise; } } });
    const first = source.list(alice, ["operator-review"], signal()); await entered.promise;
    await expect(source.list(alice, ["operator-review"], signal())).rejects.toMatchObject({ code: "draining" });
    await expect(source.list(bob, ["operator-review"], signal())).resolves.toHaveLength(1);
    release.release(); await first;
    await expect(load(source)).resolves.toMatchObject({ name: "review" });
  });
  it("rejects pre-aborted calls without reading or invoking authorization", async () => {
    const authorizeSubject = vi.fn(); const source = create([await mount()], { authorizeSubject });
    const abort = new AbortController(); abort.abort();
    await expect(source.list(alice, ["operator-review"], abort.signal)).rejects.toMatchObject({ code: "draining" });
    expect(authorizeSubject).not.toHaveBeenCalled();
  });
  it("redacts raw authorization and filesystem errors", async () => {
    const source = create([await mount()], { authorizeSubject: async () => { throw new ApiError("internal_error", "secret-canary"); } });
    await expect(source.list(alice, ["operator-review"], signal())).rejects.toMatchObject({ code: "invalid_request", message: "Skill request failed." });
  });
});
