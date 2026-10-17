import { describe, it } from "vitest";
import { runMcpVertical } from "./fixtures/mcp-vertical.js";

describe("M3.1a source bootstrap MCP vertical with MemoryStore", () => {
  it("requires approval through the router, invokes real HTTP MCP once, consumes its result in Pi and replays durable SSE", async () => {
    await runMcpVertical();
  }, 60_000);
});
