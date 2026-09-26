// The MySQL/Redis conformance suite and the dialect suite skip themselves when their environment is
// missing. A misconfigured CI job would then pass with a large part of the suite silently absent, so
// assert on the coverage summary that the code they exercise was actually executed.
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summary = JSON.parse(await readFile(resolve(ROOT, "coverage/coverage-summary.json"), "utf8"));

const required = [
  ["packages/store/src/mysql/store.ts", 40, "MySQL store — set AGENT_SERVICE_INTEGRATION=1 and MYSQL_TEST_URL"],
  ["packages/store/src/redis/lease.ts", 40, "Redis lease — set AGENT_SERVICE_INTEGRATION=1 and REDIS_TEST_URL"],
  ["packages/core/src/engine/pi.ts", 30, "PiEngine — the dialect tests against the fake vendor must run"],
];

let failed = false;
for (const [file, minLines, hint] of required) {
  const key = Object.keys(summary).find((k) => k.endsWith(file));
  const pct = key ? summary[key].lines.pct : 0;
  if (pct < minLines) {
    console.error(`✗ ${file}: ${pct}% line coverage (expected ≥ ${minLines}%). ${hint}`);
    failed = true;
  } else {
    console.log(`✓ ${file}: ${pct}%`);
  }
}
process.exit(failed ? 1 : 0);
