import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Role = "agent-router" | "agent-runner";
interface SigningInput {
  release: string; role: Role; manifestSha256: string; archive: string; tool: string;
  privateKey: string; publicKeySha256: string; output: string;
}
interface SignCliApi {
  parseVmReleaseSigningArgs(args: unknown): SigningInput | { help: true };
  isDirectVmReleaseSigningEntrypoint(importMetaUrl: unknown, argv1?: unknown): boolean;
}
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "scripts/sign-vm-release.mjs");
const ERROR = /^VM release signing failed \(operation_failed\)$/;
const FLAGS = ["--release", "--role", "--manifest-sha256", "--archive", "--tool", "--private-key", "--public-key-sha256", "--output"];
const PATH_FLAGS = ["--release", "--archive", "--tool", "--private-key", "--output"];
const owned = new Set<string>();
let api: SignCliApi;
beforeAll(async () => {
  const imported: unknown = await import(new URL("../scripts/sign-vm-release.mjs", import.meta.url).href);
  api = imported as SignCliApi;
});
afterEach(async () => {
  for (const root of owned) {
    await rm(root, { recursive: true, force: true });
    owned.delete(root);
  }
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "agent-service-vm-sign-cli-test-"));
  owned.add(root);
  return root;
}
function input(role: Role = "agent-router", root = "/fixture"): SigningInput {
  return { release: join(root, "release"), role, manifestSha256: "a".repeat(64),
    archive: join(root, "release.tar"), tool: join(root, "vm-release-tool.mjs"),
    privateKey: join(root, "ephemeral-private-key-not-present.pem"), publicKeySha256: "b".repeat(64),
    output: join(root, "new-signature.json") };
}
function args(value = input()) {
  return ["--release", value.release, "--role", value.role, "--manifest-sha256", value.manifestSha256,
    "--archive", value.archive, "--tool", value.tool, "--private-key", value.privateKey,
    "--public-key-sha256", value.publicKeySha256, "--output", value.output];
}
function invoke(path: string, cwd: string, argv: string[]) {
  return spawnSync(process.execPath, [path, ...argv], { cwd, env: { PATH: "", NODE_ENV: "test" },
    encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
}

describe("closed offline VM signer CLI parser", () => {
  it.each(["agent-router", "agent-runner"] as const)("parses all eight explicit %s selectors without key IO", (role) => {
    expect(api.parseVmReleaseSigningArgs(args(input(role)))).toEqual(input(role));
  });
  it.each([["--help"], ["-h"]].map((candidate) => ({ candidate })))("accepts only standalone help $candidate", ({ candidate }) => {
    expect(api.parseVmReleaseSigningArgs(candidate)).toEqual({ help: true });
  });
  it("accepts absolute literal paths containing spaces and URL-special characters without interpreting URLs", () => {
    const value = input("agent-runner", "/fixture with spaces # ? %");
    expect(api.parseVmReleaseSigningArgs(args(value))).toEqual(value);
  });
  it.each(FLAGS)("rejects a missing required %s", (flag) => {
    const candidate = args(); candidate.splice(candidate.indexOf(flag), 2);
    expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
  });
  it.each(FLAGS)("rejects an arity-preserving duplicate %s, including an empty duplicate", (flag) => {
    const candidate = args();
    const otherIndex = candidate.indexOf(flag) === 0 ? 2 : 0;
    candidate[otherIndex] = flag;
    candidate[otherIndex + 1] = candidate[candidate.indexOf(flag) + 1]!;
    expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
    candidate[otherIndex + 1] = "";
    expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
  });
  it.each(FLAGS)("rejects empty %s rather than obtaining an ambient default", (flag) => {
    const candidate = args(); candidate[candidate.indexOf(flag) + 1] = "";
    expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
  });
  it.each(PATH_FLAGS.flatMap((flag) => ["relative-path", "file:///tmp/resource", "/fixture\nresource", "/fixture\0resource"]
    .map((value) => ({ flag, value }))))("rejects nonabsolute/control path $flag=$value", ({ flag, value }) => {
    const candidate = args(); candidate[candidate.indexOf(flag) + 1] = value;
    expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
  });
  it.each(["--manifest-sha256", "--public-key-sha256"].flatMap((flag) => ["A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(64)}\n`]
    .map((value) => ({ flag, value }))))("rejects noncanonical $flag", ({ flag, value }) => {
    const candidate = args(); candidate[candidate.indexOf(flag) + 1] = value;
    expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
  });
  it.each(["runner", "agent-worker", "AGENT-RUNNER"])("rejects non-role %s", (role) => {
    const candidate = args(); candidate[candidate.indexOf("--role") + 1] = role;
    expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
  });
  it.each(["--source-commit", "--public-key", "--allow-dirty-development", "--allow-unsigned", "--promote", "--unknown"])(
    "rejects an arity-preserving unknown/cross-authority %s", (flag) => {
      const candidate = args(); candidate[0] = flag;
      expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
    });
  it.each([[], ["help"], ["--help", "extra"], ["--help", "--private-key", "/untrusted"], [...args(), "extra"], [...args(), "--role", "agent-router"]]
    .map((candidate) => ({ candidate })))("rejects incomplete/extra argument sequence $candidate", ({ candidate }) => {
      expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
    });
  it.each([null, {}, "--help", 1, ["--role", 1], ["--role", null]].map((candidate) => ({ candidate })))("rejects non-string argument shape $candidate", ({ candidate }) => {
    expect(() => api.parseVmReleaseSigningArgs(candidate)).toThrowError(ERROR);
  });
});

describe("actual offline signer CLI boundary", () => {
  it.each(["--help", "-h"])("runs %s in an empty directory without release/key resources or output mutation", async (flag) => {
    const cwd = await temp();
    expect(await readdir(cwd)).toEqual([]);
    const result = invoke(SCRIPT, cwd, [flag]);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: sign-vm-release");
    expect(result.stdout).toContain("--private-key"); expect(result.stdout).toContain("--public-key-sha256");
    expect(result.stdout).toContain("not environment promotion");
    expect(await readdir(cwd)).toEqual([]);
  });
  it("does not sign or print when imported as a library rather than invoked directly", async () => {
    const cwd = await temp();
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1]);", pathToFileURL(SCRIPT).href],
      { cwd, env: { PATH: "", NODE_ENV: "test" }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toBe(""); expect(result.stderr).toBe(""); expect(await readdir(cwd)).toEqual([]);
  });
  it("uses canonical and current-directory aliases and closes argument failure without leaking selectors", async () => {
    const cwd = await temp();
    await symlink(join(ROOT, "scripts"), join(cwd, "current"), "dir");
    for (const script of [SCRIPT, join(cwd, "current/sign-vm-release.mjs")]) {
      const result = invoke(script, cwd, ["--unexpected", "/unit-sensitive-selector-not-disclosed"]);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
      expect(result.stderr).toBe("VM release signing failed (operation_failed)\n");
      expect(result.stderr).not.toContain(cwd); expect(result.stderr).not.toContain("unit-sensitive-selector");
    }
    expect((await readdir(cwd)).sort()).toEqual(["current"]);
  });
  it("closes actual signing-resource failure without reading a key or creating signature output", async () => {
    const cwd = await temp(); const value = input("agent-runner", cwd);
    const result = invoke(SCRIPT, cwd, args(value));
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("VM release signing failed (operation_failed)\n");
    expect(result.stderr).not.toContain(cwd); expect(result.stderr).not.toContain(value.publicKeySha256);
    await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe("signer direct-entrypoint identity", () => {
  it("matches actual regular-file identity including file and current-directory symlink aliases", async () => {
    const cwd = await temp(); const directory = join(cwd, "version with # ? % spaces");
    await mkdir(directory); const path = join(directory, "signer # ? %.mjs");
    await writeFile(path, "export {};\n");
    await symlink(directory, join(cwd, "current"), "dir");
    await symlink(path, join(cwd, "file-alias.mjs"));
    const url = pathToFileURL(path).href;
    for (const invoked of [path, await realpath(path), join(cwd, "current", "signer # ? %.mjs"), join(cwd, "file-alias.mjs")]) {
      expect(api.isDirectVmReleaseSigningEntrypoint(url, invoked)).toBe(true);
    }
    expect(await readFile(path, "utf8")).toBe("export {};\n");
  });
  it.each(["http://example.invalid/signer.mjs", "data:text/javascript,export{}", "not a URL", "file:///missing-signer.mjs"])(
    "fails closed for unrelated/malformed import URL %s", async (url) => {
      const cwd = await temp(); const path = join(cwd, "signer.mjs"); await writeFile(path, "export {};\n");
      expect(api.isDirectVmReleaseSigningEntrypoint(url, path)).toBe(false);
    });
  it.each([undefined, null, "", "relative.mjs", 1, []].map((argv1) => ({ argv1 })))("fails closed for unusable/unrelated argv1 $argv1", async ({ argv1 }) => {
    const cwd = await temp(); const path = join(cwd, "signer.mjs"); await writeFile(path, "export {};\n");
    expect(api.isDirectVmReleaseSigningEntrypoint(pathToFileURL(path).href, argv1)).toBe(false);
  });
  it("rejects query/hash, directories, missing files and different regular files", async () => {
    const cwd = await temp(); const path = join(cwd, "signer.mjs"), other = join(cwd, "other.mjs");
    await writeFile(path, "export {};\n"); await writeFile(other, "export {};\n");
    const url = pathToFileURL(path).href;
    expect(api.isDirectVmReleaseSigningEntrypoint(`${url}?version=1`, path)).toBe(false);
    expect(api.isDirectVmReleaseSigningEntrypoint(`${url}#fragment`, path)).toBe(false);
    expect(api.isDirectVmReleaseSigningEntrypoint(pathToFileURL(cwd).href, cwd)).toBe(false);
    expect(api.isDirectVmReleaseSigningEntrypoint(url, join(cwd, "missing.mjs"))).toBe(false);
    expect(api.isDirectVmReleaseSigningEntrypoint(url, other)).toBe(false);
  });
});
