import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Edge { path: string; kind: string; external?: boolean; original?: string }
interface Metafile {
  inputs: Record<string, { imports: Edge[] }>;
  outputs: Record<string, { imports: Edge[] }>;
}
interface Policy {
  canonicalMetafileInputs(metafile: Metafile, workingDirectory: string): Promise<Map<string, string>>;
  bundledDependencyLeaks(options: {
    metafile: Metafile; inputRealpaths: Map<string, string>; bundledPackageRoots: Set<string>; declaredRoots: string[];
  }): { importer: string; specifier: string }[];
}
let policy: Policy;
beforeAll(async () => {
  policy = await import(new URL("../scripts/lib/bundled-dependency-policy.mjs", import.meta.url).href) as Policy;
});
const temporary = new Set<string>();
afterEach(async () => {
  for (const directory of temporary) {
    await rm(directory, { recursive: true, force: true });
    temporary.delete(directory);
  }
});

const ROOT = resolve("/fixture/build");
const SDK = join(ROOT, "node_modules/.pnpm/mcp-client@2.3.1/node_modules/@modelcontextprotocol/client");
const ZOD4 = join(ROOT, "node_modules/.pnpm/zod@4.4.0/node_modules/zod");
const JOSE = join(ROOT, "node_modules/.pnpm/jose@6.2.0/node_modules/jose");
const AWS = join(ROOT, "node_modules/.pnpm/aws-client-s3@3.0.0/node_modules/@aws-sdk/client-s3");
const APP = join(ROOT, "apps/agent-runner/src/main.ts");
const source = (imports: Edge[] = []) => ({ imports });
const external = (path: string): Edge => ({ path, kind: "import-statement", external: true });
const internal = (path: string): Edge => ({ path, kind: "import-statement" });
function audit(metafile: Metafile, bundled = [SDK, ZOD4, JOSE, AWS], paths?: Map<string, string>) {
  return policy.bundledDependencyLeaks({
    metafile, inputRealpaths: paths ?? new Map(Object.keys(metafile.inputs).map(path => [path, path])),
    bundledPackageRoots: new Set(bundled), declaredRoots: ["@aws-sdk/client-s3", "@modelcontextprotocol/client"],
  });
}

describe("source-edge selective dependency closure audit", () => {
  it("permits inlined SDK zod4/jose beside the application's external zod3/jose", () => {
    const sdk = join(SDK, "dist/index.mjs"), zod4 = join(ZOD4, "index.js"), jose = join(JOSE, "index.js");
    const metafile: Metafile = {
      inputs: {
        [APP]: source([external("zod"), external("jose"), internal(sdk)]),
        [sdk]: source([internal(zod4), internal(jose), external("node:crypto")]),
        [zod4]: source(), [jose]: source([external("crypto")]),
      },
      outputs: { "dist/main.js": source([external("zod"), external("jose"), external("node:crypto")]) },
    };
    expect(audit(metafile)).toEqual([]);
  });

  it("still rejects the SDK's external zod edge even when the app's same-name edge is valid", () => {
    const sdk = join(SDK, "dist/index.mjs");
    const metafile: Metafile = {
      inputs: { [APP]: source([external("zod")]), [sdk]: source([external("zod")]) },
      outputs: { "dist/main.js": source([external("zod")]) },
    };
    expect(audit(metafile)).toEqual([{ importer: sdk, specifier: "zod" }]);
  });

  it("rejects a transitive bundled package's leak without relying on a known package-name set", () => {
    const zod4 = join(ZOD4, "index.js");
    const metafile: Metafile = {
      inputs: { [APP]: source([external("new-helper")]), [zod4]: source([external("new-helper")]) },
      outputs: { "dist/main.js": source([external("new-helper")]) },
    };
    expect(audit(metafile)).toEqual([{ importer: zod4, specifier: "new-helper" }]);
  });

  it("preserves the AWS closure guard for an external Smithy dependency", () => {
    const aws = join(AWS, "dist-es/index.js");
    const metafile: Metafile = {
      inputs: { [aws]: source([external("@smithy/smithy-client")]) },
      outputs: { "dist/main.js": source([external("@smithy/smithy-client")]) },
    };
    expect(audit(metafile)).toEqual([{ importer: aws, specifier: "@smithy/smithy-client" }]);
  });

  it.each(["@modelcontextprotocol/client", "@modelcontextprotocol/client/_shims", "@aws-sdk/client-s3"])
    ("never permits an explicit root/subpath external from a workspace: %s", (specifier) => {
      const metafile: Metafile = { inputs: { [APP]: source([external(specifier)]) }, outputs: {} };
      expect(audit(metafile, [])).toEqual([{ importer: APP, specifier }]);
    });

  it("keeps a final-output explicit-root guard even without a surviving input edge", () => {
    const metafile: Metafile = {
      inputs: { [APP]: source() }, outputs: { "dist/main.js": source([external("@modelcontextprotocol/client")]) },
    };
    expect(audit(metafile, [])).toEqual([{ importer: "dist/main.js", specifier: "@modelcontextprotocol/client" }]);
  });

  it("also checks an explicit original root when an external edge has been rewritten", () => {
    const metafile: Metafile = {
      inputs: { [APP]: source([{ ...external("unexpected-external"), original: "@modelcontextprotocol/client" }]) }, outputs: {},
    };
    expect(audit(metafile, [])).toEqual([{ importer: APP, specifier: "unexpected-external" }]);
  });

  it.each(["node:crypto", "crypto", "fs/promises", "node:fs/promises"])("permits actual Node builtin %s", (specifier) => {
    const sdk = join(SDK, "dist/index.mjs");
    expect(audit({ inputs: { [sdk]: source([external(specifier)]) }, outputs: {} })).toEqual([]);
  });

  it.each(["node:not-a-real-module", "./left-behind.js", "/external/runtime.js"])
    ("rejects non-builtin runtime escape from a bundled source: %s", (specifier) => {
      const sdk = join(SDK, "dist/index.mjs");
      expect(audit({ inputs: { [sdk]: source([external(specifier)]) }, outputs: {} }))
        .toEqual([{ importer: sdk, specifier }]);
    });

  it("does not confuse similarly-prefixed physical package roots or package names", () => {
    const sibling = `${SDK}-different/dist/index.mjs`;
    expect(audit({ inputs: { [sibling]: source([external("jose"), external("@modelcontextprotocol/client-other")]) }, outputs: {} }))
      .toEqual([]);
  });

  it("uses the canonical source identity through a real symlink instead of guessing pnpm path spelling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-service-build-edge-test-")); temporary.add(directory);
    const actualRoot = join(directory, "cache/node_modules/@modelcontextprotocol/client");
    const alias = join(directory, "workspace/node_modules/@modelcontextprotocol/client");
    await mkdir(join(actualRoot, "dist"), { recursive: true });
    await mkdir(join(directory, "workspace/node_modules/@modelcontextprotocol"), { recursive: true });
    await writeFile(join(actualRoot, "dist/index.mjs"), "export {};\n");
    await symlink(actualRoot, alias, "dir");
    const canonicalRoot = await realpath(actualRoot);
    const input = "workspace/node_modules/@modelcontextprotocol/client/dist/index.mjs";
    const metafile: Metafile = { inputs: { [input]: source([external("zod")]) }, outputs: {} };
    const paths = await policy.canonicalMetafileInputs(metafile, directory);
    expect(paths.get(input)).toBe(join(canonicalRoot, "dist/index.mjs"));
    expect(audit(metafile, [canonicalRoot], paths)).toEqual([{ importer: join(canonicalRoot, "dist/index.mjs"), specifier: "zod" }]);
  });

  it("does not silently skip an input with no canonical source mapping", () => {
    expect(() => audit({ inputs: { [APP]: source([external("zod")]) }, outputs: {} }, [], new Map()))
      .toThrow("Invalid bundled dependency audit metadata.");
  });
});
