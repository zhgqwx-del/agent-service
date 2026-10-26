const MAX_FRAME = 262_144, MAX_TOTAL = 4_194_304;
const LIVE = new Set(["item/agentMessage/delta", "item/reasoning/delta", "item/toolCall/argsDelta", "item/mcpToolCall/progress", "heartbeat"]);
const invalid = () => new Error("invalid_upstream_stream");

/** Native byte chunks are not event boundaries. Dispatch only complete, bounded UTF-8 frames. */
async function* frames(source) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", lines = [], event = "", size = 0, total = 0;
  const line = value => {
    size += Buffer.byteLength(value) + 1;
    if (size > MAX_FRAME) throw invalid();
    if (!value) {
      const frame = lines.length ? { event, text: lines.join("\n") } : undefined;
      lines = []; event = ""; size = 0; return frame;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":"), name = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (name === "data") lines.push(content);
    else if (name === "event") event = content;
    // IDs are regenerated from data.seq; a live delta must never become a durable cursor.
  };
  for await (const chunk of source) {
    total += chunk.length; if (total > MAX_TOTAL) throw invalid();
    buffer += decoder.decode(chunk, { stream: true });
    let consumed = 0;
    for (let index = 0; index < buffer.length; index++) {
      if (buffer[index] !== "\r" && buffer[index] !== "\n") continue;
      if (buffer[index] === "\r" && index === buffer.length - 1) break;
      const value = buffer.slice(consumed, index);
      if (buffer[index] === "\r" && buffer[index + 1] === "\n") index++;
      consumed = index + 1;
      const frame = line(value); if (frame) yield frame;
    }
    buffer = buffer.slice(consumed);
    if (Buffer.byteLength(buffer) + size > MAX_FRAME) throw invalid();
  }
  buffer += decoder.decode();
  // A terminal CR is itself a line ending when no next byte can form a CRLF pair.
  if (buffer.endsWith("\r")) {
    const frame = line(buffer.slice(0, -1)); buffer = "";
    if (frame) yield frame;
  }
  // Never dispatch a data line cut short by EOF, even when the JSON looks complete.
  if (buffer || lines.length || event) throw invalid();
}

function drain(response) {
  return new Promise((done, reject) => {
    const clear = () => { response.off("drain", ready); response.off("close", closed); response.off("error", closed); };
    const ready = () => { clear(); done(); }, closed = () => { clear(); reject(invalid()); };
    response.once("drain", ready); response.once("close", closed); response.once("error", closed);
    if (response.destroyed) closed();
  });
}

export async function relayChatSse(source, response, { sessionId, secret }) {
  const partials = new Map();
  for await (const frame of frames(source)) {
    const data = JSON.parse(frame.text);
    if (!data || typeof data !== "object" || Array.isArray(data) || data.sessionId !== sessionId
      || typeof data.type !== "string" || !/^[A-Za-z][A-Za-z0-9/_-]{0,100}$/.test(data.type)
      || frame.event && frame.event !== "message" && frame.event !== data.type
      || data.seq !== undefined && (!Number.isSafeInteger(data.seq) || data.seq < 0 || LIVE.has(data.type))) throw invalid();

    // A credential split across separate delta events must not be reassembled in the browser.
    // Only a suffix that exactly matches a secret prefix is held; normal text passes immediately.
    if (typeof data.delta === "string") {
      const key = `${data.type}:${data.turnId}:${data.itemId}:${data.toolCallId}`;
      let text = ((partials.get(key) || "") + data.delta).replaceAll(secret, "[redacted-service-key]");
      let held = 0;
      for (let length = Math.min(secret.length - 1, text.length); length > 0; length--) {
        if (text.endsWith(secret.slice(0, length))) { held = length; break; }
      }
      if (held) { partials.set(key, text.slice(-held)); text = text.slice(0, -held); }
      else partials.delete(key);
      data.delta = text;
      if (!text) continue;
    }
    const payload = JSON.stringify(data).replaceAll(secret, "[redacted-service-key]");
    if (!response.headersSent) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
      response.flushHeaders();
    }
    const wire = `${data.seq === undefined ? "" : `id: ${data.seq}\n`}event: ${data.type}\ndata: ${payload}\n\n`;
    if (!response.write(wire)) await drain(response);
  }
  if (!response.headersSent) {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
  }
  // EOF only ends observation. The client verifies the turn and final items with GET.
  response.end();
}
