import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Match the directly invoked file across filesystem aliases and release symlinks. */
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
