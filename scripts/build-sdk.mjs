import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_ROOT = resolve(ROOT, "packages/sdk");
const DIST = resolve(SDK_ROOT, "dist");
const TSC = resolve(ROOT, "node_modules/typescript/bin/tsc");

// A package archive must never retain JavaScript or declarations for a source file that was deleted.
await rm(DIST, { recursive: true, force: true });
execFileSync(process.execPath, [TSC, "-b", resolve(SDK_ROOT, "tsconfig.json"), "--force"], {
  cwd: ROOT,
  stdio: "inherit",
});
