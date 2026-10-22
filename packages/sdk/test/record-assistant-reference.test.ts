import { describe, expect, it } from "vitest";
import {
  createRecordAssistant, MemoryReferenceApp,
  type Owner, type RecordAnswer, type RecordRequest, type SavedAnswer,
} from "../../../examples/record-assistant/reference.js";

const owner: Owner = { tenantId: "reference-tenant", userId: "alice" };
const agent = { id: "agt_019a2b3c-4d5e-7000-8000-000000000001", version: 1 };
const request = (operationId: string, extra: Partial<RecordRequest> = {}): RecordRequest => ({
  topicId: "project-a", operationId, recordId: "record-a", recordVersion: 1, text: "请分析这条记录。", ...extra,
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** SDK transport double only. It does not stand in for a router/runner/model integration. */
class RuntimeDouble {
  sessionCreates = 0;
  turnDispatches = 0;
  loseFirstTurnResponse = false;
  readonly turnKeys: string[] = [];
  readonly submissions: { sessionId: string; key: string; input: unknown }[] = [];
  readonly sessionEntered = barrier();
  sessionGate?: Promise<void>;
  turnGate?: Promise<void>;
  readonly turnEntered = barrier();
  private readonly turns = new Map<string, { id: string; sessionId: string; answer: string; idem: string }>();

  constructor(private readonly replies: string[] = ["已分析。", "已补充。", "已追问。"]) {}

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    expect(req.headers.get("authorization")).toBe("Bearer synthetic-reference-key");
    expect(req.headers.get("x-user-id")).toBe(owner.userId);
    if (req.method === "POST" && url.pathname === "/v1/sessions") {
      this.sessionCreates++;
      this.sessionEntered.release();
      await this.sessionGate;
      return Response.json({ id: `sess_019a2b3c-4d5e-7000-8000-${String(this.sessionCreates).padStart(12, "0")}`,
        tenantId: owner.tenantId, userId: owner.userId });
    }
    const start = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(url.pathname);
    if (req.method === "POST" && start) {
      const sessionId = start[1]!, idem = req.headers.get("idempotency-key")!;
      this.turnKeys.push(idem);
      const previous = this.turns.get(JSON.stringify([sessionId, idem]));
      if (previous) return Response.json({ turn: this.turn(previous) });
      const body: unknown = await req.json();
      this.submissions.push({ sessionId, key: idem, input: body });
      this.turnDispatches++;
      const value = { id: `turn_019a2b3c-4d5e-7000-8000-${String(this.turnDispatches).padStart(12, "0")}`,
        sessionId, answer: this.replies.shift() ?? "后续结果。", idem };
      this.turns.set(JSON.stringify([sessionId, idem]), value);
      this.turnEntered.release();
      await this.turnGate;
      if (this.loseFirstTurnResponse) {
        this.loseFirstTurnResponse = false;
        throw new Error("synthetic response lost after acceptance");
      }
      return new Response(`event: turn/completed\ndata: ${JSON.stringify({
        type: "turn/completed", sessionId, seq: 4, emittedAtMs: 1, turn: this.turn(value), stopReason: "end_turn",
      })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    if (req.method === "GET" && /^\/v1\/sessions\/[^/]+\/items$/.test(url.pathname)) {
      const value = [...this.turns.values()].find(turn => turn.id === url.searchParams.get("turnId"));
      if (!value) throw new Error("Unexpected reference turn lookup.");
      return Response.json({ data: [{ id: "item_019a2b3c-4d5e-7000-8000-000000000001",
        sessionId: value.sessionId, turnId: value.id, seq: 3, type: "agentMessage", status: "completed",
        text: value.answer, createdAtMs: 1, completedAtMs: 1 }] });
    }
    throw new Error("Unexpected reference SDK route.");
  };

  private turn(value: { id: string; sessionId: string; idem: string }) {
    return { id: value.id, sessionId: value.sessionId, status: "completed", stopReason: "end_turn",
      idempotencyKey: value.idem, steps: 1, toolCalls: 0, startedAtMs: 1, completedAtMs: 2,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}

function setup(runtime = new RuntimeDouble(), app = new MemoryReferenceApp()) {
  app.putRecord(owner, { id: "record-a", version: 1, text: "项目代号青禾，周五提交。" });
  const assistant = createRecordAssistant({ connection: { baseUrl: "https://reference.invalid",
    serviceApiKey: "synthetic-reference-key", userId: owner.userId, fetch: runtime.fetch }, owner, agent, app });
  return { runtime, app, assistant };
}

describe("record assistant SDK reference (single-process synthetic App)", () => {
  it("associates three turns with one topic and the selected record versions", async () => {
    const { runtime, app, assistant } = setup(new RuntimeDouble(["希望列表还是表格？", "已更正为青禾二期，按列表。", "青禾二期，周五，列表。"]));
    const first = await assistant.reply(request("op-1"));
    app.putRecord(owner, { id: "record-a", version: 2, text: "项目代号已更正为青禾二期，周五提交。" });
    const second = await assistant.reply(request("op-2", { recordVersion: 2, text: "补充：按列表交付。" }));
    const third = await assistant.reply(request("op-3", { recordVersion: 2, text: "请依据前文给出最终代号、日期和格式。" }));
    expect(runtime.sessionCreates).toBe(1);
    expect(runtime.turnDispatches).toBe(3);
    expect(new Set([first.sessionId, second.sessionId, third.sessionId]).size).toBe(1);
    expect(third).toMatchObject({ recordId: "record-a", recordVersion: 2, publication: "current", answer: "青禾二期，周五，列表。" });
    expect(app.saved(owner, "op-3")).toEqual(third);
    expect(app.saved({ ...owner, userId: "bob" }, "op-3")).toBeUndefined();
    expect(JSON.stringify(runtime.submissions[0]?.input)).toContain("record-a");
    expect(JSON.stringify(runtime.submissions[1]?.input)).toContain("青禾二期");
    // The double scripts answers: these checks prove SDK orchestration, not model comprehension.
  });

  it("shares one session allocation across concurrent submissions to the same topic", async () => {
    const runtime = new RuntimeDouble(), gate = barrier();
    runtime.sessionGate = gate.promise;
    const { assistant } = setup(runtime);
    const first = assistant.reply(request("op-1"));
    await runtime.sessionEntered.promise;
    const second = assistant.reply(request("op-2", { text: "另一个设备补充这条记录。" }));
    gate.release();
    const results = await Promise.all([first, second]);
    expect(runtime.sessionCreates).toBe(1);
    expect(results[0]?.sessionId).toBe(results[1]?.sessionId);
  });

  it("replays an exact operation and rejects changed text, topic or record version before dispatch", async () => {
    const { runtime, assistant } = setup();
    runtime.loseFirstTurnResponse = true;
    const original = request("op-1");
    await expect(assistant.reply(original)).rejects.toThrow("synthetic response lost after acceptance");
    const first = await assistant.reply(original);
    expect(await assistant.reply(original)).toEqual(first);
    for (const changed of [{ text: "different" }, { topicId: "another-topic" }, { recordVersion: 2 }]) {
      expect(() => assistant.reply({ ...original, ...changed })).toThrow("operation identity conflict");
    }
    expect(runtime.turnDispatches).toBe(1);
    expect(runtime.turnKeys).toHaveLength(2);
    expect(runtime.turnKeys[0]).toBe(runtime.turnKeys[1]);
    expect(runtime.sessionCreates).toBe(1);
  });

  it("does not publish a late answer against a newer record version", async () => {
    const runtime = new RuntimeDouble(), gate = barrier();
    runtime.turnGate = gate.promise;
    const { app, assistant } = setup(runtime);
    const old = assistant.reply(request("old-version"));
    await runtime.turnEntered.promise;
    app.putRecord(owner, { id: "record-a", version: 2, text: "更新后的事实。" });
    runtime.turnGate = undefined;
    const latest = await assistant.reply(request("new-version", { recordVersion: 2 }));
    gate.release();
    expect(await old).toMatchObject({ recordVersion: 1, publication: "superseded" });
    expect(app.saved(owner, "old-version")?.publication).toBe("superseded");
    expect(app.saved(owner, "new-version")).toEqual(latest);
    expect(latest.publication).toBe("current");
  });

  it("retries only App saving after a confirmed answer, without another SDK turn", async () => {
    class FailingSave extends MemoryReferenceApp {
      saves = 0;
      override async saveIfCurrent(subject: Owner, answer: RecordAnswer): Promise<SavedAnswer["publication"]> {
        if (++this.saves === 1) throw new Error("synthetic App save failure");
        return super.saveIfCurrent(subject, answer);
      }
    }
    const app = new FailingSave(), { runtime, assistant } = setup(new RuntimeDouble(), app);
    const input = request("op-1");
    await expect(assistant.reply(input)).rejects.toThrow("synthetic App save failure");
    expect(app.saved(owner, input.operationId)).toBeUndefined();
    expect((await assistant.reply(input)).publication).toBe("current");
    expect(runtime.turnDispatches).toBe(1);
    expect(runtime.sessionCreates).toBe(1);
    expect(app.saves).toBe(2);
  });
});
