#!/usr/bin/env node
// The GitHub needs context is CI outcome data, not application or release signing authority.
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CI_REQUIRED_JOBS = Object.freeze(["test-core", "test-history", "image"]);
const MAX_BYTES = 16 * 1024;
const failed = () => new Error("CI required jobs failed");

function dataFields(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failed();
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || key === "__proto__" || !descriptor?.enumerable
      || !Object.hasOwn(descriptor, "value")) throw failed();
    fields[key] = descriptor.value;
  }
  return fields;
}
function exact(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

/** No caller-selected job list: adding a CI job requires updating this closed gate and its policy. */
export function assertCiRequiredJobs(value) {
  try {
    const jobs = dataFields(value);
    if (!exact(jobs, CI_REQUIRED_JOBS)) throw failed();
    for (const name of CI_REQUIRED_JOBS) {
      const job = dataFields(jobs[name]);
      if (!exact(job, ["result", "outputs"]) || job.result !== "success") throw failed();
      const outputs = dataFields(job.outputs);
      if (Object.values(outputs).some((output) => typeof output !== "string")) throw failed();
    }
    return CI_REQUIRED_JOBS;
  } catch { throw failed(); }
}

// Reject duplicate keys including escaped spellings. JSON.parse remains the grammar authority;
// this bounded lexical pass cannot silently turn an earlier failure into a later success.
function uniqueKeys(text) {
  const tokens = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\s+/gy;
  const stack = [];
  let at = 0;
  while (at < text.length) {
    tokens.lastIndex = at;
    const token = tokens.exec(text)?.[0];
    if (token === undefined) throw failed();
    at = tokens.lastIndex;
    if (/^\s+$/.test(token)) continue;
    if (token === "{" || token === "[") {
      if (stack.length >= 128) throw failed();
      stack.push({ object: token === "{", keyExpected: token === "{", keys: new Set() });
    } else if (token === "}" || token === "]") {
      if (stack.pop()?.object !== (token === "}")) throw failed();
    } else if (token === ",") {
      if (stack.at(-1)?.object) stack.at(-1).keyExpected = true;
    } else if (token.startsWith('"') && stack.at(-1)?.object && stack.at(-1).keyExpected) {
      const key = JSON.parse(token), frame = stack.at(-1);
      if (frame.keys.has(key)) throw failed();
      frame.keys.add(key); frame.keyExpected = false;
    }
  }
  if (stack.length !== 0) throw failed();
}

export function parseCiRequiredJobsResults(text) {
  try {
    if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_BYTES) throw failed();
    uniqueKeys(text);
    return assertCiRequiredJobs(JSON.parse(text));
  } catch { throw failed(); }
}

export function isDirectCiRequiredJobsEntrypoint(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof importMetaUrl !== "string" || typeof argv1 !== "string" || argv1 === "") return false;
  try {
    const url = new URL(importMetaUrl);
    if (url.protocol !== "file:" || url.search !== "" || url.hash !== "") return false;
    const module = realpathSync(fileURLToPath(url)), invoked = realpathSync(argv1);
    return module === invoked && statSync(module).isFile();
  } catch { return false; }
}

export function main(args = process.argv.slice(2)) {
  try {
    if (Number(process.versions.node.split(".")[0]) !== 24 || !Array.isArray(args) || args.length !== 0) throw failed();
    parseCiRequiredJobsResults(process.env.AGENT_SERVICE_CI_NEEDS_JSON);
    process.stdout.write("CI required jobs passed\n");
    return 0;
  } catch {
    process.stderr.write("CI required jobs failed\n");
    return 1;
  }
}
if (isDirectCiRequiredJobsEntrypoint(import.meta.url)) process.exitCode = main();
