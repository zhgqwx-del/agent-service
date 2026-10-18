import { describe, it } from "vitest";
import { runMcpProgressVertical } from "./fixtures/mcp-progress-vertical.js";

describe("official modern MCP progress through real Memory runner/router/Pi and public SDK", () => {
  it("publishes live progress only after approval and write-ahead, then replays only the durable final result", async () => {
    await runMcpProgressVertical();
  }, 60_000);
});
