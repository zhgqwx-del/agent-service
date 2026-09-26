import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real HTTP server that speaks OpenAI-compatible `chat/completions` and reproduces the dialect
 * quirks of the domestic vendors we target. Tests drive provider/engine behaviour against it without
 * needing an API key, and CI can run them.
 *
 * Quirks reproduced (each verified against vendor docs or the prior PoC's probes):
 *  - reasoning goes in `reasoning_content` (DeepSeek/DashScope) rather than an OpenAI `reasoning` field
 *  - cache hits are reported under three different names depending on vendor
 *  - `tool_calls[].function.arguments` arrives split across several chunks
 *  - gateways inject `: keep-alive` SSE comment lines
 *  - `finish_reason: "length"` can land while tool-call arguments are still incomplete
 */

export type CacheDialect = "deepseek" | "dashscope" | "kimi" | "none";

export interface ScriptedToolCall {
  id: string;
  name: string;
  /** full arguments JSON; the server splits it into `argChunks` pieces */
  args: string;
  argChunks?: number;
}

export interface ScriptedReply {
  /** emitted as reasoning_content deltas before any text */
  reasoning?: string;
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** defaults to "tool_calls" when toolCalls is set, else "stop" */
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
  };
  /** emit a `: keep-alive` comment line before the first delta */
  keepAlive?: boolean;
  /** close the socket after this many data chunks, simulating a mid-stream disconnect */
  dropAfterChunks?: number;
  /** respond with this status and body instead of streaming */
  httpError?: { status: number; body?: unknown; retryAfter?: string };
  /** delay before the first chunk, ms */
  ttftMs?: number;
}

export interface FakeVendorOptions {
  cacheDialect?: CacheDialect;
  /** require this bearer token; requests without it get 401 */
  expectApiKey?: string;
}

export interface CapturedRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export class FakeVendor {
  private server?: Server;
  private readonly queue: ScriptedReply[] = [];
  readonly requests: CapturedRequest[] = [];

  constructor(private readonly opts: FakeVendorOptions = {}) {}

  /** Queue one reply per model call, in order. */
  script(...replies: ScriptedReply[]): this {
    this.queue.push(...replies);
    return this;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => res.destroy()));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  get lastRequest(): CapturedRequest | undefined {
    return this.requests.at(-1);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    this.requests.push({ path: req.url ?? "", headers, body });

    if (this.opts.expectApiKey && headers.authorization !== `Bearer ${this.opts.expectApiKey}`) {
      return json(res, 401, { error: { message: "invalid api key", type: "authentication_error" } });
    }
    if (!req.url?.includes("/chat/completions")) return json(res, 404, { error: { message: "not found" } });

    const reply = this.queue.shift() ?? { text: "(fake vendor: no script left)" };
    if (reply.httpError) {
      if (reply.httpError.retryAfter) res.setHeader("retry-after", reply.httpError.retryAfter);
      return json(res, reply.httpError.status, reply.httpError.body ?? { error: { message: `fake ${reply.httpError.status}` } });
    }
    if (body.stream === false) return json(res, 200, this.nonStreamBody(reply));
    await this.stream(res, reply);
  }

  private nonStreamBody(r: ScriptedReply) {
    return {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "fake-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: r.text ?? "", ...(r.reasoning ? { reasoning_content: r.reasoning } : {}) },
          finish_reason: r.finishReason ?? (r.toolCalls?.length ? "tool_calls" : "stop"),
        },
      ],
      usage: this.usage(r),
    };
  }

  private async stream(res: ServerResponse, r: ScriptedReply) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let written = 0;
    let dropped = false;
    const send = (payload: unknown) => {
      if (dropped) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      written += 1;
      if (r.dropAfterChunks !== undefined && written >= r.dropAfterChunks) {
        dropped = true;
        res.destroy(); // abrupt socket close, as a flaky gateway would
      }
    };
    const delta = (d: Record<string, unknown>, finish: string | null = null) =>
      send({
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "fake-model",
        choices: [{ index: 0, delta: d, finish_reason: finish }],
      });

    if (r.ttftMs) await sleep(r.ttftMs);
    if (r.keepAlive) res.write(": keep-alive\n\n"); // comment line: must be ignored by the client
    delta({ role: "assistant", content: "" });

    for (const piece of split(r.reasoning ?? "", 3)) delta({ reasoning_content: piece });
    for (const piece of split(r.text ?? "", 4)) delta({ content: piece });

    for (const [index, tc] of (r.toolCalls ?? []).entries()) {
      const pieces = split(tc.args, tc.argChunks ?? 4);
      // first chunk carries id/name, later chunks only extend the arguments
      delta({ tool_calls: [{ index, id: tc.id, type: "function", function: { name: tc.name, arguments: pieces[0] ?? "" } }] });
      for (const piece of pieces.slice(1)) delta({ tool_calls: [{ index, function: { arguments: piece } }] });
    }

    delta({}, r.finishReason ?? (r.toolCalls?.length ? "tool_calls" : "stop"));
    if (!dropped) {
      // vendors send usage in a final chunk with an empty choices array
      send({ id: "chatcmpl-fake", object: "chat.completion.chunk", model: "fake-model", choices: [], usage: this.usage(r) });
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }

  private usage(r: ScriptedReply) {
    const prompt = r.usage?.promptTokens ?? 100;
    const completion = r.usage?.completionTokens ?? 20;
    const cached = r.usage?.cachedTokens ?? 0;
    const base: Record<string, unknown> = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
    if (r.usage?.reasoningTokens) base.completion_tokens_details = { reasoning_tokens: r.usage.reasoningTokens };
    switch (this.opts.cacheDialect ?? "deepseek") {
      case "deepseek":
        base.prompt_cache_hit_tokens = cached;
        base.prompt_cache_miss_tokens = prompt - cached;
        break;
      case "dashscope":
        base.prompt_tokens_details = { cached_tokens: cached };
        break;
      case "kimi":
        base.cached_tokens = cached;
        break;
      case "none":
        break;
    }
    return base;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split a string into n roughly equal pieces, mimicking provider chunking. */
function split(s: string, n: number): string[] {
  if (!s) return [];
  const size = Math.max(1, Math.ceil(s.length / n));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
