// Bundle an app into a single ESM file that plain `node` can run.
//
// Why bundle: workspace packages expose TypeScript sources (`main: src/index.ts`) with `.js` import
// specifiers, which only a loader like tsx can resolve. Production must not depend on a loader, so we
// inline workspace packages, selectively bundle pure-JavaScript runtime closures, and leave the
// remaining third-party dependencies external.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.argv[2];
if (!app) throw new Error("usage: node scripts/build-app.mjs <apps/dir-name>");

// Pure-JavaScript dependencies used from an inlined workspace package must travel with the bundle.
// Otherwise their bare import is relocated from packages/<workspace>/src to apps/<app>/dist and can
// no longer resolve from the declaring workspace package's node_modules tree. Keep this list narrow:
// server dependencies such as mysql2 and ioredis intentionally remain external and are supplied by
// the app's production node_modules tree.
const BUNDLED_DEPENDENCY_ROOTS = ["@aws-sdk/client-s3"];

function matchesPackageRoot(specifier, root) {
  return specifier === root || specifier.startsWith(`${root}/`);
}

function packageRootForPath(path) {
  const marker = `${sep}node_modules${sep}`;
  const markerIndex = path.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const packageParts = path.slice(markerIndex + marker.length).split(sep);
  const partCount = packageParts[0]?.startsWith("@") ? 2 : 1;
  if (packageParts.length < partCount) return undefined;
  return path.slice(0, markerIndex + marker.length)
    + packageParts.slice(0, partCount).join(sep);
}

/**
 * Inline our workspace packages plus the complete dependency closure of explicitly bundled,
 * pure-JavaScript packages. Every other bare specifier stays external and is resolved from the
 * deployed app's node_modules tree.
 */
const externalizeThirdParty = {
  name: "externalize-third-party",
  setup(b) {
    const bundledPackageRoots = new Set();
    const bundledBareSpecifiers = new Set(BUNDLED_DEPENDENCY_ROOTS);

    b.onResolve({ filter: /^[^./]|^\.\.?\//, namespace: "file" }, async (args) => {
      if (args.pluginData?.skipThirdPartyPolicy === true) return null;
      if (args.kind === "entry-point") return null;
      const bare = !args.path.startsWith(".") && !args.path.startsWith("/");
      if (!bare) return null;
      if (args.path.startsWith("node:")) return { path: args.path, external: true };
      if (args.path.startsWith("@agent-service/")) return null; // inline ours

      const importerIsBundled = [...bundledPackageRoots].some((root) => (
        args.importer === root || args.importer.startsWith(`${root}${sep}`)
      ));
      const dependencyIsBundled = BUNDLED_DEPENDENCY_ROOTS.some((root) => (
        matchesPackageRoot(args.path, root)
      ));
      if (dependencyIsBundled || importerIsBundled) {
        const resolvedDependency = await b.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: { skipThirdPartyPolicy: true },
          with: args.with,
        });
        if (resolvedDependency.errors.length > 0) {
          return { errors: resolvedDependency.errors, warnings: resolvedDependency.warnings };
        }
        if (resolvedDependency.external) {
          return {
            path: resolvedDependency.path,
            external: true,
            warnings: resolvedDependency.warnings,
          };
        }
        const packageRoot = packageRootForPath(resolvedDependency.path);
        if (packageRoot) bundledPackageRoots.add(packageRoot);
        bundledBareSpecifiers.add(args.path);
        return {
          path: resolvedDependency.path,
          namespace: resolvedDependency.namespace,
          suffix: resolvedDependency.suffix,
          sideEffects: resolvedDependency.sideEffects,
          warnings: resolvedDependency.warnings,
        };
      }
      return { path: args.path, external: true };
    });

    b.onEnd((result) => {
      if (!result.metafile) return;
      const leakedImports = Object.values(result.metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((entry) => entry.external && [...bundledBareSpecifiers].some((specifier) => (
          matchesPackageRoot(entry.path, specifier)
          || matchesPackageRoot(specifier, entry.path)
        )))
        .map((entry) => entry.path);
      if (leakedImports.length > 0) {
        return {
          errors: [{
            text: `bundled dependency closure leaked runtime imports: ${[...new Set(leakedImports)].join(", ")}`,
          }],
        };
      }
      return undefined;
    });
  },
};

const distDir = resolve(ROOT, "apps", app, "dist");
const entryPoints = {
  main: resolve(ROOT, "apps", app, "src", "main.ts"),
  ...(app === "agent-runner"
    ? {
        "blob-storage-migrate": resolve(ROOT, "apps", app, "src", "blob-storage-migrate.ts"),
        "restore-ledger-reconcile": resolve(
          ROOT,
          "apps",
          app,
          "src",
          "restore-ledger-reconcile.ts",
        ),
        "backup-catalog": resolve(ROOT, "apps", app, "src", "backup-catalog.ts"),
      }
    : {}),
};
// Clean first: a stale artefact, or a migration deleted since the last build, must not ship.
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
const result = await build({
  entryPoints,
  outdir: distDir,
  entryNames: "[name]",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Prefer the ESM entry of selectively bundled dependencies. Bundling their CommonJS entry into
  // an ESM application would leave esbuild's dynamic require shim unable to load Node built-ins.
  mainFields: ["module", "main"],
  // A linked map keeps the bundle clean; sourcesContent:false keeps the TypeScript sources out of the image.
  sourcemap: "linked",
  sourcesContent: false,
  external: ["node:*"],
  plugins: [externalizeThirdParty],
  logLevel: "warning",
  metafile: true,
});
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
await writeFile(resolve(distDir, "package.json"), JSON.stringify({ type: "module" }, null, 2));
// The store reads its .sql migrations at runtime; ship them beside the bundle.
await cp(resolve(ROOT, "packages/store/migrations"), resolve(distDir, "migrations"), { recursive: true });
const artifacts = Object.keys(entryPoints).map((name) => `${name}.js`).join(", ");
console.log(`built apps/${app}/dist/{${artifacts}} (${(bytes / 1024).toFixed(0)} KB) + migrations/`);
