import { realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";

export function matchesPackageRoot(specifier, root) {
  return specifier === root || specifier.startsWith(`${root}/`);
}

/** Resolve the actual file identity, not a guessed node_modules/symlink spelling. */
export async function canonicalMetafileInputs(metafile, workingDirectory) {
  if (!isAbsolute(workingDirectory) || !metafile?.inputs || !metafile?.outputs) {
    throw new Error("Invalid bundled dependency audit metadata.");
  }
  return new Map(await Promise.all(Object.keys(metafile.inputs).map(async (input) => [
    input, await realpath(resolve(workingDirectory, input)),
  ])));
}

/**
 * Audit external import EDGES, not a global set of package names. A bundled SDK may use zod4
 * while the application legitimately keeps its own zod3 (or jose) external. Only an external
 * edge whose actual importer belongs to the bundled closure is a transitive leak. Explicit
 * bundle roots may never remain external, irrespective of which workspace imports them.
 */
export function bundledDependencyLeaks({ metafile, inputRealpaths, bundledPackageRoots, declaredRoots }) {
  if (!metafile?.inputs || !metafile?.outputs || !(inputRealpaths instanceof Map)
    || !(bundledPackageRoots instanceof Set) || !Array.isArray(declaredRoots)) {
    throw new Error("Invalid bundled dependency audit metadata.");
  }
  const leaks = [];
  const seen = new Set();
  const required = (specifier) => typeof specifier === "string"
    && declaredRoots.some((root) => matchesPackageRoot(specifier, root));
  const record = (importer, specifier) => {
    const key = JSON.stringify([importer, specifier]);
    if (!seen.has(key)) { seen.add(key); leaks.push({ importer, specifier }); }
  };
  for (const [input, source] of Object.entries(metafile.inputs)) {
    const actual = inputRealpaths.get(input);
    if (typeof actual !== "string" || !isAbsolute(actual) || !Array.isArray(source.imports)) {
      throw new Error("Invalid bundled dependency audit metadata.");
    }
    const bundled = [...bundledPackageRoots].some((root) => actual === root || actual.startsWith(`${root}${sep}`));
    for (const edge of source.imports) {
      if (edge.external !== true) continue;
      if (typeof edge.path !== "string") throw new Error("Invalid bundled dependency audit metadata.");
      if (required(edge.path) || required(edge.original) || (bundled && !isBuiltin(edge.path))) record(actual, edge.path);
    }
  }
  // Retain a final-output guard for an explicit root: even a generated/rewritten root import
  // without a surviving source edge must not slip into the relocatable application artifact.
  for (const [output, artifact] of Object.entries(metafile.outputs)) {
    if (!Array.isArray(artifact.imports)) throw new Error("Invalid bundled dependency audit metadata.");
    for (const edge of artifact.imports) if (edge.external === true && required(edge.path)) record(output, edge.path);
  }
  return leaks;
}
