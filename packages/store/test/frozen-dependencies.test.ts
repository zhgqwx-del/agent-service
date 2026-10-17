import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frozenDependencyInstallDiagnostic, frozenDependencyStoreDir, installFrozenDependencies } from "./migrations/fixtures/frozen-dependencies.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const COMMIT = "53aece04d785f7d832312cf32f697b44979861db";
const exec = promisify(execFile);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("frozen historical dependency graphs", () => {
  let temporary: string | undefined, checkout: string, before: string, beforeSource: string;
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), "agent-service-frozen-dependency-proof-"));
    checkout = join(temporary, "checkout"); await mkdir(checkout);
    const env = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, CI: "1", COREPACK_ENABLE_NETWORK: "0",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    try {
      const resolved = await exec("git", ["rev-parse", COMMIT], { cwd: ROOT, env, timeout: 10_000 });
      if (resolved.stdout.trim() !== COMMIT) throw new Error();
      const archive = join(temporary, "source.tar");
      await exec("git", ["archive", "--format=tar", `--output=${archive}`, COMMIT], { cwd: ROOT, env, timeout: 30_000 });
      await exec("tar", ["-xf", archive, "-C", checkout], { cwd: ROOT, env, timeout: 30_000 });
    } catch { throw new Error("Frozen dependency proof archive failed."); }
    before = hash(await readFile(join(checkout, "pnpm-lock.yaml")));
    beforeSource = hash(await readFile(join(checkout, "packages/core/src/index.ts")));
    await installFrozenDependencies(ROOT, checkout);
  });
  afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });
  it("installs the real frozen0039 lock offline with archive-local workspace and runtime dependencies", async () => {
    const root = await realpath(checkout);
    expect(hash(await readFile(join(checkout, "pnpm-lock.yaml")))).toBe(before);
    expect((await lstat(join(checkout, "node_modules/.pnpm"))).isSymbolicLink()).toBe(false);
    // Vitest/tsx may hook module resolution in this parent. The historical
    // runtime uses a separate child, so prove isolation with native Node too:
    // no loader, NODE_PATH/NODE_OPTIONS, test runner or inherited configuration.
    const program = `
      import { createRequire } from 'node:module';
      import { realpathSync } from 'node:fs';
      import { join, sep } from 'node:path';
      const archive = realpathSync(process.cwd());
      const current = realpathSync(process.env.FROZEN_DEPENDENCY_CURRENT_ROOT);
      const require = createRequire(join(archive, 'packages/core/package.json'));
      const location = (name) => {
        try {
          const path = realpathSync(require.resolve(name));
          return path.startsWith(archive + sep) ? 'archive' : path.startsWith(current + sep) ? 'current' : 'outside';
        } catch (error) { return error?.code === 'MODULE_NOT_FOUND' ? 'absent' : 'error'; }
      };
      const sdk = location('@modelcontextprotocol/client');
      process.stdout.write(JSON.stringify({
        protocolInside: location('@agent-service/protocol') === 'archive',
        storeInside: location('@agent-service/store') === 'archive',
        mysqlInside: location('mysql2') === 'archive', sdkAbsent: sdk === 'absent', sdkLocation: sdk
      }));
    `;
    let result: unknown;
    try {
      const child = await exec(process.execPath, ["--input-type=module", "--eval", program], { cwd: root,
        env: { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, HOME: temporary, TMPDIR: temporary,
          CI: "1", COREPACK_ENABLE_NETWORK: "0", FROZEN_DEPENDENCY_CURRENT_ROOT: ROOT },
        timeout: 10_000, maxBuffer: 1024 });
      result = JSON.parse(child.stdout) as unknown;
    } catch { throw new Error("Frozen dependency resolution proof failed."); }
    expect(result).toEqual({ protocolInside: true, storeInside: true, mysqlInside: true, sdkAbsent: true, sdkLocation: "absent" });
    expect(hash(await readFile(join(checkout, "packages/core/src/index.ts")))).toBe(beforeSource);
  });
});

describe("closed current store-directory parsing", () => {
  it("accepts only the actual pnpm12 JSON field without exposing other configuration", () => {
    expect(frozenDependencyStoreDir(Buffer.from('{"storeDir":"/private/tmp/cache","other":"ignored"}'))).toBe("/private/tmp/cache");
    for (const source of ["storeDir: /private/tmp/cache", '{"storeDir":"relative"}', '{"storeDir":null}',
      '{"storeDir":"/a","storeDir":"/b"}', '{"storeDir":"/a","store\\u0044ir":"/b"}', "null"])
      expect(() => frozenDependencyStoreDir(Buffer.from(source))).toThrow("Frozen dependency installation failed.");
  });
  it("reports only a closed installation category, native status and bounded pnpm machine code", () => {
    const secret = "fixture-credential-canary https://user:secret@example.invalid/private";
    expect(frozenDependencyInstallDiagnostic({ code: 1, stderr: `error: unexpected argument '--private-option' found ${secret}` }))
      .toBe('{"exitStatus":1,"code":"none","kind":"unknown_option"}');
    expect(frozenDependencyInstallDiagnostic({ code: 1, stdout: `${secret} ERR_PNPM_NO_OFFLINE_TARBALL` }))
      .toBe('{"exitStatus":1,"code":"ERR_PNPM_NO_OFFLINE_TARBALL","kind":"offline_missing"}');
    expect(frozenDependencyInstallDiagnostic({ code: 1, stderr: `ERR_PNPM_OUTDATED_LOCKFILE ${secret}` }))
      .toBe('{"exitStatus":1,"code":"ERR_PNPM_OUTDATED_LOCKFILE","kind":"lockfile_mismatch"}');
    const hostile = Object.defineProperty({}, "stderr", { get() { throw new Error(secret); } });
    expect(frozenDependencyInstallDiagnostic(hostile)).toBe('{"exitStatus":null,"code":"none","kind":"unknown"}');
    expect(frozenDependencyInstallDiagnostic({ code: secret, stderr: secret }))
      .toBe('{"exitStatus":null,"code":"none","kind":"unknown"}');
  });
});
