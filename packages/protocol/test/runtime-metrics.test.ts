import { describe, expect, it } from "vitest";
import {
  RUNTIME_METRICS_CONTENT_TYPE,
  authorizationContainsProtectedBearerToken,
  createRuntimeMetrics,
  runtimeMetricsTokenMatches,
  validateRuntimeMetricsToken,
} from "../src/runtime-metrics.js";

interface Sample {
  labels: Record<string, string>;
  value: number;
}

function samples(output: string, name: string): Sample[] {
  return output.split("\n").flatMap((line) => {
    const match = new RegExp(`^${name}(?:\\{([^}]*)\\})? ([^ ]+)$`).exec(line);
    if (!match) return [];
    const labels: Record<string, string> = {};
    for (const label of (match[1] ?? "").matchAll(/([a-z_]+)="([^"\\]*)"/g)) {
      labels[label[1]!] = label[2]!;
    }
    return [{ labels, value: Number(match[2]) }];
  });
}

function sample(output: string, name: string, expectedLabels: Record<string, string>): number {
  const match = samples(output, name).find(({ labels }) =>
    Object.entries(expectedLabels).every(([key, value]) => labels[key] === value));
  expect(match, `${name} with ${JSON.stringify(expectedLabels)}`).toBeDefined();
  return match!.value;
}

function processSnapshot() {
  return {
    uptimeSeconds: 42,
    residentMemoryBytes: 1_000_000,
    heapUsedBytes: 500_000,
    cpuUserSeconds: 1.25,
    cpuSystemSeconds: 0.5,
  };
}

const REQUESTS = "agent_service_http_requests_total";
const IN_PROGRESS = "agent_service_http_handlers_in_progress";
const DURATION = "agent_service_http_response_headers_duration_seconds";
const PROCESS_NAMES = [
  "agent_service_process_uptime_seconds",
  "agent_service_process_resident_memory_bytes",
  "agent_service_process_heap_used_bytes",
  "agent_service_process_cpu_user_seconds_total",
  "agent_service_process_cpu_system_seconds_total",
] as const;

describe("runtime metrics", () => {
  it("emits Prometheus text with three process gauges and two CPU counters", () => {
    const output = createRuntimeMetrics("router", { processSnapshot }).render();
    expect(RUNTIME_METRICS_CONTENT_TYPE).toContain("text/plain");
    expect(RUNTIME_METRICS_CONTENT_TYPE).toContain("version=0.0.4");
    expect(output.endsWith("\n")).toBe(true);
    for (const name of PROCESS_NAMES) {
      expect(sample(output, name, { component: "router" })).toBeGreaterThanOrEqual(0);
    }
    expect(sample(output, PROCESS_NAMES[0], { component: "router" })).toBe(42);
    expect(sample(output, PROCESS_NAMES[1], { component: "router" })).toBe(1_000_000);
    for (const name of PROCESS_NAMES.slice(0, 3)) expect(output).toContain(`# TYPE ${name} gauge`);
    for (const name of PROCESS_NAMES.slice(3)) expect(output).toContain(`# TYPE ${name} counter`);
  });

  it("counts one request and records cumulative response-header duration buckets in seconds", () => {
    let nowMs = 1_000;
    const metrics = createRuntimeMetrics("runner", { now: () => nowMs, processSnapshot });
    const finish = metrics.beginRequest("GET", "/healthz");
    expect(sample(metrics.render(), IN_PROGRESS, { component: "runner" })).toBe(1);

    nowMs = 1_012;
    finish(204);
    const output = metrics.render();
    const labels = { component: "runner", method: "GET", route: "health", status_class: "2xx" };
    expect(sample(output, REQUESTS, labels)).toBe(1);
    expect(sample(output, IN_PROGRESS, { component: "runner" })).toBe(0);
    expect(sample(output, `${DURATION}_count`, labels)).toBe(1);
    expect(sample(output, `${DURATION}_sum`, labels)).toBeCloseTo(0.012, 10);
    for (const bound of ["0.005", "0.01"]) {
      expect(sample(output, `${DURATION}_bucket`, { ...labels, le: bound })).toBe(0);
    }
    for (const bound of ["0.025", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10", "30", "+Inf"]) {
      expect(sample(output, `${DURATION}_bucket`, { ...labels, le: bound })).toBe(1);
    }
  });

  it("classifies methods, routes and status without exposing caller-controlled values", () => {
    const privatePath = "/not-an-api-route/tenant_secret_123?api_key=do-not-print";
    const metrics = createRuntimeMetrics("router", { now: () => 20, processSnapshot });
    for (let index = 0; index < 32; index += 1) {
      metrics.beginRequest("PRIVATE_METHOD", `${privatePath}/${index}`)(599);
    }
    metrics.beginRequest("CONNECT", privatePath)(0);
    metrics.beginRequest("POST", "/v1/sessions")(201);
    const output = metrics.render();
    expect(output).not.toContain("tenant_secret_123");
    expect(output).not.toContain("api_key");
    expect(output).not.toContain("do-not-print");
    expect(output).not.toContain("PRIVATE_METHOD");
    expect(output).not.toContain("CONNECT");
    expect(sample(output, REQUESTS, { component: "router", method: "other", route: "other", status_class: "5xx" })).toBe(32);
    expect(sample(output, REQUESTS, { component: "router", method: "other", route: "other", status_class: "other" })).toBe(1);
    expect(sample(output, REQUESTS, { component: "router", method: "POST", route: "sessions", status_class: "2xx" })).toBe(1);
    expect(samples(output, REQUESTS).length).toBeLessThanOrEqual(3);
    for (const { labels } of samples(output, REQUESTS)) {
      expect(Object.keys(labels).sort()).toEqual(["component", "method", "route", "status_class"]);
    }
  });

  it("uses fixed route labels for dynamic resources and every HTTP status class", () => {
    const metrics = createRuntimeMetrics("router", { now: () => 10, processSnapshot });
    metrics.beginRequest("GET", "/v1/sessions/sess_private_123/events?token=private_456")(404);
    for (const status of [101, 302, 418, 700]) metrics.beginRequest("HEAD", "/readyz")(status);
    const output = metrics.render();
    expect(output).not.toContain("sess_private_123");
    expect(output).not.toContain("private_456");
    expect(sample(output, REQUESTS, { component: "router", method: "GET", route: "session_events", status_class: "4xx" })).toBe(1);
    for (const statusClass of ["1xx", "3xx", "4xx", "other"]) {
      expect(sample(output, REQUESTS, { component: "router", method: "HEAD", route: "ready", status_class: statusClass })).toBe(1);
    }
  });

  it("tracks overlapping handlers and makes each finish callback idempotent", () => {
    let nowMs = 0;
    const metrics = createRuntimeMetrics("router", { now: () => nowMs, processSnapshot });
    const first = metrics.beginRequest("GET", "/healthz");
    const second = metrics.beginRequest("GET", "/healthz");
    expect(sample(metrics.render(), IN_PROGRESS, { component: "router" })).toBe(2);
    nowMs = 10;
    first(200);
    first(500);
    expect(sample(metrics.render(), IN_PROGRESS, { component: "router" })).toBe(1);
    nowMs = 30;
    second(503);
    const output = metrics.render();
    expect(sample(output, IN_PROGRESS, { component: "router" })).toBe(0);
    expect(sample(output, REQUESTS, { component: "router", method: "GET", route: "health", status_class: "2xx" })).toBe(1);
    expect(sample(output, REQUESTS, { component: "router", method: "GET", route: "health", status_class: "5xx" })).toBe(1);
    expect(samples(output, REQUESTS).reduce((total, entry) => total + entry.value, 0)).toBe(2);
  });

  it("clamps bad or backwards clocks rather than exporting negative or non-finite durations", () => {
    let nowMs = 100;
    const metrics = createRuntimeMetrics("runner", { now: () => nowMs, processSnapshot });
    const backwards = metrics.beginRequest("GET", "/healthz");
    nowMs = 10;
    backwards(200);
    nowMs = Number.NaN;
    const invalid = metrics.beginRequest("GET", "/healthz");
    nowMs = Number.POSITIVE_INFINITY;
    invalid(200);
    const output = metrics.render();
    expect(output).not.toMatch(/\b(?:NaN|Infinity|-Infinity)\b/);
    expect(sample(output, `${DURATION}_sum`, { component: "runner", method: "GET", route: "health", status_class: "2xx" })).toBe(0);
    for (const entry of samples(output, `${DURATION}_bucket`)) {
      expect(Number.isFinite(entry.value)).toBe(true);
      expect(entry.value).toBeGreaterThanOrEqual(0);
    }
  });

  it("sanitizes invalid process snapshots and keeps rendering when the snapshot provider throws", () => {
    const invalid = createRuntimeMetrics("runner", {
      processSnapshot: () => ({
        uptimeSeconds: Number.NaN,
        residentMemoryBytes: Number.NEGATIVE_INFINITY,
        heapUsedBytes: -1,
        cpuUserSeconds: Number.POSITIVE_INFINITY,
        cpuSystemSeconds: -2,
      }),
    }).render();
    expect(invalid).not.toMatch(/\b(?:NaN|Infinity|-Infinity)\b/);
    for (const name of PROCESS_NAMES) {
      expect(samples(invalid, name)).toHaveLength(0);
    }
    const throwing = createRuntimeMetrics("router", {
      processSnapshot: () => { throw new Error("private process failure"); },
    });
    throwing.beginRequest("GET", "/healthz")(200);
    const output = throwing.render();
    expect(output).not.toContain("private process failure");
    expect(sample(output, REQUESTS, { component: "router", method: "GET", route: "health", status_class: "2xx" })).toBe(1);
  });
});

describe("runtime metrics bearer token", () => {
  const token = "AbC_123.~-".repeat(4);

  it("accepts only 32 to 256 ASCII token characters from the closed alphabet", () => {
    for (const valid of ["a".repeat(32), "Z".repeat(256), token]) {
      expect(() => validateRuntimeMetricsToken(valid)).not.toThrow();
    }
    for (const invalid of [undefined, null, 12, "", "a".repeat(31), "a".repeat(257), "a".repeat(32) + " ", "é".repeat(32), "a/b".repeat(16), "a=b".repeat(16), "a\nb".repeat(16)]) {
      expect(() => validateRuntimeMetricsToken(invalid)).toThrow();
    }
  });

  it("rejects exact reuse of privileged tokens without echoing either token or input", () => {
    const privateToken = "A-private-admin-token-".repeat(3);
    let invalidMessage: string | undefined;
    let forbiddenMessage: string | undefined;
    try { validateRuntimeMetricsToken("very-secret-invalid"); } catch (error) { invalidMessage = (error as Error).message; }
    try { validateRuntimeMetricsToken(privateToken, [undefined, privateToken]); } catch (error) { forbiddenMessage = (error as Error).message; }
    expect(invalidMessage).toBeTruthy();
    expect(forbiddenMessage).toBeTruthy();
    expect(invalidMessage).toBe(forbiddenMessage);
    expect(invalidMessage).not.toContain("very-secret-invalid");
    expect(forbiddenMessage).not.toContain(privateToken);
  });

  it("requires one strict Bearer token while comparing the token case-sensitively", () => {
    expect(runtimeMetricsTokenMatches(`Bearer ${token}`, token)).toBe(true);
    expect(runtimeMetricsTokenMatches(`bearer ${token}`, token)).toBe(true);
    expect(runtimeMetricsTokenMatches(`BEARER ${token}`, token)).toBe(true);
    for (const badHeader of [
      token,
      `Basic ${token}`,
      `Bearer  ${token}`,
      `Bearer ${token} `,
      `Bearer ${token},${token}`,
      `Bearer ${token.toLowerCase()}`,
      `Bearer ${token} extra`,
      `Bearer ${"A".repeat(257)}`,
      `Bearer ${"A".repeat(32)}\nX-Admin: private`,
    ]) expect(runtimeMetricsTokenMatches(badHeader, token)).toBe(false);
    expect(runtimeMetricsTokenMatches(undefined, token)).toBe(false);
  });

  it("detects a protected Bearer inside combined Authorization values for deny-only forwarding checks", () => {
    for (const header of [
      `Bearer ${token}`,
      `bearer  ${token}`,
      `BEARER\t${token}`,
      `BeArEr\u00a0${token}`,
      `  Basic unrelated, Bearer ${token}  `,
      `Bearer unrelated-token-that-is-long-enough-123,\tBearer\t${token}, Basic other`,
      `Bearer ${token}, Bearer ${token}`,
    ]) {
      expect(authorizationContainsProtectedBearerToken(header, token)).toBe(true);
    }
    // Containment denies forwarding, but cannot authenticate a non-canonical scrape header.
    expect(runtimeMetricsTokenMatches(`Bearer  ${token}`, token)).toBe(false);
    expect(runtimeMetricsTokenMatches(`Basic other, Bearer ${token}`, token)).toBe(false);
  });

  it("does not confuse similar tokens or grant containment without a configured protected token", () => {
    for (const header of [
      undefined,
      42,
      `Basic ${token}`,
      `Bearer ${token.toLowerCase()}`,
      `Bearer ${token}extra`,
      `Bearer ${token}; Bearer ${token}`,
      `Bearer ${token.slice(0, 31)}`,
      `Bearer ${"x".repeat(257)}`,
    ]) {
      expect(authorizationContainsProtectedBearerToken(header, token)).toBe(false);
    }
    expect(authorizationContainsProtectedBearerToken(`Bearer ${token}`, undefined)).toBe(false);
    expect(authorizationContainsProtectedBearerToken(`Bearer ${token}`, "not-a-valid-token")).toBe(false);
  });
});
