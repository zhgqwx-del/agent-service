/** A dispatched Server-Sent Event. Comment-only heartbeats are intentionally not dispatched. */
export interface SseEvent<T> {
  /** Parsed `data` payload. Multiple data lines are joined with a single `\n`. */
  data: T;
  /** The wire `event` field, or the SSE default (`message`). */
  event: string;
  /** The current last-event id. It persists across frames once the server sets it. */
  id?: string;
  /** The current reconnection delay, once the server has supplied a valid `retry` field. */
  retry?: number;
}

/**
 * Raised when an otherwise valid SSE event contains malformed JSON.
 *
 * Only a bounded payload preview is included so diagnostics remain useful without accidentally
 * copying an arbitrarily large model response into logs.
 */
export class SseJsonParseError extends Error {
  readonly event: string;
  readonly id?: string;
  readonly retry?: number;
  readonly dataPreview: string;

  constructor(frame: SseEvent<string>, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const previewLimit = 240;
    const preview = frame.data.length > previewLimit
      ? `${frame.data.slice(0, previewLimit)}…`
      : frame.data;
    const location = [
      `event ${JSON.stringify(frame.event)}`,
      ...(frame.id === undefined ? [] : [`id ${JSON.stringify(frame.id)}`]),
    ].join(", ");
    super(`invalid JSON in SSE ${location}: ${detail}; data=${JSON.stringify(preview)}`, { cause });
    this.name = "SseJsonParseError";
    this.event = frame.event;
    this.id = frame.id;
    this.retry = frame.retry;
    this.dataPreview = preview;
  }
}

/**
 * Incrementally parses a byte stream as UTF-8 Server-Sent Events.
 *
 * The decoder is fatal: malformed UTF-8 is rejected instead of being silently replaced. SSE's
 * specified tolerant rules still apply to unknown fields, invalid retry values, comments, and ids
 * containing NUL. The parser takes no AbortSignal of its own; an abort/error on the supplied stream
 * is allowed to reject `reader.read()` unchanged.
 */
export async function* parseSseText(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent<string>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let dataLines: string[] = [];
  let eventType = "";
  let retry: number | undefined;
  let lastEventId: string | undefined;
  let reachedEof = false;

  const dispatch = (): SseEvent<string> | undefined => {
    // Per SSE, id/retry-only frames update connection state but do not dispatch a message.
    if (dataLines.length === 0) {
      eventType = "";
      return undefined;
    }

    const frame: SseEvent<string> = {
      data: dataLines.join("\n"),
      event: eventType || "message",
      ...(lastEventId === undefined ? {} : { id: lastEventId }),
      ...(retry === undefined ? {} : { retry }),
    };
    dataLines = [];
    eventType = "";
    return frame;
  };

  const processLine = (line: string): SseEvent<string> | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined; // heartbeat/comment

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // exactly one optional space

    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      case "event":
        eventType = value;
        break;
      case "id":
        // The EventSource algorithm ignores ids containing NUL and otherwise persists the value.
        if (!value.includes("\0")) lastEventId = value;
        break;
      case "retry":
        // Invalid retry fields are ignored by the protocol, not treated as malformed streams.
        if (/^[0-9]+$/.test(value)) {
          const parsed = Number(value);
          if (Number.isSafeInteger(parsed)) retry = parsed;
        }
        break;
      default:
        // Forward-compatible SSE parsers ignore fields they do not understand.
        break;
    }
    return undefined;
  };

  /** Drain complete lines while retaining a CR that may be half of a split CRLF pair. */
  function* drainLines(atEof: boolean): Generator<SseEvent<string>> {
    let consumed = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const ch = buffer[i];
      if (ch !== "\r" && ch !== "\n") continue;
      if (ch === "\r" && i + 1 === buffer.length && !atEof) break;

      const line = buffer.slice(consumed, i);
      if (ch === "\r" && buffer[i + 1] === "\n") i += 1;
      consumed = i + 1;
      const frame = processLine(line);
      if (frame) yield frame;
    }
    buffer = buffer.slice(consumed);

    // EOF terminates the final line, but does not dispatch the pending event. The SSE algorithm
    // requires a blank line to dispatch; treating a connection cut after a valid-looking JSON data
    // line as success would hide a truncated response.
    if (atEof && buffer.length > 0) {
      const frame = processLine(buffer);
      buffer = "";
      if (frame) yield frame;
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      yield* drainLines(false);
    }

    // Flush detects a truncated multi-byte UTF-8 sequence when `fatal` is enabled.
    buffer += decoder.decode();
    yield* drainLines(true);
  } finally {
    // A caller may stop `for await` after receiving the event it needs. Propagate that decision to
    // fetch/the producer instead of leaving an HTTP connection and server subscription open.
    if (!reachedEof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Parse each dispatched SSE `data` value as JSON and expose its type to SDK callers. */
export async function* parseSse<T = unknown>(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent<T>> {
  for await (const frame of parseSseText(stream)) {
    let data: T;
    try {
      data = JSON.parse(frame.data) as T;
    } catch (cause) {
      throw new SseJsonParseError(frame, cause);
    }
    yield { ...frame, data };
  }
}
