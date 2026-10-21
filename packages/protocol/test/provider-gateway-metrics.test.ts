import { describe, expect, it } from "vitest";
import { createRuntimeMetrics, type ProviderGatewayIoOutcome, type ProviderGatewayMetricScope,
  type ProviderGatewayRejectionReason, type RuntimeMetrics } from "../src/runtime-metrics.js";

const PREFIX = "agent_service_provider_gateway_";
const ATTEMPTS = PREFIX + "attempts_total", ACTIVE = PREFIX + "attempts_in_progress";
const COMPLETIONS = PREFIX + "io_completions_total", DURATION = PREFIX + "io_duration_seconds", REJECTIONS = PREFIX + "rejections_total";
const scopes: readonly ProviderGatewayMetricScope[] = ["platform", "byok"];
const reasons: readonly ProviderGatewayRejectionReason[] = ["quota_rpm", "quota_concurrency", "quota_unavailable",
  "breaker_open", "breaker_disabled", "breaker_unavailable", "subject_deleting", "cancelled", "local_unavailable"];
const outcomes: readonly ProviderGatewayIoOutcome[] = ["completed", "http_error", "transport_error", "cancelled", "local_abort"];
interface Sample { labels: Record<string, string>; value: number }
function samples(output: string, name: string): Sample[] {
  return output.split("\n").flatMap(line => {
    const match = new RegExp(`^${name}\\{([^}]*)\\} ([^ ]+)$`).exec(line); if (!match) return [];
    return [{ labels: Object.fromEntries([...match[1]!.matchAll(/([a-z_]+)="([^"\\]*)"/g)].map(value => [value[1]!, value[2]!])), value: Number(match[2]) }];
  });
}
function value(output: string, name: string, labels: Record<string, string>): number {
  const found = samples(output, name).find(sample => Object.entries(labels).every(([key, value]) => sample.labels[key] === value));
  expect(found, name).toBeDefined(); return found!.value;
}
const labels = (scope: ProviderGatewayMetricScope, outcome?: string) => ({ component: "runner", scope, ...(outcome ? { outcome } : {}) });
const registry = (now: () => number = () => 0) => createRuntimeMetrics("runner", { now,
  processSnapshot: () => ({ uptimeSeconds: 0, residentMemoryBytes: 0, heapUsedBytes: 0, cpuUserSeconds: 0, cpuSystemSeconds: 0 }) });

describe("process-local closed provider gateway metrics", () => {
  it("keeps legacy RuntimeMetrics doubles compatible and exposes one frozen observer on the same registry", () => {
    const legacy: RuntimeMetrics = { beginRequest: () => () => {}, render: () => "" };
    expect(legacy.providerGateway).toBeUndefined();
    const metrics = registry(), observer = metrics.providerGateway!;
    expect(metrics.providerGateway).toBe(observer); expect(Object.isFrozen(observer)).toBe(true);
    observer.rejected("platform", "quota_rpm"); metrics.beginRequest("GET", "/healthz")(200);
    const output = metrics.render(); expect(value(output, REJECTIONS, { ...labels("platform"), reason: "quota_rpm" })).toBe(1);
    expect(output).toContain("agent_service_http_requests_total{");
    expect(output).toContain("agent_service_process_uptime_seconds{");
  });

  it("counts actual entry immediately but records full I/O completion and duration only when explicitly finished", () => {
    let now = 1_000; const metrics = registry(() => now), observer = metrics.providerGateway!;
    const finish = observer.beginAttempt("platform");
    expect(value(metrics.render(), ATTEMPTS, labels("platform"))).toBe(1);
    expect(value(metrics.render(), ACTIVE, labels("platform"))).toBe(1);
    expect(samples(metrics.render(), COMPLETIONS)).toEqual([]);
    now = 1_012; finish("completed"); const output = metrics.render();
    expect(value(output, ACTIVE, labels("platform"))).toBe(0);
    expect(value(output, COMPLETIONS, labels("platform", "completed"))).toBe(1);
    expect(value(output, DURATION + "_sum", labels("platform", "completed"))).toBeCloseTo(0.012, 10);
    expect(value(output, DURATION + "_count", labels("platform", "completed"))).toBe(1);
    for (const le of ["0.005", "0.01"]) expect(value(output, DURATION + "_bucket", { ...labels("platform", "completed"), le })).toBe(0);
    for (const le of ["0.025", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10", "30", "+Inf"]) {
      expect(value(output, DURATION + "_bucket", { ...labels("platform", "completed"), le })).toBe(1);
    }
    expect(output).toContain("not SSE parsing, turn or billing success");
    expect(output).toContain("excluding health and quota release time");
  });

  it("keeps held overlapping attempts and the two closed scopes independent", () => {
    let now = 0; const metrics = registry(() => now), observer = metrics.providerGateway!;
    const first = observer.beginAttempt("platform"), second = observer.beginAttempt("platform"), byok = observer.beginAttempt("byok");
    // Pure lifecycle proof: no HTTP/native settlement is claimed by this controlled callback test.
    now = 5_000;
    expect(value(metrics.render(), ACTIVE, labels("platform"))).toBe(2); expect(value(metrics.render(), ACTIVE, labels("byok"))).toBe(1);
    first("http_error"); first("completed"); byok("cancelled");
    expect(value(metrics.render(), ACTIVE, labels("platform"))).toBe(1); expect(value(metrics.render(), ACTIVE, labels("byok"))).toBe(0);
    now = 8_000; second("transport_error"); const output = metrics.render();
    expect(value(output, ATTEMPTS, labels("platform"))).toBe(2); expect(value(output, ATTEMPTS, labels("byok"))).toBe(1);
    expect(value(output, ACTIVE, labels("platform"))).toBe(0);
    expect(samples(output, COMPLETIONS).map(sample => sample.value)).toEqual([1, 1, 1]);
    expect(samples(output, COMPLETIONS).some(sample => sample.labels.outcome === "completed")).toBe(false);
  });

  it("records all nine finite rejection reasons without creating attempts, active or I/O samples", () => {
    const metrics = registry(), observer = metrics.providerGateway!;
    for (const scope of scopes) for (const reason of reasons) { observer.rejected(scope, reason); observer.rejected(scope, reason); }
    const output = metrics.render(); expect(samples(output, REJECTIONS)).toHaveLength(18);
    for (const sample of samples(output, REJECTIONS)) { expect(sample.value).toBe(2); expect(Object.keys(sample.labels).sort()).toEqual(["component", "reason", "scope"]); }
    for (const name of [ATTEMPTS, ACTIVE, COMPLETIONS, DURATION + "_count"]) expect(samples(output, name)).toEqual([]);
  });

  it("releases active exactly once for an unknown outcome and records only the fixed other label", () => {
    const metrics = registry(), finish = metrics.providerGateway!.beginAttempt("byok");
    finish("private-unrecognized-status" as never); finish("completed"); finish("cancelled"); const output = metrics.render();
    expect(value(output, ACTIVE, labels("byok"))).toBe(0); expect(value(output, COMPLETIONS, labels("byok", "other"))).toBe(1);
    expect(samples(output, COMPLETIONS)).toHaveLength(1); expect(output).not.toContain("private-unrecognized-status");
  });

  it("rejects unknown scope/reason without coercion, error retention or canary labels", () => {
    const metrics = registry(), observer = metrics.providerGateway!, canary = "private-owner-provider-slot-url-key-秘密";
    let coerced = false;
    const hostile = { toString() { coerced = true; throw new Error(canary); } };
    for (const scope of [undefined, null, "tenant", canary, hostile, Symbol(canary)]) {
      observer.rejected(scope as never, "quota_rpm"); observer.beginAttempt(scope as never)("completed");
    }
    for (const reason of [undefined, null, canary, hostile, new Error(canary)]) observer.rejected("platform", reason as never);
    const finish = observer.beginAttempt("byok"); expect(() => finish(hostile as never)).not.toThrow();
    const output = metrics.render(); expect(coerced).toBe(false); expect(output).not.toContain(canary);
    expect(samples(output, REJECTIONS)).toEqual([]); expect(samples(output, ATTEMPTS)).toHaveLength(1);
    expect(value(output, COMPLETIONS, labels("byok", "other"))).toBe(1);
  });

  it("bounds all gateway series to fixed scope, reason and outcome sets", () => {
    const metrics = registry(), observer = metrics.providerGateway!;
    for (const scope of scopes) {
      for (const outcome of outcomes) observer.beginAttempt(scope)(outcome);
      for (let index = 0; index < 100; index++) {
        observer.beginAttempt(scope)(`untrusted-outcome-${index}` as never);
        observer.rejected(scope, `untrusted-reason-${index}` as never);
      }
      for (const reason of reasons) observer.rejected(scope, reason);
    }
    const output = metrics.render(); expect(samples(output, ATTEMPTS)).toHaveLength(2); expect(samples(output, ACTIVE)).toHaveLength(2);
    expect(samples(output, COMPLETIONS)).toHaveLength(12); expect(samples(output, REJECTIONS)).toHaveLength(18);
    expect(samples(output, DURATION + "_bucket")).toHaveLength(12 * 13);
    expect(output).not.toContain("untrusted-");
    for (const name of [ATTEMPTS, ACTIVE, COMPLETIONS, REJECTIONS, DURATION + "_bucket", DURATION + "_sum", DURATION + "_count"]) {
      for (const sample of samples(output, name)) {
        expect(Object.keys(sample.labels).every(key => ["component", "scope", "outcome", "reason", "le"].includes(key))).toBe(true);
        expect(scopes).toContain(sample.labels.scope); expect(Number.isFinite(sample.value)).toBe(true); expect(sample.value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it.each([
    [-1, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], [100, 10], [0, -1], [0, Number.NaN], [0, Number.POSITIVE_INFINITY],
  ])("drops an invalid or backwards timing sample (%s -> %s) without losing attempt completion", (start, end) => {
    let now = start; const metrics = registry(() => now), finish = metrics.providerGateway!.beginAttempt("platform"); now = end; finish("completed");
    const output = metrics.render(); expect(value(output, ACTIVE, labels("platform"))).toBe(0);
    expect(value(output, ATTEMPTS, labels("platform"))).toBe(1); expect(value(output, COMPLETIONS, labels("platform", "completed"))).toBe(1);
    expect(value(output, DURATION + "_count", labels("platform", "completed"))).toBe(0);
    expect(value(output, DURATION + "_sum", labels("platform", "completed"))).toBe(0); expect(output).not.toMatch(/\b(?:NaN|Infinity|-Infinity)\b/);
  });

  it.each(["begin", "finish"] as const)("a throwing %s clock probe cannot alter active/counter settlement or disclose its error", phase => {
    let shouldThrow = phase === "begin"; const canary = "private-clock-error-秘密";
    const metrics = registry(() => { if (shouldThrow) throw new Error(canary); return 0; });
    let finish!: (outcome: ProviderGatewayIoOutcome) => void;
    expect(() => { finish = metrics.providerGateway!.beginAttempt("byok"); }).not.toThrow(); shouldThrow = phase === "finish";
    expect(() => finish("local_abort")).not.toThrow(); const output = metrics.render();
    expect(value(output, ACTIVE, labels("byok"))).toBe(0); expect(value(output, COMPLETIONS, labels("byok", "local_abort"))).toBe(1);
    expect(value(output, DURATION + "_count", labels("byok", "local_abort"))).toBe(0); expect(output).not.toContain(canary);
  });

  it("saturates accumulated duration at the shared safe maximum without exporting non-finite values", () => {
    let now = 0; const metrics = registry(() => now), observer = metrics.providerGateway!;
    const finished = [observer.beginAttempt("platform"), observer.beginAttempt("platform"), observer.beginAttempt("platform")];
    now = Number.MAX_SAFE_INTEGER / 2 * 1000; for (const finish of finished) finish("completed");
    const output = metrics.render(); expect(value(output, DURATION + "_sum", labels("platform", "completed"))).toBe(Number.MAX_SAFE_INTEGER);
    expect(value(output, DURATION + "_count", labels("platform", "completed"))).toBe(3); expect(value(output, ACTIVE, labels("platform"))).toBe(0);
    expect(value(output, DURATION + "_bucket", { ...labels("platform", "completed"), le: "+Inf" })).toBe(3);
    expect(output).not.toMatch(/\b(?:NaN|Infinity|-Infinity)\b/);
  });
});
