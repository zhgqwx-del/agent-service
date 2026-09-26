// Lightweight repository secret gate. It scans tracked plus non-ignored untracked files and reports
// only locations/rule names, never the matching value.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const rules = [
  { name: "sk-style API token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub classic token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const findings = [];
for (const file of files) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  if (bytes.includes(0)) continue;
  const lines = bytes.toString("utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of rules) {
      if (rule.pattern.test(lines[index])) findings.push(`${file}:${index + 1}: ${rule.name}`);
    }
  }
}

if (findings.length) {
  console.error("possible secrets found (values suppressed):");
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}
console.log(`secret scan passed (${files.length} files)`);
