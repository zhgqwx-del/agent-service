import { describe, expect, it } from "vitest";
import { runHooksVertical } from "./fixtures/hooks-vertical.js";

describe("M3 tool hooks real source bootstrap vertical with MemoryStore", () => {
  it("allows only through signed pre policy and mandatory MCP approval, observes committed results, then denies a reusable session grant", async () => {
    const result = await runHooksVertical();
    expect(result.profile).toBe("source-memory-only");
    expect(result.remoteCalls).toBe(1);
    expect(result.webhookRequests).toBe(3);
    expect(result.finalSeq).toBeGreaterThan(1);
  }, 60_000);
});
