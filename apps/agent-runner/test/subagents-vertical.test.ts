import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "@agent-service/store";
import { runSubagentsVertical } from "./fixtures/subagents-vertical.js";

describe("root-bound subagents source-App/Pi vertical with MemoryStore", () => {
  it("runs a pinned real child through MCP approval and explicitly inherited client tool, then resumes the parent", async () => {
    const store = new MemorySessionStore(); let closed = false;
    try {
      const result = await runSubagentsVertical({ store, profile: "source-app-memory", onOwnedServicesClosed: () => { closed = true; } });
      expect(closed).toBe(true); expect(result.profile).toBe("source-app-memory");
      const ledger = store.usageLedger.filter(row => row.tenantId === result.owner.tenantId);
      const facts = [...store.billingUsageFacts.values()].filter(row => row.tenantId === result.owner.tenantId);
      expect(ledger).toHaveLength(5); expect(facts).toHaveLength(5);
      expect(new Set(ledger.map(row => row.usageId)).size).toBe(5);
      expect(facts.map(row => row.usageId).sort()).toEqual(ledger.map(row => row.usageId).sort());
      expect(ledger.map(row => `${row.sessionId}:${row.turnId}:${row.step}`).sort()).toEqual([
        `${result.rootSessionId}:${result.rootTurnId}:1`, `${result.rootSessionId}:${result.rootTurnId}:2`,
        `${result.childSessionId}:${result.childTurnId}:1`, `${result.childSessionId}:${result.childTurnId}:2`, `${result.childSessionId}:${result.childTurnId}:3`,
      ].sort());
      expect(facts.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(60);
      expect(facts.every(row => !Object.hasOwn(row, "sessionId") && !Object.hasOwn(row, "userId"))).toBe(true);
    } finally { await store.close(); }
  });
});
