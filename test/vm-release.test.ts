import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

type Role = "agent-router" | "agent-runner";
type NativeArch = "x64" | "arm64";
type NativeFormat = "elf64" | "macho64";
type FileEntry = { path: string; kind: "file"; sha256: string; size: number; mode: string }
  | { path: string; kind: "file"; sha256: string; size: number; mode: string;
      nativeFormat: "elf64" | "macho64"; nativeArch: "x64" | "arm64" }
  | { path: string; kind: "directory"; sha256: string; size: 0; mode: string }
  | { path: string; kind: "symlink"; target: string; sha256: string; size: number; mode: string };
interface Manifest {
  schema: string; role: Role; releaseKind: string; productionAccepted: false; publishable: boolean;
  targetRuntime: { nodeMajor: 24; platform: string; arch: string };
  source: { sourceCommit: string; sourceDirty: boolean; lockSha256: string; inputSha256: string;
    inputFiles: { path: string; sha256: string; size: number }[]; packageManager: string;
    buildRuntime: { node: string; platform: string; arch: string } };
  build: { bundler: string; installContract: string; dependencyClosure: string; entrypoints: string[]; migrationCount: number };
  files: FileEntry[];
}
interface ReleaseApi {
  VM_RELEASE_ROLES: readonly Role[];
  VM_RELEASE_ENTRYPOINTS: Readonly<Record<Role, readonly string[]>>;
  assertVmReleaseRole(role: unknown): Role;
  vmReleaseModeHasSpecialBits(mode: unknown): boolean;
  sha256File(path: string): Promise<string>;
  inventoryVmReleasePayload(root: string, options?: { excludeManifest?: boolean }): Promise<FileEntry[]>;
  validateVmReleasePayload(root: string, role: unknown, options?: { sealed?: boolean }): Promise<FileEntry[]>;
  verifyVmReleaseDirectory(root: string, role: unknown, trustedExpectedManifestSha256?: unknown): Promise<Manifest>;
}
interface BuilderApi {
  parseVmReleaseArgs(args: readonly string[]): { role: Role; output: string; allowDirtyDevelopment: boolean };
  buildVmRelease(input: { role: Role; output: string; allowDirtyDevelopment?: boolean }):
    Promise<{ output: string; role: Role; fileCount: number; publishable: boolean; manifestSha256: string }>;
  captureVmReleaseWorkingInputs(sourceRoot: string, snapshotRoot: string):
    Promise<{ inputSha256: string; inputFiles: { path: string; sha256: string; size: number }[] }>;
}
let release: ReleaseApi;
let builder: BuilderApi;
const ownedRoots = new Set<string>();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const runLocal = promisify(execFile);

beforeAll(async () => {
  // Dynamic URL imports keep untyped repository .mjs modules behind an explicit unknown boundary.
  const releaseModule: unknown = await import(new URL("../scripts/lib/vm-release.mjs", import.meta.url).href);
  const builderModule: unknown = await import(new URL("../scripts/package-vm-release.mjs", import.meta.url).href);
  release = releaseModule as ReleaseApi;
  builder = builderModule as BuilderApi;
});
afterEach(async () => {
  for (const root of ownedRoots) {
    // Every recursive target is the exact path returned by this test's mkdtemp, never a checkout.
    await rm(root, { recursive: true, force: true });
    ownedRoots.delete(root);
  }
});

async function tempRoot() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agent-service-vm-release-test-"));
  ownedRoots.add(root); return root;
}
/** Complete bounded synthetic headers/segment tables, never executed or claimed as vendor proof. */
function elf64(arch: NativeArch, shared = false) {
  const bytes = Buffer.alloc(121);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(shared ? 3 : 2, 16); bytes.writeUInt16LE(arch === "x64" ? 62 : 183, 18);
  bytes.writeUInt32LE(1, 20); bytes.writeBigUInt64LE(0x1000n, 24); bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeUInt32LE(5, 68);
  bytes.writeBigUInt64LE(120n, 72); bytes.writeBigUInt64LE(0x1000n, 80); bytes.writeBigUInt64LE(0x1000n, 88);
  bytes.writeBigUInt64LE(1n, 96); bytes.writeBigUInt64LE(1n, 104); bytes.writeBigUInt64LE(0x1000n, 112);
  bytes[120] = 0x90; return bytes;
}
function macho64(arch: NativeArch, shared = false) {
  const bytes = Buffer.alloc(105);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);
  bytes.writeUInt32LE(arch === "x64" ? 3 : 0, 8); bytes.writeUInt32LE(shared ? 6 : 2, 12);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(72, 20);
  bytes.writeUInt32LE(0x19, 32); bytes.writeUInt32LE(72, 36); bytes.write("__TEXT", 40, "ascii");
  bytes.writeBigUInt64LE(0x1000n, 56); bytes.writeBigUInt64LE(0x1000n, 64);
  bytes.writeBigUInt64LE(104n, 72); bytes.writeBigUInt64LE(1n, 80);
  bytes.writeUInt32LE(7, 88); bytes.writeUInt32LE(5, 92); bytes[104] = 0x90; return bytes;
}
const hostArch = (): NativeArch => process.arch === "arm64" ? "arm64" : "x64";
const hostFormat = (): NativeFormat => process.platform === "linux" ? "elf64" : "macho64";
const nativeBytes = (format: NativeFormat, arch: NativeArch, shared = false) =>
  format === "elf64" ? elf64(arch, shared) : macho64(arch, shared);
async function payload(role: Role, withLink = false) {
  const root = await tempRoot();
  await mkdir(join(root, "dist", "migrations"), { recursive: true });
  await mkdir(join(root, "node_modules", "fixture-package"), { recursive: true });
  await chmod(join(root, "node_modules", "fixture-package"), 0o755);
  await mkdir(join(root, "service"));
  await writeFile(join(root, "dist", "package.json"), '{"type":"module"}\n');
  for (const entrypoint of release.VM_RELEASE_ENTRYPOINTS[role]) {
    await writeFile(join(root, "dist", entrypoint), "export const localFixture = true;\n");
    await writeFile(join(root, "dist", `${entrypoint}.map`), '{}\n');
  }
  await writeFile(join(root, "dist", "migrations", "0001_fixture.sql"), "SELECT 1;\n");
  await writeFile(join(root, "dist", "migrations", "0002_fixture.sql"), "SELECT 2;\n");
  await writeFile(join(root, "node_modules", "fixture-package", "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "node_modules", "fixture-package", "index.js"), "export {};\n");
  await chmod(join(root, "node_modules", "fixture-package", "index.js"), 0o644);
  await writeFile(join(root, "service", `${role}.service.template`), "[Service]\nExecStart=/usr/bin/node fixture\n");
  if (withLink) await symlink("fixture-package", join(root, "node_modules", "fixture-alias"));
  return root;
}
async function seal(root: string, role: Role, sourceDirty = false) {
  const inputFiles = [{ path: "pnpm-lock.yaml", sha256: sha("unit-lock"), size: 9 }];
  // Pure provenance-shape fixture. The supplied digest is a unit trust channel, not a signed real build.
  const manifest: Manifest = { schema: "agent-service-vm-release-v1", role,
    releaseKind: "node24-platform-process-directory", productionAccepted: false, publishable: !sourceDirty,
    targetRuntime: { nodeMajor: 24, platform: process.platform, arch: process.arch },
    source: { sourceCommit: "a".repeat(40), sourceDirty, lockSha256: sha("unit-lock"),
      inputSha256: sha(JSON.stringify(inputFiles)), inputFiles, packageManager: "pnpm@12.5.1",
      buildRuntime: { node: process.versions.node, platform: process.platform, arch: process.arch } },
    build: { bundler: "scripts/build-app.mjs", installContract: "pnpm install --offline --frozen-lockfile --ignore-scripts",
      dependencyClosure: `pnpm --filter ./apps/${role} --prod --offline --ignore-scripts --trust-lockfile --frozen-lockfile deploy`,
      entrypoints: release.VM_RELEASE_ENTRYPOINTS[role].map((name) => `dist/${name}`), migrationCount: 2 },
    files: await release.validateVmReleasePayload(root, role) };
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(root, "release-manifest.json"), bytes);
  await chmod(join(root, "release-manifest.json"), 0o644);
  return { root, role, manifest, trustedDigest: sha(bytes) };
}
function setField(value: unknown, path: readonly string[], replacement: unknown) {
  let cursor: unknown = value;
  for (const key of path.slice(0, -1)) {
    if (cursor === null || typeof cursor !== "object") throw new Error("invalid fixture object path");
    cursor = (cursor as Record<string, unknown>)[key];
  }
  if (cursor === null || typeof cursor !== "object") throw new Error("invalid fixture object path");
  (cursor as Record<string, unknown>)[path[path.length - 1]!] = replacement;
}
const snapshotRootInputs = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "tsconfig.json",
  "Dockerfile", ".dockerignore", "scripts/build-app.mjs", "scripts/package-vm-release.mjs", "scripts/lib/vm-release.mjs",
  "scripts/lib/bundled-dependency-policy.mjs",
  "scripts/vm-release-tool.mjs", "scripts/package-vm-transport.mjs", "scripts/lib/vm-release-archive.mjs",
  "scripts/lib/vm-release-signature.mjs", "scripts/lib/vm-release-signed.mjs",
  "deploy/vm/agent-runner.service.template", "deploy/vm/agent-router.service.template"] as const;
async function snapshotFixture() {
  const sourceRoot = await tempRoot(), snapshotRoot = await tempRoot();
  const paths = [...snapshotRootInputs, "apps/agent-runner/package.json", "apps/agent-runner/src/main.ts",
    "apps/agent-router/package.json", "apps/agent-router/src/main.ts", "packages/fixture/package.json", "packages/fixture/src/index.ts"];
  for (const path of paths) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), `unit-input:${path}\n`);
  }
  return { sourceRoot, snapshotRoot, paths: paths.sort() };
}
async function rewrite(f: Awaited<ReturnType<typeof seal>>, change: (manifest: Manifest) => void) {
  const manifest = structuredClone(f.manifest); change(manifest);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(f.root, "release-manifest.json"), bytes);
  return { manifest, digest: sha(bytes) };
}

describe("closed VM process release contract", () => {
  it("deterministically rejects every special mode bit and combination independently of host chmod behavior", () => {
    for (const ordinary of [0, 0o644, 0o755, 0o100644, 0o40755]) {
      expect(release.vmReleaseModeHasSpecialBits(ordinary)).toBe(false);
      for (const special of [0o1000, 0o2000, 0o3000, 0o4000, 0o5000, 0o6000, 0o7000]) {
        expect(release.vmReleaseModeHasSpecialBits(ordinary | special)).toBe(true);
      }
    }
    for (const invalid of [-1, 1.5, NaN, Infinity, 0x1_0000_0000, "2048", [0o2000], null, undefined, 1n]) {
      expect(() => release.vmReleaseModeHasSpecialBits(invalid)).toThrow();
    }
  });

  it("defines exactly two roles, router one and runner five JavaScript entrypoints", () => {
    expect(release.VM_RELEASE_ROLES).toEqual(["agent-router", "agent-runner"]);
    expect(release.VM_RELEASE_ENTRYPOINTS["agent-router"]).toEqual(["main.js"]);
    expect(release.VM_RELEASE_ENTRYPOINTS["agent-runner"]).toEqual([
      "main.js", "blob-storage-migrate.js", "restore-ledger-reconcile.js", "backup-catalog.js", "telemetry-capture.js",
    ]);
    for (const role of ["runner", "router", "agent-runner ", "AGENT-ROUTER", "", null, undefined, 1, true,
      { toString: () => "agent-router" }]) {
      expect(() => release.assertVmReleaseRole(role)).toThrow();
    }
  });

  it.each(["agent-router", "agent-runner"] as const)("parses the exact %s CLI once and keeps its boolean explicit", (role) => {
    expect(builder.parseVmReleaseArgs(["--role", role, "--output", "/tmp/unit-vm-release"]))
      .toEqual({ role, output: "/tmp/unit-vm-release", allowDirtyDevelopment: false });
    expect(builder.parseVmReleaseArgs(["--allow-dirty-development", "--output", "/tmp/unit-vm-release", "--role", role]))
      .toEqual({ role, output: "/tmp/unit-vm-release", allowDirtyDevelopment: true });
  });

  it.each([
    ["--role", "agent-router", "--role", "agent-router", "--output", "/tmp/unit-vm-release"],
    ["--role", "", "--role", "agent-router", "--output", "/tmp/unit-vm-release"],
    ["--role", "agent-router", "--output", "", "--output", "/tmp/unit-vm-release"],
    ["--role", "agent-router", "--output", "/tmp/unit-vm-release", "--output", "/tmp/second"],
    ["--role", "agent-router", "--output", "/tmp/unit-vm-release", "--allow-dirty-development", "--allow-dirty-development"],
    ["--role", "agent-router", "--output", "/tmp/unit-vm-release", "--allow-dirty-development=false"],
    ["--role", "agent-router", "--output", "/tmp/unit-vm-release", "--allow-dirty-development", "false"],
    ["--role", "agent-router", "--output", "relative/path"],
    ["--role", "agent-router", "--output"], ["--output", "/tmp/unit-vm-release"],
    ["--role", "agent-runner", "--output", "/tmp/unit-vm-release", "--unknown"],
  ])("rejects duplicate/empty/missing/unknown CLI arguments (%j)", (...args: string[]) => {
    expect(() => builder.parseVmReleaseArgs(args)).toThrow();
  });

  it.each(["agent-router", "agent-runner"] as const)("verifies a complete sealed %s payload without running an application", async (role) => {
    const f = await seal(await payload(role, true), role);
    expect(await release.verifyVmReleaseDirectory(f.root, role, f.trustedDigest)).toEqual(f.manifest);
    expect(await release.sha256File(join(f.root, "release-manifest.json"))).toBe(f.trustedDigest);
    const inventory = await release.inventoryVmReleasePayload(f.root, { excludeManifest: true });
    expect(inventory).toEqual(f.manifest.files);
    expect(inventory.find((entry) => entry.path === ".")).toMatchObject({ kind: "directory", sha256: sha(""), size: 0, mode: "0700" });
    expect(inventory.filter((entry) => entry.kind === "directory").map((entry) => entry.path)).toEqual([
      ".", "dist", "dist/migrations", "node_modules", "node_modules/fixture-package", "service",
    ]);
    expect(inventory.some((entry) => entry.path === "release-manifest.json")).toBe(false);
    expect(inventory.find((entry) => entry.path === "node_modules/fixture-alias")).toMatchObject({
      kind: "symlink", target: "fixture-package", sha256: sha("fixture-package"), size: Buffer.byteLength("fixture-package"),
    });
    expect(f.manifest.productionAccepted).toBe(false);
  });

  it("inventories every nested file/link deterministically independent of filesystem creation order", async () => {
    const root = await payload("agent-router");
    await mkdir(join(root, "node_modules", "nested"));
    for (const name of ["z.js", "a.js", "m.js"]) await writeFile(join(root, "node_modules", "nested", name), name);
    await symlink("nested/a.js", join(root, "node_modules", "file-alias"));
    const first = await release.inventoryVmReleasePayload(root);
    const second = await release.inventoryVmReleasePayload(root);
    expect(second).toEqual(first);
    expect(first.map((entry) => entry.path)).toEqual(first.map((entry) => entry.path).sort((a, b) => a.localeCompare(b, "en")));
    expect(first.filter((entry) => entry.path.startsWith("node_modules/nested/"))).toHaveLength(3);
    expect(first.find((entry) => entry.path === "node_modules/file-alias")).toMatchObject({ kind: "symlink", target: "nested/a.js" });
  });

  it.each(["bytes", "size", "mode", "extra", "missing", "symlink-target"] as const)("rejects %s drift against the original trusted manifest", async (drift) => {
    const f = await seal(await payload("agent-router", true), "agent-router");
    const file = join(f.root, "node_modules", "fixture-package", "index.js");
    if (drift === "bytes") await writeFile(file, "export {};\r");
    if (drift === "size") await writeFile(file, "export const larger = true;\n");
    if (drift === "mode") await chmod(file, 0o600);
    if (drift === "extra") await writeFile(join(f.root, "node_modules", "unlisted.js"), "export {};\n");
    if (drift === "missing") await rm(file);
    if (drift === "symlink-target") {
      await rm(join(f.root, "node_modules", "fixture-alias"));
      await symlink("fixture-package/index.js", join(f.root, "node_modules", "fixture-alias"));
    }
    await expect(release.verifyVmReleaseDirectory(f.root, f.role, f.trustedDigest)).rejects.toThrow();
  });

  it.each(["root", "nested"] as const)("rejects ordinary %s directory permission drift against the trusted manifest", async (kind) => {
    const f = await seal(await payload("agent-router"), "agent-router");
    const path = kind === "root" ? f.root : join(f.root, "node_modules", "fixture-package");
    await chmod(path, kind === "root" ? 0o750 : 0o700);
    await expect(release.verifyVmReleaseDirectory(f.root, f.role, f.trustedDigest)).rejects.toThrow("complete manifest inventory");
  });

  it.each([
    ["file", 0o4000], ["file", 0o2000], ["file", 0o1000],
    ["directory", 0o4000], ["directory", 0o2000], ["directory", 0o1000],
    ["root", 0o4000], ["root", 0o2000], ["root", 0o1000],
  ] as const)("rejects host-retained privileged %s permission bit %i and recognizes a host-cleared bit", async (kind, bit) => {
    const root = await payload("agent-router");
    const path = kind === "root" ? root : kind === "directory" ? join(root, "node_modules", "fixture-package")
      : join(root, "node_modules", "fixture-package", "index.js");
    const ordinaryMode = kind === "file" ? 0o644 : 0o755;
    await chmod(path, bit | ordinaryMode);
    const observed = (await lstat(path)).mode;
    expect(observed & 0o777).toBe(ordinaryMode);
    if ((observed & 0o7000) === bit) {
      await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow("special permission bits");
    } else {
      // Some hosts clear setgid on chmod for an ordinary owner/group. That is not a rejection
      // proof; the pure mode contract above covers this exact bit deterministically.
      expect(observed & 0o7000).toBe(0);
      const inventory = await release.inventoryVmReleasePayload(root);
      expect(inventory.some((entry) => entry.path === (kind === "root" ? "."
        : kind === "directory" ? "node_modules/fixture-package"
          : "node_modules/fixture-package/index.js") && entry.mode === ordinaryMode.toString(8).padStart(4, "0"))).toBe(true);
      await expect(release.validateVmReleasePayload(root, "agent-router")).resolves.toEqual(inventory);
    }
  });

  it.each([0o4000, 0o2000, 0o1000])("rejects host-retained privileged manifest permission bit %i while preserving its independent digest", async (bit) => {
    const f = await seal(await payload("agent-router"), "agent-router");
    const path = join(f.root, "release-manifest.json");
    await chmod(path, 0o644 | bit);
    const observed = (await lstat(path)).mode;
    expect(observed & 0o777).toBe(0o644);
    expect(await release.sha256File(path)).toBe(f.trustedDigest);
    if ((observed & 0o7000) === bit) {
      await expect(release.verifyVmReleaseDirectory(f.root, f.role, f.trustedDigest)).rejects.toThrow("special permission bits");
    } else {
      expect(observed & 0o7000).toBe(0);
      await expect(release.verifyVmReleaseDirectory(f.root, f.role, f.trustedDigest)).resolves.toEqual(f.manifest);
    }
  });

  it("rejects ordinary manifest permission drift independently from the unchanged trusted byte digest", async () => {
    const f = await seal(await payload("agent-router"), "agent-router");
    const path = join(f.root, "release-manifest.json");
    await chmod(path, 0o600);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await release.sha256File(path)).toBe(f.trustedDigest);
    await expect(release.verifyVmReleaseDirectory(f.root, f.role, f.trustedDigest)).rejects.toThrow("mode 0644");
  });

  it.each(["absolute", "windows-absolute", "outside", "dangling", "loop", "indirect-outside"] as const)("rejects %s symlink targets", async (kind) => {
    const root = await payload("agent-router");
    const link = join(root, "node_modules", "unsafe-link");
    const outsideRoot = await tempRoot();
    await writeFile(join(outsideRoot, "outside.js"), "export {};\n");
    if (kind === "absolute") await symlink(join(root, "dist", "main.js"), link);
    if (kind === "windows-absolute") await symlink("C:\\outside\\payload.js", link);
    if (kind === "outside") await symlink(`../../${outsideRoot.split("/").at(-1)!}/outside.js`, link);
    if (kind === "dangling") await symlink("absent.js", link);
    if (kind === "loop") await symlink("unsafe-link", link);
    if (kind === "indirect-outside") {
      await symlink(outsideRoot, join(root, "node_modules", "zzz-absolute-escape"));
      await symlink("zzz-absolute-escape/outside.js", link);
    }
    if (kind === "indirect-outside") await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow("resolves outside");
    else await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow();
  });

  it.each([".env", ".env.local", ".npmrc", "private.pem", "private.key", "id_rsa", "id_ed25519", "credentials",
    "local.sqlite", "native.node", "native.so", "native.dylib", "native.dll", "native.exe"])("rejects forbidden payload name %s", async (name) => {
    const root = await payload("agent-router");
    await writeFile(join(root, "node_modules", name), "synthetic fixture, no credential contents\n");
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow();
  });

  it("inventories and verifies the pinned SDK's credentials code-directory shape without treating it as a secret file", async () => {
    const root = await payload("agent-router");
    const directory = join(root, "node_modules", "@anthropic-ai", "sdk", "lib", "credentials");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.js"), "export const syntheticSdkCode = true;\n");
    const f = await seal(root, "agent-router");
    const path = "node_modules/@anthropic-ai/sdk/lib/credentials";
    expect(f.manifest.files.find((entry) => entry.path === path)).toMatchObject({ kind: "directory", size: 0, sha256: sha("") });
    expect(f.manifest.files.find((entry) => entry.path === `${path}/index.js`)).toMatchObject({ kind: "file" });
    expect(await release.verifyVmReleaseDirectory(root, f.role, f.trustedDigest)).toEqual(f.manifest);
  });

  it("still rejects a nested credentials regular file instead of interpreting it as an SDK code directory", async () => {
    const root = await payload("agent-router");
    const parent = join(root, "node_modules", "@anthropic-ai", "sdk", "lib");
    await mkdir(parent, { recursive: true });
    await writeFile(join(parent, "credentials"), "synthetic forbidden file, no secret contents\n");
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow("credential or database file");
  });

  it("rejects a nested credentials symlink even when it points to a safe existing code file inside the payload", async () => {
    const root = await payload("agent-router");
    const parent = join(root, "node_modules", "@anthropic-ai", "sdk", "lib");
    await mkdir(parent, { recursive: true });
    const path = join(parent, "credentials");
    await symlink("../../../fixture-package/index.js", path);
    expect(await readFile(path, "utf8")).toBe("export {};\n");
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow("credential or database file");
  });

  it.each([".env", "private.key"])("checks every SDK code-directory descendant and rejects %s", async (name) => {
    const root = await payload("agent-router");
    const directory = join(root, "node_modules", "@anthropic-ai", "sdk", "lib", "credentials");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.js"), "export {};\n");
    await writeFile(join(directory, name), "synthetic forbidden descendant, no secret contents\n");
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow();
  });

  it.each([
    ["ELF", [0x7f, 0x45, 0x4c, 0x46]], ["PE", [0x4d, 0x5a, 0, 0]],
    ["MachO32", [0xfe, 0xed, 0xfa, 0xce]], ["MachO64", [0xfe, 0xed, 0xfa, 0xcf]],
    ["MachO32LE", [0xce, 0xfa, 0xed, 0xfe]], ["MachO64LE", [0xcf, 0xfa, 0xed, 0xfe]],
    ["MachOFat", [0xca, 0xfe, 0xba, 0xbe]], ["MachOFatLE", [0xbe, 0xba, 0xfe, 0xca]],
  ] as const)("rejects %s malformed/truncated native headers without relying on a filename extension", async (_label, bytes) => {
    const root = await payload("agent-router");
    await writeFile(join(root, "node_modules", "native-blob"), Buffer.from(bytes));
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow(/native|ELF64|Mach-O64/);
  });

  it.each(["elf64", "macho64"] as const)("accepts complete %s only on its matching current host; the other OS is genuinely rejected", async (format) => {
    const root = await payload("agent-router");
    const path = join(root, "node_modules", "synthetic-native");
    await writeFile(path, nativeBytes(format, hostArch()));
    const matches = process.platform === (format === "elf64" ? "linux" : "darwin");
    if (matches) {
      const f = await seal(root, "agent-router");
      expect(f.manifest.files.find((entry) => entry.path === "node_modules/synthetic-native")).toMatchObject({
        kind: "file", nativeFormat: format, nativeArch: process.arch, sha256: await release.sha256File(path),
      });
      expect(await release.verifyVmReleaseDirectory(root, f.role, f.trustedDigest)).toEqual(f.manifest);
    } else {
      await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow(/ELF64 target|Mach-O64 target/);
    }
  });

  it("rejects a complete current-format native file with the other architecture", async () => {
    const root = await payload("agent-router");
    await writeFile(join(root, "node_modules", "wrong-arch"), nativeBytes(hostFormat(), hostArch() === "x64" ? "arm64" : "x64"));
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow(/header does not match target runtime/);
  });

  it.each(["header-only", "no-load", "out-of-bounds", "table-truncated"] as const)("rejects current-host native %s rather than accepting its valid magic alone", async (kind) => {
    const root = await payload("agent-router");
    const format = hostFormat(); let bytes = nativeBytes(format, hostArch());
    if (kind === "header-only") bytes = bytes.subarray(0, format === "elf64" ? 64 : 32);
    if (kind === "no-load") {
      if (format === "elf64") bytes.writeUInt32LE(0, 64);
      else bytes.writeUInt32LE(1, 32);
    }
    if (kind === "out-of-bounds") bytes.writeBigUInt64LE(10_000n, 72);
    if (kind === "table-truncated") bytes = bytes.subarray(0, format === "elf64" ? 100 : 80);
    await writeFile(join(root, "node_modules", "malformed-complete-header"), bytes);
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow(/ELF64|Mach-O64/);
  });

  it.each(["node", "so", "dylib"])("requires and inventories a complete matching current-host .%s native header", async (extension) => {
    const root = await payload("agent-router");
    const path = `node_modules/synthetic-addon.${extension}`;
    await writeFile(join(root, path), nativeBytes(hostFormat(), hostArch(), true));
    const f = await seal(root, "agent-router");
    expect(f.manifest.files.find((entry) => entry.path === path)).toMatchObject({ nativeFormat: hostFormat(), nativeArch: process.arch });
    expect(await release.verifyVmReleaseDirectory(root, f.role, f.trustedDigest)).toEqual(f.manifest);
  });

  it.each(["node", "so", "dylib"])("rejects a .%s native-module symlink to ordinary safe JS instead of trusting its extension", async (extension) => {
    const root = await payload("agent-router");
    await symlink("fixture-package/index.js", join(root, "node_modules", `synthetic-addon.${extension}`));
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow("native module symlink does not resolve to a matching binary");
  });

  it.each(["exe", "dll"])("still rejects .%s even if its bytes contain a complete matching non-Windows header", async (extension) => {
    const root = await payload("agent-router");
    await writeFile(join(root, "node_modules", `synthetic-native.${extension}`), nativeBytes(hostFormat(), hostArch()));
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow("Windows binary");
  });

  it.each(["format", "arch", "missing-arch", "extra"] as const)("rejects native inventory metadata %s drift after manifest resealing", async (kind) => {
    const root = await payload("agent-router");
    await writeFile(join(root, "node_modules", "synthetic-native"), nativeBytes(hostFormat(), hostArch()));
    const f = await seal(root, "agent-router");
    const changed = await rewrite(f, (manifest) => {
      const entry = manifest.files.find((row) => row.path === "node_modules/synthetic-native");
      if (!entry) throw new Error("native fixture inventory row missing");
      if (kind === "format") setField(entry, ["nativeFormat"], hostFormat() === "elf64" ? "macho64" : "elf64");
      if (kind === "arch") setField(entry, ["nativeArch"], hostArch() === "x64" ? "arm64" : "x64");
      if (kind === "missing-arch") delete (entry as unknown as Record<string, unknown>).nativeArch;
      if (kind === "extra") setField(entry, ["extra"], true);
    });
    await expect(release.verifyVmReleaseDirectory(root, f.role, changed.digest)).rejects.toThrow("file inventory");
  });

  it.each(["platform", "arch"] as const)("rejects a self-consistent source/target %s reassignment away from the execution host", async (field) => {
    const f = await seal(await payload("agent-router"), "agent-router");
    const value = field === "platform" ? process.platform === "linux" ? "darwin" : "linux"
      : hostArch() === "x64" ? "arm64" : "x64";
    const changed = await rewrite(f, (manifest) => {
      manifest.targetRuntime[field] = value; manifest.source.buildRuntime[field] = value;
    });
    await expect(release.verifyVmReleaseDirectory(f.root, f.role, changed.digest)).rejects.toThrow("invalid VM release provenance");
  });

  it("rejects a local FIFO as a special filesystem entry", async () => {
    const root = await payload("agent-router");
    await runLocal("mkfifo", [join(root, "node_modules", "local-fifo")]);
    await expect(release.inventoryVmReleasePayload(root)).rejects.toThrow("unsupported filesystem entry");
  });

  it.each(["extra-top", "missing-main", "empty-main", "extra-dist", "wrong-type-module", "module-extra-field", "bad-migration",
    "migration-directory", "migration-symlink", "service-extra", "service-wrong-role", "top-symlink"] as const)("rejects malformed role payload %s", async (kind) => {
    const root = await payload("agent-router");
    if (kind === "extra-top") await writeFile(join(root, "unexpected.txt"), "fixture");
    if (kind === "missing-main") await rm(join(root, "dist", "main.js"));
    if (kind === "empty-main") await writeFile(join(root, "dist", "main.js"), "");
    if (kind === "extra-dist") await writeFile(join(root, "dist", "backup-catalog.js"), "export {};\n");
    if (kind === "wrong-type-module") await writeFile(join(root, "dist", "package.json"), '{"type":"commonjs"}');
    if (kind === "module-extra-field") await writeFile(join(root, "dist", "package.json"), '{"type":"module","scripts":{}}');
    if (kind === "bad-migration") await writeFile(join(root, "dist", "migrations", "README.md"), "fixture");
    if (kind === "migration-directory") await mkdir(join(root, "dist", "migrations", "0003_directory.sql"));
    if (kind === "migration-symlink") await symlink("0001_fixture.sql", join(root, "dist", "migrations", "0003_alias.sql"));
    if (kind === "service-extra") await writeFile(join(root, "service", "extra.template"), "fixture");
    if (kind === "service-wrong-role") {
      await rm(join(root, "service", "agent-router.service.template"));
      await writeFile(join(root, "service", "agent-runner.service.template"), "fixture");
    }
    if (kind === "top-symlink") {
      const target = await tempRoot();
      await rm(join(root, "service"), { recursive: true });
      await symlink(target, join(root, "service"));
    }
    await expect(release.validateVmReleasePayload(root, "agent-router")).rejects.toThrow();
  });

  it("requires the independent original manifest digest and role; a self-consistent replacement is not authenticated", async () => {
    const f = await seal(await payload("agent-router"), "agent-router");
    for (const digest of [undefined, "", "0".repeat(63), "A".repeat(64), 1]) {
      await expect(release.verifyVmReleaseDirectory(f.root, f.role, digest)).rejects.toThrow("trusted external manifest");
    }
    await expect(release.verifyVmReleaseDirectory(f.root, "agent-runner", f.trustedDigest)).rejects.toThrow();
    await writeFile(join(f.root, "node_modules", "fixture-package", "index.js"), "export const substituted = true;\n");
    const alteredFiles = await release.inventoryVmReleasePayload(f.root, { excludeManifest: true });
    const replacement = await rewrite(f, (manifest) => { manifest.files = alteredFiles; });
    expect(replacement.digest).not.toBe(f.trustedDigest);
    await expect(release.verifyVmReleaseDirectory(f.root, f.role, f.trustedDigest)).rejects.toThrow("trusted external digest");
    // A different independently trusted promotion digest would be different authority; this test
    // deliberately never grants that authority to the attacker's replacement bytes.
  });

  it.each([
    ["dirty-string", ["source", "sourceDirty"], "false"], ["dirty-number", ["source", "sourceDirty"], 0],
    ["dirty-null", ["source", "sourceDirty"], null], ["publishable-mismatch", ["publishable"], false],
    ["production-accepted", ["productionAccepted"], true], ["source-extra", ["source", "extra"], true],
    ["root-extra", ["extra"], true], ["runtime-extra", ["source", "buildRuntime", "extra"], true],
    ["target-extra", ["targetRuntime", "extra"], true],
    ["target-node-major", ["targetRuntime", "nodeMajor"], 22],
    ["target-node-array", ["targetRuntime", "nodeMajor"], [24]],
    ["target-node-string", ["targetRuntime", "nodeMajor"], "24"],
    ["target-platform", ["targetRuntime", "platform"], "unknown"],
    ["target-platform-array", ["targetRuntime", "platform"], [process.platform]],
    ["target-arch", ["targetRuntime", "arch"], "unknown"],
    ["target-arch-array", ["targetRuntime", "arch"], [process.arch]],
    ["old-portable-kind", ["releaseKind"], "node24-esm-process-directory"],
    ["build-extra", ["build", "extra"], true], ["commit", ["source", "sourceCommit"], "A".repeat(40)],
    ["node-major", ["source", "buildRuntime", "node"], "22.1.0"], ["package-manager", ["source", "packageManager"], "pnpm@latest"],
    ["runtime-platform", ["source", "buildRuntime", "platform"], "unknown"], ["runtime-arch", ["source", "buildRuntime", "arch"], "unknown"],
    ["lock-digest", ["source", "lockSha256"], "x".repeat(64)], ["input-digest", ["source", "inputSha256"], "0".repeat(64)],
    ["lock-input-mismatch", ["source", "lockSha256"], sha("different-lock")],
    ["commit-array", ["source", "sourceCommit"], ["a".repeat(40)]],
    ["lock-array", ["source", "lockSha256"], [sha("unit-lock")]],
    ["input-array", ["source", "inputSha256"], [sha(JSON.stringify([{ path: "pnpm-lock.yaml", sha256: sha("unit-lock"), size: 9 }]))]],
    ["node-array", ["source", "buildRuntime", "node"], ["24.21.0"]],
    ["package-manager-array", ["source", "packageManager"], ["pnpm@12.5.1"]],
    ["migration-count", ["build", "migrationCount"], 3], ["migration-unsafe-count", ["build", "migrationCount"], Number.MAX_SAFE_INTEGER + 1],
    ["bundler", ["build", "bundler"], "custom.js"], ["install", ["build", "installContract"], "pnpm install"],
    ["closure", ["build", "dependencyClosure"], "pnpm deploy"],
    ["entrypoints", ["build", "entrypoints"], ["dist/main.js", "dist/unknown.js"]],
  ] as const)("rejects strict metadata drift %s even with a separately supplied digest for those exact malformed bytes", async (_label, path, value) => {
    const f = await seal(await payload("agent-router"), "agent-router");
    const changed = await rewrite(f, (manifest) => setField(manifest, path, value));
    await expect(release.verifyVmReleaseDirectory(f.root, f.role, changed.digest)).rejects.toThrow();
  });

  it("accepts dirty development only as unpublishable and rejects extra inventory keys", async () => {
    const f = await seal(await payload("agent-router"), "agent-router", true);
    expect((await release.verifyVmReleaseDirectory(f.root, f.role, f.trustedDigest)).publishable).toBe(false);
    const changed = await rewrite(f, (manifest) => setField(manifest.files[0], ["extra"], true));
    await expect(release.verifyVmReleaseDirectory(f.root, f.role, changed.digest)).rejects.toThrow("file inventory");
  });

  it.each(["empty", "duplicate", "outside", "absolute", "extra-key", "unsafe-size", "sha-array"] as const)(
    "rejects malformed working-input inventory %s independently from its matching checksum", async (kind) => {
      const f = await seal(await payload("agent-router"), "agent-router");
      const changed = await rewrite(f, (manifest) => {
        if (kind === "empty") manifest.source.inputFiles = [];
        if (kind === "duplicate") manifest.source.inputFiles.push({ ...manifest.source.inputFiles[0]! });
        if (kind === "outside") manifest.source.inputFiles[0]!.path = "../outside";
        if (kind === "absolute") manifest.source.inputFiles[0]!.path = "/absolute";
        if (kind === "extra-key") setField(manifest.source.inputFiles[0], ["extra"], true);
        if (kind === "unsafe-size") manifest.source.inputFiles[0]!.size = Number.MAX_SAFE_INTEGER + 1;
        if (kind === "sha-array") setField(manifest.source.inputFiles[0], ["sha256"], [manifest.source.inputFiles[0]!.sha256]);
        manifest.source.inputSha256 = sha(JSON.stringify(manifest.source.inputFiles));
      });
      await expect(release.verifyVmReleaseDirectory(f.root, f.role, changed.digest)).rejects.toThrow("working build input inventory");
    });

  it.each(["size", "digest", "root-kind", "root-path"] as const)("rejects invalid directory inventory %s with a freshly supplied manifest checksum", async (kind) => {
    const f = await seal(await payload("agent-router"), "agent-router");
    const changed = await rewrite(f, (manifest) => {
      const rootEntry = manifest.files.find((entry) => entry.path === ".");
      if (!rootEntry) throw new Error("directory fixture root row missing");
      if (kind === "size") setField(rootEntry, ["size"], 1);
      if (kind === "digest") rootEntry.sha256 = sha("not-empty-directory");
      if (kind === "root-kind") setField(rootEntry, ["kind"], "file");
      if (kind === "root-path") rootEntry.path = "./";
    });
    await expect(release.verifyVmReleaseDirectory(f.root, f.role, changed.digest)).rejects.toThrow("file inventory");
  });

  it("captures actual working-source bytes into an independent snapshot and survives live-source mutate/restore without relabelling copied bytes", async () => {
    const f = await snapshotFixture();
    const result = await builder.captureVmReleaseWorkingInputs(f.sourceRoot, f.snapshotRoot);
    expect(result.inputFiles.map((entry) => entry.path)).toEqual(f.paths);
    expect(result.inputSha256).toBe(sha(JSON.stringify(result.inputFiles)));
    for (const entry of result.inputFiles) {
      const copied = await readFile(join(f.snapshotRoot, entry.path));
      expect(copied).toEqual(await readFile(join(f.sourceRoot, entry.path)));
      expect(entry.sha256).toBe(sha(copied)); expect(entry.size).toBe(copied.length);
    }
    const path = "apps/agent-runner/src/main.ts";
    const original = await readFile(join(f.sourceRoot, path));
    const sealedFile = result.inputFiles.find((entry) => entry.path === path)!;
    await writeFile(join(f.sourceRoot, path), "temporarily-substituted-source\n");
    expect(await readFile(join(f.snapshotRoot, path))).toEqual(original);
    expect(await release.sha256File(join(f.snapshotRoot, path))).toBe(sealedFile.sha256);
    await writeFile(join(f.sourceRoot, path), original);
    expect(await release.sha256File(join(f.snapshotRoot, path))).toBe(sealedFile.sha256);
    expect(result.inputSha256).toBe(sha(JSON.stringify(result.inputFiles)));
  });

  it("excludes ambient root env and nonruntime workspace data without copying or executing it", async () => {
    const f = await snapshotFixture();
    const excluded = [".env", "docs/notes.md", "apps/agent-router/test/fixture.ts", "apps/agent-runner/dist/main.js",
      "packages/fixture/node_modules/local.js", "packages/fixture/.local-run/state.json", "packages/fixture/coverage/report.json"];
    for (const path of excluded) {
      await mkdir(dirname(join(f.sourceRoot, path)), { recursive: true });
      await writeFile(join(f.sourceRoot, path), "synthetic excluded fixture, no secret\n");
    }
    const result = await builder.captureVmReleaseWorkingInputs(f.sourceRoot, f.snapshotRoot);
    expect(result.inputFiles.map((entry) => entry.path)).toEqual(f.paths);
    for (const path of excluded) await expect(lstat(join(f.snapshotRoot, path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([".npmrc", ".pnpmfile.cjs", ".pnpmfile.js"])("rejects source package-manager hook %s by presence without loading it", async (name) => {
    const f = await snapshotFixture();
    await writeFile(join(f.sourceRoot, name), "synthetic forbidden hook\n");
    await expect(builder.captureVmReleaseWorkingInputs(f.sourceRoot, f.snapshotRoot)).rejects.toThrow("configuration hooks");
    expect(await readdir(f.snapshotRoot)).toEqual([]);
  });

  it.each([".env", ".env.local", "private.key"])("rejects selected runtime source %s instead of copying secret-shaped configuration", async (name) => {
    const f = await snapshotFixture();
    await writeFile(join(f.sourceRoot, "apps", "agent-router", "src", name), "synthetic forbidden source\n");
    await expect(builder.captureVmReleaseWorkingInputs(f.sourceRoot, f.snapshotRoot)).rejects.toThrow("forbidden in source snapshot");
  });

  it.each(["file", "package-directory"] as const)("rejects selected source %s symlinks rather than following an alternate source", async (kind) => {
    const f = await snapshotFixture();
    if (kind === "file") {
      const path = join(f.sourceRoot, "apps", "agent-router", "src", "main.ts");
      await rm(path); await symlink("../../agent-runner/src/main.ts", path);
      expect(await readFile(path)).toEqual(await readFile(join(f.sourceRoot, "apps", "agent-runner", "src", "main.ts")));
    } else {
      await rm(join(f.sourceRoot, "packages", "fixture"), { recursive: true });
      await symlink("../apps/agent-runner", join(f.sourceRoot, "packages", "fixture"));
    }
    await expect(builder.captureVmReleaseWorkingInputs(f.sourceRoot, f.snapshotRoot)).rejects.toThrow();
  });

  it.each([0o4000, 0o2000, 0o1000])("rejects host-retained privileged source file mode %i before admitting its bytes", async (bit) => {
    const f = await snapshotFixture();
    const path = join(f.sourceRoot, "apps", "agent-router", "src", "main.ts");
    await chmod(path, bit | 0o644);
    const observed = (await lstat(path)).mode;
    expect(observed & 0o777).toBe(0o644);
    if ((observed & 0o7000) === bit) {
      await expect(builder.captureVmReleaseWorkingInputs(f.sourceRoot, f.snapshotRoot)).rejects.toThrow("special permission bits");
    } else {
      expect(observed & 0o7000).toBe(0);
      const captured = await builder.captureVmReleaseWorkingInputs(f.sourceRoot, f.snapshotRoot);
      const sourceBytes = await readFile(path);
      expect(captured.inputFiles.some((entry) => entry.path === "apps/agent-router/src/main.ts"
        && entry.sha256 === sha(sourceBytes))).toBe(true);
      expect(await readFile(join(f.snapshotRoot, "apps", "agent-router", "src", "main.ts"))).toEqual(sourceBytes);
    }
  });

  it("rejects a selected FIFO source by its actual nonregular type before open/read can block", async () => {
    const f = await snapshotFixture();
    const path = join(f.sourceRoot, "apps", "agent-router", "src", "local-fifo.ts");
    await runLocal("mkfifo", [path]);
    const stats = await lstat(path);
    expect(stats.isFIFO()).toBe(true); expect(stats.mode & 0o7000).toBe(0);
    await expect(builder.captureVmReleaseWorkingInputs(f.sourceRoot, f.snapshotRoot)).rejects.toThrow("source input must be a regular file");
    expect(await readdir(f.snapshotRoot)).toEqual([]);
  });

  it.each(["same-root", "nonempty", "relative"] as const)("rejects unsafe snapshot destination %s before overwriting anything", async (kind) => {
    const f = await snapshotFixture();
    if (kind === "nonempty") await writeFile(join(f.snapshotRoot, "owned-sentinel"), "keep\n");
    await expect(builder.captureVmReleaseWorkingInputs(kind === "relative" ? "relative-source" : f.sourceRoot,
      kind === "same-root" ? f.sourceRoot : f.snapshotRoot)).rejects.toThrow("separate absolute paths");
    if (kind === "nonempty") expect(await readFile(join(f.snapshotRoot, "owned-sentinel"), "utf8")).toBe("keep\n");
  });

  it("rejects invalid real-builder CLI arguments through both its canonical path and current-file alias before any build", async () => {
    const root = await tempRoot();
    const canonical = fileURLToPath(new URL("../scripts/package-vm-release.mjs", import.meta.url));
    const alias = join(root, "current-builder.mjs");
    await symlink(canonical, alias);
    const stderr = "VM release build failed: usage: package-vm-release.mjs --role agent-runner|agent-router --output <new-absolute-directory> [--allow-dirty-development]\n";
    for (const invokedPath of [canonical, alias]) {
      // No caller config, credentials, NODE_OPTIONS or executable search path reaches this child.
      // --unexpected must fail parsing before the builder can invoke pnpm or inspect resources.
      const failure: unknown = await runLocal(process.execPath, [invokedPath, "--unexpected"], {
        cwd: root,
        env: { NODE_ENV: "test", PATH: "" },
        timeout: 2_000,
        maxBuffer: 4_096,
        encoding: "utf8",
      }).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({ code: 1, killed: false, signal: null, stdout: "", stderr });
    }
    expect(await readdir(root)).toEqual(["current-builder.mjs"]);
  });

  it("never overwrites an existing dedicated output directory and rejects before any build/package-manager invocation", async () => {
    expect(Number(process.versions.node.split(".")[0])).toBe(24);
    const f = await seal(await payload("agent-router"), "agent-router");
    await expect(builder.buildVmRelease({ role: f.role, output: f.root, allowDirtyDevelopment: true })).rejects.toThrow("already exists");
    expect(await release.sha256File(join(f.root, "release-manifest.json"))).toBe(f.trustedDigest);
    expect(await readFile(join(f.root, "dist", "main.js"), "utf8")).toBe("export const localFixture = true;\n");
  });
});
