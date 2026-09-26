// Bundle an app into a single ESM file that plain `node` can run.
//
// Why bundle: workspace packages expose TypeScript sources (`main: src/index.ts`) with `.js` import
// specifiers, which only a loader like tsx can resolve. Production must not depend on a loader, so we
// inline the workspace packages and leave real third-party dependencies external.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.argv[2];
if (!app) throw new Error("usage: node scripts/build-app.mjs <apps/dir-name>");

/**
 * Inline only our own workspace packages (`@agent-service/*`). Every other bare specifier stays
 * external and is resolved from node_modules at runtime, which keeps the bundle small and lets native
 * modules (mysql2, ioredis) work normally.
 */
const externalizeThirdParty = {
  name: "externalize-third-party",
  setup(b) {
    b.onResolve({ filter: /^[^./]|^\.\.?\//, namespace: "file" }, (args) => {
      if (args.kind === "entry-point") return null;
      const bare = !args.path.startsWith(".") && !args.path.startsWith("/");
      if (!bare) return null;
      if (args.path.startsWith("@agent-service/")) return null; // inline ours
      return { path: args.path, external: true };
    });
  },
};

const outfile = resolve(ROOT, "apps", app, "dist", "main.js");
// Clean first: a stale artefact, or a migration deleted since the last build, must not ship.
await rm(dirname(outfile), { recursive: true, force: true });
await mkdir(dirname(outfile), { recursive: true });
const result = await build({
  entryPoints: [resolve(ROOT, "apps", app, "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // A linked map keeps the bundle clean; sourcesContent:false keeps the TypeScript sources out of the image.
  sourcemap: "linked",
  sourcesContent: false,
  external: ["node:*"],
  plugins: [externalizeThirdParty],
  logLevel: "warning",
  metafile: true,
});
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
await writeFile(resolve(dirname(outfile), "package.json"), JSON.stringify({ type: "module" }, null, 2));
// The store reads its .sql migrations at runtime; ship them beside the bundle.
await cp(resolve(ROOT, "packages/store/migrations"), resolve(dirname(outfile), "migrations"), { recursive: true });
console.log(`built apps/${app}/dist/main.js (${(bytes / 1024).toFixed(0)} KB) + migrations/`);
