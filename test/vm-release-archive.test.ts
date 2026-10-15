import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

type Role = "agent-router" | "agent-runner";
type InventoryEntry = { path: string; kind: "file" | "directory" | "symlink"; sha256: string; size: number;
  mode: string; target?: string; nativeFormat?: string; nativeArch?: string };
type ArchiveLimits = Partial<Record<"entryCount" | "archiveBytes" | "fileBytes" | "manifestBytes"
  | "metadataBytes" | "pathBytes" | "deadlineMs", number>>;
interface ArchiveReceipt {
  schema: "agent-service-vm-release-archive-v1";
  role: Role;
  targetRuntime: { nodeMajor: 24; platform: string; arch: string };
  manifestSha256: string;
  archiveSha256: string;
  archiveBytes: number;
  entryCount: number;
  productionAccepted: false;
}
interface ReleaseApi {
  VM_RELEASE_ENTRYPOINTS: Readonly<Record<Role, readonly string[]>>;
  validateVmReleasePayload(root: string, role: Role): Promise<InventoryEntry[]>;
  inventoryVmReleasePayload(root: string, options?: { excludeManifest?: boolean }): Promise<InventoryEntry[]>;
  verifyVmReleaseDirectory(root: string, role: Role, manifestSha256: string): Promise<unknown>;
}
interface ArchiveApi {
  packVmReleaseArchive(input: { release: string; role: Role; manifestSha256: string; archive: string;
    limits?: ArchiveLimits }): Promise<ArchiveReceipt>;
  unpackVmReleaseArchive(input: { archive: string; role: Role; archiveSha256: string;
    manifestSha256: string; output: string; limits?: ArchiveLimits }): Promise<ArchiveReceipt>;
  inspectVmReleaseArchive(input: { archive: string; role: Role; manifestSha256: string;
    limits?: ArchiveLimits }): Promise<{ receipt: ArchiveReceipt; manifest: unknown }>;
}
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ownedRoots = new Set<string>();
const runLocal = promisify(execFile);
let release: ReleaseApi;
let archiveApi: ArchiveApi;

beforeAll(async () => {
  // The implementation remains a repository .mjs module without a TypeScript declaration.
  release = await import(new URL("../scripts/lib/vm-release.mjs", import.meta.url).href) as ReleaseApi;
  archiveApi = await import(new URL("../scripts/lib/vm-release-archive.mjs", import.meta.url).href) as ArchiveApi;
});
afterEach(async () => {
  for (const root of ownedRoots) {
    await rm(root, { recursive: true, force: true });
    ownedRoots.delete(root);
  }
});
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "agent-service-vm-archive-test-"));
  ownedRoots.add(root);
  return root;
}
async function payload(role: Role) {
  const root = await tempRoot();
  await mkdir(join(root, "dist", "migrations"), { recursive: true });
  await mkdir(join(root, "node_modules", "fixture-package"), { recursive: true });
  await mkdir(join(root, "service"));
  await writeFile(join(root, "dist", "package.json"), '{"type":"module"}\n');
  for (const entrypoint of release.VM_RELEASE_ENTRYPOINTS[role]) {
    await writeFile(join(root, "dist", entrypoint), "export const archiveFixture = true;\n");
    await writeFile(join(root, "dist", `${entrypoint}.map`), "{}\n");
  }
  await writeFile(join(root, "dist", "migrations", "0001_fixture.sql"), "SELECT 1;\n");
  await writeFile(join(root, "node_modules", "fixture-package", "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "node_modules", "fixture-package", "index.js"), "export {};\n");
  await chmod(join(root, "node_modules", "fixture-package", "index.js"), 0o640);
  await writeFile(join(root, "service", `${role}.service.template`), "[Service]\nExecStart=/usr/bin/node fixture\n");
  await symlink("fixture-package", join(root, "node_modules", "fixture-alias"));
  const longSegment = `fixture-long-${"x".repeat(150)}`;
  const longPath = `node_modules/.pnpm/${longSegment}/node_modules/fixture-long/index.js`;
  await mkdir(dirname(join(root, longPath)), { recursive: true });
  await writeFile(join(root, longPath), "export const longFixture = true;\n");
  return { root, longPath };
}
async function seal(root: string, role: Role) {
  const inputFiles = [{ path: "pnpm-lock.yaml", sha256: sha("unit-lock"), size: 9 }];
  const manifest = { schema: "agent-service-vm-release-v1", role,
    releaseKind: "node24-platform-process-directory", productionAccepted: false, publishable: true,
    targetRuntime: { nodeMajor: 24, platform: process.platform, arch: process.arch },
    source: { sourceCommit: "a".repeat(40), sourceDirty: false, lockSha256: sha("unit-lock"),
      inputSha256: sha(JSON.stringify(inputFiles)), inputFiles, packageManager: "pnpm@12.5.1",
      buildRuntime: { node: process.versions.node, platform: process.platform, arch: process.arch } },
    build: { bundler: "scripts/build-app.mjs", installContract: "pnpm install --offline --frozen-lockfile --ignore-scripts",
      dependencyClosure: `pnpm --filter ./apps/${role} --prod --offline --ignore-scripts --trust-lockfile --frozen-lockfile deploy`,
      entrypoints: release.VM_RELEASE_ENTRYPOINTS[role].map((name) => `dist/${name}`), migrationCount: 1 },
    files: await release.validateVmReleasePayload(root, role) };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, "release-manifest.json"), manifestBytes);
  await chmod(join(root, "release-manifest.json"), 0o644);
  const manifestSha256 = sha(manifestBytes);
  await release.verifyVmReleaseDirectory(root, role, manifestSha256);
  return { root, role, manifest, manifestSha256 };
}
async function fixture(role: Role) {
  const source = await payload(role);
  return { ...await seal(source.root, role), longPath: source.longPath };
}
async function archivePath() { return join(await tempRoot(), "release.tar"); }
async function outputPath() { return join(await tempRoot(), "output"); }
async function pack(f: Awaited<ReturnType<typeof fixture>>) {
  const archive = await archivePath();
  const receipt = await archiveApi.packVmReleaseArchive({ release: f.root, role: f.role,
    manifestSha256: f.manifestSha256, archive });
  return { archive, receipt, archiveSha256: sha(await readFile(archive)) };
}

interface TarHeader { offset: number; name: string; type: string; size: number; dataOffset: number; }
function octal(bytes: Buffer, start: number, length: number) {
  return Number.parseInt(bytes.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim(), 8);
}
function tarHeaders(bytes: Buffer): TarHeader[] {
  const rows: TarHeader[] = [];
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const size = octal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("test fixture tar is not canonical");
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    rows.push({ offset, name, type: String.fromCharCode(header[156]!), size, dataOffset: offset + 512 });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return rows;
}
function writeTarField(bytes: Buffer, start: number, length: number, value: string) {
  const encoded = Buffer.from(value);
  if (encoded.length >= length) throw new Error("test tar field is too long");
  bytes.fill(0, start, start + length);
  encoded.copy(bytes, start);
}
function writeTarOctal(bytes: Buffer, start: number, length: number, value: number) {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length >= length) throw new Error("test tar octal does not fit");
  bytes.fill(0, start, start + length);
  bytes.write(text, start, text.length, "ascii");
}
function rewriteTarHeaderChecksum(bytes: Buffer, offset: number) {
  bytes.fill(0x20, offset + 148, offset + 156);
  let sum = 0;
  for (let i = offset; i < offset + 512; i += 1) sum += bytes[i]!;
  const value = sum.toString(8).padStart(6, "0");
  bytes.write(value, offset + 148, 6, "ascii");
  bytes[offset + 154] = 0;
  bytes[offset + 155] = 0x20;
}
function mutateHeader(bytes: Buffer, row: TarHeader, change: (copy: Buffer, offset: number) => void) {
  const copy = Buffer.from(bytes);
  change(copy, row.offset);
  rewriteTarHeaderChecksum(copy, row.offset);
  return copy;
}
async function malformedUnpack(f: Awaited<ReturnType<typeof fixture>>, bytes: Buffer,
  limits?: ArchiveLimits, manifestSha256 = f.manifestSha256) {
  const archive = await archivePath();
  const output = await outputPath();
  await writeFile(archive, bytes);
  await expect(archiveApi.unpackVmReleaseArchive({ archive, role: f.role, archiveSha256: sha(bytes),
    manifestSha256, output, limits })).rejects.toThrow();
  try {
    const stats = await lstat(output);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return output;
}

function requireHeader(bytes: Buffer, predicate: (row: TarHeader) => boolean) {
  const row = tarHeaders(bytes).find(predicate);
  if (!row) throw new Error("packed fixture lacks required tar header");
  return row;
}
function paxRecord(key: string, value: string) {
  const tail = ` ${key}=${value}\n`;
  let size = Buffer.byteLength(tail) + 1;
  while (true) {
    const next = Buffer.byteLength(String(size)) + Buffer.byteLength(tail);
    if (next === size) return `${size}${tail}`;
    size = next;
  }
}

describe("VM release tar transport", () => {
  // The tests below never execute any packaged JavaScript or native payload.
  it.each(["agent-router", "agent-runner"] as const)("roundtrips complete %s bytes, modes, links and long pnpm path", async (role) => {
    const f = await fixture(role);
    const packed = await pack(f);
    const output = await outputPath();
    const unpacked = await archiveApi.unpackVmReleaseArchive({ archive: packed.archive, role,
      archiveSha256: packed.archiveSha256, manifestSha256: f.manifestSha256, output });
    expect(packed.receipt).toEqual(unpacked);
    expect(unpacked).toMatchObject({ schema: "agent-service-vm-release-archive-v1", role,
      manifestSha256: f.manifestSha256, archiveSha256: packed.archiveSha256,
      archiveBytes: (await lstat(packed.archive)).size, entryCount: f.manifest.files.length + 1,
      productionAccepted: false,
      targetRuntime: { nodeMajor: 24, platform: process.platform, arch: process.arch } });
    expect(await release.verifyVmReleaseDirectory(output, role, f.manifestSha256)).toEqual(f.manifest);
    expect(await release.inventoryVmReleasePayload(output, { excludeManifest: true })).toEqual(f.manifest.files);
    expect(await readFile(join(output, f.longPath))).toEqual(await readFile(join(f.root, f.longPath)));
    expect((await lstat(join(output, "node_modules", "fixture-package", "index.js"))).mode & 0o777).toBe(0o640);
    expect((await lstat(output)).mode & 0o777).toBe((await lstat(f.root)).mode & 0o777);
    expect((await lstat(join(output, "node_modules", "fixture-alias"))).isSymbolicLink()).toBe(true);
    expect(tarHeaders(await readFile(packed.archive)).some((row) => row.type === "x")).toBe(true);
  });

  it("requires independent archive and manifest digests before unpacking", async () => {
    const f = await fixture("agent-router"), packed = await pack(f);
    await expect(archiveApi.unpackVmReleaseArchive({ archive: packed.archive, role: f.role,
      archiveSha256: "0".repeat(64), manifestSha256: f.manifestSha256, output: await outputPath() })).rejects.toThrow();
    await expect(archiveApi.unpackVmReleaseArchive({ archive: packed.archive, role: f.role,
      archiveSha256: packed.archiveSha256, manifestSha256: "0".repeat(64), output: await outputPath() })).rejects.toThrow();
    await expect(archiveApi.unpackVmReleaseArchive({ archive: packed.archive, role: f.role,
      archiveSha256: packed.archiveSha256, manifestSha256: "", output: await outputPath() })).rejects.toThrow();
  });

  it("rejects wrong role and host even if an attacker re-signs the archive bytes", async () => {
    const f = await fixture("agent-router"), packed = await pack(f);
    await expect(archiveApi.unpackVmReleaseArchive({ archive: packed.archive, role: "agent-runner",
      archiveSha256: packed.archiveSha256, manifestSha256: f.manifestSha256, output: await outputPath() })).rejects.toThrow();
    const wrongHost = structuredClone(f.manifest);
    wrongHost.targetRuntime.arch = process.arch === "arm64" ? "x64" : "arm64";
    wrongHost.source.buildRuntime.arch = wrongHost.targetRuntime.arch;
    const wrongBytes = Buffer.from(`${JSON.stringify(wrongHost, null, 2)}\n`);
    await writeFile(join(f.root, "release-manifest.json"), wrongBytes);
    await expect(archiveApi.packVmReleaseArchive({ release: f.root, role: f.role,
      manifestSha256: sha(wrongBytes), archive: await archivePath() })).rejects.toThrow();
  });

  it("cannot promote a modified payload plus matching attacker manifest under the original trusted digest", async () => {
    const f = await fixture("agent-router"), original = await pack(f);
    const target = join(f.root, "node_modules", "fixture-package", "index.js");
    await writeFile(target, "export const attacker = true;\n");
    f.manifest.files = await release.inventoryVmReleasePayload(f.root, { excludeManifest: true });
    const attackerManifest = Buffer.from(`${JSON.stringify(f.manifest, null, 2)}\n`);
    await writeFile(join(f.root, "release-manifest.json"), attackerManifest);
    const attackerArchive = await archivePath();
    await archiveApi.packVmReleaseArchive({ release: f.root, role: f.role,
      manifestSha256: sha(attackerManifest), archive: attackerArchive });
    const attackerArchiveSha256 = sha(await readFile(attackerArchive));
    expect(attackerArchiveSha256).not.toBe(original.archiveSha256);
    await expect(archiveApi.unpackVmReleaseArchive({ archive: attackerArchive, role: f.role,
      archiveSha256: attackerArchiveSha256, manifestSha256: f.manifestSha256,
      output: await outputPath() })).rejects.toThrow();
  });

  it("never overwrites an existing archive or output directory", async () => {
    const f = await fixture("agent-router"), archive = await archivePath();
    await writeFile(archive, "operator-owned");
    await expect(archiveApi.packVmReleaseArchive({ release: f.root, role: f.role,
      manifestSha256: f.manifestSha256, archive })).rejects.toThrow();
    expect(await readFile(archive, "utf8")).toBe("operator-owned");
    const packed = await pack(f), output = await outputPath();
    await mkdir(output);
    await writeFile(join(output, "sentinel"), "operator-owned");
    await expect(archiveApi.unpackVmReleaseArchive({ archive: packed.archive, role: f.role,
      archiveSha256: packed.archiveSha256, manifestSha256: f.manifestSha256, output })).rejects.toThrow();
    expect(await readFile(join(output, "sentinel"), "utf8")).toBe("operator-owned");
  });

  it("applies lowered pack budgets before publishing an archive and rejects raised limits", async () => {
    const f = await fixture("agent-router");
    for (const limits of [{ entryCount: 1 }, { fileBytes: 1 }, { metadataBytes: 1 },
      { pathBytes: 1 }, { archiveBytes: 1024 }, { entryCount: 100_001 }, { unknown: 1 }]) {
      const archive = await archivePath();
      await expect(archiveApi.packVmReleaseArchive({ release: f.root, role: f.role,
        manifestSha256: f.manifestSha256, archive,
        limits: limits as unknown as ArchiveLimits })).rejects.toThrow();
      await expect(lstat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["traversal", "absolute", "windows", "control", "duplicate", "invalid-utf8"] as const)(
    "rejects %s tar path even with recomputed archive and header checksums", async (kind) => {
      const f = await fixture("agent-router"), packed = await pack(f);
      const bytes = await readFile(packed.archive);
      const row = requireHeader(bytes, (entry) => entry.name === "node_modules/fixture-package/index.js");
      const changed = mutateHeader(bytes, row, (copy, offset) => {
        if (kind === "invalid-utf8") { copy[offset] = 0xff; return; }
        const path = kind === "traversal" ? "node_modules/../escape.js"
          : kind === "absolute" ? "/tmp/escape.js"
            : kind === "windows" ? "C:\\escape.js"
              : kind === "control" ? "node_modules/bad\nname.js"
                : "node_modules/fixture-package/package.json";
        writeTarField(copy, offset, 100, path);
      });
      await malformedUnpack(f, changed);
    },
  );

  it.each(["hardlink", "character-device", "fifo", "special-mode", "escape-link", "ancestor-link"] as const)(
    "rejects %s tar entry instead of extracting it", async (kind) => {
      const f = await fixture("agent-router"), packed = await pack(f);
      const bytes = await readFile(packed.archive);
      const row = requireHeader(bytes, (entry) => kind === "escape-link" ? entry.name === "node_modules/fixture-alias"
        : kind === "ancestor-link" ? entry.name.replace(/\/$/, "") === "node_modules/fixture-package"
          : entry.name === "node_modules/fixture-package/index.js");
      const changed = mutateHeader(bytes, row, (copy, offset) => {
        if (kind === "special-mode") writeTarOctal(copy, offset + 100, 8, 0o4755);
        else if (kind === "escape-link") writeTarField(copy, offset + 157, 100, "../../outside");
        else if (kind === "ancestor-link") {
          copy[offset + 156] = "2".charCodeAt(0);
          writeTarField(copy, offset + 157, 100, "..");
        } else copy[offset + 156] = ({ hardlink: "1", "character-device": "3", fifo: "6" } as const)[kind].charCodeAt(0);
      });
      await malformedUnpack(f, changed);
    },
  );

  it.each(["unknown", "duplicate"] as const)("rejects %s PAX metadata", async (kind) => {
    const f = await fixture("agent-router"), packed = await pack(f);
    const bytes = await readFile(packed.archive);
    const pax = requireHeader(bytes, (entry) => entry.type === "x");
    const changed = Buffer.from(bytes);
    if (kind === "unknown") {
      const data = changed.subarray(pax.dataOffset, pax.dataOffset + pax.size);
      const keyOffset = data.indexOf("path=");
      expect(keyOffset).toBeGreaterThanOrEqual(0);
      data.write("evil=", keyOffset, 5, "ascii");
    } else {
      const repeated = Buffer.from(paxRecord("path", "node_modules/a") + paxRecord("path", "node_modules/b"));
      expect(repeated.length).toBeLessThanOrEqual(512);
      changed.fill(0, pax.dataOffset, pax.dataOffset + 512);
      repeated.copy(changed, pax.dataOffset);
      writeTarOctal(changed, pax.offset + 124, 12, repeated.length);
      rewriteTarHeaderChecksum(changed, pax.offset);
    }
    await malformedUnpack(f, changed);
  });

  it.each(["octal", "checksum", "pax-length"] as const)(
    "rejects high-bit bytes in raw %s syntax even when Node ASCII decoding would mask them", async (kind) => {
      const f = await fixture("agent-router"), packed = await pack(f);
      const bytes = await readFile(packed.archive);
      const changed = Buffer.from(bytes);
      if (kind === "pax-length") {
        const pax = requireHeader(bytes, (entry) => entry.type === "x");
        changed[pax.dataOffset] = changed[pax.dataOffset]! | 0x80;
      } else {
        const file = requireHeader(bytes, (entry) => entry.name === "node_modules/fixture-package/index.js");
        if (kind === "octal") {
          changed[file.offset + 100] = changed[file.offset + 100]! | 0x80;
          rewriteTarHeaderChecksum(changed, file.offset);
        } else changed[file.offset + 148] = changed[file.offset + 148]! | 0x80;
      }
      await malformedUnpack(f, changed);
    },
  );

  it.each(["truncated", "nonzero-padding", "trailing-data"] as const)("rejects %s tar framing", async (kind) => {
    const f = await fixture("agent-router"), packed = await pack(f);
    const bytes = await readFile(packed.archive);
    const file = requireHeader(bytes, (entry) => entry.name === "node_modules/fixture-package/index.js");
    const changed = kind === "truncated" ? bytes.subarray(0, file.dataOffset + file.size - 1)
      : kind === "trailing-data" ? Buffer.concat([bytes, Buffer.alloc(512, 0x42)])
        : Buffer.from(bytes);
    if (kind === "nonzero-padding") changed[file.dataOffset + file.size] = 0x42;
    await malformedUnpack(f, changed);
  });

  it.each(["entryCount", "archiveBytes", "fileBytes", "manifestBytes", "metadataBytes", "pathBytes"] as const)(
    "enforces lower %s extraction budget on an otherwise valid archive", async (limit) => {
      const f = await fixture("agent-router"), packed = await pack(f);
      const bytes = await readFile(packed.archive);
      const allowance = limit === "archiveBytes" ? bytes.length - 1 : 1;
      await malformedUnpack(f, bytes, { [limit]: allowance });
    },
  );

  it("rejects raised or unknown safety budgets without creating an output", async () => {
    const f = await fixture("agent-router"), packed = await pack(f);
    for (const limits of [{ entryCount: 100_001 }, { archiveBytes: 2 * 1024 * 1024 * 1024 + 1 },
      { fileBytes: 128 * 1024 * 1024 + 1 }, { manifestBytes: 16 * 1024 * 1024 + 1 },
      { metadataBytes: 4097 }, { pathBytes: 4097 }, { deadlineMs: 120_001 },
      { unknown: 1 }, { entryCount: 0 }, { entryCount: 1.5 }]) {
      const output = await outputPath();
      await expect(archiveApi.unpackVmReleaseArchive({ archive: packed.archive, role: f.role,
        archiveSha256: packed.archiveSha256, manifestSha256: f.manifestSha256, output,
        limits: limits as unknown as ArchiveLimits })).rejects.toThrow();
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects a FIFO source archive promptly before opening or reading the FIFO", async () => {
    const f = await fixture("agent-router"), archive = await archivePath(), output = await outputPath();
    await runLocal("mkfifo", [archive]);
    const moduleUrl = new URL("../scripts/lib/vm-release-archive.mjs", import.meta.url).href;
    const options = { archive, role: f.role, archiveSha256: "0".repeat(64),
      manifestSha256: f.manifestSha256, output };
    const child = `import { unpackVmReleaseArchive } from ${JSON.stringify(moduleUrl)};\n`
      + `try { await unpackVmReleaseArchive(${JSON.stringify(options)}); process.exitCode = 1; }\n`
      + "catch { process.exitCode = 0; }\n";
    // A finite child timeout makes an O_RDONLY FIFO regression fail rather than stall the suite.
    await runLocal(process.execPath, ["--input-type=module", "-e", child], { timeout: 4_000 });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["unknown-source-field", "sensitive-payload-path"] as const)(
    "keeps a fully extracted but %s rejected release quarantined at root mode 0700", async (kind) => {
      const source = await payload("agent-router");
      await chmod(source.root, 0o755);
      const f = { ...await seal(source.root, "agent-router"), longPath: source.longPath };
      const packed = await pack(f);
      const bytes = await readFile(packed.archive);
      const changed = kind === "sensitive-payload-path"
        ? mutateHeader(bytes, requireHeader(bytes,
          (row) => row.name === "node_modules/fixture-package/index.js"), (copy, offset) => {
          writeTarField(copy, offset, 100, "node_modules/fixture-package/.env.log");
        }) : Buffer.from(bytes);
      const manifestRow = requireHeader(changed, (row) => row.name === "release-manifest.json");
      const manifest = changed.subarray(manifestRow.dataOffset, manifestRow.dataOffset + manifestRow.size);
      const before = kind === "unknown-source-field" ? '"sourceCommit"'
        : "node_modules/fixture-package/index.js";
      const after = kind === "unknown-source-field" ? '"sourceCommiX"'
        : "node_modules/fixture-package/.env.log";
      expect(Buffer.byteLength(before)).toBe(Buffer.byteLength(after));
      const at = manifest.indexOf(before);
      expect(at).toBeGreaterThanOrEqual(0);
      manifest.write(after, at, "utf8");
      const output = await malformedUnpack(f, changed, undefined, sha(manifest));
      expect((await lstat(output)).isDirectory()).toBe(true);
      expect((await lstat(output)).mode & 0o777).toBe(0o700);
      expect(await readFile(join(output, "release-manifest.json"))).toEqual(manifest);
      if (kind === "sensitive-payload-path") {
        expect((await lstat(join(output, "node_modules", "fixture-package", ".env.log"))).isFile()).toBe(true);
      }
    },
  );
});

describe("read-only VM release archive inspection", () => {
  it.each(["agent-router", "agent-runner"] as const)("checks complete %s tar bytes against its trusted manifest without extracting", async (role) => {
    const f = await fixture(role), packed = await pack(f);
    const originalArchive = await readFile(packed.archive);
    const originalManifest = await readFile(join(f.root, "release-manifest.json"));
    const originalPayload = await readFile(join(f.root, f.longPath));
    const archiveDirectoryBefore = await readdir(dirname(packed.archive));
    const inspected = await archiveApi.inspectVmReleaseArchive({ archive: packed.archive, role,
      manifestSha256: f.manifestSha256 });
    expect(inspected.receipt).toEqual(packed.receipt);
    expect(inspected.receipt.archiveSha256).toBe(sha(originalArchive));
    expect(inspected.manifest).toEqual(f.manifest);
    expect(inspected.manifest).not.toBe(f.manifest);
    expect(Object.isFrozen(inspected.manifest)).toBe(true);
    const immutable = inspected.manifest as { source: object; files: object[] };
    expect(Object.isFrozen(immutable.source)).toBe(true);
    expect(Object.isFrozen(immutable.files)).toBe(true);
    expect(Object.isFrozen(immutable.files[0])).toBe(true);
    expect(await readFile(packed.archive)).toEqual(originalArchive);
    expect(await readFile(join(f.root, "release-manifest.json"))).toEqual(originalManifest);
    expect(await readFile(join(f.root, f.longPath))).toEqual(originalPayload);
    expect(await readdir(dirname(packed.archive))).toEqual(archiveDirectoryBefore);
  });

  it("hashes the actual tar bytes even when two valid tar encodings carry the same manifest and inventory", async () => {
    const f = await fixture("agent-router"), packed = await pack(f);
    const extraZeroBlock = Buffer.concat([await readFile(packed.archive), Buffer.alloc(512)]);
    const otherArchive = await archivePath();
    await writeFile(otherArchive, extraZeroBlock);
    const original = await archiveApi.inspectVmReleaseArchive({ archive: packed.archive,
      role: f.role, manifestSha256: f.manifestSha256 });
    const changed = await archiveApi.inspectVmReleaseArchive({ archive: otherArchive,
      role: f.role, manifestSha256: f.manifestSha256 });
    expect(changed.manifest).toEqual(original.manifest);
    expect(changed.receipt.entryCount).toBe(original.receipt.entryCount);
    expect(changed.receipt.archiveBytes).toBe(original.receipt.archiveBytes + 512);
    expect(changed.receipt.archiveSha256).toBe(sha(extraZeroBlock));
    expect(changed.receipt.archiveSha256).not.toBe(original.receipt.archiveSha256);
  });

  it("rejects an untrusted manifest, wrong role, truncated archive and unsafe topology without altering input", async () => {
    const f = await fixture("agent-router"), packed = await pack(f);
    const original = await readFile(packed.archive);
    await expect(archiveApi.inspectVmReleaseArchive({ archive: packed.archive, role: f.role,
      manifestSha256: "0".repeat(64) })).rejects.toThrow();
    await expect(archiveApi.inspectVmReleaseArchive({ archive: packed.archive, role: "agent-runner",
      manifestSha256: f.manifestSha256 })).rejects.toThrow();
    const truncated = await archivePath();
    await writeFile(truncated, original.subarray(0, original.length - 1));
    await expect(archiveApi.inspectVmReleaseArchive({ archive: truncated, role: f.role,
      manifestSha256: f.manifestSha256 })).rejects.toThrow();
    const link = requireHeader(original, (row) => row.name === "node_modules/fixture-alias");
    const unsafe = mutateHeader(original, link, (copy, offset) => {
      writeTarField(copy, offset + 157, 100, "../../outside");
    });
    const unsafeArchive = await archivePath();
    await writeFile(unsafeArchive, unsafe);
    await expect(archiveApi.inspectVmReleaseArchive({ archive: unsafeArchive, role: f.role,
      manifestSha256: f.manifestSha256 })).rejects.toThrow();
    expect(await readFile(packed.archive)).toEqual(original);
    expect(await readFile(truncated)).toEqual(original.subarray(0, original.length - 1));
    expect(await readFile(unsafeArchive)).toEqual(unsafe);
  });

  it("enforces the existing closed safety budgets and refuses caller output options", async () => {
    const f = await fixture("agent-router"), packed = await pack(f);
    const bytes = await readFile(packed.archive);
    for (const limits of [{ entryCount: 1 }, { archiveBytes: bytes.length - 1 }, { fileBytes: 1 },
      { manifestBytes: 1 }, { metadataBytes: 1 }, { pathBytes: 1 }, { entryCount: 100_001 },
      { unknown: 1 }]) {
      await expect(archiveApi.inspectVmReleaseArchive({ archive: packed.archive, role: f.role,
        manifestSha256: f.manifestSha256, limits: limits as ArchiveLimits })).rejects.toThrow();
    }
    const output = await outputPath();
    await expect(archiveApi.inspectVmReleaseArchive({ archive: packed.archive, role: f.role,
      manifestSha256: f.manifestSha256, output } as never)).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans only its exact private scratch on success and failure", async () => {
    const f = await fixture("agent-router"), packed = await pack(f);
    const scratchParent = await tempRoot();
    const moduleUrl = new URL("../scripts/lib/vm-release-archive.mjs", import.meta.url).href;
    const child = `import { inspectVmReleaseArchive } from ${JSON.stringify(moduleUrl)};\n`
      + `import { tmpdir } from 'node:os';\n`
      + `const input = ${JSON.stringify({ archive: packed.archive, role: f.role, manifestSha256: f.manifestSha256 })};\n`
      + `const good = await inspectVmReleaseArchive(input);\n`
      + `let badRejected = false;\n`
      + `try { await inspectVmReleaseArchive({ ...input, manifestSha256: '0'.repeat(64) }); } catch { badRejected = true; }\n`
      + `process.stdout.write(JSON.stringify({ scratchParent: tmpdir(), archiveSha256: good.receipt.archiveSha256, badRejected }));\n`;
    const { stdout } = await runLocal(process.execPath, ["--input-type=module", "-e", child],
      { env: { ...process.env, TMPDIR: scratchParent }, timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({ scratchParent, archiveSha256: packed.archiveSha256, badRejected: true });
    expect(await readdir(scratchParent)).toEqual([]);
  });
});
