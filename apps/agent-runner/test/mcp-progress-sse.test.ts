import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { Event, type Event as DomainEvent } from "@agent-service/protocol";
import { parseSse } from "../../../packages/sdk/src/sse.js";
import { sseResponse } from "../src/sse.js";

const uuid = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const sessionId = `sess_${uuid}`;
const progress = Event.parse({ type: "item/mcpToolCall/progress", sessionId,
  turnId: `turn_${uuid}`, itemId: `item_${uuid}`, toolCallId: "actual_call", emittedAtMs: 2,
  progress: 1, total: 2, message: "处理进度" });

function fixture() {
  let unsubscribed = 0;
  const app = new Hono();
  app.get("/events", c => sseResponse(c, async (send, close) => {
    send(Event.parse({ type: "session/created", sessionId, emittedAtMs: 1, seq: 7 }));
    send(progress);
    send(Event.parse({ type: "session/archived", sessionId, emittedAtMs: 3, seq: 8 }));
    close();
    return () => { unsubscribed++; };
  }, { heartbeatMs: 60_000, sessionId }));
  return { app, unsubscribed: () => unsubscribed };
}

describe("MCP progress uses the ordinary public SSE framing", () => {
  it("emits no progress id and drains durable/progress/durable frames before close", async () => {
    const { app, unsubscribed } = fixture();
    const response = await app.request("/events");
    expect(response.status).toBe(200);
    const text = await response.text();
    const frames = text.trim().split(/\n\n/);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toContain("id: 7");
    expect(frames[1]).toContain("event: item/mcpToolCall/progress");
    expect(frames[1]).not.toMatch(/(?:^|\n)id:/);
    expect(frames[1]).toContain(JSON.stringify(progress));
    expect(frames[2]).toContain("id: 8");
    expect(unsubscribed()).toBe(1);
  });

  it("the actual SDK parser retains only the preceding durable resume cursor", async () => {
    const { app, unsubscribed } = fixture();
    const response = await app.request("/events");
    const events = [];
    for await (const event of parseSse<DomainEvent>(response.body!)) events.push(event);
    expect(events.map(event => event.id)).toEqual(["7", "7", "8"]);
    expect(events[1]?.data).toEqual(progress);
    expect(events[1]?.data).not.toHaveProperty("seq");
    expect(unsubscribed()).toBe(1);
  });
});
