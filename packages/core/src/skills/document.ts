import { createHash } from "node:crypto";
import { ApiError } from "@agent-service/protocol";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";

export const SKILL_PARSER_PROFILE = "skill-markdown-v1" as const;
export const MAX_SKILL_DOCUMENT_BYTES = 65_536;
export const MAX_SKILL_BODY_BYTES = 32_768;
export interface SkillDocumentMetadata {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string | null;
  readonly disableModelInvocation: boolean;
  readonly userInvocable: boolean;
  readonly dependencies: Readonly<{ tools: readonly string[] }>;
}
export interface ParsedSkillDocument {
  readonly metadata: SkillDocumentMetadata;
  readonly body: string;
  /** Exact whole-document bytes, not a digest reconstructed from the body. */
  readonly contentSha256: string;
  readonly sizeBytes: number;
}
const MESSAGE = "Skill request failed.";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function bad(): never { throw new ApiError("invalid_request", MESSAGE); }
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) bad();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable)) bad();
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) bad();
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r\n\t<>]/.test(value)) bad();
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) bad();
  return value;
}
function summary(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 1024
    || Buffer.from(value, "utf8").toString("utf8") !== value
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f<>]/.test(value)) bad();
  const normalized = value.replace(/[ \t\r\n\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, " ").trim();
  if (!normalized) bad();
  return normalized;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Pure, silent YAML/Markdown parser shared by static and registered skills.
 * Parsing establishes shape and budgets, never trust or executable authority.
 * It reads no file, follows no link and evaluates no template or script. */
export function parseSkillDocument(bytes: Uint8Array): ParsedSkillDocument {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) bad();
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (source.startsWith("\ufeff") || source.includes("\u0000") || /\r(?!\n)/.test(source)) bad();
    const normalized = source.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) bad();
    const end = normalized.indexOf("\n---\n", 4);
    if (end < 0) bad();
    const header = normalized.slice(4, end), body = normalized.slice(end + 5);
    if (Buffer.byteLength(header) > 16_384 || !body.trim() || Buffer.byteLength(body) > MAX_SKILL_BODY_BYTES
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) bad();
    const doc = parseDocument(header, { version: "1.2", schema: "core", strict: true, uniqueKeys: true,
      stringKeys: true, prettyErrors: false, logLevel: "silent", merge: false, resolveKnownTags: false });
    if (doc.errors.length || doc.warnings.length || doc.directives.yaml.explicit || doc.directives.docStart || doc.directives.docEnd
      || Object.keys(doc.directives.tags).some(key => key !== "!!") || !isMap(doc.contents)) bad();
    let nodes = 0;
    visit(doc, (_key, node, path) => {
      if (++nodes > 192 || path.length > 8 || isAlias(node)) bad();
      if ((isMap(node) || isSeq(node) || isScalar(node)) && (node.anchor || node.tag)) bad();
      if (isMap(node)) for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string"
          || ["__proto__", "prototype", "constructor", "<<"].includes(pair.key.value)) bad();
      }
    });
    const raw: unknown = doc.toJS({ maxAliasCount: 0 }), r = plain(raw);
    closed(r, ["name", "description", "whenToUse", "disable-model-invocation", "user-invocable", "metadata", "dependencies"], ["name", "description"]);
    const name = text(r.name, 64); if (!NAME.test(name)) bad();
    const description = summary(r.description), whenToUse = r.whenToUse === undefined ? null : summary(r.whenToUse);
    for (const key of ["disable-model-invocation", "user-invocable"]) if (r[key] !== undefined && typeof r[key] !== "boolean") bad();
    if (r.metadata !== undefined) {
      const metadata = plain(r.metadata); if (Object.keys(metadata).length > 16) bad();
      for (const [key, value] of Object.entries(metadata)) { identifier(key); text(value, 256); }
    }
    const dependencies = r.dependencies === undefined ? {} : plain(r.dependencies);
    closed(dependencies, ["tools"]);
    let tools: string[] = [];
    if (dependencies.tools !== undefined) {
      const value = dependencies.tools;
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 32
        || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length
        || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, d]) => key !== "length" && (!("value" in d) || !d.enumerable))) bad();
      tools = value.map(identifier);
    }
    if (new Set(tools).size !== tools.length) bad();
    tools.sort();
    return freeze({
      metadata: { name, description, whenToUse, disableModelInvocation: r["disable-model-invocation"] === true,
        userInvocable: r["user-invocable"] !== false, dependencies: { tools } },
      body, contentSha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength,
    });
  } catch { return bad(); }
}
