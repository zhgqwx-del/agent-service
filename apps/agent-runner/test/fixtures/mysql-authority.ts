import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createMysqlAuthorityCliExecutor } from "../../../../test/fixtures/mysql-authority-cli.mjs";

/** Explicit source-only native fixture adapter. Construct only inside an owned fresh-DB
 * bootstrap. It runs the selected real product authority CLI; no synthetic admission, runtime
 * operator fallback, image/dist inference or protected environment defaults are provided. */
export function createSourceAuthorityExecutor(): ReturnType<typeof createMysqlAuthorityCliExecutor> {
  return createMysqlAuthorityCliExecutor({
    entrypoint: fileURLToPath(new URL("../../src/main.ts", import.meta.url)), mode: "source",
    cwd: resolve(fileURLToPath(new URL("../../../../", import.meta.url))),
  });
}
