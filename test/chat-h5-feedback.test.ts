import { describe, expect, it } from "vitest";
import { createChatPage, type PageFetch } from "./helpers/chat-page-harness.js";

type Json = Record<string, unknown>;
const STORE = "agent-service.chat-h5.v1";
const SID = "sess_feedback_a", OTHER = "sess_feedback_b";
const identity = { userId: "feedback_user", agentId: "agt_feedback", agentVersion: 1 };
const session = (id = SID) => ({ id, ...identity, title: id, status: { type: "idle" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function stream(signal?: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>, closed = false;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { closed = true; } });
  signal?.addEventListener("abort", () => { if (!closed) { closed = true; controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })); } }, { once: true });
  return { response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    event(value: Json) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)); },
    close() { if (!closed) { closed = true; controller.close(); } } };
}
function turn(id: string, key: string, status = "inProgress", sid = SID) {
  return { id, sessionId: sid, idempotencyKey: key, status, startedAtMs: 1_800_000_000_000,
    ...(status === "completed" ? { stopReason: "end_turn", steps: 1, toolCalls: 0 } : {}) };
}
function userItem(id: string, turnId: string, seq = 1, text = "相同内容", sid = SID) {
  return { id, sessionId: sid, turnId, seq, type: "userMessage", status: "completed", content: [{ type: "text", text }], createdAtMs: 1_800_000_000_000 };
}

async function fixture(options: { saved?: Json; storage?: Map<string, string>; script?: "app.js" | "environment.js" } = {}) {
  const storage = options.storage ?? new Map([[STORE, JSON.stringify(options.saved ?? { selected: SID, recent: [SID, OTHER], drafts: {}, pending: {} })]]);
  const sessions = new Map<string, Json>([[SID, session()], [OTHER, session(OTHER)]]);
  const turns = new Map<string, Json[]>([[SID, []], [OTHER, []]]), items = new Map<string, Json[]>([[SID, []], [OTHER, []]]);
  const post = deferred<Response>(); let onPost = (request: PageFetch) => { request.signal?.addEventListener("abort", () => post.reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); return post.promise; };
  let environment: Json = { enabled: true, overall: "ready", checkedAt: "2026-10-26T12:00:00Z", operation: null,
    components: ["owner", "router", "runner", "mysql", "redis"].map(id => ({ id, state: "ready" })), actions: [] };
  let onAction = async (_request: PageFetch) => json({ error: "test_action_not_configured" }, 400);
  const page = await createChatPage({ storage, script: options.script, fetch: request => {
    if (request.path === "/api/config") return json({ ...identity, csrfToken: "feedback-fixture-token", requestTimeoutMs: 15000, operationTimeoutMs: 90000 });
    if (request.path === "/api/health") return json({ ready: true });
    if (request.path === "/api/environment") return json(environment);
    if (request.path === "/api/environment/actions") return onAction(request);
    if (request.path.startsWith("/api/sessions?")) return json({ data: [...sessions.values()], nextCursor: null });
    const match = request.path.match(/^\/api\/sessions\/([^/?]+)(?:\/(turns|items|events)(?:\/([^?]+))?)?(?:\?(.*))?$/);
    if (!match) throw new Error(`Unexpected browser request ${request.method} ${request.path}`);
    const sid = match[1]!, route = match[2], id = match[3];
    if (!route) return json(sessions.get(sid));
    if (route === "turns" && request.method === "POST") return onPost(request);
    if (route === "turns" && id) return json(turns.get(sid)?.find(value => value.id === id));
    if (route === "turns") return json({ data: turns.get(sid) ?? [], nextCursor: null });
    if (route === "items") { const params = new URLSearchParams(match[4]), after = Number(params.get("afterSeq") ?? -1), limit = Number(params.get("limit") ?? 200); return json({ data: (items.get(sid) ?? []).filter(value => Number(value.seq) > after).slice(0, limit) }); }
    return stream(request.signal).response;
  } });
  await page.flush();
  return { ...page, sessions, turns, items, post,
    setPost(handler: (request: PageFetch) => Promise<Response> | Response) { onPost = request => Promise.resolve(handler(request)); },
    setEnvironment(value: Json) { environment = value; },
    setAction(handler: (request: PageFetch) => Promise<Response> | Response) { onAction = request => Promise.resolve(handler(request)); },
    posts() { return page.calls.filter(value => value.method === "POST" && value.path.endsWith("/turns")); },
    messages() { return page.node("messages").querySelectorAll("article"); },
    saved() { return JSON.parse(storage.get(STORE)!) as { pending: Record<string, Json>; drafts: Record<string, string>; failed?: Record<string, Json[]>; feedback?: Record<string, Json> }; },
    async select(sid: string) { page.node("session-id").value = sid; await page.node("restore-form").emit("submit"); await page.flush(); },
  };
}

describe("H5 immediate message feedback through the real browser script", () => {
  it("renders and durably records a pending bubble synchronously before delayed POST headers", async () => {
    const f = await fixture();
    try {
      await f.input("延迟三秒也立即可见");
      const submitted = f.submit();
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0]!.textContent).toContain("延迟三秒也立即可见");
      expect(f.messages()[0]!.querySelector(".message-delivery")?.textContent).toContain("发送");
      expect(f.saved().pending[SID]?.key).toBe(f.posts()[0]?.headers["Idempotency-Key"]);
      expect(f.posts()).toHaveLength(1);
      f.advance(3500); await f.flush();
      expect(f.messages()).toHaveLength(1);
      expect(f.node("detail-accepted").textContent).not.toContain("3500");
      f.post.resolve(json({ error: { code: "environment_not_ready" } }, 503));
      await submitted; await f.flush();
    } finally { await f.close(); }
  });

  it("merges polling and SSE by exact turn/item identity and keeps consecutive identical inputs", async () => {
    const f = await fixture();
    try {
      for (const index of [1, 2]) {
        let channel!: ReturnType<typeof stream>;
        f.setPost(request => { channel = stream(request.signal); return channel.response; });
        await f.input("相同内容"); const submitted = f.submit(); await f.flush();
        expect(f.node("detail-turn-id").textContent).toBe("—");
        const localNode = f.messages().at(-1);
        const key = f.posts().at(-1)!.headers["Idempotency-Key"]!, tid = `turn_feedback_${index}`, item = userItem(`item_feedback_${index}`, tid, index);
        const running = turn(tid, key);
        f.turns.set(SID, [...f.turns.get(SID)!, running]);
        f.items.set(SID, [...f.items.get(SID)!, item]);
        f.sessions.set(SID, { ...session(), status: { type: "active", turnId: tid } });
        channel.event({ sessionId: SID, seq: index * 10, type: "turn/started", turn: running }); await f.flush();
        await f.timer(1000);
        expect(f.messages()).toHaveLength(index);
        expect(f.messages().at(-1)).toBe(localNode);
        expect(f.messages().at(-1)?.id).toBe(`message-${item.id}`);
        channel.event({ sessionId: SID, seq: index * 10 + 1, type: "item/completed", item }); await f.flush();
        expect(f.messages()).toHaveLength(index);
        const completed = turn(tid, key, "completed"); f.turns.set(SID, [...f.turns.get(SID)!.slice(0, -1), completed]); f.sessions.set(SID, session());
        channel.event({ sessionId: SID, seq: index * 10 + 2, type: "turn/completed", turn: completed }); await f.flush();
        channel.close(); await submitted; await f.flush();
        expect(f.saved().pending[SID]).toBeUndefined();
      }
      expect(f.posts()).toHaveLength(2);
      expect(new Set(f.posts().map(value => value.headers["Idempotency-Key"])).size).toBe(2);
      expect(f.messages().map(node => node.querySelector(".message-text")?.textContent)).toEqual(["相同内容", "相同内容"]);
      expect(f.messages().map(node => node.id)).toEqual(["message-item_feedback_1", "message-item_feedback_2"]);
    } finally { await f.close(); }
  });

  it("preserves a rejected message and restores its draft for a deliberate manual retry", async () => {
    const f = await fixture();
    try {
      f.setPost(() => json({ error: { code: "turn_not_submitted", message: "fixture unavailable" } }, 503));
      await f.input("这段草稿不能丢"); await f.submit(); await f.flush();
      expect(f.saved().pending[SID]).toBeUndefined();
      expect(f.node("message-input").value).toBe("这段草稿不能丢");
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0]!.querySelector(".message-delivery")?.textContent).toMatch(/未提交|未发送|拒绝/);
      expect(f.posts()).toHaveLength(1);
      await f.node("refresh-session").emit("click"); await f.flush();
      expect(f.posts()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("locks an unknown outcome, restores its bubble after reload and never repeats the POST", async () => {
    const f = await fixture();
    try {
      f.setPost(() => Promise.reject(new Error("fixture transport lost")));
      await f.input("结果不明的原文"); await f.submit(); await f.flush();
      expect(f.saved().pending[SID]?.unknown).toBe(true);
      expect(f.node("send-message").disabled).toBe(true);
      expect(f.messages()).toHaveLength(1);
      await f.node("refresh-session").emit("click"); await f.flush();
      expect(f.posts()).toHaveLength(1);
      const restored = await fixture({ storage: f.storage });
      try {
        expect(restored.messages()).toHaveLength(1);
        expect(restored.messages()[0]!.textContent).toContain("结果不明的原文");
        expect(restored.node("send-message").disabled).toBe(true);
        expect(restored.posts()).toHaveLength(0);
        expect(restored.calls.every(call => call.method === "GET")).toBe(true);
      } finally { await restored.close(); }
    } finally { await f.close(); }
  });

  it("keeps an unresolved bubble in its original session when switching away and back", async () => {
    const f = await fixture();
    try {
      await f.input("只属于会话 A"); const submitted = f.submit();
      await f.select(OTHER); await submitted; await f.flush();
      expect(f.node("session-reference").textContent).toBe(OTHER);
      expect(f.node("messages").textContent).not.toContain("只属于会话 A");
      await f.input("会话 B 草稿");
      await f.select(SID);
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0]!.textContent).toContain("只属于会话 A");
      await f.select(OTHER);
      expect(f.node("message-input").value).toBe("会话 B 草稿");
      expect(f.posts()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("does not match a restored unknown request by equal text from a different idempotency key", async () => {
    const pending = { key: "00000000-0000-4000-8000-000000000099", createdAtMs: 1_800_000_000_000, unknown: true, turnId: null,
      body: { input: [{ type: "text", text: "相同内容" }], stream: true } };
    const f = await fixture({ saved: { selected: SID, recent: [SID], pending: { [SID]: pending }, drafts: { [SID]: "相同内容" } } });
    try {
      f.turns.set(SID, [turn("turn_unrelated", "different-key", "completed")]);
      f.items.set(SID, [userItem("item_unrelated", "turn_unrelated")]);
      await f.node("refresh-session").emit("click"); await f.flush();
      expect(f.messages()).toHaveLength(2);
      expect(f.saved().pending[SID]?.turnId).toBeNull();
      expect(f.node("send-message").disabled).toBe(true);
      expect(f.posts()).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("locks immediately for environment actions, preserves drafts and only reads after recovery", async () => {
    const f = await fixture();
    try {
      await f.input("服务重启期间保留的草稿");
      await f.environment({ phase: "action-start", available: true, overall: "transitioning", operationState: "running", servicesReady: false });
      expect(f.node("send-message").disabled).toBe(true);
      expect(f.node("message-input").value).toBe("服务重启期间保留的草稿");
      await f.environment({ phase: "settled", available: true, overall: "stopped", operationState: "succeeded", servicesReady: false });
      await f.flush(); expect(f.node("send-message").disabled).toBe(true);
      const before = f.calls.length;
      await f.environment({ phase: "action-settled", available: true, overall: "ready", operationState: "succeeded", servicesReady: true });
      await f.flush();
      expect(f.node("send-message").disabled).toBe(false);
      expect(f.node("message-input").value).toBe("服务重启期间保留的草稿");
      expect(f.calls.slice(before).some(call => call.path === "/api/health")).toBe(true);
      expect(f.calls.slice(before).some(call => call.path === `/api/sessions/${SID}`)).toBe(true);
      expect(f.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await f.close(); }
  });

  it("tracks browser feedback, server acceptance and first text separately without inventing model latency", async () => {
    const f = await fixture();
    try {
      let channel!: ReturnType<typeof stream>; const gate = deferred<Response>();
      f.setPost(request => { channel = stream(request.signal); return gate.promise; });
      await f.input("计时测试"); const submitted = f.submit(); await f.flush();
      expect(f.node("detail-feedback").textContent).toMatch(/ms|毫秒/);
      expect(f.node("detail-accepted").textContent).toMatch(/—|等待|尚未/);
      const key = f.posts()[0]!.headers["Idempotency-Key"]!, running = turn("turn_timing", key);
      f.advance(2200); gate.resolve(channel.response); await f.flush();
      channel.event({ sessionId: SID, seq: 1, type: "turn/started", turn: running }); await f.flush();
      expect(f.node("detail-accepted").textContent).toMatch(/2[,.]?200|2\.20|2\.2/);
      expect(f.node("detail-first-chunk").textContent).toMatch(/—|等待|尚未/);
      f.advance(800); channel.event({ sessionId: SID, type: "item/agentMessage/delta", turnId: running.id, itemId: "item_timing", delta: "首片", emittedAtMs: 1_800_000_000_000 }); await f.flush();
      expect(f.node("detail-first-chunk").textContent).toBe("800 ms");
      expect(f.node("diagnostics").textContent).not.toMatch(/模型耗时[：:]?\s*3/);
      channel.close(); await submitted;
    } finally { await f.close(); }
  });

  it("reveals a new submission, preserves upward reading during deltas and follows only after jumping back", async () => {
    const f = await fixture();
    try {
      let channel!: ReturnType<typeof stream>;
      f.setPost(request => { channel = stream(request.signal); return channel.response; });
      const messages = f.node("messages"); messages.scrollHeight = 1500; messages.scrollTop = 100;
      await messages.emit("scroll"); await f.input("主动发送应显示新消息"); const submitted = f.submit(); await f.flush();
      expect(messages.scrollTop).toBe(messages.scrollHeight);
      const key = f.posts()[0]!.headers["Idempotency-Key"]!, running = turn("turn_scroll", key);
      channel.event({ sessionId: SID, seq: 1, type: "turn/started", turn: running });
      channel.event({ sessionId: SID, seq: 2, type: "item/started", item: { id: "item_scroll_reply", sessionId: SID, turnId: running.id, seq: 2, type: "agentMessage", text: "", status: "inProgress" } }); await f.flush();
      messages.scrollTop = 100; await messages.emit("scroll");
      channel.event({ sessionId: SID, type: "item/agentMessage/delta", turnId: running.id, itemId: "item_scroll_reply", delta: "新片段", emittedAtMs: 1_800_000_000_000 }); await f.flush();
      expect(messages.scrollTop).toBe(100);
      expect(f.node("jump-to-latest").hidden).toBe(false);
      expect(f.node("jump-to-latest").textContent).toContain("有新消息");
      await f.node("jump-to-latest").emit("click");
      expect(messages.scrollTop).toBe(messages.scrollHeight);
      expect(f.node("jump-to-latest").hidden).toBe(true);
      channel.close(); await submitted;
    } finally { await f.close(); }
  });

  it.each(["missing", "different"] as const)("never establishes an initial turn binding with a %s idempotency key", async fault => {
    const f = await fixture();
    try {
      let channel!: ReturnType<typeof stream>;
      f.setPost(request => { channel = stream(request.signal); return channel.response; });
      await f.input("初次绑定必须核验幂等键"); const submitted = f.submit(); await f.flush();
      const candidate: Json = turn("turn_untrusted_key", "another-key", "completed");
      if (fault === "missing") delete candidate.idempotencyKey;
      f.turns.set(SID, [candidate]);
      f.items.set(SID, [userItem("item_untrusted_key", String(candidate.id), 1, "初次绑定必须核验幂等键")]);
      channel.event({ sessionId: SID, seq: 1, type: "turn/started", turn: { ...candidate, status: "inProgress" } });
      channel.event({ sessionId: SID, seq: 2, type: "turn/completed", turn: candidate });
      channel.close(); await submitted; await f.flush();
      expect(f.saved().pending[SID]?.turnId).toBeNull();
      expect(f.saved().pending[SID]?.unknown).toBe(true);
      expect(f.node("message-input").disabled).toBe(false);
      expect(f.node("send-message").disabled).toBe(true);
      expect(f.posts()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("accepts omitted optional keys on later SSE and GET snapshots after an exact initial binding", async () => {
    const f = await fixture();
    try {
      let channel!: ReturnType<typeof stream>;
      f.setPost(request => { channel = stream(request.signal); return channel.response; });
      await f.input("绑定后允许省略可选键"); const submitted = f.submit(); await f.flush();
      const key = f.posts()[0]!.headers["Idempotency-Key"]!, running = turn("turn_optional_key", key);
      channel.event({ sessionId: SID, seq: 1, type: "turn/started", turn: running }); await f.flush();
      expect(f.saved().pending[SID]?.turnId).toBe(running.id);
      const completed: Json = turn(running.id, key, "completed"); delete completed.idempotencyKey;
      const item = userItem("item_optional_key", running.id, 1, "绑定后允许省略可选键");
      f.turns.set(SID, [completed]); f.items.set(SID, [item]);
      channel.event({ sessionId: SID, seq: 2, type: "item/completed", item });
      channel.event({ sessionId: SID, seq: 3, type: "turn/completed", turn: completed });
      await f.flush(); channel.close(); await submitted; await f.flush();
      expect(f.saved().pending[SID]).toBeUndefined();
      expect(f.node("message-input").disabled).toBe(false);
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0]!.id).toBe("message-item_optional_key");
      expect(f.posts()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("refuses an explicitly conflicting key after binding instead of clearing the original request", async () => {
    const f = await fixture();
    try {
      let channel!: ReturnType<typeof stream>;
      f.setPost(request => { channel = stream(request.signal); return channel.response; });
      await f.input("显式冲突不能提升为成功"); const submitted = f.submit(); await f.flush();
      const key = f.posts()[0]!.headers["Idempotency-Key"]!, running = turn("turn_conflicting_key", key);
      channel.event({ sessionId: SID, seq: 1, type: "turn/started", turn: running }); await f.flush();
      const conflicting = turn(running.id, "different-key", "completed");
      f.turns.set(SID, [conflicting]); f.items.set(SID, [userItem("item_conflicting_key", running.id)]);
      channel.event({ sessionId: SID, seq: 2, type: "turn/completed", turn: conflicting });
      channel.close(); await submitted; await f.flush();
      expect(f.saved().pending[SID]).toMatchObject({ key, turnId: running.id });
      expect(f.node("message-input").disabled).toBe(false);
      expect(f.node("send-message").disabled).toBe(true);
      expect(f.posts()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("unlocks a read-confirmed terminal turn without a user item while preserving its unmatched bubble", async () => {
    const f = await fixture();
    try {
      let channel!: ReturnType<typeof stream>;
      f.setPost(request => { channel = stream(request.signal); return channel.response; });
      await f.input("终态缺持久用户消息也不能丢原文"); const submitted = f.submit(); await f.flush();
      const localNode = f.messages()[0], key = f.posts()[0]!.headers["Idempotency-Key"]!, running = turn("turn_without_user_item", key);
      channel.event({ sessionId: SID, seq: 1, type: "turn/started", turn: running }); await f.flush();
      const completed = turn(running.id, key, "completed"); f.turns.set(SID, [completed]);
      channel.event({ sessionId: SID, seq: 2, type: "turn/completed", turn: completed });
      await f.flush(); channel.close(); await submitted; await f.flush();
      expect(f.saved().pending[SID]).toBeUndefined();
      expect(f.node("message-input").disabled).toBe(false);
      expect(f.saved().feedback?.[SID]).toMatchObject({ key, turnId: running.id, unmatched: true });
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0]).toBe(localNode);
      expect(f.messages()[0]!.querySelector(".message-delivery")?.textContent).toContain("待核对持久消息");
      expect(f.messages()[0]!.textContent).toContain("终态缺持久用户消息也不能丢原文");
      expect(f.node("turn-banner-title").textContent).toContain("持久消息待核对");
      f.items.set(SID, [userItem("item_late_persisted", running.id, 1, "终态缺持久用户消息也不能丢原文")]);
      await f.node("refresh-session").emit("click"); await f.flush();
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0]).toBe(localNode);
      expect(f.messages()[0]!.id).toBe("message-item_late_persisted");
      expect(f.saved().feedback?.[SID]).not.toHaveProperty("unmatched");
      expect(f.saved().feedback?.[SID]).not.toHaveProperty("body");
      expect(f.posts()).toHaveLength(1);
    } finally { await f.close(); }
  });
});

describe("H5 next drafts and incremental history through the real browser script", () => {
  it.each(["下一轮草稿", "正在执行的原文"])("keeps an editable next draft %s through acceptance and terminal read confirmation", async draft => {
    const f = await fixture();
    try {
      let channel!: ReturnType<typeof stream>;
      f.setPost(request => { channel = stream(request.signal); return channel.response; });
      await f.input("正在执行的原文"); const submitted = f.submit(); await f.flush();
      const body = f.posts()[0]!.body, key = f.posts()[0]!.headers["Idempotency-Key"]!;
      expect(f.node("message-input").value).toBe("");
      expect(f.node("message-input").disabled).toBe(false);
      expect(f.node("send-message").disabled).toBe(true);
      await f.input(draft);
      await f.submit();
      expect(f.posts()).toHaveLength(1);
      expect(f.saved().pending[SID]?.body).toEqual(body);
      const running = turn("turn_next_draft", key), item = userItem("item_next_draft", running.id, 1, "正在执行的原文");
      f.turns.set(SID, [running]); f.items.set(SID, [item]); f.sessions.set(SID, { ...session(), status: { type: "active", turnId: running.id } });
      channel.event({ sessionId: SID, seq: 1, type: "turn/started", turn: running });
      channel.event({ sessionId: SID, seq: 2, type: "item/completed", item });
      await f.flush();
      expect(f.node("message-input").value).toBe(draft);
      expect(f.saved().drafts[SID]).toBe(draft);
      const completed = turn(running.id, key, "completed"); f.turns.set(SID, [completed]);
      channel.event({ sessionId: SID, seq: 3, type: "turn/completed", turn: completed });
      await f.flush(); channel.close(); await submitted; await f.flush();
      // Even a terminal SSE and terminal turn GET cannot admit another POST while the session is active.
      expect(f.saved().pending[SID]?.turnId).toBe(running.id);
      expect(f.node("send-message").disabled).toBe(true);
      expect(f.node("message-input").value).toBe(draft);
      expect(f.posts()).toHaveLength(1);
      f.sessions.set(SID, session());
      await f.node("refresh-session").emit("click"); await f.flush();
      expect(f.saved().pending[SID]).toBeUndefined();
      expect(f.node("message-input").value).toBe(draft);
      expect(f.saved().drafts[SID]).toBe(draft);
      expect(f.node("send-message").disabled).toBe(false);
      expect(f.posts()).toHaveLength(1);
      expect(f.posts()[0]!.body).toEqual(body);
    } finally { await f.close(); }
  });

  it.each(["admission", "rejection", "transport"] as const)("preserves a newly edited draft after a delayed %s failure", async failure => {
    const f = await fixture();
    try {
      await f.input("失败请求的原文"); const submitted = f.submit(); await f.flush();
      await f.input("请求返回前另写的新草稿");
      if (failure === "transport") f.post.reject(new Error("fixture transport lost after draft edit"));
      else f.post.resolve(json({ error: { code: failure === "admission" ? "turn_not_submitted" : "turn_conflict" } }, failure === "admission" ? 503 : 409));
      await submitted; await f.flush();
      expect(f.node("message-input").disabled).toBe(false);
      expect(f.node("message-input").value).toBe("请求返回前另写的新草稿");
      expect(f.saved().drafts[SID]).toBe("请求返回前另写的新草稿");
      expect(f.messages()[0]!.querySelector(".message-text")?.textContent).toBe("失败请求的原文");
      expect(f.node("send-message").disabled).toBe(failure === "transport");
      expect(f.posts()).toHaveLength(1);
      await f.node("refresh-session").emit("click"); await f.flush();
      expect(f.node("message-input").value).toBe("请求返回前另写的新草稿");
      expect(f.posts()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("persists a pending session's next draft across switches and reload without automatically submitting either text", async () => {
    const f = await fixture();
    try {
      await f.input("会话 A 已发送的原文"); const submitted = f.submit(); await f.flush();
      await f.input("会话 A 的下一条草稿");
      await f.select(OTHER); await submitted; await f.flush();
      await f.input("会话 B 的独立草稿");
      await f.select(SID);
      expect(f.node("message-input").value).toBe("会话 A 的下一条草稿");
      expect(f.node("message-input").disabled).toBe(false);
      expect(f.node("send-message").disabled).toBe(true);
      expect(f.saved().pending[SID]?.body).toMatchObject({ input: [{ type: "text", text: "会话 A 已发送的原文" }] });
      expect(f.posts()).toHaveLength(1);
      const restored = await fixture({ storage: f.storage });
      try {
        expect(restored.node("message-input").value).toBe("会话 A 的下一条草稿");
        expect(restored.node("message-input").disabled).toBe(false);
        expect(restored.node("send-message").disabled).toBe(true);
        expect(restored.messages()[0]!.querySelector(".message-text")?.textContent).toBe("会话 A 已发送的原文");
        await restored.select(OTHER);
        expect(restored.node("message-input").value).toBe("会话 B 的独立草稿");
        await restored.select(SID);
        expect(restored.node("message-input").value).toBe("会话 A 的下一条草稿");
        expect(restored.calls.every(call => call.method === "GET")).toBe(true);
        expect(restored.posts()).toHaveLength(0);
      } finally { await restored.close(); }
    } finally { await f.close(); }
  });

  it("does not restore a rejected original over a next draft deliberately cleared by the user", async () => {
    const f = await fixture();
    try {
      await f.input("被拒绝但保存在气泡中的原文"); const submitted = f.submit(); await f.flush();
      await f.input("临时下一条草稿"); await f.input("");
      f.post.resolve(json({ error: { code: "turn_not_submitted" } }, 503));
      await submitted; await f.flush();
      expect(f.node("message-input").value).toBe("");
      expect(f.saved().drafts[SID]).toBe("");
      expect(f.messages()[0]!.textContent).toContain("被拒绝但保存在气泡中的原文");
      expect(f.posts()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("retains 500 unchanged history articles and text nodes through polling, deltas and terminal metadata changes", async () => {
    const f = await fixture();
    try {
      const history = Array.from({ length: 500 }, (_, index) => userItem(`item_history_${index}`, "turn_history_seed", index + 1, `历史消息 ${String(index).padStart(3, "0")}`));
      f.items.set(SID, history);
      await f.node("refresh-session").emit("click"); await f.flush();
      expect(f.messages()).toHaveLength(500);
      const articles = f.messages(), texts = articles.map(article => article.querySelector(".message-text")!), textNodes = texts.map(text => text.firstChild);
      const snapshots = articles.map((article, index) => ({ article: { ...article.mutations }, text: { ...texts[index]!.mutations }, leaf: { ...textNodes[index]!.mutations } }));
      const assertHistoryUntouched = () => {
        const current = f.messages();
        expect(articles.every((article, index) => current[index] === article)).toBe(true);
        expect(texts.every((text, index) => current[index]!.querySelector(".message-text") === text && text.firstChild === textNodes[index])).toBe(true);
        expect(articles.map((article, index) => ({ article: { ...article.mutations }, text: { ...texts[index]!.mutations }, leaf: { ...textNodes[index]!.mutations } }))).toEqual(snapshots);
      };
      let channel!: ReturnType<typeof stream>;
      f.setPost(request => { channel = stream(request.signal); return channel.response; });
      await f.input("长历史之后的新消息"); const submitted = f.submit(); await f.flush();
      assertHistoryUntouched();
      const key = f.posts()[0]!.headers["Idempotency-Key"]!, running = turn("turn_history_live", key);
      const user = userItem("item_history_live_user", running.id, 501, "长历史之后的新消息");
      const reply = { id: "item_history_live_reply", sessionId: SID, turnId: running.id, seq: 502, type: "agentMessage", status: "inProgress", text: "", createdAtMs: 1_800_000_000_000 };
      f.turns.set(SID, [running]); f.items.set(SID, [...history, user, reply]); f.sessions.set(SID, { ...session(), status: { type: "active", turnId: running.id } });
      channel.event({ sessionId: SID, seq: 1, type: "turn/started", turn: running });
      channel.event({ sessionId: SID, seq: 2, type: "item/completed", item: user });
      channel.event({ sessionId: SID, seq: 3, type: "item/started", item: reply }); await f.flush();
      assertHistoryUntouched();
      const messages = f.node("messages"), rootWrites = messages.mutations.children;
      messages.scrollTop = 1200; await messages.emit("scroll");
      await f.timer(1000);
      expect(messages.mutations.children).toBe(rootWrites);
      expect(messages.scrollTop).toBe(1200);
      assertHistoryUntouched();
      channel.event({ sessionId: SID, type: "item/agentMessage/delta", turnId: running.id, itemId: reply.id, delta: "新的分片", emittedAtMs: 1_800_000_000_000 }); await f.flush();
      expect(messages.mutations.children).toBe(rootWrites);
      expect(messages.scrollTop).toBe(1200);
      assertHistoryUntouched();
      const replyArticle = f.messages().at(-1)!, replyText = replyArticle.querySelector(".message-text")!, replyLeaf = replyText.firstChild;
      const finalReply = { ...reply, text: "新的分片", status: "completed" }, completed = turn(running.id, key, "completed");
      f.items.set(SID, [...history, user, finalReply]); f.turns.set(SID, [completed]); f.sessions.set(SID, session());
      channel.event({ sessionId: SID, seq: 4, type: "item/completed", item: finalReply });
      channel.event({ sessionId: SID, seq: 5, type: "turn/completed", turn: completed });
      await f.flush(); channel.close(); await submitted; await f.flush();
      expect(f.saved().pending[SID]).toBeUndefined();
      expect(f.messages().at(-1)).toBe(replyArticle);
      expect(replyArticle.querySelector(".message-text")).toBe(replyText);
      expect(replyText.firstChild).toBe(replyLeaf);
      expect(replyText.textContent).toBe("新的分片");
      expect(messages.scrollTop).toBe(1200);
      assertHistoryUntouched();
      expect(f.posts()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("updates a same-length durable text correction without replacing its article or any unrelated body", async () => {
    const f = await fixture();
    try {
      const original = userItem("item_same_length", "turn_same_length", 1, "旧正文"), other = userItem("item_other_body", "turn_same_length", 2, "未变正文");
      f.items.set(SID, [original, other]);
      await f.node("refresh-session").emit("click"); await f.flush();
      const [changedArticle, otherArticle] = f.messages(), changedBody = changedArticle!.querySelector(".message-text"), otherBody = otherArticle!.querySelector(".message-text"), otherLeaf = otherBody!.firstChild;
      const otherMutations = { ...otherBody!.mutations };
      f.items.set(SID, [{ ...original, content: [{ type: "text", text: "新正文" }] }, other]);
      await f.node("refresh-session").emit("click"); await f.flush();
      expect(f.messages()[0]).toBe(changedArticle);
      expect(changedArticle!.querySelector(".message-text")).toBe(changedBody);
      expect(changedBody!.textContent).toBe("新正文");
      expect(f.messages()[1]).toBe(otherArticle);
      expect(otherArticle!.querySelector(".message-text")).toBe(otherBody);
      expect(otherBody!.firstChild).toBe(otherLeaf);
      expect(otherBody!.mutations).toEqual(otherMutations);
      expect(f.posts()).toHaveLength(0);
    } finally { await f.close(); }
  });
});

describe("H5 environment events from the real isolated panel script", () => {
  it("publishes readiness changes while retaining read-only refresh and deduplicating equal snapshots", async () => {
    const f = await fixture({ script: "environment.js" }), received: Json[] = [];
    f.document.addEventListener("chat-environment-state", event => { received.push(event.detail as Json); });
    try {
      await f.node("env-refresh").emit("click"); await f.flush();
      f.setEnvironment({ enabled: true, overall: "stopped", operation: null, components: ["owner", "router", "runner", "mysql", "redis"].map(id => ({ id, state: id === "owner" ? "ready" : "stopped" })), actions: [] });
      await f.node("env-refresh").emit("click"); await f.flush();
      const stopped = received.filter(event => event.phase === "settled" && event.servicesReady === false);
      expect(stopped).toHaveLength(1);
      await f.node("env-refresh").emit("click"); await f.flush();
      expect(received.filter(event => event.phase === "settled" && event.servicesReady === false)).toHaveLength(1);
      expect(f.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await f.close(); }
  });

  it("does not report disabled OWNER controls as proof that independent chat is stopped", async () => {
    const f = await fixture({ script: "environment.js" }), received: Json[] = [];
    f.document.addEventListener("chat-environment-state", event => { received.push(event.detail as Json); });
    try {
      f.setEnvironment({ enabled: false, overall: "unknown", components: [], actions: [], operation: null });
      await f.node("env-refresh").emit("click"); await f.flush();
      const settled = received.find(event => event.phase === "settled" && event.available === false);
      expect(settled).toBeDefined();
      expect(settled).not.toHaveProperty("servicesReady");
      expect(f.calls.every(call => call.method === "GET")).toBe(true);
    } finally { await f.close(); }
  });

  it("publishes an immediate action lock and one unknown result without retrying an ambiguous operation", async () => {
    const f = await fixture({ script: "environment.js" }), received: Json[] = [];
    f.document.addEventListener("chat-environment-state", event => { received.push(event.detail as Json); });
    try {
      f.setEnvironment({ enabled: true, overall: "stopped", operation: null, components: ["owner", "router", "runner", "mysql", "redis"].map(id => ({ id, state: id === "owner" ? "ready" : "stopped" })), actions: [{ id: "start-services", enabled: true }] });
      await f.node("env-refresh").emit("click"); await f.flush();
      const gate = deferred<Response>(); f.setAction(() => gate.promise);
      const start = f.node("env-actions").querySelectorAll("button").find(node => node.dataset.action === "start-services")!;
      await start.emit("click");
      expect(received.find(event => event.phase === "action-start")).toMatchObject({ operationState: "running", servicesReady: false });
      gate.reject(new Error("fixture connection lost")); await f.flush();
      expect(received.filter(event => event.phase === "action-settled")).toEqual([expect.objectContaining({ operationState: "unknown", servicesReady: false })]);
      await f.node("env-refresh").emit("click"); await f.flush();
      expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
      expect(f.node("env-actions").querySelectorAll("button").every(button => button.disabled)).toBe(true);
    } finally { await f.close(); }
  });

  it("waits for a read-confirmed exact operation before publishing action completion", async () => {
    const f = await fixture({ script: "environment.js" }), received: Json[] = [];
    f.document.addEventListener("chat-environment-state", event => { received.push(event.detail as Json); });
    try {
      const components = ["owner", "router", "runner", "mysql", "redis"].map(id => ({ id, state: "ready" }));
      f.setEnvironment({ enabled: true, overall: "ready", operation: null, components, actions: [{ id: "start-services", enabled: true }] });
      await f.node("env-refresh").emit("click"); await f.flush();
      let operation = { id: "", action: "start-services", state: "running" };
      f.setAction(request => { operation = { ...operation, id: request.headers["Idempotency-Key"]! }; f.setEnvironment({ enabled: true, overall: "transitioning", operation, components, actions: [] }); return json({ operation }, 202); });
      await f.node("env-actions").querySelectorAll("button").find(node => node.dataset.action === "start-services")!.emit("click"); await f.flush();
      expect(received.filter(event => event.phase === "action-settled"), JSON.stringify(received)).toEqual([]);
      f.setEnvironment({ enabled: true, overall: "ready", operation: { ...operation, state: "succeeded" }, components, actions: [] });
      await f.timer(5000);
      expect(received.filter(event => event.phase === "action-settled")).toEqual([expect.objectContaining({ operationId: operation.id, operationState: "succeeded", servicesReady: true })]);
      expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("does not complete an action when its accepted response carries a different operation UUID", async () => {
    const f = await fixture({ script: "environment.js" }), received: Json[] = [];
    f.document.addEventListener("chat-environment-state", event => { received.push(event.detail as Json); });
    try {
      const components = ["owner", "router", "runner", "mysql", "redis"].map(id => ({ id, state: "ready" }));
      f.setEnvironment({ enabled: true, overall: "ready", operation: null, components, actions: [{ id: "start-services", enabled: true }] });
      await f.node("env-refresh").emit("click"); await f.flush();
      const operation = { id: "00000000-0000-4000-8000-000000000050", action: "start-services", state: "succeeded" };
      f.setAction(() => { f.setEnvironment({ enabled: true, overall: "ready", operation, components, actions: [] }); return json({ operation }, 202); });
      await f.node("env-actions").querySelectorAll("button").find(node => node.dataset.action === "start-services")!.emit("click"); await f.flush();
      expect(f.calls.find(call => call.method === "POST")?.headers["Idempotency-Key"]).not.toBe(operation.id);
      expect(received.filter(event => event.phase === "action-settled")).toEqual([expect.objectContaining({ operationState: "unknown", servicesReady: false })]);
      await f.node("env-refresh").emit("click"); await f.flush();
      expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
      expect(f.node("env-actions").querySelectorAll("button").every(button => button.disabled)).toBe(true);
    } finally { await f.close(); }
  });
});
