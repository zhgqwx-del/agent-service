"use strict";

// Environment controls publish only a small, credential-free readiness signal;
// chat owns its own health checks, history, drafts and SSE connection.
(() => {
  const $ = (id) => document.getElementById(id);
  const ui = {
    panel: $("environment-panel"), toggle: $("env-toggle"), content: $("env-content"),
    overall: $("env-overall"), checked: $("env-checked"), refresh: $("env-refresh"),
    notice: $("env-notice"), components: $("env-components"), actions: $("env-actions"),
    operation: $("env-operation"), confirm: $("env-confirm"),
  };
  if (!ui.panel) return;

  const ACTIONS = Object.freeze([
    { id: "start-services", label: "启动服务", group: "services" },
    { id: "stop-services", label: "停止服务", group: "services" },
    { id: "restart-services", label: "重启服务", group: "services" },
    { id: "start-infrastructure", label: "启动数据库", group: "infrastructure" },
    { id: "stop-infrastructure", label: "停止数据库", group: "infrastructure" },
    { id: "restart-infrastructure", label: "重启数据库", group: "infrastructure" },
  ]);
  const componentNames = { owner: "OWNER 管理器", router: "Router", runner: "Runner", mysql: "MySQL", redis: "Redis" };
  const componentStates = { ready: "就绪", running: "运行中", stopped: "已停止", unknown: "待核对", starting: "启动中", stopping: "停止中", failed: "异常" };
  const overallNames = { ready: "环境就绪", stopped: "已停止", partial: "部分可用", unknown: "待核对", transitioning: "操作中" };
  const operationNames = { running: "操作进行中", succeeded: "操作已完成", failed: "操作未完成", unknown: "操作结果待核对" };
  const operationIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const state = {
    token: null, configTask: null, data: null, requestTask: null, timer: null,
    expanded: false, posting: false, confirmation: null, uncertainSubmission: false, pendingKey: null,
    actionError: "", statusAvailable: false, lastStatusSignal: null, watchedAction: null,
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function message(text = "") {
    ui.notice.textContent = [state.actionError, text].filter(Boolean).join("\n");
    ui.notice.hidden = !ui.notice.textContent;
  }
  function busy() {
    return state.posting || state.uncertainSubmission
      || ["running", "unknown"].includes(state.data?.operation?.state);
  }
  function capability(id) {
    return state.data?.actions?.find((action) => action?.id === id);
  }
  function canRun(id) {
    return state.data?.enabled === true && !busy() && capability(id)?.enabled === true;
  }
  function closeConfirmation() {
    state.confirmation = null;
    ui.confirm.hidden = true;
  }

  function environmentSignal(overrides = {}) {
    const operation = state.data?.operation;
    const operationState = state.uncertainSubmission ? "unknown"
      : Object.hasOwn(operationNames, operation?.state) ? operation.state : "none";
    const available = state.statusAvailable && state.data?.enabled === true;
    const detail = {
      available,
      overall: available && Object.hasOwn(overallNames, state.data?.overall) ? state.data.overall : "unknown",
      operationState,
    };
    if (!state.uncertainSubmission && typeof operation?.id === "string" && operationIdPattern.test(operation.id)) detail.operationId = operation.id;
    if (state.posting || ["running", "unknown"].includes(operationState)) detail.servicesReady = false;
    else if (available) detail.servicesReady = state.data.overall === "ready"
      && Object.keys(componentNames).every(id => state.data.components.some(component => component?.id === id && component.state === "ready"));
    const signal = { ...detail, ...overrides };
    if (typeof signal.operationId !== "string" || !operationIdPattern.test(signal.operationId)) delete signal.operationId;
    return signal;
  }

  function publishEnvironment(phase, overrides = {}) {
    const detail = environmentSignal(overrides);
    // checkedAt and presentation text must not turn every five-second panel
    // refresh into another chat health/history request.
    const signature = JSON.stringify(detail);
    if (phase === "settled" && signature === state.lastStatusSignal) return;
    if (phase === "settled" || phase === "action-settled") state.lastStatusSignal = signature;
    document.dispatchEvent(new CustomEvent("chat-environment-state", { detail: Object.freeze({ phase, ...detail }) }));
  }

  function publishActionResult() {
    const watched = state.watchedAction;
    if (!watched || state.posting) return false;
    if (watched.rejected) {
      // A rejected admission did not begin an operation. Fresh component status
      // and chat's independent health read decide when sending can resume.
      publishEnvironment("action-settled");
      state.watchedAction = null;
      return true;
    }
    const operation = state.data?.operation;
    const matches = operation?.id === watched.id || operation?.id === watched.key
      || operation?.idempotencyKey === watched.key;
    if (state.statusAvailable && !state.uncertainSubmission && matches) {
      if (operation.state === "running") return false;
      publishEnvironment("action-settled");
      state.watchedAction = null;
      return true;
    }
    // An ambiguous write is never retried. Emit its uncertainty once, then let
    // later read-only status checks confirm this exact operation if possible.
    if (!watched.unknownPublished) {
      publishEnvironment("action-settled", { overall: "unknown", operationState: "unknown", operationId: watched.id, servicesReady: false });
      watched.unknownPublished = true;
      return true;
    }
    return false;
  }

  async function request(path, { method = "GET", body, key } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const headers = { Accept: "application/json" };
    if (state.token) headers["X-Chat-Token"] = state.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (key) headers["Idempotency-Key"] = key;
    try {
      const response = await fetch(path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal, cache: "no-store", mode: "same-origin",
        credentials: "same-origin", redirect: "error",
      });
      let value;
      try { value = await response.json(); }
      catch { throw new Error("管理接口返回了无法读取的结果。"); }
      if (!response.ok) {
        const error = new Error(typeof value?.error?.message === "string" ? value.error.message
          : typeof value?.message === "string" ? value.message : `管理请求未完成（HTTP ${response.status}）。`);
        error.rejected = response.status >= 400 && response.status < 500;
        throw error;
      }
      return value;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("管理请求超时，请刷新核对实际状态。");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function ensureToken() {
    if (state.token) return;
    if (!state.configTask) {
      state.configTask = request("/api/config").then((config) => {
        if (typeof config.csrfToken !== "string" || !config.csrfToken) throw new Error("尚未获得本机管理连接。");
        state.token = config.csrfToken;
      }).finally(() => { state.configTask = null; });
    }
    await state.configTask;
  }

  function renderSummary() {
    const data = state.data;
    const overall = data?.enabled === false ? "unknown" : data?.overall || "unknown";
    ui.overall.dataset.state = Object.hasOwn(overallNames, overall) ? overall : "unknown";
    ui.overall.textContent = state.posting ? "提交操作中" : data?.enabled === false
      ? "未连接本机管理器" : overallNames[overall] || overallNames.unknown;
    const time = typeof data?.checkedAt === "string" ? new Date(data.checkedAt) : null;
    ui.checked.textContent = time && Number.isFinite(time.getTime())
      ? `${time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 检查` : "";
    ui.refresh.disabled = Boolean(state.requestTask) || state.posting;
  }

  function renderComponents() {
    const nodes = [];
    const components = Array.isArray(state.data?.components) ? state.data.components : [];
    for (const [id, fallbackName] of Object.entries(componentNames)) {
      const component = components.find((item) => item?.id === id);
      const card = element("div", "env-component");
      const row = element("div", "env-component-row");
      row.append(element("strong", "", typeof component?.name === "string" ? component.name : fallbackName));
      const status = element("span", "env-state", componentStates[component?.state] || componentStates.unknown);
      status.dataset.state = Object.hasOwn(componentStates, component?.state) ? component.state : "unknown";
      row.append(status);
      card.append(row, element("p", "env-component-detail", typeof component?.detail === "string" ? component.detail : "尚无状态信息"));
      const address = [];
      if (typeof component?.endpoint === "string") address.push(component.endpoint);
      if (Number.isSafeInteger(component?.pid) && component.pid > 0) address.push(`PID ${component.pid}`);
      if (address.length) card.append(element("small", "env-component-address", address.join(" · ")));
      nodes.push(card);
    }
    ui.components.replaceChildren(...nodes);
  }

  function renderActions() {
    const groups = [];
    for (const group of ["services", "infrastructure"]) {
      const box = element("div", "env-action-group");
      box.append(element("h3", "", group === "services" ? "应用服务" : "数据库与缓存"));
      const row = element("div", "env-action-row");
      for (const action of ACTIONS.filter((item) => item.group === group)) {
        const available = capability(action.id);
        const item = element("div", "env-action-item");
        const button = element("button", "env-button", action.label);
        button.type = "button";
        button.dataset.action = action.id;
        button.disabled = !canRun(action.id);
        button.addEventListener("click", () => selectAction(action));
        item.append(button);
        if (available?.enabled === false && typeof available.reason === "string" && available.reason) {
          button.title = available.reason;
          item.append(element("span", "env-action-reason", available.reason));
        }
        row.append(item);
      }
      box.append(row);
      groups.push(box);
    }
    ui.actions.replaceChildren(...groups);
  }

  function renderOperation() {
    const operation = state.data?.operation;
    ui.operation.hidden = !operation && !state.uncertainSubmission;
    ui.operation.replaceChildren();
    if (state.uncertainSubmission) {
      ui.operation.dataset.state = "unknown";
      ui.operation.append(element("strong", "", "操作提交结果待核对"), element("p", "", "请刷新状态并保留当前页面；管理器确认结果前，按钮保持锁定。页面不会自动重试操作。"));
      return;
    }
    if (!operation) return;
    ui.operation.dataset.state = ["running", "succeeded", "failed", "unknown"].includes(operation.state) ? operation.state : "unknown";
    const action = ACTIONS.find((item) => item.id === operation.action);
    ui.operation.append(element("strong", "", `${action?.label || "环境操作"} · ${operationNames[operation.state] || operationNames.unknown}`));
    if (typeof operation.message === "string" && operation.message) ui.operation.append(element("p", "", operation.message));
    if (typeof operation.phase === "string" && operation.phase) ui.operation.append(element("small", "", `阶段：${operation.phase}`));
    if (["failed", "unknown"].includes(operation.state)) ui.operation.append(element("p", "", "请保留现场并核对原因；页面不会自动重试。"));
  }

  function render() {
    renderSummary();
    renderComponents();
    renderOperation();
    renderActions();
    if (state.confirmation && !canRun(state.confirmation.id)) closeConfirmation();
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = null;
    const watchingOperation = !state.uncertainSubmission && state.data?.operation?.state === "running";
    if ((state.expanded || watchingOperation) && !document.hidden) state.timer = setTimeout(() => refresh(), 5000);
  }

  async function refresh() {
    if (state.posting) return;
    if (state.requestTask) return state.requestTask;
    publishEnvironment("checking");
    state.requestTask = (async () => {
      try {
        await ensureToken();
        const data = await request("/api/environment");
        if (typeof data?.enabled !== "boolean" || !Array.isArray(data.components) || !Array.isArray(data.actions)
          || (data.operation !== null && (!data.operation?.id
            || !Object.hasOwn(operationNames, data.operation.state)))) {
          throw new Error("本机管理器的状态格式无法识别。");
        }
        state.data = data;
        state.statusAvailable = true;
        // Only this exact operation clears an ambiguous POST; never resubmit it.
        if (state.uncertainSubmission && state.pendingKey
          && (data.operation?.id === state.pendingKey || data.operation?.idempotencyKey === state.pendingKey)) {
          state.uncertainSubmission = false;
          state.pendingKey = null;
        }
        message(data.enabled ? "" : "未连接本机管理器。聊天功能可独立使用，环境控制暂不可用。");
      } catch (error) {
        state.statusAvailable = false;
        if (state.data) state.data = { ...state.data, overall: "unknown", actions: [] };
        message(`无法核对本地环境状态。${error.message || "请稍后手动刷新。"}`);
      } finally {
        state.requestTask = null;
        render();
        if (!publishActionResult()) publishEnvironment("settled");
        schedule();
      }
    })();
    renderSummary();
    return state.requestTask;
  }

  function selectAction(action) {
    if (!canRun(action.id)) return;
    state.actionError = "";
    message();
    if (action.id.startsWith("start-")) { void execute(action); return; }
    state.confirmation = action;
    $("env-confirm-title").textContent = `确认${action.label}？`;
    $("env-confirm-message").textContent = action.group === "infrastructure"
      ? "这会暂时中断聊天与数据访问。管理器须先停止接收新请求，并等待当前任务和服务排空；原有数据库与缓存数据将保留。请先确认当前聊天任务已完成。"
      : "这会暂时中断聊天服务。管理器须先停止接收新请求，并等待当前任务排空；会话和数据库数据将保留。请先确认当前聊天任务已完成。";
    $("env-confirm-submit").textContent = `确认${action.label}`;
    ui.confirm.hidden = false;
    ui.confirm.scrollIntoView({ block: "nearest", behavior: "auto" });
    $("env-confirm-cancel").focus({ preventScroll: true });
  }

  async function execute(action) {
    if (state.requestTask) await state.requestTask;
    if (!canRun(action.id)) { closeConfirmation(); return; }
    closeConfirmation();
    if (typeof crypto.randomUUID !== "function") {
      state.actionError = "当前浏览器无法生成安全的操作标识，环境控制暂不可用。";
      message();
      return;
    }
    const key = crypto.randomUUID();
    state.watchedAction = { key, id: null, rejected: false, unknownPublished: false };
    state.pendingKey = key;
    state.posting = true;
    clearTimeout(state.timer);
    state.timer = null;
    state.actionError = "";
    publishEnvironment("action-start", { overall: "transitioning", operationState: "running", operationId: null, servicesReady: false });
    message();
    render();
    try {
      const result = await request("/api/environment/actions", { method: "POST", key, body: { action: action.id } });
      if (result?.operation?.id !== key || result.operation.action !== action.id
        || !Object.hasOwn(operationNames, result.operation.state)) {
        throw new Error("管理器尚未返回可核对的操作标识。");
      }
      state.data = { ...state.data, overall: "transitioning", operation: result.operation };
      state.watchedAction.id = result.operation.id;
      state.pendingKey = null;
    } catch (error) {
      if (!error.rejected) state.uncertainSubmission = true;
      else { state.pendingKey = null; state.watchedAction.rejected = true; }
      state.actionError = `操作未确认完成。${error.message || "请手动刷新状态核对。"} 页面不会自动重试。`;
      message();
    } finally {
      state.posting = false;
      render();
      await refresh();
    }
  }

  function expand(value) {
    state.expanded = value;
    ui.content.hidden = !value;
    ui.toggle.setAttribute("aria-expanded", String(value));
    if (value) void refresh();
    else { closeConfirmation(); schedule(); }
  }
  ui.toggle.addEventListener("click", () => expand(!state.expanded));
  $("env-close").addEventListener("click", () => { expand(false); ui.toggle.focus(); });
  ui.refresh.addEventListener("click", () => { void refresh(); });
  $("env-confirm-cancel").addEventListener("click", closeConfirmation);
  $("env-confirm-submit").addEventListener("click", () => {
    if (state.confirmation) void execute(state.confirmation);
  });
  ui.panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.expanded) {
      if (state.confirmation) closeConfirmation();
      else { expand(false); ui.toggle.focus(); }
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearTimeout(state.timer); state.timer = null; }
    else if (state.expanded || state.watchedAction || state.data?.operation?.state === "running") void refresh();
  });
  void refresh();
})();
