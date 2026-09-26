import { describe, expect, it } from "vitest";
import { parseSse, parseSseText, SseJsonParseError, type SseEvent } from "../src/sse.js";

const bytes = new TextEncoder();

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("SDK SSE parser", () => {
  it("decodes split UTF-8 and CRLF boundaries and joins multi-line JSON data", async () => {
    const input = [
      "event: greeting\r\n",
      "id: 42\r\n",
      "retry: 1500\r\n",
      "data: {\r\n",
      'data: "message": "你好"\r\n',
      "data: }\r\n",
      "\r\n",
    ].join("");
    const encoded = bytes.encode(input);
    const chineseStart = encoded.indexOf(0xe4); // split within the first three-byte character
    const chunks = [
      encoded.slice(0, 16), // ends on the CR of a CRLF pair
      encoded.slice(16, chineseStart + 1),
      encoded.slice(chineseStart + 1, chineseStart + 2),
      encoded.slice(chineseStart + 2),
    ];

    const events = await collect(parseSse<{ message: string }>(byteStream(chunks)));
    expect(events).toEqual([{
      data: { message: "你好" },
      event: "greeting",
      id: "42",
      retry: 1500,
    }]);
  });

  it("ignores comment heartbeats and unknown fields while preserving the last event id", async () => {
    const stream = byteStream([bytes.encode([
      ": heartbeat\n\n",
      "id: cursor-1\n\n",
      "retry: 2500\n\n",
      "unknown: future\n",
      'data: {"n":1}\n\n',
      ": keepalive\r\n\r\n",
      "event: update\r",
      "retry: nope\r",
      'data: {"n":2}\r',
      "\r",
    ].join(""))]);

    expect(await collect(parseSse<{ n: number }>(stream))).toEqual([
      { data: { n: 1 }, event: "message", id: "cursor-1", retry: 2500 },
      { data: { n: 2 }, event: "update", id: "cursor-1", retry: 2500 },
    ]);
  });

  it("discards a pending frame when EOF arrives without a blank-line delimiter", async () => {
    const events = await collect(parseSse<{ done: boolean }>(
      byteStream([bytes.encode('event: final\ndata: {"done":true}')]),
    ));
    expect(events).toEqual([]);
  });

  it("keeps raw data available when JSON decoding is not desired", async () => {
    const events = await collect(parseSseText(byteStream([
      bytes.encode("data: first\n"),
      bytes.encode("data: second\n\n"),
    ])));
    expect(events).toEqual([{ data: "first\nsecond", event: "message" }]);
  });

  it("throws a diagnostic error for malformed event JSON", async () => {
    const iterator = parseSse<{ ok: boolean }>(byteStream([
      bytes.encode("event: turn/completed\nid: 9\nretry: 500\ndata: {bad}\n\n"),
    ]));

    let thrown: unknown;
    try {
      await iterator.next();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SseJsonParseError);
    const error = thrown as SseJsonParseError;
    expect(error).toMatchObject({
      event: "turn/completed",
      id: "9",
      retry: 500,
      dataPreview: "{bad}",
    });
    expect(error.message).toContain('event "turn/completed", id "9"');
    expect(error.message).toContain("data=\"{bad}\"");
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it("rejects malformed or truncated UTF-8 instead of inserting replacement characters", async () => {
    const invalid = byteStream([bytes.encode("data: \""), new Uint8Array([0xe4, 0xbd])]);
    await expect(collect(parseSseText(invalid))).rejects.toBeInstanceOf(TypeError);
  });

  it("propagates an upstream AbortSignal reason unchanged", async () => {
    const abort = new AbortController();
    const reason = new DOMException("caller aborted", "AbortError");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        abort.signal.addEventListener("abort", () => controller.error(abort.signal.reason), { once: true });
      },
    });
    const pending = parseSse<unknown>(stream).next();
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("cancels the upstream stream when a consumer stops iterating early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.encode('data: {"n":1}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const event of parseSse<{ n: number }>(stream)) {
      expect(event.data.n).toBe(1);
      break;
    }

    expect(cancelled).toBe(true);
  });

  it("ignores an id containing NUL and accepts an empty id reset", async () => {
    const input = [
      "id: good\n",
      'data: {"n":1}\n\n',
      "id: bad\0id\n",
      'data: {"n":2}\n\n',
      "id:\n",
      'data: {"n":3}\n\n',
    ].join("");
    const events: SseEvent<{ n: number }>[] = await collect(parseSse(byteStream([bytes.encode(input)])));
    expect(events.map(({ id }) => id)).toEqual(["good", "good", ""]);
  });
});
