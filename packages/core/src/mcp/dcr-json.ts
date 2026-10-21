/** DCR metadata/results must have one unambiguous identity before SDK parsing.
 * JSON.parse is syntax authority; this bounded lexical walk rejects duplicate
 * and escaped-duplicate object keys at every nesting level, lone UTF-16 surrogates
 * in all decoded strings, and non-finite numeric tokens. It never echoes wire. */
export function parseMcpDcrJson(wire: string, maximum: number): unknown {
  const fail = (): never => { throw new Error("MCP JSON response is invalid."); };
  if (Buffer.byteLength(wire) > maximum) fail();
  let value: unknown;
  try { value = JSON.parse(wire); } catch { return fail(); }
  const tokens = wire.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]:,]|true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? fail();
  let index = 0, nodes = 0;
  const read = (depth: number): void => {
    if (depth > 16 || ++nodes > 4096) fail();
    const token = tokens[index++] ?? fail();
    if (token === "{") {
      const seen = new Set<string>(); if (tokens[index] === "}") { index++; return; }
      for (;;) {
        const name = tokens[index++] ?? fail(); if (!name.startsWith('"') || tokens[index++] !== ":") fail();
        const decoded: unknown = JSON.parse(name); if (typeof decoded !== "string") return fail();
        if (/[\uD800-\uDFFF]/u.test(decoded) || seen.has(decoded)) fail(); seen.add(decoded);
        read(depth + 1); const separator = tokens[index++]; if (separator === "}") return; if (separator !== ",") fail();
      }
    }
    if (token === "[") {
      if (tokens[index] === "]") { index++; return; }
      for (;;) { read(depth + 1); const separator = tokens[index++]; if (separator === "]") return; if (separator !== ",") fail(); }
    }
    if (["true", "false", "null"].includes(token)) return;
    if (token.startsWith('"')) {
      const decoded: unknown = JSON.parse(token); if (typeof decoded !== "string") return fail();
      // Under Unicode mode a valid surrogate pair is one scalar code point;
      // only lone surrogate code units match this BMP range.
      if (/[\uD800-\uDFFF]/u.test(decoded)) fail(); return;
    }
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token) || !Number.isFinite(Number(token))) fail();
  };
  read(0); if (index !== tokens.length) fail(); return value;
}
