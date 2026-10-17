import { describe, expect, it } from "vitest";
import { runSkillsVertical } from "./fixtures/skills-vertical.js";

describe("M3 static skills source bootstrap vertical with MemoryStore", () => {
  it("loads a real mounted SKILL.md via skill tool, feeds its durable typed result to Pi, and resumes SSE after a real disconnect", async () => {
    const result = await runSkillsVertical();
    expect(result.profile).toBe("source-memory-only");
    expect(result.finalSeq).toBeGreaterThan(1);
  }, 60_000);
});
