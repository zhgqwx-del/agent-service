import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_ROOT = resolve(ROOT, "packages/sdk");

execFileSync(process.execPath, [resolve(ROOT, "scripts/build-sdk.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});

const temp = await mkdtemp(resolve(tmpdir(), "agent-service-sdk-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", temp, "--config.ignore-scripts=true"], {
    cwd: SDK_ROOT,
    stdio: "pipe",
  });
  const archive = (await readdir(temp)).find((name) => name.endsWith(".tgz"));
  if (!archive) throw new Error("pnpm pack did not produce an SDK archive");
  const listing = execFileSync("tar", ["-tzf", resolve(temp, archive)], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const required of [
    "package/package.json",
    "package/README.md",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/generated/schema.d.ts",
  ]) {
    if (!listing.includes(required)) throw new Error(`SDK archive is missing ${required}`);
  }
  if (listing.some((entry) => entry.startsWith("package/src/"))) {
    throw new Error("SDK archive unexpectedly contains TypeScript sources");
  }

  // Extract the real archive into an isolated package root. Copy only dependencies declared by the
  // packed manifest (and their declared transitives) from the already locked/installed workspace;
  // this stays offline while a missing declaration still makes the package-name import fail.
  const archivePath = resolve(temp, archive);
  const consumer = resolve(temp, "consumer");
  await mkdir(consumer, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", consumer, "--strip-components=1"], { stdio: "pipe" });
  const packedManifest = JSON.parse(await readFile(resolve(consumer, "package.json"), "utf8"));
  const sdkRequire = createRequire(resolve(SDK_ROOT, "package.json"));
  const installed = new Set();
  const findPackageRoot = async (name, entry) => {
    let directory = dirname(entry);
    for (;;) {
      try {
        const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
        if (manifest.name === name) return { directory, manifest };
      } catch {
        // Keep walking from an exported entry to its owning package root.
      }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`cannot find installed package root for ${name}`);
      directory = parent;
    }
  };
  const installDeclared = async (name, requested, resolver) => {
    if (installed.has(name)) return;
    installed.add(name);
    const found = await findPackageRoot(name, resolver.resolve(name));
    if (/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(requested) && found.manifest.version !== requested) {
      throw new Error(`packed SDK requests ${name}@${requested}, but the locked workspace has ${found.manifest.version}`);
    }
    const destination = resolve(consumer, "node_modules", ...name.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(found.directory, destination, { recursive: true, dereference: true });
    const dependencyResolver = createRequire(resolve(found.directory, "package.json"));
    for (const [dependency, range] of Object.entries(found.manifest.dependencies ?? {})) {
      await installDeclared(dependency, String(range), dependencyResolver);
    }
  };
  for (const [dependency, range] of Object.entries(packedManifest.dependencies ?? {})) {
    await installDeclared(dependency, String(range), sdkRequire);
  }

  await writeFile(resolve(consumer, "smoke.mjs"), `
import * as sdk from "@agent-service/sdk";
for (const name of [
  "createAgentServiceClient",
  "startTurnStream",
  "subscribeSessionEvents",
  "uploadSessionBlob",
  "readSessionBlob",
  "readItemOutput",
  "parseSse",
]) {
  if (typeof sdk[name] !== "function") throw new Error(\`installed SDK does not export \${name}\`);
}
`);
  execFileSync(process.execPath, [resolve(consumer, "smoke.mjs")], { cwd: consumer, stdio: "pipe" });

  await writeFile(resolve(consumer, "smoke.ts"), `
import {
  createAgentServiceClient,
  readItemOutput,
  readSessionBlob,
  uploadSessionBlob,
  type AgentServiceEvent,
  type ExcludableEventType,
} from "@agent-service/sdk";
const client = createAgentServiceClient({ baseUrl: "http://127.0.0.1:8080" });
const event = null as unknown as AgentServiceEvent;
const excluded: ExcludableEventType = "heartbeat";
const request = { baseUrl: "http://127.0.0.1:8080" };
const uploaded = uploadSessionBlob(request, "sess_example", new Uint8Array([1]), "image/png");
const downloaded = readSessionBlob(request, "sess_example", "blob_example");
const output = readItemOutput(request, "sess_example", "item_example");
void [client, event, excluded, uploaded, downloaded, output];
`);
  await writeFile(resolve(consumer, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2024",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ["smoke.ts"],
  }, null, 2)}\n`);
  execFileSync(process.execPath, [resolve(ROOT, "node_modules/typescript/bin/tsc"), "-p", resolve(consumer, "tsconfig.json")], {
    cwd: consumer,
    stdio: "pipe",
  });
  console.log(`installed SDK runtime/types and package archive verified (${listing.length} files)`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
