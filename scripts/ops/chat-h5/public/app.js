"use strict";

// This page only knows the local proxy's CSRF token. Upstream credentials stay in Node.
(() => {
  const $ = (id) => document.getElementById(id);
  const ui = {
    sessions: $("session-list"), messages: $("messages"), input: $("message-input"),
    send: $("send-message"), create: $("new-session"), refresh: $("refresh-session"),
    stop: $("interrupt-turn"), banner: $("turn-banner"), notice: $("global-notice"),
    latest: $("jump-to-latest"),
  };
  const STORE = "agent-service.chat-h5.v1";
  const LIMITS = Object.freeze({ maxSteps: 6, maxToolCalls: 1, maxWallClockMs: 60000, maxOutputTokensPerStep: 1024 });
  const TERMINAL = new Set(["completed", "interrupted", "failed"]);
  const statusNames = { inProgress: "执行中", completed: "已完成", interrupted: "已中断", failed: "执行失败" };
  const stopNames = {
    end_turn: "自然结束", max_steps: "达到步数限制", max_tool_calls: "达到工具调用限制",
    max_cost: "达到费用限制", max_wall_clock: "达到时间限制", max_output_tokens: "达到输出限制",
    interrupted: "已中断", error: "执行错误",
  };
  const messageLayouts = new WeakMap(), messagePresentations = new WeakMap();
  let saved = readSaved();
  const state = {
    config: null, ready: false, sessions: new Map(), sessionCursor: null,
    session: null, turns: [], turn: null, items: new Map(), view: 0,
    loading: false, posting: false, creating: false, stopping: false,
    poll: null, refreshTask: null, listTask: null, sessionError: "", toastTimer: null,
    stream: null, streamItems: new Map(), eventAfter: -1, streamStatus: "", reconnect: null,
    reconnects: 0, postRequest: null, turnRevision: 0, turnUnconfirmed: false,
    followLatest: true, unread: false, progressTimer: null, environmentBusy: false,
    environmentReady: undefined, environmentRevision: 0, environmentSignature: "", environmentTask: null,
  };

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }

  function readSaved() {
    try {
      const value = JSON.parse(sessionStorage.getItem(STORE) || "{}");
      return {
        selected: typeof value.selected === "string" ? value.selected : "",
        recent: Array.isArray(value.recent) ? value.recent.filter(validSessionId).slice(0, 100) : [],
        pending: value.pending && typeof value.pending === "object" && !Array.isArray(value.pending) ? value.pending : {},
        drafts: value.drafts && typeof value.drafts === "object" && !Array.isArray(value.drafts) ? value.drafts : {},
        failed: value.failed && typeof value.failed === "object" && !Array.isArray(value.failed) ? value.failed : {},
        feedback: value.feedback && typeof value.feedback === "object" && !Array.isArray(value.feedback) ? value.feedback : {},
      };
    } catch { return { selected: "", recent: [], pending: {}, drafts: {}, failed: {}, feedback: {} }; }
  }

  function persist() {
    try { sessionStorage.setItem(STORE, JSON.stringify(saved)); return true; }
    catch {
      notice("浏览器无法保存本次请求状态。为避免刷新后重复发送，已禁用新的发送；请允许本站使用 sessionStorage 后重新打开页面。");
      state.storageFailed = true;
      return false;
    }
  }

  function validSessionId(value) { return typeof value === "string" && /^sess_[A-Za-z0-9_-]+$/.test(value); }
  function pendingFor(id = state.session?.id) {
    const value = id && saved.pending[id];
    if (!value) return null;
    // A malformed durable marker must stay locked instead of silently becoming a new request.
    return typeof value === "object" ? value : { unknown: true, invalid: true };
  }
  function requestText(record) {
    const input = record?.body?.input;
    if (typeof record?.key !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(record.key) || !Array.isArray(input) || input.length !== 1
      || input[0]?.type !== "text" || typeof input[0].text !== "string" || input[0].text.length > 16000) return null;
    return input[0].text;
  }
  function timingFor(record) {
    if (!record) return null;
    if (!record.timing || typeof record.timing !== "object" || Array.isArray(record.timing)) record.timing = {};
    return record.timing;
  }
  function markTiming(record, field) {
    const timing = timingFor(record);
    if (timing && !Number.isFinite(timing[field])) {
      timing[field] = Date.now(); persist();
      if (field === "firstChunkAtMs") { renderBanner(); renderDiagnostics(); }
    }
  }
  function elapsed(record) {
    if (!Number.isFinite(record?.createdAtMs)) return "";
    const end = Number.isFinite(record.timing?.confirmedAtMs) ? record.timing.confirmedAtMs : Date.now();
    return `${Math.max(0, (end - record.createdAtMs) / 1000).toFixed(1)} 秒`;
  }
  function detachSubmittedDraft(record, sid) {
    // First-batch pages kept the submitted text in the composer until acceptance.
    // Detach that legacy draft once. New requests are detached before their POST;
    // later acceptance/terminal reads must never compare or clear the next draft.
    if (record.draftDetached) return;
    const text = requestText(record);
    if (text === null) return;
    if (typeof saved.drafts[sid] === "string" && saved.drafts[sid].trim() === text) saved.drafts[sid] = "";
    if (sid === state.session?.id && ui.input.value.trim() === text) ui.input.value = "";
    record.draftDetached = true;
  }
  function saveDraft() {
    if (!state.session) return;
    const sid = state.session.id, pending = pendingFor(sid);
    saved.drafts[sid] = ui.input.value;
    if (pending) pending.nextDraftEdited = true;
    persist();
  }
  function restoreRejectedDraft(record, sid) {
    const text = requestText(record);
    if (text === null || record.nextDraftEdited || saved.drafts[sid]) return;
    saved.drafts[sid] = text;
    if (sid === state.session?.id) ui.input.value = text;
  }
  function rememberFailure(sid, record, notSubmitted, message) {
    const failure = { key: record.key, body: record.body, createdAtMs: record.createdAtMs, timing: record.timing,
      failed: true, notSubmitted, message: String(message || "").slice(0, 300) };
    rememberLocalRecord(sid, failure);
  }
  function rememberLocalRecord(sid, failure) {
    const rows = Array.isArray(saved.failed[sid]) ? saved.failed[sid] : [];
    saved.failed[sid] = [...rows.filter((row) => row?.key !== failure.key), failure].slice(-3);
    const all = Object.entries(saved.failed).flatMap(([id, records]) => Array.isArray(records) ? records.map((row) => ({ sid: id, row })) : [])
      .sort((a, b) => (b.row?.createdAtMs || 0) - (a.row?.createdAtMs || 0));
    const keep = new Set(all.slice(0, 20).map(({ row }) => row));
    for (const [id, records] of Object.entries(saved.failed)) {
      if (!Array.isArray(records)) { delete saved.failed[id]; continue; }
      saved.failed[id] = records.filter((row) => keep.has(row));
      if (!saved.failed[id].length) delete saved.failed[id];
    }
  }
  function deliveryText(record) {
    if (record.failed) return record.notSubmitted ? "未发送 · 草稿已保留" : "发送被拒绝 · 草稿已保留";
    if (record.unmatched) return "已接收 · 执行已结束，待核对持久消息";
    if (!record.turnId) return record.unknown ? "结果待核对 · 不会自动重发" : `发送中${elapsed(record) ? ` · ${elapsed(record)}` : ""}`;
    if (record.timing?.confirmedAtMs) return "已发送";
    if (record.unknown) return "已接收 · 连接中断，正在核对";
    if (state.turn?.id === record.turnId && TERMINAL.has(state.turn.status)) return "已发送 · 正在核对结果";
    return `${record.timing?.firstChunkAtMs ? "已发送 · 正在回复" : "已发送 · 等待回复"}${elapsed(record) ? ` · ${elapsed(record)}` : ""}`;
  }
  function syncProgressTimer() {
    if (pendingFor() && !state.progressTimer) state.progressTimer = setInterval(() => {
      // The banner is a live region. Keep the clock in non-live diagnostics and
      // bubble metadata so assistive technology only announces phase changes.
      renderDiagnostics();
      for (const node of ui.messages.querySelectorAll("[data-local-key]")) {
        const pending = pendingFor();
        if (pending?.key === node.dataset.localKey) {
          const label = node.querySelector(".message-delivery");
          if (label) setNodeText(label, deliveryText(pending));
        }
      }
    }, 500);
    else if (!pendingFor() && state.progressTimer) { clearInterval(state.progressTimer); state.progressTimer = null; }
  }
  function profileMismatch() {
    const session = state.session, config = state.config;
    return Boolean(session?.status && config && (session.userId !== config.userId
      || session.agentId !== config.agentId || session.agentVersion !== config.agentVersion));
  }
  function rememberSession(session) {
    state.sessions.set(session.id, session);
    saved.recent = [session.id, ...saved.recent.filter((id) => id !== session.id)].slice(0, 100);
    persist();
    renderSessions();
  }
  function notice(message = "") { ui.notice.textContent = message; ui.notice.hidden = !message; }
  function toast(message) {
    clearTimeout(state.toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    state.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3000);
  }
  function formatDate(ms) {
    if (!Number.isFinite(ms)) return "本机已保存的会话";
    return new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function clockTime(ms) { return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""; }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.method === "POST"
      ? state.config?.operationTimeoutMs || 90000 : state.config?.requestTimeoutMs || 15000);
    try {
      const headers = { Accept: "application/json", ...options.headers };
      if (state.config?.csrfToken) headers["X-Chat-Token"] = state.config.csrfToken;
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(path, {
        method: options.method || "GET", headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
      });
      let data;
      try { data = await response.json(); } catch { throw new ApiError("代理返回了不可读取的结果。", response.status, "invalid_response"); }
      if (!response.ok) {
        const error = data?.error;
        const code = typeof error === "string" ? error : error?.code || data?.code;
        const descriptions = { upstream_outcome_unknown: "上游处理结果尚不明确", session_profile_mismatch: "会话与当前体验配置不一致", upstream_rejected: "服务明确拒绝本次请求", turn_not_submitted: "服务暂不可用，本次消息尚未提交给执行服务", environment_not_ready: "本地环境尚未就绪，本次消息尚未提交" };
        throw new ApiError(error?.message || data?.message || descriptions[code] || `请求失败（HTTP ${response.status}）`, response.status, code);
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new ApiError("请求超时；服务端可能仍在处理。", 0, "request_timeout");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function hasActiveTurn() {
    return Boolean(pendingFor() || state.turnUnconfirmed || state.turn?.status === "inProgress" || state.session?.status?.type === "active");
  }

  function closeStream() {
    clearTimeout(state.reconnect); state.reconnect = null;
    const stream = state.stream;
    state.stream = null;
    if (stream) stream.controller.abort();
  }

  function streamIsCurrent(stream) {
    return state.stream === stream && stream.view === state.view && stream.sid === state.session?.id;
  }

  function streamTurnMatches(stream, turnId) {
    const expected = pendingFor(stream.sid)?.turnId || stream.turnId;
    return Boolean(expected && expected === turnId);
  }

  function finalItem(item) { return Boolean(item && item.status !== "inProgress"); }

  function acceptStreamTurn(stream, turn) {
    if (!turn?.id || turn.sessionId !== stream.sid) throw new Error("流式执行的会话归属不正确。请只读核对。");
    const pending = pendingFor(stream.sid);
    // A resumed stream can replay earlier turns. Bind an unknown submission only by its exact key.
    if (pending && (!pending.key || (turn.idempotencyKey !== undefined && pending.key !== turn.idempotencyKey)
      || (pending.turnId ? pending.turnId !== turn.id : pending.key !== turn.idempotencyKey))) return false;
    if (!pending && stream.turnId && stream.turnId !== turn.id) return false;
    stream.turnId = turn.id;
    if (pending) {
      pending.turnId = turn.id; pending.unknown = false;
      markTiming(pending, "acceptedAtMs");
      detachSubmittedDraft(pending, stream.sid);
      persist();
    }
    state.turn = turn;
    state.turnRevision++;
    state.turnUnconfirmed = true;
    return true;
  }

  function applyStreamEvent(stream, event) {
    if (!streamIsCurrent(stream)) return;
    if (!event || event.sessionId !== stream.sid || typeof event.type !== "string") throw new Error("流式事件的会话归属或格式不正确。请只读核对。");
    if (event.seq !== undefined) {
      if (!Number.isInteger(event.seq) || event.seq < 0) throw new Error("流式事件序列不正确。请只读核对。");
      if (event.seq <= state.eventAfter) return;
      state.eventAfter = event.seq;
    }
    if (event.type === "turn/started" || event.type === "turn/completed") {
      if (!acceptStreamTurn(stream, event.turn)) return;
      if (event.type === "turn/completed") {
        stream.terminal = true;
        state.streamStatus = "输出已结束，正在核对持久结果";
        // The event alone never unlocks the composer; GET must confirm turn, items and idle session.
        void refreshCurrent(true);
      }
      renderControls();
    } else if (event.type === "item/started" || event.type === "item/completed") {
      const item = event.item;
      if (!item?.id || item.sessionId !== stream.sid || !Number.isInteger(item.seq)) throw new Error("流式消息的会话归属或格式不正确。请只读核对。");
      if (!streamTurnMatches(stream, item.turnId)) return;
      if (finalItem(state.items.get(item.id))) return;
      const prior = state.streamItems.get(item.id);
      // Replayed item/started is an empty durable snapshot; preserve live text already received.
      const value = event.type === "item/started" && item.type === "agentMessage" && prior?.type === "agentMessage"
        ? { ...item, text: prior.text || item.text } : item;
      if (item.type === "agentMessage" && value.text) markTiming(pendingFor(stream.sid), "firstChunkAtMs");
      state.streamItems.set(item.id, { ...value, _stream: event.type === "item/started" && item.type === "agentMessage" && item.status === "inProgress" });
      renderItems();
    } else if (event.type === "item/agentMessage/delta") {
      if (!streamTurnMatches(stream, event.turnId)) return;
      if (typeof event.itemId !== "string" || typeof event.delta !== "string") throw new Error("流式文本分片格式不正确。请只读核对。");
      if (finalItem(state.items.get(event.itemId))) return;
      const previous = state.streamItems.get(event.itemId) || state.items.get(event.itemId);
      if (finalItem(previous)) return;
      if (event.delta) markTiming(pendingFor(stream.sid), "firstChunkAtMs");
      const maxSeq = previous ? previous.seq : [...state.items.values(), ...state.streamItems.values()].reduce((max, item) => Math.max(max, item.seq), -1);
      const item = {
        ...(previous || { id: event.itemId, sessionId: stream.sid, turnId: event.turnId, seq: maxSeq + 0.5, createdAtMs: event.emittedAtMs, type: "agentMessage" }),
        text: (previous?.text || "") + event.delta, status: "inProgress", _stream: true,
      };
      state.streamItems.set(event.itemId, item);
      renderDelta(item);
    } else if (event.type === "usage/updated" && streamTurnMatches(stream, event.turnId) && state.turn) {
      state.turn = { ...state.turn, usage: event.turnUsage, model: event.runtime };
      renderDiagnostics();
    }
  }

  async function readEventStream(response, stream, resetTimeout) {
    if (!response.body) throw new Error("代理未返回可读取的事件流。");
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "", lines = [], frameSize = 0;
    function line(value) {
      if (value === "") {
        if (lines.length) {
          let event;
          try { event = JSON.parse(lines.join("\n")); } catch { throw new Error("流式事件 JSON 不可读取。请只读核对。"); }
          applyStreamEvent(stream, event);
        }
        lines = []; frameSize = 0;
        return;
      }
      if (value[0] === ":") return;
      const colon = value.indexOf(":"), field = colon < 0 ? value : value.slice(0, colon);
      let content = colon < 0 ? "" : value.slice(colon + 1);
      if (content[0] === " ") content = content.slice(1);
      // Live deltas intentionally have no SSE id. Reconnect cursors come only from durable seq.
      if (field === "data") {
        frameSize += content.length;
        if (frameSize > 1048576) throw new Error("单条流式事件过大，已转为只读核对。");
        lines.push(content);
      }
    }
    function drain(final = false) {
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== "\r" && buffer[i] !== "\n") continue;
        if (buffer[i] === "\r" && i === buffer.length - 1 && !final) break;
        line(buffer.slice(start, i));
        if (buffer[i] === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
        if (stream.terminal || !streamIsCurrent(stream)) break;
      }
      buffer = buffer.slice(start);
      if (buffer.length > 1048576) throw new Error("流式事件缓冲过大，已转为只读核对。");
    }
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode(); drain(true);
          // An incomplete final frame is discarded. EOF is never evidence of turn completion.
          break;
        }
        resetTimeout();
        buffer += decoder.decode(value, { stream: true }); drain();
        if (stream.terminal || !streamIsCurrent(stream)) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function fetchStream(stream, path, options = {}) {
    let timeout;
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => stream.controller.abort(), state.config?.operationTimeoutMs || 90000);
    };
    resetTimeout();
    try {
      const headers = { Accept: "text/event-stream, application/json", "X-Chat-Token": state.config.csrfToken, ...options.headers };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(path, {
        method: options.method || "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal: stream.controller.signal,
      });
      if (!response.ok) {
        let data;
        try { data = await response.json(); } catch { throw new ApiError("代理返回了不可读取的结果。", response.status, "invalid_response"); }
        const error = data?.error;
        throw new ApiError(error?.message || data?.message || `请求失败（HTTP ${response.status}）`, response.status,
          typeof error === "string" ? error : error?.code || data?.code);
      }
      const type = response.headers.get("content-type")?.toLowerCase() || "";
      if (type.includes("text/event-stream")) {
        if (streamIsCurrent(stream)) { state.streamStatus = "流式接收中"; renderControls(); }
        await readEventStream(response, stream, resetTimeout);
      } else if (options.method === "POST" && response.status === 200 && type.includes("application/json")) {
        let data;
        try { data = await response.json(); } catch { throw new ApiError("重放响应不可读取。", response.status, "invalid_response"); }
        if (!streamIsCurrent(stream)) return;
        if (!data?.turn || !acceptStreamTurn(stream, data.turn)) throw new ApiError("重放响应缺少匹配的 turn。", response.status, "invalid_response");
        stream.terminal = TERMINAL.has(data.turn.status);
      } else throw new ApiError("代理未返回 SSE 事件流。", response.status, "invalid_response");
    } finally { clearTimeout(timeout); }
  }

  function makeStream(sid, view, kind) {
    closeStream();
    const stream = { sid, view, kind, controller: new AbortController(), turnId: pendingFor(sid)?.turnId || state.session?.status?.turnId || state.turn?.id, terminal: false };
    state.stream = stream;
    state.streamStatus = kind === "post" ? "正在连接流式输出" : "正在恢复流式订阅";
    return stream;
  }

  async function subscribeEvents(view) {
    if (view !== state.view || state.stream || state.reconnect || !hasActiveTurn() || !state.session?.status) return;
    // An unknown POST must first be matched by a read of the exact persisted idempotency key.
    if (pendingFor() && !pendingFor().turnId) return;
    if (state.reconnects >= 2) return;
    state.reconnects++;
    const sid = state.session.id, stream = makeStream(sid, view, "get");
    renderControls();
    try { await fetchStream(stream, `/api/sessions/${encodeURIComponent(sid)}/events?after=${state.eventAfter}`); }
    catch { /* A subscription only reads. GET polling remains available after any interruption. */ }
    finally { if (streamIsCurrent(stream)) await finishStream(stream); }
  }

  async function finishStream(stream) {
    if (!streamIsCurrent(stream)) return;
    state.stream = null;
    state.streamStatus = stream.terminal ? "输出已结束，正在核对持久结果" : "流式连接已断开，正在只读核对";
    renderControls();
    await refreshCurrent(true);
    if (stream.view !== state.view) return;
    renderControls(); schedulePoll(stream.view);
    if (!stream.terminal && hasActiveTurn() && state.reconnects < 2) {
      state.reconnect = setTimeout(() => { state.reconnect = null; void subscribeEvents(stream.view); }, 1200 * (state.reconnects + 1));
    }
  }

  function connection(ready, text) {
    state.ready = ready;
    $("connection").className = `connection ${ready ? "ready" : "error"}`;
    $("connection-label").textContent = text;
    renderControls();
  }

  async function health() {
    const revision = state.environmentRevision;
    try {
      const result = await api("/api/health");
      if (revision !== state.environmentRevision) return;
      const ready = result.ready === true && !state.environmentBusy && state.environmentReady !== false;
      connection(ready, ready ? "本地服务就绪" : state.environmentBusy ? "环境操作中" : "服务尚未就绪");
    } catch { if (revision === state.environmentRevision) connection(false, "连接异常"); }
  }

  function environmentChanged(event) {
    const detail = event.detail;
    if (!detail || !["settled", "action-start", "action-settled"].includes(detail.phase)) return;
    const signature = JSON.stringify([detail.phase === "action-start", detail.overall, detail.operationState, detail.operationId, detail.servicesReady]);
    if (signature === state.environmentSignature) return;
    state.environmentSignature = signature;
    state.environmentRevision++;
    state.environmentBusy = detail.phase === "action-start" || ["running", "unknown"].includes(detail.operationState);
    state.environmentReady = typeof detail.servicesReady === "boolean" ? detail.servicesReady : undefined;
    if (state.environmentBusy || state.environmentReady === false) connection(false, state.environmentBusy ? "环境操作中" : "服务尚未就绪");
    if (detail.phase === "action-start" || !state.config) return;
    // Status reads stay out of typing/sending. Coalesce panel transitions into
    // read-only probes; a successful fresh health read is required to unlock.
    state.environmentRefreshPending = true;
    if (state.environmentTask) return;
    state.environmentTask = (async () => {
      while (state.environmentRefreshPending) {
        state.environmentRefreshPending = false;
        await health();
        if (state.session && !state.loading) {
          const view = state.view;
          await refreshCurrent(true);
          if (view === state.view) { schedulePoll(view); void subscribeEvents(view); }
        }
      }
    })().finally(() => { state.environmentTask = null; });
  }

  function renderSessions() {
    const sessions = [...state.sessions.values()].sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    ui.sessions.replaceChildren();
    if (!sessions.length) ui.sessions.append(element("p", "list-empty", "还没有会话。点击「新建会话」开始。"));
    for (const session of sessions) {
      const button = element("button", `session-button${session.id === state.session?.id ? " selected" : ""}`);
      button.type = "button";
      button.setAttribute("aria-current", session.id === state.session?.id ? "true" : "false");
      button.title = session.id;
      const row = element("span", "session-row");
      row.append(element("span", "session-icon", "◌"), element("span", "session-name", session.title || `会话 ${session.id.slice(-8)}`));
      button.append(row, element("span", "session-date", `${pendingFor(session.id) ? "待核对 · " : ""}${formatDate(session.updatedAtMs)}`));
      button.addEventListener("click", () => selectSession(session.id));
      ui.sessions.append(button);
    }
    $("more-sessions").hidden = !state.sessionCursor;
  }

  async function loadSessions(more = false) {
    if (state.listTask) return state.listTask;
    state.listTask = (async () => {
      $("reload-sessions").disabled = true;
      $("more-sessions").disabled = true;
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (more && state.sessionCursor) params.set("cursor", state.sessionCursor);
        const result = await api(`/api/sessions?${params}`);
        if (!Array.isArray(result.data)) throw new Error("会话列表格式不正确。");
        for (const session of result.data) if (validSessionId(session.id)) state.sessions.set(session.id, session);
        state.sessionCursor = result.nextCursor || null;
        // Only use locally remembered IDs as placeholders; ownership is checked on every read.
        for (const id of saved.recent) if (!state.sessions.has(id)) state.sessions.set(id, { id });
        renderSessions();
      } catch (error) {
        for (const id of saved.recent) if (!state.sessions.has(id)) state.sessions.set(id, { id });
        renderSessions();
        notice(`无法读取会话列表：${error.message} 可以用已知会话 ID 恢复。`);
      } finally {
        $("reload-sessions").disabled = !state.config;
        $("more-sessions").disabled = false;
        state.listTask = null;
      }
    })();
    return state.listTask;
  }

  function renderControls() {
    const pending = pendingFor();
    const running = state.turn?.status === "inProgress" || state.session?.status?.type === "active";
    const locked = !state.config || !state.ready || state.environmentBusy || state.environmentReady === false || !state.session?.status || state.session.status.type === "error" || Boolean(state.sessionError) || profileMismatch()
      || state.loading || state.posting || Boolean(pending) || running || state.turnUnconfirmed || state.storageFailed;
    // Draft editing is local and independent of admission for a new paid turn.
    // Keep it available while an earlier request runs or is being reconciled.
    ui.input.disabled = !state.config || !state.session || state.storageFailed;
    ui.send.disabled = locked || !ui.input.value.trim();
    ui.send.firstChild.textContent = pending || running || state.turnUnconfirmed ? "等待本轮 " : "发送 ";
    ui.input.placeholder = pending || running || state.turnUnconfirmed ? "可先写下一条；本轮结束后手动发送…" : "输入消息，开始体验…";
    if ($("draft-status")) $("draft-status").textContent = pending || running || state.turnUnconfirmed
      ? "可编辑下一条草稿 · 本轮核对完成后手动发送" : "草稿按会话保存在当前标签页 · 不会自动发送";
    ui.create.disabled = !state.config || !state.ready || state.environmentBusy || state.environmentReady === false || state.creating;
    ui.create.lastChild.textContent = state.creating ? " 创建中…" : " 新建会话";
    ui.refresh.disabled = !state.config || !state.session || state.loading;
    $("copy-session").disabled = !state.session;
    $("restore-form").querySelector("button").disabled = !state.config;
    ui.stop.hidden = !state.turn || state.turn.status !== "inProgress" || profileMismatch();
    ui.stop.disabled = state.stopping;
    ui.stop.textContent = state.stopping ? "正在请求停止…" : "停止执行";
    $("character-count").textContent = ui.input.value.length.toLocaleString("en-US");
    ui.messages.setAttribute("aria-busy", String(state.loading || state.posting || running));
    renderBanner();
    renderDiagnostics();
    syncProgressTimer();
  }

  function renderBanner() {
    const pending = pendingFor();
    const turn = state.turn;
    const feedback = saved.feedback[state.session?.id];
    let title = "", message = "", kind = "";
    if (pending && !pending.turnId) {
      title = state.posting ? "正在提交消息" : "提交结果尚不明确";
      message = state.posting ? "请求已保存。等待服务返回执行 ID，请勿重复发送。"
        : "原幂等键和原始请求已保留。本页只读核对，不会自动重新提交；未找到匹配执行前保持锁定。可点击「刷新结果」再次核对。";
      kind = state.posting ? "running" : "warning";
    } else if (state.sessionError) {
      title = "结果读取暂时失败";
      message = `${state.sessionError} 已保留会话与请求状态；刷新只读取结果。`;
      kind = "error";
    } else if (profileMismatch()) {
      title = "历史会话 · 只读查看";
      message = "此会话的用户或 Agent 版本与当前固定配置不一致。请新建会话后发送；历史消息可以继续读取。";
      kind = "warning";
    } else if (state.session?.status?.type === "error") {
      title = "会话处于错误状态";
      message = state.session.status.message || "请先检查服务端状态，然后只读刷新核对。";
      kind = "error";
    } else if (turn?.status === "inProgress") {
      title = pending?.timing?.firstChunkAtMs ? "Agent 正在回复" : pending?.turnId ? "服务已接收 · 等待回复" : "Agent 正在执行";
      message = `${state.streamStatus || "正在只读查询持久结果"}。停止执行会发送一次中断请求，不代表费用立即停止；以最终 turn 状态为准。`;
      kind = "running";
    } else if ((pending?.turnId || state.turnUnconfirmed) && turn && TERMINAL.has(turn.status)) {
      title = "执行已结束 · 正在核对持久结果";
      message = "等待服务端持久消息与会话空闲状态确认后，即可继续发送。";
      kind = "running";
    } else if (turn && TERMINAL.has(turn.status) && feedback?.turnId === turn.id && feedback.unmatched) {
      title = `${statusNames[turn.status] || turn.status} · 持久消息待核对`;
      message = "执行终态与会话空闲已核实。当前用户气泡保留在本机，尚未读到对应的持久消息；可刷新只读核对。";
      kind = "warning";
    } else if (turn) {
      const reason = stopNames[turn.stopReason] || turn.stopReason || "未返回停止原因";
      title = `${statusNames[turn.status] || turn.status} · ${reason}`;
      if (turn.error) message = `${turn.error.code || "error"}：${turn.error.message || "执行失败"}`;
      else if (turn.stopReason !== "end_turn") message = "请结合持久消息与执行详情判断结果；达到限制不等于自然结束。";
      else message = "本轮服务端执行结果已核对，可使用同一个会话继续对话。";
      kind = turn.status === "failed" ? "error" : turn.stopReason === "end_turn" ? "" : "warning";
    } else if (state.session?.status?.type === "active") {
      title = "会话仍有执行进行中";
      message = `${state.streamStatus || "正在读取当前 turn"}。确认最终状态前暂停新的发送。`;
      kind = "running";
    }
    ui.banner.hidden = !title;
    ui.banner.className = `turn-banner ${kind}`;
    $("turn-banner-title").textContent = title;
    $("turn-banner-text").textContent = message;
  }

  function renderDiagnostics() {
    const pending = pendingFor();
    const turn = pending && !pending.turnId ? null : state.turn;
    $("turn-summary").textContent = turn ? `${turn.status} / ${turn.stopReason || "—"}` : pendingFor() ? "提交待核对" : "尚无执行";
    $("detail-turn-id").textContent = turn?.id || "—";
    $("detail-status").textContent = turn ? `${turn.status} / ${turn.stopReason || "—"}` : "—";
    $("detail-counts").textContent = turn ? `${turn.steps ?? "—"} / ${turn.toolCalls ?? "—"}` : "—";
    $("detail-model").textContent = turn?.model ? [turn.model.provider, turn.model.model].filter(Boolean).join(" / ") || JSON.stringify(turn.model) : "—";
    const usage = turn?.usage;
    $("detail-usage").textContent = usage ? `输入 ${usage.inputTokens ?? "—"} / 输出 ${usage.outputTokens ?? "—"} / ¥${usage.costCNY ?? "未返回"}` : "—";
    $("detail-key").textContent = pendingFor()?.key || turn?.idempotencyKey || "—";
    $("detail-stream").textContent = state.streamStatus || "尚未建立流式连接";
    const feedback = pendingFor() || (saved.feedback[state.session?.id]?.turnId === turn?.id ? saved.feedback[state.session?.id] : null);
    const start = feedback?.createdAtMs;
    const duration = (value) => Number.isFinite(start) && Number.isFinite(value) ? `${Math.max(0, value - start).toLocaleString("en-US")} ms` : "—";
    if ($("detail-feedback")) $("detail-feedback").textContent = duration(feedback?.timing?.feedbackAtMs);
    if ($("detail-accepted")) $("detail-accepted").textContent = duration(feedback?.timing?.acceptedAtMs);
    if ($("detail-first-chunk")) $("detail-first-chunk").textContent = Number.isFinite(feedback?.timing?.acceptedAtMs) && Number.isFinite(feedback?.timing?.firstChunkAtMs)
      ? `${Math.max(0, feedback.timing.firstChunkAtMs - feedback.timing.acceptedAtMs).toLocaleString("en-US")} ms` : "—";
    if ($("detail-total")) $("detail-total").textContent = feedback?.timing?.confirmedAtMs
      ? `${duration(feedback.timing.confirmedAtMs)}${feedback.unmatched ? " · turn 已确认，用户消息待核对" : ""}`
      : feedback && elapsed(feedback) ? `${elapsed(feedback)} · 核对中` : "—";
  }

  function messagePresentation(item) {
    const cached = messagePresentations.get(item);
    if (cached) return cached;
    const isUser = item.type === "userMessage", isAgent = item.type === "agentMessage";
    const names = { userMessage: "你", agentMessage: item.phase === "commentary" ? "Agent · 过程消息" : "Agent", reasoning: "推理记录", toolCall: "工具调用", toolResult: "工具结果", systemNotice: "系统提示", approvalRequest: "等待审批", contextCompaction: "上下文压缩", subagentActivity: "子任务活动" };
    const content = () => (item.content || []).map((part) => part.type === "text" ? part.text : `[${part.type} 内容]`).join("\n");
    const view = {
      kind: isUser ? "user" : isAgent ? "assistant" : "system",
      details: !isUser && !isAgent && item.type !== "systemNotice",
      name: names[item.type] || item.type, time: clockTime(item.createdAtMs),
      status: item.status === "completed" ? "" : item._stream ? "流式片段 · 待持久核对" : statusNames[item.status] || item.status,
      summary: item.name || names[item.type] || "查看记录",
      text: isUser ? content() : isAgent || item.type === "systemNotice" ? item.text || "（暂无文本）"
        : item.text || item.summary || (item.content ? content() : JSON.stringify(item, null, 2)),
    };
    messagePresentations.set(item, view);
    return view;
  }

  function setNodeText(node, text) {
    text = String(text ?? "");
    const previous = node.textContent;
    if (previous === text) return false;
    const child = node.firstChild;
    // Keep the Text node (and an existing selection in its earlier characters)
    // when live output is appended. Unchanged history is never rewritten.
    if (node.childNodes.length === 1 && child?.nodeType === 3) {
      if (text.startsWith(previous)) child.appendData(text.slice(previous.length));
      else child.data = text;
    } else node.textContent = text;
    return true;
  }

  function patchMessageNode(article, item) {
    const view = messagePresentation(item), layout = messageLayouts.get(article);
    if (!layout || layout.kind !== view.kind || layout.details !== view.details) return null;
    // readItems retains completed snapshots between incremental reads. Nothing
    // displayed can change for the same immutable non-local item object.
    if (layout.item === item && !item._local) return false;
    const classes = `message ${view.kind}${item._stream ? " streaming-message" : ""}${item._local && item.id === `local-${item._local.key}` ? " local-message" : ""}`;
    if (article.className !== classes) article.className = classes;
    const id = `message-${item.id}`;
    if (article.id !== id) article.id = id;
    if (article.dataset.itemId !== item.id) article.dataset.itemId = item.id;
    if (item._local) {
      if (article.dataset.localKey !== item._local.key) article.dataset.localKey = item._local.key;
    } else if (article.dataset.localKey) { delete article.dataset.localKey; article.removeAttribute("data-local-key"); }
    setNodeText(layout.name, view.name); setNodeText(layout.time, view.time);
    if (view.status && !layout.status) {
      layout.status = element("span", "inline-status");
      layout.meta.insertBefore(layout.status, layout.delivery || null);
    }
    if (layout.status) {
      if (view.status) setNodeText(layout.status, view.status);
      else { layout.status.remove(); layout.status = null; }
    }
    if (item._local && !layout.delivery) {
      layout.delivery = element("span", "message-delivery"); layout.meta.append(layout.delivery);
    }
    if (layout.delivery) {
      if (item._local) {
        const record = item._local;
        const classes = `message-delivery${record.failed ? " delivery-failed" : record.unknown ? " delivery-unknown" : ""}`;
        if (layout.delivery.className !== classes) layout.delivery.className = classes;
        setNodeText(layout.delivery, deliveryText(record));
      } else { layout.delivery.remove(); layout.delivery = null; }
    }
    if (layout.summary) setNodeText(layout.summary, view.summary);
    const changed = setNodeText(layout.text, view.text);
    const failure = item._local?.failed && item._local.message || "";
    if (failure && !layout.failure) { layout.failure = element("p", "message-failure"); layout.body.append(layout.failure); }
    if (layout.failure) {
      if (failure) setNodeText(layout.failure, failure);
      else { layout.failure.remove(); layout.failure = null; }
    }
    layout.item = item;
    return changed;
  }

  function messageNode(item) {
    const view = messagePresentation(item), article = element("article"), body = element("div", "message-body");
    if (view.kind !== "system") article.append(element("div", "message-avatar", view.kind === "user" ? "YOU" : "✳"));
    const meta = element("div", "message-meta"), name = element("span"), time = element("time");
    meta.append(name, time); body.append(meta);
    const text = element(view.details ? "pre" : "div", view.details ? "" : "message-text");
    let summary = null;
    if (view.details) {
      const details = element("details", "message-details"); summary = element("summary");
      details.append(summary, text); body.append(details);
    } else body.append(text);
    article.append(body);
    messageLayouts.set(article, { kind: view.kind, details: view.details, body, meta, name, time, text, summary, status: null, delivery: null, failure: null });
    patchMessageNode(article, item);
    return article;
  }

  function renderDelta(item) {
    const node = document.getElementById(`message-${item.id}`);
    const text = node?.querySelector(".message-text");
    if (!node || !ui.messages.contains(node) || !text) { renderItems(); return; }
    if (patchMessageNode(node, item) === null) { renderItems(); return; }
    if (state.followLatest) ui.messages.scrollTop = ui.messages.scrollHeight;
    else state.unread = true;
    renderLatest();
  }

  function matchingUser(record, items) {
    if (!record?.turnId || typeof record.key !== "string") return null;
    const turn = state.turn?.id === record.turnId ? state.turn : state.turns.find((candidate) => candidate.id === record.turnId);
    if (!turn || turn.sessionId !== state.session?.id || (turn.idempotencyKey !== undefined && turn.idempotencyKey !== record.key)) return null;
    const matches = [...items.values()].filter((item) => item.type === "userMessage" && item.sessionId === state.session?.id && item.turnId === record.turnId);
    // A turn binding comes only from its exact idempotency key. An item binding then
    // comes from that turn's unique user item, never from matching message text.
    if (matches.length !== 1 || (record.itemId && record.itemId !== matches[0].id)) return null;
    if (!record.itemId) { record.itemId = matches[0].id; persist(); }
    return matches[0];
  }

  function localItem(record, seq) {
    const text = requestText(record);
    return text === null ? null : { id: `local-${record.key}`, sessionId: state.session.id, turnId: record.turnId,
      seq, createdAtMs: record.createdAtMs, type: "userMessage", status: "completed", content: [{ type: "text", text }], _local: record };
  }

  function renderLatest() {
    if (!ui.latest) return;
    ui.latest.hidden = state.followLatest;
    ui.latest.textContent = state.unread ? "有新消息 · 回到底部 ↓" : "回到底部 ↓";
  }

  function renderItems({ forceLatest = false } = {}) {
    const oldScroll = ui.messages.scrollTop;
    const bounds = !forceLatest && !state.followLatest ? ui.messages.getBoundingClientRect?.() : null;
    const anchor = bounds && [...ui.messages.children].find((node) => node.getBoundingClientRect?.().bottom > bounds.top);
    const anchorTop = anchor?.getBoundingClientRect?.().top;
    const merged = new Map(state.items);
    for (const [id, item] of state.streamItems) if (!finalItem(merged.get(id))) merged.set(id, item);
    const pending = pendingFor(), feedback = saved.feedback[state.session?.id];
    for (const record of [feedback, pending]) {
      if (!record || (record === pending && requestText(record) === null)) continue;
      const item = matchingUser(record, merged);
      if (item) {
        if (record.unmatched) { delete record.unmatched; delete record.body; persist(); }
        merged.set(item.id, { ...item, _local: record });
      } else if (record === pending || record.unmatched) {
        const seq = [...merged.values()].reduce((max, value) => Math.max(max, value.seq), -1) + 1;
        const local = localItem(record, seq);
        if (local) merged.set(local.id, local);
      }
    }
    const failures = saved.failed[state.session?.id];
    if (Array.isArray(failures)) for (const record of failures) {
      // Failed submissions are local records, deliberately distinct from any
      // later manual send even if the user sends identical words again.
      const local = localItem(record, 0);
      if (!local || (!record.failed && !record.unmatched)) continue;
      if (record.unmatched) {
        const item = matchingUser(record, merged);
        if (item) { merged.set(item.id, { ...item, _local: { ...record, unmatched: false } }); continue; }
      }
      const ordered = [...merged.values()].sort((a, b) => a.seq - b.seq);
      const before = ordered.filter((item) => Number.isFinite(item.createdAtMs) && item.createdAtMs <= record.createdAtMs).at(-1);
      local.seq = before ? before.seq + 0.01 : -0.5;
      merged.set(local.id, local);
    }
    const ordered = [...merged.values()].sort((a, b) => a.seq - b.seq);
    const existingNodes = new Map(), localNodes = new Map();
    for (const node of ui.messages.children) {
      if (node.dataset.itemId) existingNodes.set(node.dataset.itemId, node);
      if (node.dataset.localKey) localNodes.set(node.dataset.localKey, node);
    }
    let changed = false;
    const nodes = ordered.map((item) => {
      const existing = existingNodes.get(item.id) || (item._local && localNodes.get(item._local.key));
      if (!existing) { changed = true; return messageNode(item); }
      const patched = patchMessageNode(existing, item);
      if (patched === null) { changed = true; return messageNode(item); }
      changed ||= patched;
      return existing;
    });
    if (!nodes.length) nodes.push(ui.messages.querySelector(".empty-history") || element("p", "empty-history", "会话已就绪。发送第一条消息，开始真实模型体验。"));
    const retained = new Set(nodes);
    for (const node of [...ui.messages.childNodes]) if (!retained.has(node)) { node.remove(); changed = true; }
    let cursor = ui.messages.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else { ui.messages.insertBefore(node, cursor); changed = true; }
    }
    if (forceLatest || state.followLatest || state.loading) {
      state.followLatest = true; state.unread = false;
      ui.messages.scrollTop = ui.messages.scrollHeight;
    } else {
      // Retain the visible message when earlier rows change height. Native scroll
      // anchoring may already have applied the same adjustment; use its final
      // geometry rather than adding an assumed delta to the old scroll offset.
      const retainedAnchor = anchor && ui.messages.contains(anchor) && Number.isFinite(anchorTop);
      const shift = retainedAnchor ? anchor.getBoundingClientRect().top - anchorTop : 0;
      ui.messages.scrollTop = retainedAnchor && Number.isFinite(shift) ? ui.messages.scrollTop + shift : oldScroll;
      if (state.itemsSignature && changed) state.unread = true;
    }
    state.itemsSignature = "rendered";
    renderLatest();
  }

  function stopPolling() { clearTimeout(state.poll); state.poll = null; }
  function schedulePoll(view) {
    stopPolling();
    if (view !== state.view || !state.session) return;
    if (!hasActiveTurn()) return;
    state.poll = setTimeout(async () => {
      await refreshCurrent(true);
      if (view === state.view) { schedulePoll(view); void subscribeEvents(view); }
    }, state.sessionError ? 4000 : 1000);
  }

  async function allTurns(sid, view) {
    const turns = [], seen = new Set();
    let cursor = null;
    do {
      if (view !== state.view) return null;
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const result = await api(`/api/sessions/${encodeURIComponent(sid)}/turns?${params}`);
      if (!Array.isArray(result.data)) throw new Error("turn 列表格式不正确。");
      turns.push(...result.data);
      cursor = result.nextCursor || null;
      if (cursor && seen.has(cursor)) throw new Error("turn 分页游标重复，读取已暂停。");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return turns;
  }

  async function readItems(sid, view, full = false) {
    const prior = full ? [] : [...state.items.values()];
    const active = prior.filter((item) => item.status === "inProgress");
    let after = active.length ? Math.min(...active.map((item) => item.seq)) - 1 : prior.length ? Math.max(...prior.map((item) => item.seq)) : -1;
    const items = new Map(full ? [] : state.items);
    for (;;) {
      if (view !== state.view) return null;
      const result = await api(`/api/sessions/${encodeURIComponent(sid)}/items?afterSeq=${after}&limit=200`);
      if (!Array.isArray(result.data)) throw new Error("消息列表格式不正确。");
      for (const item of result.data) {
        if (item.sessionId !== sid || !Number.isInteger(item.seq) || item.seq <= after) throw new Error("消息序列或会话归属不正确，读取已暂停。");
        items.set(item.id, item);
      }
      if (result.data.length < 200) return items;
      const next = Math.max(...result.data.map((item) => item.seq));
      if (next <= after) throw new Error("消息分页没有前进，读取已暂停。");
      after = next;
    }
  }

  async function refreshCurrent(quiet = false, full = false) {
    const sid = state.session?.id, view = state.view;
    if (!sid) return;
    if (state.refreshTask?.view === view) return state.refreshTask.promise;
    const turnRevision = state.turnRevision;
    const promise = (async () => {
      try {
        const session = await api(`/api/sessions/${encodeURIComponent(sid)}`);
        if (view !== state.view) return;
        if (session.id !== sid) throw new Error("会话响应归属不正确。");
        let pending = pendingFor(sid), turn = null;
        // Unknown POSTs are reconciled only against the exact persisted idempotency key.
        if ((pending && !pending.turnId) || full || !state.turn) {
          const turns = await allTurns(sid, view);
          if (view !== state.view || !turns) return;
          state.turns = turns;
          if (pending?.key) {
            const match = turns.find((candidate) => candidate.idempotencyKey === pending.key && candidate.sessionId === sid);
            if (match) {
              pending.turnId = match.id; pending.unknown = false;
              markTiming(pending, "acceptedAtMs"); detachSubmittedDraft(pending, sid);
              persist(); turn = match;
            }
          }
          if (!turn && (!pending || pending.turnId)) turn = turns.reduce((latest, candidate) => !latest || candidate.startedAtMs > latest.startedAtMs ? candidate : latest, null);
        }
        const turnId = pending?.turnId || session.status?.turnId || turn?.id || state.turn?.id;
        if (turnId) {
          const value = await api(`/api/sessions/${encodeURIComponent(sid)}/turns/${encodeURIComponent(turnId)}`);
          turn = value.turn || value;
          if (turn.id !== turnId || turn.sessionId !== sid) throw new Error("turn 响应归属不正确。");
          if (pending?.turnId && (turn.id !== pending.turnId || (turn.idempotencyKey !== undefined && turn.idempotencyKey !== pending.key))) throw new Error("turn 幂等键与原请求不一致，已保留待核对状态。");
        }
        if (view !== state.view) return;
        const items = await readItems(sid, view, full);
        if (view !== state.view || !items) return;
        // A live started/completed event can arrive during any GET above. Keep that newer
        // turn (and its stop control) instead of replacing it with this older read snapshot.
        // The existing pending/active lock keeps polling until a later, current read confirms it.
        if (turnRevision !== state.turnRevision) return;
        state.session = session;
        state.turn = turn;
        state.turnUnconfirmed = false;
        state.items = items;
        for (const [id] of state.streamItems) if (finalItem(items.get(id))) state.streamItems.delete(id);
        state.sessionError = "";
        // A terminal turn, persisted items and a fresh idle session together allow a new send.
        const persistedUser = pending?.turnId ? matchingUser(pending, items) : null;
        if (pending?.turnId && turn?.id === pending.turnId && TERMINAL.has(turn.status) && session.status?.type === "idle") {
          markTiming(pending, "confirmedAtMs");
          const previousFeedback = saved.feedback[sid];
          if (previousFeedback?.unmatched && previousFeedback.key !== pending.key) rememberLocalRecord(sid, previousFeedback);
          saved.feedback[sid] = { key: pending.key, turnId: pending.turnId, itemId: persistedUser?.id,
            createdAtMs: pending.createdAtMs, timing: pending.timing,
            ...(!persistedUser ? { unmatched: true, body: pending.body } : {}) };
          const recentFeedback = Object.keys(saved.feedback).sort((a, b) => (saved.feedback[b]?.createdAtMs || 0) - (saved.feedback[a]?.createdAtMs || 0));
          for (const id of recentFeedback.slice(20)) delete saved.feedback[id];
          delete saved.pending[sid];
          detachSubmittedDraft(pending, sid);
          notice();
          persist();
        }
        if (turn && TERMINAL.has(turn.status) && session.status?.type === "idle" && !pendingFor(sid)) {
          state.streamItems.clear();
          state.streamStatus = "持久结果已确认";
          closeStream();
        }
        rememberSession(session);
        updateSessionHeading();
        renderItems();
        renderControls();
        if (!quiet) { await health(); toast("已读取服务端持久结果"); }
      } catch (error) {
        if (view !== state.view) return;
        state.sessionError = error.message;
        renderControls();
        if (!quiet) await health();
      } finally {
        if (state.refreshTask?.view === view) state.refreshTask = null;
      }
    })();
    state.refreshTask = { view, promise };
    return promise;
  }

  function updateSessionHeading() {
    $("session-title").textContent = state.session?.title || (state.session ? "未命名会话" : "开始一段新对话");
    $("session-reference").textContent = state.session?.id || "创建会话后即可发送消息";
  }

  async function selectSession(id) {
    if (!validSessionId(id)) { toast("请输入有效的 sess_ 会话 ID"); return; }
    if (state.session) { saved.drafts[state.session.id] = ui.input.value; persist(); }
    stopPolling();
    closeStream();
    const view = ++state.view;
    state.turnRevision++;
    state.session = state.sessions.get(id) || { id };
    state.items = new Map(); state.turn = null; state.turns = []; state.loading = true; state.sessionError = "";
    state.streamItems = new Map(); state.eventAfter = -1; state.streamStatus = ""; state.reconnects = 0; state.turnUnconfirmed = false;
    state.posting = false; state.postRequest = null;
    state.followLatest = true; state.unread = false; state.itemsSignature = "";
    saved.selected = id; persist();
    const recovered = pendingFor(id);
    if (recovered && !recovered.turnId) { recovered.unknown = true; persist(); }
    ui.input.value = typeof saved.drafts[id] === "string" ? saved.drafts[id] : "";
    if (recovered) { detachSubmittedDraft(recovered, id); persist(); }
    if (pendingFor(id) || (Array.isArray(saved.failed[id]) && saved.failed[id].length)) renderItems({ forceLatest: true });
    else ui.messages.replaceChildren(element("p", "loading-history", "正在恢复会话与持久消息…"));
    updateSessionHeading(); renderSessions(); renderControls(); renderLatest();
    await refreshCurrent(true, true);
    if (view !== state.view) return;
    state.loading = false;
    renderControls(); schedulePoll(view);
    void subscribeEvents(view);
  }

  async function createSession() {
    if (state.creating || !state.ready) return;
    const starter = !state.session ? ui.input.value : "";
    state.creating = true; renderControls(); notice();
    try {
      const session = await api("/api/sessions", { method: "POST", body: {} });
      if (!validSessionId(session.id)) throw new Error("创建会话响应缺少有效 ID。");
      if (starter) { saved.drafts[session.id] = starter; persist(); }
      rememberSession(session);
      await selectSession(session.id);
      if (!ui.input.disabled) ui.input.focus();
    } catch (error) { notice(`创建会话未成功确认：${error.message} 请先刷新会话列表核对；本页不会自动重试创建。`); }
    finally { state.creating = false; renderControls(); }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (ui.send.disabled || !state.session || pendingFor()) return;
    const text = ui.input.value.trim();
    if (!text) return;
    if (text.length > 16000) { notice("消息最多 16,000 个字符，请缩短后发送。"); return; }
    const sid = state.session.id, view = state.view;
    const body = { input: [{ type: "text", text }], stream: true, busyPolicy: "reject", limits: { ...LIMITS } };
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 32768) {
      notice("这条消息的 UTF-8 请求超过 32 KB。中文、换行等会占用更多字节，请缩短消息后发送；本次尚未提交。");
      return;
    }
    const pending = {
      key: crypto.randomUUID(), body,
      createdAtMs: Date.now(), unknown: false, turnId: null,
      draftDetached: true, nextDraftEdited: false,
    };
    saved.pending[sid] = pending;
    saved.drafts[sid] = "";
    if (!persist()) { renderControls(); return; }
    ui.input.value = ""; ui.input.style.height = "auto";
    state.posting = true; state.sessionError = ""; state.reconnects = 0;
    const request = { sid, view };
    state.postRequest = request;
    const stream = makeStream(sid, view, "post");
    notice(); renderControls(); renderItems({ forceLatest: true }); markTiming(pending, "feedbackAtMs"); renderDiagnostics(); schedulePoll(view);
    try {
      await fetchStream(stream, `/api/sessions/${encodeURIComponent(sid)}/turns`, { method: "POST", body: pending.body, headers: { "Idempotency-Key": pending.key } });
      if (!stream.terminal && view === state.view && saved.pending[sid] === pending && !pending.turnId) pending.unknown = true;
    } catch (error) {
      // A definite admission rejection can be corrected by a new user action. A timeout,
      // transport/response failure, or server error remains locked until GET reconciliation.
      const notSubmitted = error instanceof ApiError && ["turn_not_submitted", "environment_not_ready"].includes(error.code);
      const rejected = notSubmitted || (error instanceof ApiError && error.code !== "invalid_response" && [400, 401, 403, 404, 409, 413, 415, 422, 429].includes(error.status));
      if (rejected && saved.pending[sid] === pending && !pending.turnId) {
        restoreRejectedDraft(pending, sid);
        rememberFailure(sid, pending, notSubmitted, error.message);
        delete saved.pending[sid];
      }
      else if (saved.pending[sid] === pending) pending.unknown = true;
      persist();
      if (view === state.view) { renderItems(); renderControls(); }
      if (view === state.view && saved.pending[sid] === pending) notice(pending.turnId ? "流式连接已断开，已接收的片段暂时保留。正在只读核对持久结果；页面不会自动重新提交。"
        : notSubmitted ? "本次消息尚未提交，草稿已保留。服务恢复并刷新确认后，可手动再次发送；页面不会自动重发。"
        : rejected ? `请求被明确拒绝：${error.message} 未自动重发；请检查配置或服务状态。` : `提交结果不明：${error.message} 原请求与幂等键已保留，请只读刷新核对。`);
      else if (view === state.view && rejected && !pending.turnId) notice(notSubmitted ? "本次消息尚未提交，草稿已保留。服务恢复后可手动再次发送；页面不会自动重发。" : `请求被明确拒绝：${error.message} 未自动重发；草稿已保留。`);
    } finally {
      if (state.postRequest === request) { state.posting = false; state.postRequest = null; }
      if (view === state.view) {
        if (streamIsCurrent(stream)) await finishStream(stream);
        else { renderControls(); schedulePoll(view); }
      }
    }
  }

  async function interrupt() {
    const turn = state.turn, sid = state.session?.id, view = state.view;
    if (!sid || turn?.status !== "inProgress" || state.stopping || profileMismatch()) return;
    state.stopping = true; renderControls();
    try {
      await api(`/api/sessions/${encodeURIComponent(sid)}/turns/${encodeURIComponent(turn.id)}/interrupt`, { method: "POST", body: {} });
      if (view === state.view) toast("中断请求已返回，正在核对最终状态");
    } catch (error) { if (view === state.view) notice(`中断请求未确认：${error.message} 未自动重发；执行可能仍在继续，请刷新核对。`); }
    finally {
      state.stopping = false;
      if (view === state.view) { await refreshCurrent(true); renderControls(); schedulePoll(view); }
    }
  }

  $("composer").addEventListener("submit", sendMessage);
  ui.messages.addEventListener("scroll", () => {
    state.followLatest = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 100;
    if (state.followLatest) state.unread = false;
    renderLatest();
  }, { passive: true });
  ui.latest?.addEventListener("click", () => {
    state.followLatest = true; state.unread = false;
    ui.messages.scrollTop = ui.messages.scrollHeight;
    renderLatest();
  });
  document.addEventListener("chat-environment-state", environmentChanged);
  ui.input.addEventListener("input", () => {
    saveDraft();
    ui.input.style.height = "auto";
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, 180)}px`;
    renderControls();
  });
  ui.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) {
      event.preventDefault();
      if (!ui.send.disabled) $("composer").requestSubmit();
    }
  });
  ui.create.addEventListener("click", createSession);
  ui.refresh.addEventListener("click", async () => { const view = state.view; await refreshCurrent(false, true); schedulePoll(view); void subscribeEvents(view); });
  ui.stop.addEventListener("click", interrupt);
  $("reload-sessions").addEventListener("click", async () => { await health(); await loadSessions(); });
  $("more-sessions").addEventListener("click", () => loadSessions(true));
  $("restore-form").addEventListener("submit", (event) => { event.preventDefault(); selectSession($("session-id").value.trim()); });
  $("copy-session").addEventListener("click", async () => {
    if (!state.session) return;
    try { await navigator.clipboard.writeText(state.session.id); toast("会话 ID 已复制"); }
    catch { toast("复制不可用，可从会话标题下方选择 ID"); }
  });
  for (const button of document.querySelectorAll("[data-prompt]")) button.addEventListener("click", () => {
    ui.input.value = button.dataset.prompt;
    saveDraft();
    renderControls();
    if (!state.session) toast("已填入示例；请先点击「新建会话」");
    else if (!ui.input.disabled) ui.input.focus();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.session && !state.loading) { const view = state.view; refreshCurrent(true).then(() => { schedulePoll(view); void subscribeEvents(view); }); } });
  window.addEventListener("pagehide", () => { stopPolling(); closeStream(); clearInterval(state.progressTimer); state.progressTimer = null; });

  async function init() {
    try {
      const config = await api("/api/config");
      if (!config.csrfToken || typeof config.csrfToken !== "string") throw new Error("本地代理未返回页面令牌。");
      state.config = config;
      $("agent-label").textContent = `Agent ${config.agentId} · v${config.agentVersion || "默认"} · 用户 ${config.userId}`;
      $("endpoint-label").textContent = config.baseUrl || "本地代理";
      $("reload-sessions").disabled = false;
      // Exercise storage before enabling a paid operation.
      persist();
      await Promise.all([health(), loadSessions()]);
      if (validSessionId(saved.selected)) await selectSession(saved.selected);
      renderControls();
    } catch (error) {
      connection(false, "配置加载失败");
      notice(`无法初始化体验台：${error.message} 请检查终端中的代理启动信息后刷新页面。`);
    }
  }
  init();
})();
