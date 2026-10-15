// Restricted, uncompressed transport for an independently authenticated VM release directory.
// This is not a general tar extractor, signature authority, installer, or program launcher.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  assertVmReleaseRole, currentVmReleaseTargetRuntime,
  verifyVmReleaseDirectory, verifyVmReleaseQuarantinedDirectory,
} from "./vm-release.mjs";

export const VM_RELEASE_ARCHIVE_DEFAULT_LIMITS = Object.freeze({
  entryCount: 100_000,
  archiveBytes: 2 * 1024 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024,
  manifestBytes: 16 * 1024 * 1024,
  metadataBytes: 4_096,
  pathBytes: 4_096,
  deadlineMs: 120_000,
});

const SCHEMA = "agent-service-vm-release-archive-v1";
const BLOCK = 512;
const CHUNK = 256 * 1024;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function checkedSha(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`trusted external ${name} SHA-256 is required`);
  }
  return value;
}
function checkedOptions(value, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => ![...required, "limits"].includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("invalid closed VM release archive options");
  }
  return value;
}
function context(overrides) {
  if (overrides !== undefined && (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)
    || Object.keys(overrides).some((key) => !Object.hasOwn(VM_RELEASE_ARCHIVE_DEFAULT_LIMITS, key)))) {
    throw new Error("invalid closed VM release archive limits");
  }
  const limits = { ...VM_RELEASE_ARCHIVE_DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > VM_RELEASE_ARCHIVE_DEFAULT_LIMITS[key]) {
      throw new Error(`VM release archive ${key} limit may only lower its default`);
    }
  }
  const expires = performance.now() + limits.deadlineMs;
  return { limits, check() {
    if (performance.now() >= expires) throw new Error("VM release archive whole-operation deadline exceeded");
  } };
}
function absolute(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\p{Cc}\p{Cs}]/u.test(value)) {
    throw new Error(`${name} must be an absolute path without control characters`);
  }
  return resolve(value);
}
function inside(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}
async function destination(path, ctx) {
  ctx.check();
  const parent = dirname(path);
  const stats = await fs.lstat(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("archive destination parent must be a real directory");
  const canonical = join(await fs.realpath(parent), basename(path));
  try {
    await fs.lstat(canonical);
    throw new Error("archive destination already exists; transport never overwrites");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  ctx.check();
  return canonical;
}
function safePath(path, limits, allowRoot = true) {
  if (typeof path !== "string" || path === "" || Buffer.byteLength(path) > limits.pathBytes
    || /[\p{Cc}\p{Cs}\ufffd]/u.test(path) || path.includes("\\")
    || path.startsWith("/") || /^[A-Za-z]:/.test(path)
    || !(allowRoot && path === ".") && path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("unsafe or noncanonical archive path");
  }
  return path;
}
function safeLink(target, path, limits) {
  if (typeof target !== "string" || target === "" || Buffer.byteLength(target) > limits.pathBytes
    || /[\p{Cc}\p{Cs}\ufffd]/u.test(target) || target.includes("\\")
    || target.startsWith("/") || /^[A-Za-z]:/.test(target) || posix.normalize(target) !== target) {
    throw new Error("unsafe or noncanonical archive symlink target");
  }
  const parts = posix.dirname(path) === "." ? [] : posix.dirname(path).split("/");
  for (const part of target.split("/")) {
    if (part === "..") {
      if (parts.length === 0) throw new Error("archive symlink escapes release root");
      parts.pop();
    } else if (part !== ".") parts.push(part);
  }
  return target;
}
function modeNumber(mode) {
  if (typeof mode !== "string" || !/^0[0-7]{3}$/.test(mode)) throw new Error("invalid archive permission mode");
  return Number.parseInt(mode, 8);
}
function statMode(stats) {
  if ((stats.mode & 0o7000) !== 0) throw new Error("archive special permission bits are forbidden");
  return (stats.mode & 0o777).toString(8).padStart(4, "0");
}
function align(size) { return Math.ceil(size / BLOCK) * BLOCK; }
function safeSize(size, max, name) {
  if (!Number.isSafeInteger(size) || size < 0 || size > max) throw new Error(`archive ${name} budget exceeded`);
  return size;
}
function zero(bytes) { return bytes.every((byte) => byte === 0); }

function octal(header, offset, width, value) {
  const digits = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || digits.length > width - 1) throw new Error("archive numeric field overflow");
  header.write(digits.padStart(width - 1, "0"), offset, width - 1, "ascii");
}
function stringField(header, offset, width, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > width) throw new Error("archive USTAR string field overflow");
  bytes.copy(header, offset);
}
function ustarName(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
    const prefix = path.slice(0, at), name = path.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return null;
}
function headerFor({ name, prefix = "", mode, size, type, link = "" }) {
  const header = Buffer.alloc(BLOCK);
  stringField(header, 0, 100, name);
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0); octal(header, 116, 8, 0);
  octal(header, 124, 12, size); octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii"); stringField(header, 157, 100, link);
  header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  octal(header, 329, 8, 0); octal(header, 337, 8, 0);
  stringField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0; header[155] = 0x20;
  return header;
}
function paxRecord(key, value) {
  const body = Buffer.from(`${key}=${value}\n`, "utf8");
  let size = body.length + 2;
  for (;;) {
    const prefix = Buffer.from(`${size} `, "ascii");
    const next = prefix.length + body.length;
    if (next === size) return Buffer.concat([prefix, body]);
    size = next;
  }
}
function entryEncoding(entry, index, ctx) {
  safePath(entry.path, ctx.limits);
  const type = { file: "0", directory: "5", symlink: "2" }[entry.kind];
  if (!type) throw new Error("unsupported archive entry kind");
  const mode = modeNumber(entry.mode);
  const size = entry.kind === "file" ? safeSize(entry.size,
    entry.path === "release-manifest.json" ? Math.min(ctx.limits.fileBytes, ctx.limits.manifestBytes) : ctx.limits.fileBytes,
    entry.path === "release-manifest.json" ? "manifest bytes" : "file bytes") : 0;
  if (entry.path === "." && entry.kind !== "directory") throw new Error("archive root must be a directory");
  if (entry.path === "release-manifest.json" && (entry.kind !== "file" || entry.mode !== "0644")) {
    throw new Error("archive manifest must be a regular 0644 file");
  }
  const name = ustarName(entry.path);
  const fields = [];
  if (name === null) fields.push(paxRecord("path", entry.path));
  let link = "";
  if (entry.kind === "symlink") {
    safeLink(entry.target, entry.path, ctx.limits);
    if (Buffer.byteLength(entry.target) > 100) fields.push(paxRecord("linkpath", entry.target));
    else link = entry.target;
  }
  const pax = fields.length === 0 ? null : Buffer.concat(fields);
  if (pax !== null) safeSize(pax.length, ctx.limits.metadataBytes, "PAX metadata bytes");
  return { header: headerFor({ ...(name ?? { name: `PaxEntry/${index}` }), mode, size, type, link }), pax,
    paxHeader: pax === null ? null : headerFor({ name: `PaxHeaders/${index}`, mode: 0o644, size: pax.length, type: "x" }),
    size, bytes: BLOCK + align(size) + (pax === null ? 0 : BLOCK + align(pax.length)) };
}

async function readExact(handle, size, position, ctx) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    ctx.check();
    const { bytesRead } = await handle.read(bytes, offset, size - offset, position + offset);
    if (bytesRead === 0) throw new Error("archive is truncated");
    offset += bytesRead;
  }
  ctx.check();
  return bytes;
}
async function writeAll(handle, bytes, position, ctx) {
  let offset = 0;
  while (offset < bytes.length) {
    ctx.check();
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (bytesWritten === 0) throw new Error("archive write made no progress");
    offset += bytesWritten;
  }
  ctx.check();
}
async function openRegularRead(path, ctx) {
  ctx.check();
  const observed = await fs.lstat(path);
  if (!observed.isFile() || observed.isSymbolicLink()) throw new Error("archive copy source must be a regular file");
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
    throw new Error("this host cannot safely open archive copy sources");
  }
  // lstat alone is not sufficient: a file replaced by a FIFO before open must not block.
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("archive copy source must remain a regular file");
    ctx.check();
    return { handle, stats };
  } catch (error) { await handle.close(); throw error; }
}
async function withVerify(release, role, manifestSha256, ctx) {
  ctx.check();
  // The existing verifier is not cancellable. Its elapsed work is part of this cooperative budget;
  // exceeding the deadline never returns a receipt, but is not a promise of native I/O cancellation.
  const manifest = await verifyVmReleaseDirectory(release, role, manifestSha256);
  ctx.check();
  return manifest;
}
function receipt(role, targetRuntime, manifestSha256, archiveSha256, archiveBytes, entryCount) {
  return Object.freeze({ schema: SCHEMA, role,
    targetRuntime: Object.freeze({ nodeMajor: targetRuntime.nodeMajor, platform: targetRuntime.platform, arch: targetRuntime.arch }),
    manifestSha256, archiveSha256, archiveBytes, entryCount, productionAccepted: false });
}

/**
 * Copy bytes checked against the original, independently authenticated manifest into a new tar.
 * Source/parent directories must be controlled and not concurrently renamed or mutated by another
 * same-UID process. Node has no portable openat directory-fd walk; this is not a hostile-parent sandbox.
 * A failed pack may leave an untrusted partial archive. Only a successful receipt is transport proof.
 */
export async function packVmReleaseArchive(options) {
  const { release, role: requestedRole, manifestSha256: requestedManifestSha, archive, limits } =
    checkedOptions(options, ["release", "role", "manifestSha256", "archive"]);
  const ctx = context(limits), role = assertVmReleaseRole(requestedRole);
  const manifestSha256 = checkedSha(requestedManifestSha, "manifest");
  const source = await fs.realpath(absolute(release, "release"));
  const output = await destination(absolute(archive, "archive"), ctx);
  if (inside(source, output)) throw new Error("archive output must be outside its source release");
  const manifestStats = await fs.lstat(join(source, "release-manifest.json"));
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) throw new Error("archive manifest must be a regular file");
  safeSize(manifestStats.size, Math.min(ctx.limits.manifestBytes, ctx.limits.fileBytes), "manifest bytes");
  const manifest = await withVerify(source, role, manifestSha256, ctx);
  const entries = [...manifest.files, { path: "release-manifest.json", kind: "file", mode: "0644",
    size: manifestStats.size, sha256: manifestSha256 }].sort((a, b) => a.path.localeCompare(b.path, "en"));
  safeSize(entries.length, ctx.limits.entryCount, "entry count");
  const encodings = entries.map((entry, index) => entryEncoding(entry, index, ctx));
  safeSize(encodings.reduce((total, encoding) => total + encoding.bytes, 2 * BLOCK), ctx.limits.archiveBytes, "byte count");
  const archiveHandle = await fs.open(output, "wx", 0o600);
  let position = 0;
  const archiveDigest = createHash("sha256");
  const emit = async (bytes) => {
    safeSize(position + bytes.length, ctx.limits.archiveBytes, "byte count");
    await writeAll(archiveHandle, bytes, position, ctx);
    archiveDigest.update(bytes); position += bytes.length;
  };
  try {
    for (const [index, entry] of entries.entries()) {
      ctx.check();
      const encoding = encodings[index];
      const path = entry.path === "." ? source : join(source, entry.path);
      if (encoding.pax !== null) {
        await emit(encoding.paxHeader); await emit(encoding.pax);
        if (align(encoding.pax.length) !== encoding.pax.length) await emit(Buffer.alloc(align(encoding.pax.length) - encoding.pax.length));
      }
      await emit(encoding.header);
      if (entry.kind === "file") {
        const { handle, stats } = await openRegularRead(path, ctx);
        try {
          if (!stats.isFile() || stats.size !== entry.size || statMode(stats) !== entry.mode) throw new Error("source file drifted before archive copy");
          const copiedDigest = createHash("sha256");
          for (let offset = 0; offset < entry.size;) {
            const bytes = await readExact(handle, Math.min(CHUNK, entry.size - offset), offset, ctx);
            copiedDigest.update(bytes); await emit(bytes); offset += bytes.length;
          }
          const extra = Buffer.alloc(1);
          ctx.check();
          const { bytesRead } = await handle.read(extra, 0, 1, entry.size);
          const after = await handle.stat();
          if (bytesRead !== 0 || !after.isFile() || after.size !== entry.size || statMode(after) !== entry.mode
            || copiedDigest.digest("hex") !== entry.sha256) throw new Error("copied source bytes differ from the trusted manifest");
        } finally { await handle.close(); }
        const padding = align(entry.size) - entry.size;
        if (padding) await emit(Buffer.alloc(padding));
      } else {
        const stats = await fs.lstat(path);
        if (statMode(stats) !== entry.mode
          || entry.kind === "directory" && (!stats.isDirectory() || stats.isSymbolicLink())
          || entry.kind === "symlink" && (!stats.isSymbolicLink() || await fs.readlink(path) !== entry.target)) {
          throw new Error("source directory or symlink drifted during archive copy");
        }
      }
    }
    await emit(ZERO_BLOCK); await emit(ZERO_BLOCK);
    await archiveHandle.sync(); ctx.check();
    // Per-copied-byte hashes prevent an edit/copy/restore ABA from hiding incorrect archive bytes.
    await withVerify(source, role, manifestSha256, ctx);
    return receipt(role, manifest.targetRuntime, manifestSha256, archiveDigest.digest("hex"), position, entries.length);
  } finally { await archiveHandle.close(); ctx.check(); }
}

function readString(header, offset, width) {
  const bytes = header.subarray(offset, offset + width);
  const nul = bytes.indexOf(0);
  if (nul >= 0 && !zero(bytes.subarray(nul))) throw new Error("nonzero USTAR string padding");
  return utf8.decode(nul < 0 ? bytes : bytes.subarray(0, nul));
}
function readOctal(header, offset, width) {
  const bytes = header.subarray(offset, offset + width);
  if (bytes[width - 1] !== 0 || bytes.subarray(0, width - 1).some((byte) => byte < 0x30 || byte > 0x37)) {
    throw new Error("noncanonical or overflowing USTAR numeric field");
  }
  const number = Number.parseInt(bytes.subarray(0, width - 1).toString("latin1"), 8);
  if (!Number.isSafeInteger(number)) throw new Error("unsafe USTAR numeric field");
  return number;
}
function parseHeader(header, ctx) {
  if (!header.subarray(257, 263).equals(Buffer.from("ustar\0"))
    || !header.subarray(263, 265).equals(Buffer.from("00"))
    || !zero(header.subarray(265, 329)) || !zero(header.subarray(500))) throw new Error("unsupported or noncanonical USTAR header");
  const checksumBytes = header.subarray(148, 156);
  if (checksumBytes[6] !== 0 || checksumBytes[7] !== 0x20 || checksumBytes.subarray(0, 6).some((byte) => byte < 0x30 || byte > 0x37)) {
    throw new Error("noncanonical USTAR checksum field");
  }
  const checksum = header.reduce((sum, byte, at) => sum + (at >= 148 && at < 156 ? 0x20 : byte), 0);
  if (Number.parseInt(checksumBytes.subarray(0, 6).toString("latin1"), 8) !== checksum) throw new Error("USTAR checksum mismatch");
  if ([readOctal(header, 108, 8), readOctal(header, 116, 8), readOctal(header, 136, 12),
    readOctal(header, 329, 8), readOctal(header, 337, 8)].some((number) => number !== 0)) {
    throw new Error("archive owner, time and device metadata must be zero");
  }
  const mode = readOctal(header, 100, 8);
  if (mode > 0o777) throw new Error("archive special permission bits are forbidden");
  const name = readString(header, 0, 100), prefix = readString(header, 345, 155);
  const path = prefix === "" ? name : `${prefix}/${name}`;
  safePath(path, ctx.limits);
  const type = String.fromCharCode(header[156]);
  if (!["0", "5", "2", "x"].includes(type)) throw new Error("unsupported tar entry type; only regular, directory, symlink and local PAX are allowed");
  const size = readOctal(header, 124, 12), link = readString(header, 157, 100);
  if (type !== "2" && link !== "") throw new Error("unexpected USTAR link field");
  if ((type === "5" || type === "2") && size !== 0) throw new Error("directory and symlink archive bodies must be empty");
  return { path, type, size, mode: mode.toString(8).padStart(4, "0"), link };
}
function parsePax(bytes, ctx) {
  safeSize(bytes.length, ctx.limits.metadataBytes, "PAX metadata bytes");
  const fields = Object.create(null);
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw new Error("malformed PAX record length");
    const lengthBytes = bytes.subarray(offset, space);
    if (lengthBytes.length === 0 || lengthBytes[0] === 0x30
      || lengthBytes.some((byte) => byte < 0x30 || byte > 0x39)) throw new Error("noncanonical PAX record length");
    const lengthText = lengthBytes.toString("latin1");
    const length = Number(lengthText), end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 1 || bytes[end - 1] !== 0x0a) throw new Error("truncated PAX record");
    const body = utf8.decode(bytes.subarray(space + 1, end - 1));
    const equals = body.indexOf("="), key = body.slice(0, equals), value = body.slice(equals + 1);
    if (equals <= 0 || !["path", "linkpath"].includes(key) || Object.hasOwn(fields, key) || value === ""
      || /[\p{Cc}\p{Cs}\ufffd]/u.test(body)) throw new Error("unsupported, duplicate or malformed PAX field");
    fields[key] = value; offset = end;
  }
  if (Object.keys(fields).length === 0) throw new Error("empty PAX metadata is forbidden");
  return fields;
}
async function bodyHash(handle, position, size, ctx) {
  const hash = createHash("sha256");
  for (let offset = 0; offset < size;) {
    const bytes = await readExact(handle, Math.min(CHUNK, size - offset), position + offset, ctx);
    hash.update(bytes); offset += bytes.length;
  }
  return hash.digest("hex");
}
function topology(entries, ctx) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (byPath.get(".")?.kind !== "directory") throw new Error("archive requires one explicit directory root '.'");
  for (const entry of entries) {
    ctx.check();
    if (entry.path === ".") continue;
    for (let parent = posix.dirname(entry.path); parent !== "."; parent = posix.dirname(parent)) {
      if (byPath.get(parent)?.kind !== "directory") throw new Error("archive parent must be an explicit directory, never a symlink");
    }
    if (entry.kind !== "symlink") continue;
    safeLink(entry.target, entry.path, ctx.limits);
    // Resolve the archive graph without touching a destination. No missing target, cycle or
    // intermediate non-directory can be justified by filesystem state outside this archive.
    const parts = posix.dirname(entry.path) === "." ? [] : posix.dirname(entry.path).split("/");
    const pending = entry.target.split("/");
    let links = 0;
    while (pending.length) {
      const part = pending.shift();
      if (part === ".") continue;
      if (part === "..") {
        if (parts.length === 0) throw new Error("effective archive symlink escapes release root");
        parts.pop(); continue;
      }
      const path = [...parts, part].join("/");
      const node = byPath.get(path);
      if (!node) throw new Error("archive symlink target is missing");
      if (node.kind === "symlink") {
        if (++links > 64) throw new Error("archive symlink loop or excessive resolution depth");
        safeLink(node.target, node.path, ctx.limits);
        pending.unshift(...node.target.split("/"));
      } else {
        if (pending.length > 0 && node.kind !== "directory") throw new Error("archive symlink traverses a non-directory");
        parts.push(part);
      }
    }
  }
  return byPath;
}
function preflightManifest(manifestBytes, manifestSha256, role, entries, ctx) {
  if (digest(manifestBytes) !== manifestSha256) throw new Error("archive manifest differs from trusted external digest");
  const manifest = JSON.parse(utf8.decode(manifestBytes));
  const target = currentVmReleaseTargetRuntime();
  if (manifest?.schema !== "agent-service-vm-release-v1" || manifest.role !== role
    || manifest.productionAccepted !== false || manifest.targetRuntime === null
    || typeof manifest.targetRuntime !== "object" || Array.isArray(manifest.targetRuntime)
    || Object.keys(manifest.targetRuntime).sort().join("\0") !== ["arch", "nodeMajor", "platform"].join("\0")
    || Object.keys(target).some((key) => target[key] !== manifest.targetRuntime[key]) || !Array.isArray(manifest.files)) {
    throw new Error("archive manifest role or target runtime is invalid");
  }
  const actual = new Map(entries.filter((entry) => entry.path !== "release-manifest.json").map((entry) => [entry.path, entry]));
  const observed = new Set();
  for (const expected of manifest.files) {
    safePath(expected?.path, ctx.limits);
    const entry = actual.get(expected.path);
    if (observed.has(expected.path) || !entry || expected.kind !== entry.kind || expected.mode !== entry.mode
      || expected.sha256 !== entry.sha256 || expected.size !== entry.size
      || entry.kind === "symlink" && expected.target !== entry.target) throw new Error("archive entries differ from trusted manifest inventory");
    observed.add(expected.path);
  }
  if (observed.size !== actual.size) throw new Error("archive omits or adds trusted manifest entries");
  // This early body/metadata comparison is not a replacement codec. The full existing verifier
  // must still validate its closed provenance schema and real native/owner-free filesystem below.
  return manifest;
}
async function scan(handle, archiveBytes, manifestSha256, role, ctx) {
  const entries = [], seen = new Set();
  let offset = 0, pax = null, manifestBytes;
  for (;;) {
    ctx.check();
    if (offset + BLOCK > archiveBytes) throw new Error("archive is truncated before its two-block terminator");
    const header = await readExact(handle, BLOCK, offset, ctx);
    if (zero(header)) {
      if (pax !== null || offset + 2 * BLOCK > archiveBytes || !zero(await readExact(handle, BLOCK, offset + BLOCK, ctx))) {
        throw new Error("archive terminator is truncated or PAX metadata is orphaned");
      }
      for (let at = offset + 2 * BLOCK; at < archiveBytes;) {
        const bytes = await readExact(handle, Math.min(CHUNK, archiveBytes - at), at, ctx);
        if (!zero(bytes)) throw new Error("archive contains trailing nonzero data");
        at += bytes.length;
      }
      break;
    }
    const decoded = parseHeader(header, ctx);
    const start = offset + BLOCK, end = start + align(decoded.size);
    if (!Number.isSafeInteger(end) || end > archiveBytes) throw new Error("archive body is truncated or overflowing");
    if (decoded.type === "x") {
      if (pax !== null || decoded.mode !== "0644" || decoded.size === 0) throw new Error("invalid or consecutive local PAX metadata");
      safeSize(decoded.size, ctx.limits.metadataBytes, "PAX metadata bytes");
      pax = parsePax(await readExact(handle, decoded.size, start, ctx), ctx);
    } else {
      const path = safePath(pax?.path ?? decoded.path, ctx.limits);
      if (seen.has(path)) throw new Error("duplicate archive entry path");
      safeSize(entries.length + 1, ctx.limits.entryCount, "entry count");
      if (pax?.linkpath !== undefined && decoded.type !== "2") throw new Error("PAX linkpath is only valid for a symlink");
      if (pax?.linkpath !== undefined && decoded.link !== "") throw new Error("PAX linkpath requires an empty fallback link field");
      const kind = { "0": "file", "5": "directory", "2": "symlink" }[decoded.type];
      const target = kind === "symlink" ? safeLink(pax?.linkpath ?? decoded.link, path, ctx.limits) : undefined;
      if (path === "." && kind !== "directory") throw new Error("archive root must be a directory");
      const size = kind === "file" ? safeSize(decoded.size, path === "release-manifest.json"
        ? Math.min(ctx.limits.fileBytes, ctx.limits.manifestBytes) : ctx.limits.fileBytes, "file bytes")
        : kind === "symlink" ? Buffer.byteLength(target) : 0;
      if (path === "release-manifest.json" && (kind !== "file" || decoded.mode !== "0644")) throw new Error("archive manifest must be a regular 0644 file");
      const sha256 = kind === "file" ? await bodyHash(handle, start, size, ctx)
        : kind === "symlink" ? digest(Buffer.from(target)) : EMPTY_SHA256;
      const entry = { path, kind, mode: decoded.mode, size, sha256, dataOffset: start,
        ...(target === undefined ? {} : { target }) };
      entries.push(entry); seen.add(path); pax = null;
      if (path === "release-manifest.json") manifestBytes = await readExact(handle, size, start, ctx);
    }
    const padding = align(decoded.size) - decoded.size;
    if (padding && !zero(await readExact(handle, padding, start + decoded.size, ctx))) throw new Error("archive body padding must be zero");
    offset = end;
  }
  topology(entries, ctx);
  if (manifestBytes === undefined) throw new Error("archive release manifest is missing");
  const manifest = preflightManifest(manifestBytes, manifestSha256, role, entries, ctx);
  return { entries, manifest };
}

async function fixedArchiveCopy(source, scratchHandle, ctx) {
  const { handle, stats } = await openRegularRead(source, ctx);
  try {
    const size = safeSize(stats.size, ctx.limits.archiveBytes, "byte count");
    if (size < 2 * BLOCK || size % BLOCK !== 0) throw new Error("archive is truncated or not block-aligned");
    const hash = createHash("sha256");
    for (let offset = 0; offset < size;) {
      const bytes = await readExact(handle, Math.min(CHUNK, size - offset), offset, ctx);
      await writeAll(scratchHandle, bytes, offset, ctx); hash.update(bytes); offset += bytes.length;
    }
    ctx.check();
    const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, size);
    const after = await handle.stat();
    if (bytesRead !== 0 || !after.isFile() || after.size !== size) throw new Error("source archive changed while copying");
    return { archiveBytes: size, archiveSha256: hash.digest("hex") };
  } finally { await handle.close(); }
}
async function extract(entries, archiveHandle, output, ctx) {
  const directories = entries.filter((entry) => entry.kind === "directory")
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path, "en"));
  for (const entry of directories) {
    ctx.check();
    if (entry.path !== ".") {
      await fs.mkdir(join(output, entry.path), { mode: 0o700 });
      await fs.chmod(join(output, entry.path), 0o700);
    }
  }
  for (const entry of entries.filter((row) => row.kind === "file")) {
    ctx.check();
    const handle = await fs.open(join(output, entry.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const hash = createHash("sha256");
      for (let offset = 0; offset < entry.size;) {
        const bytes = await readExact(archiveHandle, Math.min(CHUNK, entry.size - offset), entry.dataOffset + offset, ctx);
        await writeAll(handle, bytes, offset, ctx); hash.update(bytes); offset += bytes.length;
      }
      if (hash.digest("hex") !== entry.sha256) throw new Error("private archive copy changed during extraction");
      await handle.chmod(modeNumber(entry.mode));
    } finally { await handle.close(); }
  }
  // No file or directory is ever created through an archive-supplied symlink.
  for (const entry of entries.filter((row) => row.kind === "symlink")) {
    ctx.check();
    const path = join(output, entry.path);
    await fs.symlink(entry.target, path);
    if (statMode(await fs.lstat(path)) !== entry.mode) {
      if (typeof fs.lchmod !== "function") throw new Error("archive symlink mode is unsupported on this host");
      await fs.lchmod(path, modeNumber(entry.mode));
    }
  }
  for (const entry of directories.reverse()) {
    ctx.check();
    if (entry.path !== ".") await fs.chmod(join(output, entry.path), modeNumber(entry.mode));
  }
}

/**
 * Authenticate one private copied-byte archive, scan its complete topology, then exclusively create
 * an isolated output. Requires a controlled parent, not a hostile same-UID directory mutator. No
 * archive program executes. On failure an already-created output is retained at root mode 0700 for
 * operator inspection; it is never installed, selected as current, or automatically removed.
 */
export async function unpackVmReleaseArchive(options) {
  const { archive, role: requestedRole, archiveSha256: requestedArchiveSha, manifestSha256: requestedManifestSha, output, limits } =
    checkedOptions(options, ["archive", "role", "archiveSha256", "manifestSha256", "output"]);
  const ctx = context(limits), role = assertVmReleaseRole(requestedRole);
  const archiveSha256 = checkedSha(requestedArchiveSha, "archive"), manifestSha256 = checkedSha(requestedManifestSha, "manifest");
  const source = absolute(archive, "archive"), target = await destination(absolute(output, "output"), ctx);
  const scratch = await fs.mkdtemp(join(tmpdir(), "agent-service-vm-archive-"));
  let archiveHandle, created = false, unpacked;
  try {
    try {
      await fs.chmod(scratch, 0o700);
      archiveHandle = await fs.open(join(scratch, "archive.tar"), "wx+", 0o600);
      const copied = await fixedArchiveCopy(source, archiveHandle, ctx);
      if (copied.archiveSha256 !== archiveSha256) throw new Error("archive differs from trusted external digest");
      // Use this same open scratch handle, never reopen the mutable source after authenticating it.
      const { entries, manifest } = await scan(archiveHandle, copied.archiveBytes, manifestSha256, role, ctx);
      ctx.check();
      await fs.mkdir(target, { mode: 0o700 }); created = true;
      await fs.chmod(target, 0o700);
      await extract(entries, archiveHandle, target, ctx);
      const root = entries.find((entry) => entry.path === ".");
      ctx.check();
      // This narrow shared validator requires actual root mode 0700, normalizes only that one
      // already-authenticated root-mode field, and otherwise runs every original full proof.
      const verified = await verifyVmReleaseQuarantinedDirectory(target, role, manifestSha256);
      ctx.check();
      if (JSON.stringify(verified.targetRuntime) !== JSON.stringify(manifest.targetRuntime)) throw new Error("unpacked target runtime changed during verification");
      unpacked = { verified, root, archiveBytes: copied.archiveBytes, entryCount: entries.length };
    } finally {
      try { await archiveHandle?.close(); } finally {
        // Only this invocation's exact mkdtemp-created private scratch is a recursive cleanup target.
        await fs.rm(scratch, { recursive: true, force: true });
      }
    }
    // Complete private finalization before exposing the authenticated release's original root mode.
    ctx.check();
    await fs.chmod(target, modeNumber(unpacked.root.mode));
    const rootStats = await fs.lstat(target);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || statMode(rootStats) !== unpacked.root.mode) {
      throw new Error("verified output root mode did not restore exactly");
    }
    ctx.check();
    return receipt(role, unpacked.verified.targetRuntime, manifestSha256, archiveSha256, unpacked.archiveBytes, unpacked.entryCount);
  } catch (error) {
    if (created) {
      // This exact newly-created output is retained, never recursively removed. A controlled parent
      // is required: permissions do not defend against another same-UID process renaming ancestors.
      const stats = await fs.lstat(target).catch(() => null);
      if (stats?.isDirectory() && !stats.isSymbolicLink()) await fs.chmod(target, 0o700);
    }
    // Includes finalization failures: no cleanup error may leave a failed output in release mode.
    throw error;
  }
}

function immutableManifestCopy(manifest, ctx) {
  // The scan owns its parsed JSON. Return a separate, deeply frozen value so a caller cannot
  // accidentally mutate the evidence it receives while assembling a transport signature.
  const copy = structuredClone(manifest);
  const pending = [copy];
  while (pending.length > 0) {
    ctx.check();
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    for (const child of Object.values(value)) pending.push(child);
    Object.freeze(value);
  }
  return copy;
}

/**
 * Inspect an existing archive against an independently trusted directory-manifest digest.
 * This reads every archive body from one private, fixed-byte copy and never extracts or creates
 * a caller-visible output. It does not independently validate the manifest's closed provenance
 * or native payload: the signing caller must first verify its source release directory.
 */
export async function inspectVmReleaseArchive(options) {
  const { archive, role: requestedRole, manifestSha256: requestedManifestSha, limits } =
    checkedOptions(options, ["archive", "role", "manifestSha256"]);
  const ctx = context(limits), role = assertVmReleaseRole(requestedRole);
  const manifestSha256 = checkedSha(requestedManifestSha, "manifest");
  const source = absolute(archive, "archive");
  const scratch = await fs.mkdtemp(join(tmpdir(), "agent-service-vm-archive-"));
  let archiveHandle, result;
  try {
    await fs.chmod(scratch, 0o700);
    archiveHandle = await fs.open(join(scratch, "archive.tar"), "wx+", 0o600);
    const copied = await fixedArchiveCopy(source, archiveHandle, ctx);
    // Keep the same opened private copy for the entire body, topology and manifest scan.
    const { entries, manifest } = await scan(archiveHandle, copied.archiveBytes, manifestSha256, role, ctx);
    result = {
      receipt: receipt(role, manifest.targetRuntime, manifestSha256, copied.archiveSha256,
        copied.archiveBytes, entries.length),
      manifest: immutableManifestCopy(manifest, ctx),
    };
  } finally {
    try { await archiveHandle?.close(); } finally {
      // This invocation's exact private scratch is the only recursive cleanup target.
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
  ctx.check();
  return result;
}
