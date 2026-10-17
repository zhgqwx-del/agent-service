import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/client";
import { ApiError, Principal } from "@agent-service/protocol";
import type { ToolResult } from "../tools/types.js";
export type Server = Readonly<{ id: string; endpoint: string; subjects: readonly Readonly<Principal>[] }>;
export type Snapshot = Readonly<{ wire: Tool; identity: string; name: string; description: string; parameters: Record<string, unknown> }>;
const MESSAGE = "MCP request failed.";
const MAX_SCHEMA = 16_384, MAX_RESULT = 65_536, MAX_REQUEST = 32_768;
const ownerKey = (p: Principal) => JSON.stringify([p.tenantId, p.userId]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function bad(): never { throw new Error(MESSAGE); }
function unavailable(): ApiError { return new ApiError("draining", MESSAGE, undefined, true); }
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) bad();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(d => !("value" in d) || !d.enumerable)) bad();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) bad();
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, d]) => key !== "length" && (!("value" in d) || !d.enumerable))) bad();
  return value;
}
function text(value: unknown, maximum: number, allowEmpty = true): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum || (!allowEmpty && !value)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) bad();
  return value;
}
/** Bounded plain JSON only: no accessors, cycles, prototypes, callable values or URI traversal. */
function json(value: unknown, maximum: number): string {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): string => {
    if (++nodes > 2048 || depth > 12) bad();
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "string") { if (Buffer.byteLength(v) > maximum) bad(); return JSON.stringify(v); }
    if (typeof v === "number") { if (!Number.isFinite(v)) bad(); return JSON.stringify(v); }
    if (typeof v !== "object" || seen.has(v)) bad();
    seen.add(v);
    let output: string;
    if (Array.isArray(v)) {
      array(v); if (v.length > 512) bad();
      output = `[${v.map(child => visit(child, depth + 1)).join(",")}]`;
    } else {
      const record = plain(v), names = Object.keys(record).sort();
      if (names.length > 128 || names.some(key => ["__proto__", "prototype", "constructor"].includes(key))) bad();
      output = `{${names.map(key => `${JSON.stringify(key)}:${visit(record[key], depth + 1)}`).join(",")}}`;
    }
    seen.delete(v); return output;
  };
  const result = visit(value, 0); if (Buffer.byteLength(result) > maximum) bad(); return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function principal(value: Principal): Readonly<Principal> {
  const raw = plain(value); keys(raw, ["tenantId", "userId"], ["tenantId", "userId"]);
  // Shared Principal limits tenant characters, not UTF-8 bytes; still bound text before parsing.
  const result = Principal.safeParse({ tenantId: text(raw.tenantId, 512, false), userId: text(raw.userId, 128, false) });
  if (!result.success) bad();
  return Object.freeze(result.data);
}
/** Deliberately finite JSON-Schema subset. $ref/$dynamicRef, patterns, external
 * formats, composition, extensions (including x-mcp-header) and task schemas are rejected. */
function schema(value: unknown): Record<string, unknown> {
  json(value, MAX_SCHEMA); let count = 0;
  const visit = (v: unknown, depth: number) => {
    if (++count > 256 || depth > 8) bad();
    const r = plain(v);
    keys(r, ["type", "description", "title", "properties", "required", "additionalProperties", "items",
      "enum", "const", "default", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"], ["type"]);
    if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(r.type))) bad();
    for (const field of ["description", "title"]) if (r[field] !== undefined) text(r[field], 2048);
    for (const field of ["minimum", "maximum"]) if (r[field] !== undefined && (typeof r[field] !== "number" || !Number.isFinite(r[field]))) bad();
    for (const field of ["minLength", "maxLength", "minItems", "maxItems"]) {
      if (r[field] !== undefined && (!Number.isSafeInteger(r[field]) || Number(r[field]) < 0 || Number(r[field]) > 65536)) bad();
    }
    for (const pair of [["minLength", "maxLength"], ["minItems", "maxItems"], ["minimum", "maximum"]]) {
      if (r[pair[0]!] !== undefined && r[pair[1]!] !== undefined && Number(r[pair[0]!]) > Number(r[pair[1]!])) bad();
    }
    if (r.enum !== undefined && (!Array.isArray(r.enum) || r.enum.length < 1 || r.enum.length > 64)) bad();
    if (r.type === "object") {
      const properties = r.properties === undefined ? {} : plain(r.properties);
      if (Object.keys(properties).length > 64) bad();
      for (const [name, child] of Object.entries(properties)) { text(name, 128, false); visit(child, depth + 1); }
      if (r.required !== undefined && (!Array.isArray(r.required) || r.required.length > 64
        || new Set(r.required).size !== r.required.length || r.required.some(name => typeof name !== "string" || !Object.hasOwn(properties, name)))) bad();
      if (r.additionalProperties !== undefined && typeof r.additionalProperties !== "boolean") bad();
    } else if (r.properties !== undefined || r.required !== undefined || r.additionalProperties !== undefined) bad();
    if (r.type === "array") { if (r.items === undefined) bad(); visit(r.items, depth + 1); }
    else if (r.items !== undefined) bad();
  };
  visit(value, 0); return JSON.parse(json(value, MAX_SCHEMA)) as Record<string, unknown>;
}
function validArguments(value: unknown, s: Record<string, unknown>): void {
  const matches = s.type === "null" ? value === null : s.type === "array" ? Array.isArray(value)
    : s.type === "object" ? !!value && typeof value === "object" && !Array.isArray(value)
      : s.type === "integer" ? typeof value === "number" && Number.isSafeInteger(value) : typeof value === s.type;
  if (!matches || s.enum !== undefined && !(s.enum as unknown[]).some(item => json(item, MAX_REQUEST) === json(value, MAX_REQUEST))
    || Object.hasOwn(s, "const") && json(s.const, MAX_REQUEST) !== json(value, MAX_REQUEST)) bad();
  if (typeof value === "string" && ((s.minLength !== undefined && [...value].length < Number(s.minLength))
    || s.maxLength !== undefined && [...value].length > Number(s.maxLength))) bad();
  if (typeof value === "number" && ((s.minimum !== undefined && value < Number(s.minimum))
    || s.maximum !== undefined && value > Number(s.maximum))) bad();
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < Number(s.minItems) || s.maxItems !== undefined && value.length > Number(s.maxItems)) bad();
    value.forEach(child => validArguments(child, s.items as Record<string, unknown>));
  } else if (s.type === "object") {
    const record = plain(value), properties = (s.properties ?? {}) as Record<string, Record<string, unknown>>;
    if ((s.required as string[] | undefined)?.some(key => !Object.hasOwn(record, key))) bad();
    for (const [key, child] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) validArguments(child, properties[key]!);
      else if (s.additionalProperties === false) bad();
    }
  }
}
function snapshot(server: Server, value: unknown): Snapshot {
  const r = plain(value);
  keys(r, ["name", "description", "title", "inputSchema", "outputSchema", "annotations"], ["name", "inputSchema"]);
  const name = text(r.name, 128, false); if (!/^[A-Za-z0-9_.-]+$/.test(name)) bad();
  const description = text(r.description ?? "", 2048);
  if (r.title !== undefined) text(r.title, 256);
  const parameters = schema(r.inputSchema); if (parameters.type !== "object") bad();
  if (r.outputSchema !== undefined) schema(r.outputSchema);
  if (r.annotations !== undefined) {
    const annotations = plain(r.annotations);
    keys(annotations, ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]);
    for (const [key, value] of Object.entries(annotations)) {
      if (key === "title") text(value, 256); else if (typeof value !== "boolean") bad();
    }
  }
  const wire = freeze(JSON.parse(json(r, 24_576)) as Tool);
  const identity = hash(json({ server, wire }, 65_536));
  return freeze({ wire, identity, parameters, name, description });
}
function toolName(serverId: string, remoteName: string): string {
  const safe = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 10);
  return `mcp__${safe(serverId)}__${safe(remoteName)}_${hash(JSON.stringify([serverId, remoteName])).slice(0, 32)}`;
}
function toolResult(value: unknown): ToolResult {
  const r = plain(value); keys(r, ["content", "structuredContent", "isError", "_meta", "resultType"]);
  if (r.resultType !== undefined && r.resultType !== "complete") bad();
  if (r.isError !== undefined && typeof r.isError !== "boolean") bad();
  if (r.isError === true) bad();
  const parts = r.content === undefined ? [] : array(r.content); if (parts.length > 64) bad();
  const content: { type: "text"; text: string }[] = [];
  for (const part of parts) { const p = plain(part); keys(p, ["type", "text"], ["type", "text"]); if (p.type !== "text") bad(); content.push({ type: "text", text: text(p.text, MAX_RESULT) }); }
  if (r.structuredContent !== undefined) content.push({ type: "text", text: json(r.structuredContent, MAX_RESULT) });
  if (!content.length) bad(); json(content, MAX_RESULT);
  return { content };
}
function cacheMetadata(value: Record<string, unknown>, required: boolean): void {
  if (required && (!Object.hasOwn(value, "ttlMs") || !Object.hasOwn(value, "cacheScope"))) bad();
  if (value.ttlMs !== undefined && (!Number.isSafeInteger(value.ttlMs) || Number(value.ttlMs) < 0)) bad();
  if (value.cacheScope !== undefined && value.cacheScope !== "public" && value.cacheScope !== "private") bad();
  if (value.resultType !== undefined && value.resultType !== "complete") bad();
}
export { plain, keys, array, text, json, freeze, principal, schema, validArguments, snapshot, toolName, toolResult, cacheMetadata, ownerKey, hash };
