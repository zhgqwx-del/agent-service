import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A one-shot command runs only when Node invoked this actual file as its entrypoint. Compare
 * resolved filesystem identities, not URL spellings: macOS /var and /private/var aliases and
 * versioned VM `current` symlinks can otherwise make an ordinary direct invocation a no-op.
 */
export function isDirectCliEntrypoint(
  importMetaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (typeof importMetaUrl !== "string" || typeof argv1 !== "string" || argv1 === "") return false;
  try {
    const moduleUrl = new URL(importMetaUrl);
    if (moduleUrl.protocol !== "file:" || moduleUrl.search !== "" || moduleUrl.hash !== "") return false;
    const modulePath = realpathSync(fileURLToPath(moduleUrl));
    const invokedPath = realpathSync(argv1);
    return modulePath === invokedPath && statSync(modulePath).isFile() && statSync(invokedPath).isFile();
  } catch {
    return false;
  }
}
