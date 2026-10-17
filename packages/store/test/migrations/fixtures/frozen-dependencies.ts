import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PACKAGE_MANAGER = "pnpm@12.5.1";
const PROJECTS = ["packages/core", "packages/protocol", "packages/providers", "packages/sdk",
  "packages/store", "packages/testkit", "apps/agent-router", "apps/agent-runner"] as const;
const MANIFESTS = ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json",
  ...PROJECTS.map(project => `${project}/package.json`)];
function fail(): never { throw new Error("Frozen dependency installation failed."); }

/** Diagnostic only, never a success/retry decision. Native output is inspected
 * in memory and only a bounded machine code/closed category may leave this file. */
export function frozenDependencyInstallDiagnostic(error: unknown): string {
  const value = (name: string): unknown => error && typeof error === "object"
    ? Object.getOwnPropertyDescriptor(error, name)?.value as unknown : undefined;
  const status = value("code"), stdout = value("stdout"), stderr = value("stderr");
  const output = [stdout, stderr].filter((item): item is string => typeof item === "string" && item.length <= 1_048_576).join("\n");
  const codes = [...output.matchAll(/\bERR_PNPM_[A-Z0-9_]{1,64}\b/g)].map(match => match[0]);
  const code = codes[0] ?? "none";
  const kind = /\b(?:unknown|unexpected|unrecognized)\s+(?:option|argument)\b/i.test(output) ? "unknown_option"
    : /\bERR_PNPM_(?:NO_OFFLINE_[A-Z0-9_]+|MISSING_[A-Z0-9_]+)\b/.test(output)
      || /\boffline\b[^\n]{0,100}\b(?:missing|not found|not cached|unavailable)\b/i.test(output) ? "offline_missing"
      : /\bERR_PNPM_[A-Z0-9_]*LOCKFILE[A-Z0-9_]*\b/.test(output)
        || /\blockfile\b[^\n]{0,100}\b(?:mismatch|outdated|incompatible|not up.to.date)\b/i.test(output) ? "lockfile_mismatch"
        : "unknown";
  return JSON.stringify({ exitStatus: typeof status === "number" && Number.isSafeInteger(status) && status >= 0 && status <= 255 ? status : null, code, kind });
}

/** pnpm 12 writes JSON to this filename. Unknown formats/configuration fail closed;
 * no user config, subprocess output, or cache path is exposed in a diagnostic. */
export function frozenDependencyStoreDir(bytes: Buffer): string {
  try {
    if (!bytes.length || bytes.length > 1_048_576) fail();
    const source = bytes.toString("utf8");
    if (!Buffer.from(source).equals(bytes) || (source.match(/"storeDir"\s*:/g) ?? []).length !== 1) fail();
    const value: unknown = JSON.parse(source);
    // pnpm12's JSON.stringify format, ignoring only whitespace OUTSIDE strings.
    // This also rejects duplicate/escaped duplicate keys before JSON.parse can
    // silently replace one value (including an escaped spelling of storeDir).
    let compact = "", quoted = false, escaped = false;
    for (const character of source) {
      if (quoted) {
        compact += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') { quoted = true; compact += character; }
      else if (!/\s/.test(character)) compact += character;
    }
    if (JSON.stringify(value) !== compact) fail();
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const store = Object.getOwnPropertyDescriptor(value, "storeDir")?.value as unknown;
    if (typeof store !== "string" || !isAbsolute(store) || store.includes("\0")) fail();
    return store;
  } catch { return fail(); }
}

async function regularBytes(root: string, relative: string): Promise<Buffer> {
  const path = join(root, relative), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !(await realpath(path)).startsWith(root + sep)) fail();
  return readFile(path);
}
async function manifests(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const path of MANIFESTS) result.set(path, await regularBytes(root, path));
  const rootPackage: unknown = JSON.parse(result.get("package.json")!.toString("utf8"));
  if (!rootPackage || typeof rootPackage !== "object" || Array.isArray(rootPackage)
    || Object.getOwnPropertyDescriptor(rootPackage, "packageManager")?.value !== PACKAGE_MANAGER) fail();
  return result;
}
async function assertInternalLinks(checkout: string): Promise<void> {
  const store = await lstat(join(checkout, "node_modules/.pnpm"));
  if (!store.isDirectory() || store.isSymbolicLink()) fail();
  let links = 0;
  for (const project of ["", "node_modules/.pnpm", ...PROJECTS]) {
    const scope = join(checkout, project, "node_modules/@agent-service");
    const names = await readdir(scope).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    for (const name of names) {
      const path = join(scope, name);
      if (!(await lstat(path)).isSymbolicLink() || isAbsolute(await readlink(path))
        || !(await realpath(path)).startsWith(checkout + sep)) fail();
      links++;
    }
  }
  if (!links) fail();
}

/** Trusted current harness only. Each fresh git archive gets its OWN frozen graph,
 * not a copy of current node_modules. Call once per archive in the existing setup.
 * Only the installer may read the explicit content-addressed cache; historical
 * business subprocesses retain their separate, pre-existing isolated environment. */
export async function installFrozenDependencies(currentRoot: string, archivedCheckout: string): Promise<void> {
  let stage: "preflight" | "store" | "version" | "offline_install" | "manifests" | "links" = "preflight";
  try {
    const current = await realpath(currentRoot), checkout = await realpath(archivedCheckout);
    if (checkout === current || checkout.startsWith(current + sep) || current.startsWith(checkout + sep)) fail();
    const before = await manifests(checkout);
    const currentPackage: unknown = JSON.parse((await regularBytes(current, "package.json")).toString("utf8"));
    if (!currentPackage || typeof currentPackage !== "object" || Array.isArray(currentPackage)
      || Object.getOwnPropertyDescriptor(currentPackage, "packageManager")?.value !== PACKAGE_MANAGER) fail();
    const existing = await lstat(join(checkout, "node_modules")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined; throw error;
    });
    if (existing) fail();
    stage = "store";
    const store = await realpath(frozenDependencyStoreDir(await regularBytes(current, "node_modules/.modules.yaml")));
    if (!(await lstat(store)).isDirectory()) fail();
    const scratch = join(dirname(checkout), `installer-${checkout.split(sep).at(-1)!}`);
    await mkdir(scratch); // create-only, inside this fixture's already-owned temporary directory.
    const env: NodeJS.ProcessEnv = {
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      HOME: scratch, TMPDIR: scratch, XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch,
      CI: "1", NO_COLOR: "1", COREPACK_ENABLE_NETWORK: "0",
      NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const options = { cwd: checkout, env, timeout: 180_000, maxBuffer: 1024 * 1024 };
    stage = "version";
    const version = await exec("pnpm", ["--offline", "--store-dir", store, "--version"], options);
    if (version.stdout.trim() !== "12.5.1") fail();
    stage = "offline_install";
    // Only trusted, exact git archives call this harness. Trust their immutable
    // lock rather than querying today's registry age/provenance policy metadata
    // from a deliberately empty scratch HOME/cache. Frozen resolution, default
    // store/tarball integrity checks and the manifest byte checks remain intact;
    // missing package bytes must still fail offline, never fall back to network.
    await exec("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile",
      "--trust-lockfile", "--store-dir", store], options);
    stage = "manifests";
    const after = await manifests(checkout);
    for (const [path, bytes] of before) if (!bytes.equals(after.get(path)!)) fail();
    stage = "links";
    await assertInternalLinks(checkout);
  } catch (error) { throw new Error(`Frozen dependency installation failed: ${stage}.`
    + (stage === "offline_install" ? ` ${frozenDependencyInstallDiagnostic(error)}` : "")); }
  // Never expose stderr, args, environment, paths, or an underlying cause.
}
