import { isAbsolute, normalize, parse, sep } from "node:path";
import { Principal } from "@agent-service/protocol";
import type { StaticSkillMount } from "@agent-service/core";

const MESSAGE = "Invalid static skills operator configuration";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
function bad(): never { throw new Error(MESSAGE); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) bad();
  return value as Record<string, unknown>;
}
function ownerText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f<>]/.test(value)) bad();
  return value;
}
/** JSON.parse remains the syntax authority; additionally reject duplicate keys,
 * including escaped spellings, rather than silently changing an operator ACL. */
function uniqueKeys(raw: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "{" || c === "[") { stack.push(c === "{" ? new Set() : null); if (stack.length > 12) bad(); }
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      const start = i;
      for (i++; i < raw.length; i++) { if (raw[i] === "\\") i++; else if (raw[i] === '"') break; }
      let next = i + 1; while (/\s/.test(raw[next] ?? "") && next < raw.length) next++;
      if (raw[next] === ":") {
        const keys = stack.at(-1); if (!keys) bad();
        const key: unknown = JSON.parse(raw.slice(start, i + 1)); if (typeof key !== "string" || keys.has(key)) bad(); keys.add(key);
      }
    }
  }
}

/** Pure operator-config parser only. It does not read env, resolve paths, open
 * SKILL.md, import code or accept credentials, URLs, executable resource paths
 * or wildcard subjects. The source independently checks real filesystem paths. */
export function parseStaticSkillsConfig(raw: string | undefined): readonly StaticSkillMount[] {
  if (raw === undefined) return Object.freeze([]);
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 65_536) bad();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return bad(); }
  uniqueKeys(raw);
  if (!Array.isArray(value) || value.length > 32) bad();
  const ids = new Set<string>();
  const result: StaticSkillMount[] = value.map(entry => {
    const row = object(entry, ["id", "directory", "subjects"]);
    if (typeof row.id !== "string" || !ID.test(row.id) || ids.has(row.id)) bad(); ids.add(row.id);
    const directory = row.directory;
    if (typeof directory !== "string" || Buffer.byteLength(directory) > 4096 || /[\u0000-\u001f\u007f<>\\]/.test(directory)
      || !isAbsolute(directory) || normalize(directory) !== directory || directory === parse(directory).root || directory.endsWith(sep)) bad();
    if (!Array.isArray(row.subjects) || !row.subjects.length || row.subjects.length > 64) bad();
    const subjects = row.subjects.map(entry => {
      const subject = object(entry, ["tenantId", "userId"]);
      const result = Principal.safeParse({ tenantId: ownerText(subject.tenantId, 512), userId: ownerText(subject.userId, 128) });
      if (!result.success) bad();
      return Object.freeze(result.data);
    });
    if (new Set(subjects.map(subject => JSON.stringify([subject.tenantId, subject.userId]))).size !== subjects.length) bad();
    return Object.freeze({ id: row.id, directory, subjects: Object.freeze(subjects) });
  });
  return Object.freeze(result);
}
