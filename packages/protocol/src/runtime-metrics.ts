import { createHash, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";

export type RuntimeMetricsComponent = "router" | "runner";

export type ProviderGatewayMetricScope = "platform" | "byok";
export type ProviderGatewayRejectionReason = "quota_rpm" | "quota_concurrency" | "quota_unavailable"
  | "breaker_open" | "breaker_disabled" | "breaker_unavailable" | "subject_deleting" | "cancelled" | "local_unavailable";
export type ProviderGatewayIoOutcome = "completed" | "http_error" | "transport_error" | "cancelled" | "local_abort";

/** L0 process-only observation. Never pass identities, credentials, errors or response bodies. */
export interface ProviderGatewayObserver {
  rejected(scope: ProviderGatewayMetricScope, reason: ProviderGatewayRejectionReason): void;
  /** Start only at actual delegate entry. Finish after original fetch/read/cancel joins, before permit release. */
  beginAttempt(scope: ProviderGatewayMetricScope): (outcome: ProviderGatewayIoOutcome) => void;
}

export interface RuntimeMetrics {
  /** Call immediately before sending response headers, not after streaming the body. */
  beginRequest(method: string, path: string): (status: number) => void;
  readonly providerGateway?: ProviderGatewayObserver;
  render(): string;
}

export interface RuntimeMetricsProcessSnapshot {
  uptimeSeconds: number;
  residentMemoryBytes: number;
  heapUsedBytes: number;
  cpuUserSeconds: number;
  cpuSystemSeconds: number;
}

export interface RuntimeMetricsOptions {
  /** Monotonic milliseconds. Invalid or throwing clocks only omit a duration sample. */
  now?: () => number;
  processSnapshot?: () => RuntimeMetricsProcessSnapshot;
}

export const RUNTIME_METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"] as const;
type MethodLabel = (typeof METHODS)[number] | "other";

const ROUTES = [
  "health", "ready", "openapi", "capabilities", "usage", "sessions", "session_turns",
  "session_events", "session_items", "session_approvals", "agents", "providers", "blobs",
  "governance", "internal_control", "other",
] as const;
type RouteLabel = (typeof ROUTES)[number];
type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other";

const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;
const MAX_METRIC_NUMBER = Number.MAX_SAFE_INTEGER;

interface CompletedSeries {
  method: MethodLabel;
  route: RouteLabel;
  statusClass: StatusClass;
  requests: number;
  durationCount: number;
  durationSum: number;
  cumulativeBuckets: number[];
}

interface ActiveSeries {
  method: MethodLabel;
  route: RouteLabel;
  handlers: number;
}

const GATEWAY_REASONS: readonly ProviderGatewayRejectionReason[] = ["quota_rpm", "quota_concurrency", "quota_unavailable",
  "breaker_open", "breaker_disabled", "breaker_unavailable", "subject_deleting", "cancelled", "local_unavailable"];
const GATEWAY_OUTCOMES: readonly ProviderGatewayIoOutcome[] = ["completed", "http_error", "transport_error", "cancelled", "local_abort"];
type GatewayObservedOutcome = ProviderGatewayIoOutcome | "other";
interface GatewayAttemptSeries { scope: ProviderGatewayMetricScope; attempts: number; active: number }
interface GatewayCompletionSeries {
  scope: ProviderGatewayMetricScope; outcome: GatewayObservedOutcome; completions: number;
  durationCount: number; durationSum: number; cumulativeBuckets: number[];
}

function classifyMethod(value: unknown): MethodLabel {
  if (typeof value !== "string" || value.length > 16) return "other";
  const method = value.toUpperCase();
  return (METHODS as readonly string[]).includes(method) ? method as MethodLabel : "other";
}

function classifyRoute(value: unknown): RouteLabel {
  if (typeof value !== "string" || value.length > 4_096 || !value.startsWith("/")) return "other";
  // Parse only in this stack frame. Neither the path nor query is retained by a series or closure.
  const queryIndex = value.search(/[?#]/);
  const path = queryIndex < 0 ? value : value.slice(0, queryIndex);
  if (path === "/healthz" || path === "/health") return "health";
  if (path === "/readyz" || path === "/ready") return "ready";
  if (path === "/openapi.json" || path === "/openapi" || path === "/v1/openapi.json") return "openapi";
  if (path === "/v1/capabilities") return "capabilities";
  if (path === "/v1/usage" || path.startsWith("/v1/usage/")) return "usage";
  if (path === "/v1/agents" || path.startsWith("/v1/agents/")) return "agents";
  if (path === "/v1/providers" || path.startsWith("/v1/providers/")) return "providers";
  if (/^\/v1\/sessions\/[^/]+\/blobs(?:\/|$)/.test(path) || path === "/v1/blobs" || path.startsWith("/v1/blobs/")) return "blobs";
  if (path === "/v1/sessions" || path === "/v1/sessions/") return "sessions";
  if (/^\/v1\/sessions\/[^/]+\/turns(?:\/|$)/.test(path)) return "session_turns";
  if (/^\/v1\/sessions\/[^/]+\/events(?:\/|$)/.test(path)) return "session_events";
  if (/^\/v1\/sessions\/[^/]+\/items(?:\/|$)/.test(path)) return "session_items";
  if (/^\/v1\/sessions\/[^/]+\/approvals(?:\/|$)/.test(path)) return "session_approvals";
  if (path.startsWith("/v1/sessions/")) return "sessions";
  if (
    path === "/v1/data-erasure-requests" || path.startsWith("/v1/data-erasure-requests/") ||
    path === "/v1/data-export-requests" || path.startsWith("/v1/data-export-requests/") ||
    path === "/v1/retention-policies" || path.startsWith("/v1/retention-policies/") ||
    path === "/v1/legal-holds" || path.startsWith("/v1/legal-holds/")
  ) return "governance";
  if (path === "/_internal" || path.startsWith("/_internal/") ||
      path === "/_router" || path.startsWith("/_router/")) return "internal_control";
  return "other";
}

function classifyStatus(value: unknown): StatusClass {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) return "other";
  return `${Math.floor(value / 100)}xx` as StatusClass;
}

function increment(value: number): number {
  return value < MAX_METRIC_NUMBER ? value + 1 : MAX_METRIC_NUMBER;
}

function validMetricNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function defaultProcessSnapshot(): RuntimeMetricsProcessSnapshot {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    uptimeSeconds: process.uptime(),
    residentMemoryBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    cpuUserSeconds: cpu.user / 1_000_000,
    cpuSystemSeconds: cpu.system / 1_000_000,
  };
}

function labelString(component: RuntimeMetricsComponent, method: MethodLabel, route: RouteLabel, statusClass?: StatusClass): string {
  const base = `component="${component}",method="${method}",route="${route}"`;
  return statusClass === undefined ? base : `${base},status_class="${statusClass}"`;
}

function createProviderGatewayMetrics(component: RuntimeMetricsComponent, now: () => number) {
  const attempts = new Map<ProviderGatewayMetricScope, GatewayAttemptSeries>();
  const completions = new Map<string, GatewayCompletionSeries>();
  const rejections = new Map<string, { scope: ProviderGatewayMetricScope; reason: ProviderGatewayRejectionReason; count: number }>();
  const validScope = (scope: unknown): scope is ProviderGatewayMetricScope => scope === "platform" || scope === "byok";
  const labels = (scope: ProviderGatewayMetricScope) => `component="${component}",scope="${scope}"`;
  const observer: ProviderGatewayObserver = Object.freeze({
    rejected(scope: ProviderGatewayMetricScope, reason: ProviderGatewayRejectionReason): void {
      if (!validScope(scope) || typeof reason !== "string" || !GATEWAY_REASONS.includes(reason)) return;
      const key = `${scope}|${reason}`, series = rejections.get(key) ?? { scope, reason, count: 0 };
      series.count = increment(series.count); rejections.set(key, series);
    },
    beginAttempt(scope: ProviderGatewayMetricScope): (outcome: ProviderGatewayIoOutcome) => void {
      if (!validScope(scope)) return () => {};
      const series = attempts.get(scope) ?? { scope, attempts: 0, active: 0 };
      attempts.set(scope, series); series.attempts = increment(series.attempts); series.active = increment(series.active);
      let startedAt: number | null = null;
      try { const value = now(); if (validMetricNumber(value)) startedAt = value; } catch { /* Omit only the timing sample. */ }
      let finished = false;
      return (input: ProviderGatewayIoOutcome): void => {
        if (finished) return; finished = true; series.active = Math.max(0, series.active - 1);
        // Unknown runtime values never become labels; they still settle the owned active sample.
        const outcome: GatewayObservedOutcome = typeof input === "string" && GATEWAY_OUTCOMES.includes(input) ? input : "other";
        const key = `${scope}|${outcome}`, completed = completions.get(key) ?? { scope, outcome, completions: 0,
          durationCount: 0, durationSum: 0, cumulativeBuckets: HISTOGRAM_BUCKETS.map(() => 0) };
        completions.set(key, completed); completed.completions = increment(completed.completions);
        if (startedAt === null) return;
        let endedAt: number;
        try { endedAt = now(); } catch { return; }
        if (!validMetricNumber(endedAt) || endedAt < startedAt) return;
        const durationSeconds = (endedAt - startedAt) / 1_000;
        if (!validMetricNumber(durationSeconds) || durationSeconds > MAX_METRIC_NUMBER) return;
        completed.durationCount = increment(completed.durationCount);
        completed.durationSum = Math.min(MAX_METRIC_NUMBER, completed.durationSum + durationSeconds);
        for (let index = 0; index < HISTOGRAM_BUCKETS.length; index++) {
          if (durationSeconds <= HISTOGRAM_BUCKETS[index]!) completed.cumulativeBuckets[index] = increment(completed.cumulativeBuckets[index]!);
        }
      };
    },
  });
  return { observer, append(lines: string[]): void {
    lines.push("# HELP agent_service_provider_gateway_attempts_total Actual upstream delegate entries, not model or billing successes.",
      "# TYPE agent_service_provider_gateway_attempts_total counter");
    for (const [, series] of [...attempts].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`agent_service_provider_gateway_attempts_total{${labels(series.scope)}} ${series.attempts}`);
    }
    lines.push("# HELP agent_service_provider_gateway_attempts_in_progress Upstream attempts whose original fetch, read and cancellation have not all settled.",
      "# TYPE agent_service_provider_gateway_attempts_in_progress gauge");
    for (const [, series] of [...attempts].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`agent_service_provider_gateway_attempts_in_progress{${labels(series.scope)}} ${series.active}`);
    }
    lines.push("# HELP agent_service_provider_gateway_io_completions_total Joined upstream I/O outcomes; completed means only a full 2xx I/O, not SSE parsing, turn or billing success.",
      "# TYPE agent_service_provider_gateway_io_completions_total counter");
    for (const [, series] of [...completions].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`agent_service_provider_gateway_io_completions_total{${labels(series.scope)},outcome="${series.outcome}"} ${series.completions}`);
    }
    lines.push("# HELP agent_service_provider_gateway_io_duration_seconds Actual delegate entry to joined fetch, read and cancellation, excluding health and quota release time.",
      "# TYPE agent_service_provider_gateway_io_duration_seconds histogram");
    for (const [, series] of [...completions].sort(([a], [b]) => a.localeCompare(b))) {
      const label = `${labels(series.scope)},outcome="${series.outcome}"`;
      for (let index = 0; index < HISTOGRAM_BUCKETS.length; index++) {
        lines.push(`agent_service_provider_gateway_io_duration_seconds_bucket{${label},le="${HISTOGRAM_BUCKETS[index]}"} ${series.cumulativeBuckets[index]}`);
      }
      lines.push(`agent_service_provider_gateway_io_duration_seconds_bucket{${label},le="+Inf"} ${series.durationCount}`,
        `agent_service_provider_gateway_io_duration_seconds_sum{${label}} ${series.durationSum}`,
        `agent_service_provider_gateway_io_duration_seconds_count{${label}} ${series.durationCount}`);
    }
    lines.push("# HELP agent_service_provider_gateway_rejections_total Pre-dispatch gateway rejections; no upstream attempt was entered.",
      "# TYPE agent_service_provider_gateway_rejections_total counter");
    for (const [, series] of [...rejections].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`agent_service_provider_gateway_rejections_total{${labels(series.scope)},reason="${series.reason}"} ${series.count}`);
    }
  } };
}

/** Fixed, low-cardinality, in-memory L0 Prometheus text metrics. No input values become labels. */
export function createRuntimeMetrics(component: RuntimeMetricsComponent, options: RuntimeMetricsOptions = {}): RuntimeMetrics {
  if (component !== "router" && component !== "runner") throw new Error("invalid runtime metrics component");
  const now = options.now ?? (() => performance.now());
  const processSnapshot = options.processSnapshot ?? defaultProcessSnapshot;
  const active = new Map<string, ActiveSeries>();
  const completed = new Map<string, CompletedSeries>();
  const gateway = createProviderGatewayMetrics(component, now);

  return {
    providerGateway: gateway.observer,
    beginRequest(methodInput: string, pathInput: string): (status: number) => void {
      const method = classifyMethod(methodInput);
      const route = classifyRoute(pathInput);
      const activeKey = `${method}|${route}`;
      const activeSeries = active.get(activeKey) ?? { method, route, handlers: 0 };
      active.set(activeKey, activeSeries);
      activeSeries.handlers = increment(activeSeries.handlers);
      let startedAt: number | null = null;
      try {
        const value = now();
        if (validMetricNumber(value)) startedAt = value;
      } catch {
        // Metrics must never alter request handling.
      }
      let finished = false;
      return (statusInput: number): void => {
        if (finished) return;
        finished = true;
        activeSeries.handlers = Math.max(0, activeSeries.handlers - 1);
        const statusClass = classifyStatus(statusInput);
        const key = `${activeKey}|${statusClass}`;
        let series = completed.get(key);
        if (series === undefined) {
          series = { method, route, statusClass, requests: 0, durationCount: 0, durationSum: 0,
            cumulativeBuckets: HISTOGRAM_BUCKETS.map(() => 0) };
          completed.set(key, series);
        }
        series.requests = increment(series.requests);
        if (startedAt === null) return;
        let endedAt: number;
        try {
          endedAt = now();
        } catch {
          return;
        }
        if (!validMetricNumber(endedAt) || endedAt < startedAt) return;
        const durationSeconds = (endedAt - startedAt) / 1_000;
        if (!validMetricNumber(durationSeconds) || durationSeconds > MAX_METRIC_NUMBER) return;
        series.durationCount = increment(series.durationCount);
        series.durationSum = Math.min(MAX_METRIC_NUMBER, series.durationSum + durationSeconds);
        for (let index = 0; index < HISTOGRAM_BUCKETS.length; index += 1) {
          if (durationSeconds <= HISTOGRAM_BUCKETS[index]!) {
            series.cumulativeBuckets[index] = increment(series.cumulativeBuckets[index]!);
          }
        }
      };
    },

    render(): string {
      const lines: string[] = [
        "# HELP agent_service_http_requests_total HTTP requests completed when response headers are ready.",
        "# TYPE agent_service_http_requests_total counter",
      ];
      for (const [, series] of [...completed].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`agent_service_http_requests_total{${labelString(component, series.method, series.route, series.statusClass)}} ${series.requests}`);
      }
      lines.push(
        "# HELP agent_service_http_handlers_in_progress HTTP handlers with response headers not yet ready.",
        "# TYPE agent_service_http_handlers_in_progress gauge",
      );
      for (const [, series] of [...active].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`agent_service_http_handlers_in_progress{${labelString(component, series.method, series.route)}} ${series.handlers}`);
      }
      lines.push(
        "# HELP agent_service_http_response_headers_duration_seconds Time to response headers, excluding streaming body lifetime.",
        "# TYPE agent_service_http_response_headers_duration_seconds histogram",
      );
      for (const [, series] of [...completed].sort(([a], [b]) => a.localeCompare(b))) {
        const labels = labelString(component, series.method, series.route, series.statusClass);
        for (let index = 0; index < HISTOGRAM_BUCKETS.length; index += 1) {
          lines.push(`agent_service_http_response_headers_duration_seconds_bucket{${labels},le="${HISTOGRAM_BUCKETS[index]}"} ${series.cumulativeBuckets[index]}`);
        }
        lines.push(`agent_service_http_response_headers_duration_seconds_bucket{${labels},le="+Inf"} ${series.durationCount}`);
        lines.push(`agent_service_http_response_headers_duration_seconds_sum{${labels}} ${series.durationSum}`);
        lines.push(`agent_service_http_response_headers_duration_seconds_count{${labels}} ${series.durationCount}`);
      }

      gateway.append(lines);
      let snapshot: RuntimeMetricsProcessSnapshot | null = null;
      try {
        snapshot = processSnapshot();
      } catch {
        // A failed process probe never breaks a scrape or exposes an exception message.
      }
      const processFields = [
        ["agent_service_process_uptime_seconds", "uptimeSeconds", "gauge"],
        ["agent_service_process_resident_memory_bytes", "residentMemoryBytes", "gauge"],
        ["agent_service_process_heap_used_bytes", "heapUsedBytes", "gauge"],
        ["agent_service_process_cpu_user_seconds_total", "cpuUserSeconds", "counter"],
        ["agent_service_process_cpu_system_seconds_total", "cpuSystemSeconds", "counter"],
      ] as const;
      for (const [name, field, metricType] of processFields) {
        lines.push(`# HELP ${name} Current process ${field}.`);
        lines.push(`# TYPE ${name} ${metricType}`);
        try {
          const value = snapshot?.[field];
          if (validMetricNumber(value)) lines.push(`${name}{component="${component}"} ${value}`);
        } catch {
          // A hostile or broken snapshot getter cannot alter the response.
        }
      }
      return `${lines.join("\n")}\n`;
    },
  };
}

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/;
const INVALID_TOKEN = "invalid runtime metrics token";

/** Startup-only validation. The error never contains a candidate or privileged token. */
export function validateRuntimeMetricsToken(
  token: unknown,
  forbiddenTokens: readonly (string | undefined)[] = [],
): asserts token is string {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) throw new Error(INVALID_TOKEN);
  for (const forbidden of forbiddenTokens) {
    if (forbidden !== undefined && token === forbidden) throw new Error(INVALID_TOKEN);
  }
}

/** Strict Authorization: Bearer, with a fixed-size digest comparison and no input reflection. */
export function runtimeMetricsTokenMatches(header: unknown, expected: string): boolean {
  if (typeof header !== "string" || header.length > 263 ||
      !/^[Bb][Ee][Aa][Rr][Ee][Rr] [A-Za-z0-9._~-]{32,256}$/.test(header) ||
      typeof expected !== "string" || !TOKEN_PATTERN.test(expected)) return false;
  const supplied = header.slice(7);
  const suppliedDigest = createHash("sha256").update(supplied, "ascii").digest();
  const expectedDigest = createHash("sha256").update(expected, "ascii").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

/**
 * Detect a protected token inside a comma-combined Authorization value before forwarding it.
 * This is a deny-only containment check, never an alternative scrape authenticator.
 */
export function authorizationContainsProtectedBearerToken(header: unknown, expected: string | undefined): boolean {
  if (typeof header !== "string" || expected === undefined) return false;
  let start = 0;
  while (start <= header.length) {
    const comma = header.indexOf(",", start);
    const end = comma < 0 ? header.length : comma;
    const segment = header.slice(start, end).trim();
    const match = /^Bearer\s+([A-Za-z0-9._~-]{32,256})$/i.exec(segment);
    if (match !== null && runtimeMetricsTokenMatches(`Bearer ${match[1]}`, expected)) return true;
    if (comma < 0) return false;
    start = comma + 1;
  }
  return false;
}
