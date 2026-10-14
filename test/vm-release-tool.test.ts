import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
type Role = "agent-router" | "agent-runner";
interface ReleaseApi {
  validateVmReleasePayload(root: string, role: Role): Promise<unknown[]>;
  verifyVmReleaseDirectory(root: string, role: Role, digest: string): Promise<unknown>;
  verifyVmReleaseQuarantinedDirectory(root: string, role: Role, digest: string): Promise<unknown>;
}
interface ToolApi {
  parseVmReleaseToolArgs(args: unknown): { command: string };
  runVmReleaseTool(input: unknown): Promise<Json>;
}
interface TransportApi {
  packageVmTransport(input: { release: string; role: Role; manifestSha256: string; output: string }): Promise<Json>;
  deriveVmTransportCompilerContract(packageBytes: Uint8Array, lockBytes: Uint8Array): { version: string };
}
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCES = ["scripts/lib/vm-release-archive.mjs", "scripts/lib/vm-release.mjs",
  "scripts/package-vm-transport.mjs", "scripts/vm-release-tool.mjs"].sort();
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const owned = new Set<string>();
let release: ReleaseApi;
let tool: ToolApi;
let transport: TransportApi;
beforeAll(async () => {
  release = await import(new URL("../scripts/lib/vm-release.mjs", import.meta.url).href) as ReleaseApi;
  tool = await import(new URL("../scripts/vm-release-tool.mjs", import.meta.url).href) as ToolApi;
  transport = await import(new URL("../scripts/package-vm-transport.mjs", import.meta.url).href) as TransportApi;
});
afterEach(async () => {
  for (const directory of owned) {
    await rm(directory, { recursive: true, force: true });
    owned.delete(directory);
  }
});
async function temp() {
  const directory = await mkdtemp(join(tmpdir(), "agent-service-vm-tool-test-"));
  owned.add(directory);
  return directory;
}
async function fixture() {
  const root = join(await temp(), "source-release");
  await mkdir(join(root, "dist/migrations"), { recursive: true });
  await mkdir(join(root, "node_modules/fixture"), { recursive: true });
  await mkdir(join(root, "service"));
  await chmod(root, 0o755);
  await writeFile(join(root, "dist/main.js"), 'export const fixture = true;\n');
  await writeFile(join(root, "dist/main.js.map"), '{}\n');
  await writeFile(join(root, "dist/package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "dist/migrations/0001_fixture.sql"), 'SELECT 1;\n');
  await writeFile(join(root, "node_modules/fixture/index.js"), 'export {};\n');
  await writeFile(join(root, "service/agent-router.service.template"), '[Service]\n');
  const sourceInputs = await Promise.all(SOURCES.map(async (path) => {
    const bytes = await readFile(join(ROOT, path));
    return { path, sha256: sha(bytes), size: bytes.length };
  }));
  const lock = await readFile(join(ROOT, "pnpm-lock.yaml"));
  const packageBytes = await readFile(join(ROOT, "package.json"));
  const inputFiles = [...sourceInputs, { path: "pnpm-lock.yaml", sha256: sha(lock), size: lock.length },
    { path: "package.json", sha256: sha(packageBytes), size: packageBytes.length }]
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const manifest = {
    schema: "agent-service-vm-release-v1", role: "agent-router" as const,
    releaseKind: "node24-platform-process-directory", productionAccepted: false, publishable: true,
    targetRuntime: { nodeMajor: 24, platform: process.platform, arch: process.arch },
    source: { sourceCommit: "b".repeat(40), sourceDirty: false, lockSha256: sha(lock),
      inputSha256: sha(JSON.stringify(inputFiles)), inputFiles, packageManager: "pnpm@12.5.1",
      buildRuntime: { node: process.versions.node, platform: process.platform, arch: process.arch } },
    build: { installContract: "pnpm install --offline --frozen-lockfile --ignore-scripts",
      bundler: "scripts/build-app.mjs",
      dependencyClosure: "pnpm --filter ./apps/agent-router --prod --offline --ignore-scripts --trust-lockfile --frozen-lockfile deploy",
      entrypoints: ["dist/main.js"], migrationCount: 1 },
    files: await release.validateVmReleasePayload(root, "agent-router"),
  };
  const seal = async () => {
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(root, "release-manifest.json"), bytes);
    await chmod(join(root, "release-manifest.json"), 0o644);
    return sha(bytes);
  };
  const manifestSha256 = await seal();
  await release.verifyVmReleaseDirectory(root, "agent-router", manifestSha256);
  return { root, manifest, manifestSha256, seal };
}
function invoke(toolPath: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd, env: { PATH: "", NODE_ENV: "test" }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
}

describe("closed VM transport CLI", () => {
  it.each([["--help"], ["-h"]].map((args) => ({ args })))("accepts bounded help form $args", ({ args }) => {
    expect(tool.parseVmReleaseToolArgs(args).command).toBe("help");
  });
  it.each(["pack", "unpack", "verify"])("accepts the complete %s contract", (command) => {
    const args = command === "pack" ? ["pack", "--release", "/release", "--role", "agent-router",
      "--manifest-sha256", "a".repeat(64), "--archive", "/release.tar"]
      : command === "unpack" ? ["unpack", "--archive", "/release.tar", "--role", "agent-router",
        "--archive-sha256", "b".repeat(64), "--manifest-sha256", "a".repeat(64), "--output", "/new-release"]
        : ["verify", "--release", "/release", "--role", "agent-router", "--manifest-sha256", "a".repeat(64)];
    expect(tool.parseVmReleaseToolArgs(args).command).toBe(command);
  });
  const valid = ["verify", "--release", "/release", "--role", "agent-router", "--manifest-sha256", "a".repeat(64)];
  it.each([
    [], ["help"], ["unknown"], ["verify"], ["verify", "--help", "extra"], [...valid, "--role", "agent-router"],
    [...valid, "--unknown", "value"], [...valid, "--output", "/extra"], [...valid, "--manifest-sha256", "b".repeat(64)],
    ["verify", "--release", "relative", ...valid.slice(3)],
    ["verify", "--release", "/release", "--role", "agent-worker", ...valid.slice(5)],
    [...valid.slice(0, -1), "A".repeat(64)], [...valid.slice(0, -1), "a".repeat(63)],
    ["verify", "--release", "/release", "--role", "agent-router", "--manifest-sha256"],
  ].map((args) => ({ args })))("rejects missing, duplicate, cross-command and noncanonical arguments $args", ({ args }) => {
    expect(() => tool.parseVmReleaseToolArgs(args)).toThrow();
  });
  it.each([null, {}, "verify", ["verify", 1], ["verify", null]].map((args) => ({ args })))("rejects non-string argument shape $args", ({ args }) => {
    expect(() => tool.parseVmReleaseToolArgs(args)).toThrow();
  });
});

describe("standalone trusted VM transport artifact", () => {
  it.each(["missing-parent", "existing-output"] as const)("closes checker artifact initializer errors for %s before builds", async (kind) => {
    const cwd = await temp();
    const output = kind === "missing-parent" ? join(cwd, "missing-parent", "new-output") : join(cwd, "existing-output");
    if (kind === "existing-output") {
      await mkdir(output); await writeFile(join(output, "sentinel"), "keep\n");
    }
    const result = invoke(join(ROOT, "scripts/check-vm-release.mjs"), cwd, ["--artifacts", output]);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("VM release verification failed (operation_failed, phase=artifact-directory)\n");
    if (kind === "existing-output") expect(await readFile(join(output, "sentinel"), "utf8")).toBe("keep\n");
    else await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps normal permissions exact while quarantine changes only the isolated root comparison", async () => {
    const f = await fixture();
    await expect(release.verifyVmReleaseQuarantinedDirectory(f.root, "agent-router", f.manifestSha256))
      .rejects.toThrow("0700");
    await chmod(f.root, 0o700);
    await expect(release.verifyVmReleaseDirectory(f.root, "agent-router", f.manifestSha256))
      .rejects.toThrow("complete manifest inventory");
    expect(await release.verifyVmReleaseQuarantinedDirectory(f.root, "agent-router", f.manifestSha256))
      .toMatchObject({ productionAccepted: false });
    expect((await lstat(f.root)).mode & 0o777).toBe(0o700);
    await chmod(join(f.root, "dist/main.js"), 0o600);
    await expect(release.verifyVmReleaseQuarantinedDirectory(f.root, "agent-router", f.manifestSha256))
      .rejects.toThrow("complete manifest inventory");
    await chmod(join(f.root, "dist/main.js"), 0o644);
    await chmod(f.root, 0o755);
    expect(await release.verifyVmReleaseDirectory(f.root, "agent-router", f.manifestSha256))
      .toMatchObject({ productionAccepted: false });
  });

  it("bundles a digest-bound builtin-only tool, then unpacks and verifies without checkout or pnpm", async () => {
    const f = await fixture();
    const output = join(await temp(), "transport");
    const proof = await transport.packageVmTransport({ release: f.root, role: "agent-router",
      manifestSha256: f.manifestSha256, output });
    expect((await readdir(output)).sort()).toEqual(["release.tar", "transport-proof.json", "vm-release-tool.mjs"]);
    expect(proof.productionAccepted).toBe(false);
    expect(proof.sourceCommit).toBe(f.manifest.source.sourceCommit);
    expect(proof.publishable).toBe(true);
    expect(proof.sourceDirty).toBe(false);
    expect(proof.targetRuntime).toEqual(f.manifest.targetRuntime);
    expect(proof.compiler).toMatchObject({ name: "esbuild", version: "0.28.2",
      boundLockSha256: f.manifest.source.lockSha256, toolchainTrust: "trusted-local-install" });
    const toolPath = join(output, "vm-release-tool.mjs");
    const bytes = await readFile(toolPath);
    expect(proof.toolSha256).toBe(sha(bytes));
    expect(proof.archiveSha256).toBe(sha(await readFile(join(output, "release.tar"))));
    expect(proof.manifestSha256).toBe(f.manifestSha256);
    expect(bytes.toString()).not.toContain(ROOT);
    expect(JSON.parse(await readFile(join(output, "transport-proof.json"), "utf8"))).toEqual(proof);
    const cwd = await temp();
    const help = invoke(toolPath, cwd, ["--help"]);
    expect(help.error).toBeUndefined(); expect(help.status).toBe(0); expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage:");
    const extracted = join(cwd, "extracted");
    const unpack = invoke(toolPath, cwd, ["unpack", "--archive", join(output, "release.tar"),
      "--role", "agent-router", "--archive-sha256", String(proof.archiveSha256),
      "--manifest-sha256", f.manifestSha256, "--output", extracted]);
    expect(unpack.error).toBeUndefined(); expect(unpack.status).toBe(0); expect(unpack.stderr).toBe("");
    expect(JSON.parse(unpack.stdout)).toMatchObject({ role: "agent-router", manifestSha256: f.manifestSha256,
      archiveSha256: proof.archiveSha256, productionAccepted: false });
    expect(await readFile(join(extracted, "dist/main.js"))).toEqual(await readFile(join(f.root, "dist/main.js")));
    const verify = invoke(toolPath, cwd, ["verify", "--release", extracted, "--role", "agent-router",
      "--manifest-sha256", f.manifestSha256]);
    expect(verify.error).toBeUndefined(); expect(verify.status).toBe(0); expect(verify.stderr).toBe("");
    expect(JSON.parse(verify.stdout)).toMatchObject({ schema: "agent-service-vm-release-verification-v1",
      manifestSha256: f.manifestSha256, productionAccepted: false });
    const badOutput = join(cwd, "bad-output");
    const denied = invoke(toolPath, cwd, ["unpack", "--archive", join(output, "release.tar"),
      "--role", "agent-router", "--archive-sha256", "0".repeat(64),
      "--manifest-sha256", f.manifestSha256, "--output", badOutput]);
    expect(denied.status).toBe(1); expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain("operation_failed");
    expect(denied.stderr).not.toContain(cwd);
    await expect(lstat(badOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing-source", "changed-source", "changed-package", "changed-lock"] as const)("refuses %s before creating a transport directory", async (kind) => {
    const f = await fixture();
    const index = f.manifest.source.inputFiles.findIndex((entry) => entry.path === "scripts/vm-release-tool.mjs");
    if (kind === "missing-source") f.manifest.source.inputFiles.splice(index, 1);
    else if (kind === "changed-source") f.manifest.source.inputFiles[index]!.sha256 = "0".repeat(64);
    else {
      const path = kind === "changed-package" ? "package.json" : "pnpm-lock.yaml";
      f.manifest.source.inputFiles.find((entry) => entry.path === path)!.sha256 = "0".repeat(64);
      if (kind === "changed-lock") f.manifest.source.lockSha256 = "0".repeat(64);
    }
    f.manifest.source.inputSha256 = sha(JSON.stringify(f.manifest.source.inputFiles));
    const manifestSha256 = await f.seal();
    const output = join(await temp(), "not-created");
    await expect(transport.packageVmTransport({ release: f.root, role: "agent-router", manifestSha256, output })).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite an existing operator output directory", async () => {
    const f = await fixture(); const output = await temp();
    await writeFile(join(output, "sentinel"), "keep\n");
    await expect(transport.packageVmTransport({ release: f.root, role: "agent-router",
      manifestSha256: f.manifestSha256, output })).rejects.toThrow();
    expect(await readFile(join(output, "sentinel"), "utf8")).toBe("keep\n");
  });

  it("inherits nonpublishable dirty provenance without upgrading it", async () => {
    const f = await fixture();
    f.manifest.source.sourceDirty = true; f.manifest.publishable = false;
    const manifestSha256 = await f.seal();
    const output = join(await temp(), "development-transport");
    const proof = await transport.packageVmTransport({ release: f.root, role: "agent-router", manifestSha256, output });
    expect(proof.sourceDirty).toBe(true); expect(proof.publishable).toBe(false); expect(proof.productionAccepted).toBe(false);
  });

  it("derives the compiler pin only from the exact root importer and matching package specifier", async () => {
    const packageBytes = await readFile(join(ROOT, "package.json"));
    const lock = await readFile(join(ROOT, "pnpm-lock.yaml"));
    expect(transport.deriveVmTransportCompilerContract(packageBytes, lock)).toMatchObject({ version: "0.28.2" });
  });

  it.each(["missing-root", "duplicate-root", "duplicate-esbuild", "missing-esbuild", "specifier-mismatch", "quoted-importers", "duplicate-top-importers", "empty-root", "empty-importer-with-body"] as const)(
    "rejects ambiguous or mismatched compiler input %s without consulting ambient modules", async (kind) => {
      const packageBytes = await readFile(join(ROOT, "package.json"));
      const original = await readFile(join(ROOT, "pnpm-lock.yaml"), "utf8");
      const block = "      esbuild:\n        specifier: ^0.28.2\n        version: 0.28.2\n";
      expect(original).toContain(block);
      const rootStart = original.indexOf("  .:\n"), rootEnd = original.indexOf("  apps/agent-router:\n", rootStart);
      expect(rootStart).toBeGreaterThan(0); expect(rootEnd).toBeGreaterThan(rootStart);
      expect(original).toContain("  packages/testkit: {}\n");
      const malformed = kind === "missing-root" ? original.replace("  .:\n", "  other-root:\n")
        : kind === "duplicate-root" ? original.replace("  .:\n", "  .:\n  .:\n")
          : kind === "duplicate-esbuild" ? original.replace(block, block + block)
            : kind === "missing-esbuild" ? original.replace(block, "")
              : kind === "quoted-importers" ? original.replace("packages:\n", "'importers':\npackages:\n")
                : kind === "duplicate-top-importers" ? original.replace("packages:\n", "importers:\npackages:\n")
                  : kind === "empty-root" ? original.slice(0, rootStart) + "  .: {}\n\n" + original.slice(rootEnd)
                    : kind === "empty-importer-with-body" ? original.replace("  packages/testkit: {}\n", "  packages/testkit: {}\n    devDependencies:\n" + block)
                      : original.replace(block, block.replace("^0.28.2", "^9.0.0"));
      expect(() => transport.deriveVmTransportCompilerContract(packageBytes, Buffer.from(malformed))).toThrow();
    });

  it.each([
    { label: "root", text: '{"devDependencies":{"esbuild":"^0.28.2"},"devDependencies":{"esbuild":"^0.28.2"}}' },
    { label: "dependency", text: '{"devDependencies":{"esbuild":"^0.28.2","esbuild":"^0.28.2"}}' },
    { label: "escaped-dependency", text: String.raw`{"devDependencies":{"esbuild":"^0.28.2","\u0065sbuild":"^0.28.2"}}` },
    { label: "non-object", text: '{"devDependencies":["esbuild","^0.28.2"]}' },
  ])("rejects duplicate/ambiguous package keys $label instead of trusting JSON last-wins", async ({ text }) => {
    const lock = await readFile(join(ROOT, "pnpm-lock.yaml"));
    expect(() => transport.deriveVmTransportCompilerContract(Buffer.from(text), lock)).toThrow();
  });
});
