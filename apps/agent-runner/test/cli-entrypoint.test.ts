import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { isDirectCliEntrypoint as runnerEntrypoint } from "../src/cli-entrypoint.js";
import { isDirectCliEntrypoint as routerEntrypoint } from "../../agent-router/src/cli-entrypoint.js";

const ownedRoots = new Set<string>();
afterEach(async () => {
  for (const root of ownedRoots) {
    // Only exact mkdtemp-owned fixture directories are recursively removed.
    await rm(root, { recursive: true, force: true }); ownedRoots.delete(root);
  }
});
async function fixture(name = "entry.js") {
  const root = await mkdtemp(join(tmpdir(), "agent-cli-entrypoint-test-"));
  ownedRoots.add(root);
  const file = join(root, name);
  await writeFile(file, "// Synthetic identity fixture; never imported or executed.\n");
  return { root, file, moduleUrl: pathToFileURL(file).href };
}

describe.each([["runner", runnerEntrypoint], ["router", routerEntrypoint]] as const)(
  "%s direct filesystem entrypoint identity", (_role, isDirectCliEntrypoint) => {
  it("recognizes an ordinary existing file without invoking its command body", async () => {
    const f = await fixture();
    expect(isDirectCliEntrypoint(f.moduleUrl, f.file)).toBe(true);
    expect(await readFile(f.file, "utf8")).toContain("never imported or executed");
  });

  it.each(["entry with spaces.js", "entry#query?.js", "entry%encoded.js", "入口 ü.js"])(
    "recognizes properly encoded file URLs for %s", async (name) => {
      const f = await fixture(name);
      expect(new URL(f.moduleUrl).search).toBe(""); expect(new URL(f.moduleUrl).hash).toBe("");
      expect(isDirectCliEntrypoint(f.moduleUrl, f.file)).toBe(true);
    });

  it("matches the actual temp-directory canonical identity, including macOS /var versus /private/var aliases", async () => {
    const f = await fixture();
    const canonical = await realpath(f.file);
    expect(isDirectCliEntrypoint(pathToFileURL(canonical).href, f.file)).toBe(true);
    expect(isDirectCliEntrypoint(f.moduleUrl, canonical)).toBe(true);
    // On non-aliasing hosts these are still ordinary identity assertions, not a platform skip.
  });

  it("resolves a relative argv path against the real current working directory", async () => {
    const f = await fixture("relative entry.js");
    expect(isDirectCliEntrypoint(f.moduleUrl, relative(process.cwd(), f.file))).toBe(true);
  });

  it.each(["argv-link", "module-link"] as const)("matches a real file symlink in the %s position", async (kind) => {
    const f = await fixture();
    const alias = join(f.root, "entry-alias.js");
    await symlink("entry.js", alias);
    expect(await realpath(alias)).toBe(await realpath(f.file));
    expect(isDirectCliEntrypoint(kind === "module-link" ? pathToFileURL(alias).href : f.moduleUrl,
      kind === "argv-link" ? alias : f.file)).toBe(true);
  });

  it.each(["argv-current", "module-current"] as const)("matches a versioned directory current symlink in the %s position", async (kind) => {
    const f = await fixture();
    const directory = join(f.root, "release with spaces # ? %");
    await mkdir(directory); await writeFile(join(directory, "command.js"), "// never executed\n");
    await symlink("release with spaces # ? %", join(f.root, "current"));
    const canonical = join(directory, "command.js"), alias = join(f.root, "current", "command.js");
    expect(await realpath(alias)).toBe(await realpath(canonical));
    expect(isDirectCliEntrypoint(pathToFileURL(kind === "module-current" ? alias : canonical).href,
      kind === "argv-current" ? alias : canonical)).toBe(true);
  });

  it("matches a bounded chain of existing file aliases", async () => {
    const f = await fixture();
    await symlink("entry.js", join(f.root, "first.js"));
    await symlink("first.js", join(f.root, "second.js"));
    expect(isDirectCliEntrypoint(f.moduleUrl, join(f.root, "second.js"))).toBe(true);
  });

  it("rejects an unrelated existing regular argv file rather than equating byte-identical contents", async () => {
    const f = await fixture();
    const unrelated = join(f.root, "other.js");
    await writeFile(unrelated, await readFile(f.file));
    expect(isDirectCliEntrypoint(f.moduleUrl, unrelated)).toBe(false);
  });

  it("rejects an identical canonical directory identity because an entrypoint must be a regular file", async () => {
    const f = await fixture();
    expect(isDirectCliEntrypoint(pathToFileURL(f.root).href, f.root)).toBe(false);
  });

  it.each(["module-missing", "argv-missing"] as const)("fails closed for %s without throwing or executing anything", async (kind) => {
    const f = await fixture();
    const missing = join(f.root, "absent.js");
    expect(isDirectCliEntrypoint(kind === "module-missing" ? pathToFileURL(missing).href : f.moduleUrl,
      kind === "argv-missing" ? missing : f.file)).toBe(false);
  });

  it.each(["http", "https", "data", "node", "relative", "invalid-escape", "remote-file-host", "query", "fragment"] as const)(
    "rejects a malformed or non-plain-file module URL (%s)", async (kind) => {
      const f = await fixture();
      const urls = { http: "http://example.invalid/entry.js", https: "https://example.invalid/entry.js",
        data: "data:text/javascript,export{}", node: "node:fs", relative: "entry.js",
        "invalid-escape": f.moduleUrl.replace("entry.js", "%ZZ.js"),
        "remote-file-host": `file://not-localhost${new URL(f.moduleUrl).pathname}`,
        query: `${f.moduleUrl}?attempt=1`, fragment: `${f.moduleUrl}#entry` };
      expect(isDirectCliEntrypoint(urls[kind], f.file)).toBe(false);
    });

  it.each(["dangling", "loop"] as const)("fails closed on a %s symlink without hanging", async (kind) => {
    const f = await fixture();
    const path = join(f.root, "invalid-link.js");
    await symlink(kind === "loop" ? "invalid-link.js" : "absent.js", path);
    expect(isDirectCliEntrypoint(pathToFileURL(path).href, path)).toBe(false);
  });

  it.each(["null", "number", "boolean", "object", "array"] as const)("rejects non-string argv %s instead of coercing it into a file identity", async (kind) => {
    const f = await fixture();
    const values = { null: null, number: 0, boolean: false, object: { toString: () => f.file }, array: [f.file] };
    expect(isDirectCliEntrypoint(f.moduleUrl, values[kind] as unknown as string)).toBe(false);
  });

  it.each(["null", "number", "boolean", "object", "array"] as const)("rejects non-string module URL %s instead of coercing it", async (kind) => {
    const f = await fixture();
    const values = { null: null, number: 0, boolean: false, object: { toString: () => f.moduleUrl }, array: [f.moduleUrl] };
    expect(isDirectCliEntrypoint(values[kind] as unknown as string, f.file)).toBe(false);
  });

  it("rejects empty/NUL argv and does not mistake the current test runner's default argv for an unrelated fixture", async () => {
    const f = await fixture();
    expect(isDirectCliEntrypoint(f.moduleUrl, "")).toBe(false);
    expect(isDirectCliEntrypoint(f.moduleUrl, "\u0000")).toBe(false);
    expect(isDirectCliEntrypoint(f.moduleUrl, undefined)).toBe(false);
    expect(isDirectCliEntrypoint(f.moduleUrl)).toBe(false);
  });
});
