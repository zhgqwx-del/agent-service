import { beforeAll, describe, expect, it } from "vitest";

interface RunnerLoadArgs {
  turns: number;
  concurrency: number;
  ttftMs: number;
  deadlineMs: number;
}

type Outcome = "completed" | "http_error" | "protocol_error" | "deadline" | "transport_error";
type Percentiles = { p50: number | null; p95: number | null; p99: number | null };

interface RunnerLoadReport {
  turns: number;
  concurrency: number;
  scheduled: number;
  started: number;
  terminal: number;
  completed: number;
  failed: number;
  inFlight: number;
  activePeak: number;
  outcomes: Record<Outcome, number>;
  startLatencyMs: Percentiles;
  completionLatencyMs: Percentiles;
  elapsedMs: number;
  throughputPerSecond: number;
  targetConcurrencyMet: boolean;
}

interface RunnerLoadTracker {
  schedule(index: number, atMs: number): void;
  started(index: number, atMs: number): void;
  terminal(index: number, value: { atMs: number; outcome: Outcome }): void;
  report(atMs: number): RunnerLoadReport;
}

interface RunnerLoadDecoder {
  feed(bytes: Uint8Array): Array<{ event: string; data: Record<string, unknown> }>;
  end(): Array<{ event: string; data: Record<string, unknown> }>;
}

interface RunnerLoadApi {
  parseRunnerLoadArgs(argv: readonly string[]): RunnerLoadArgs | { help: true };
  createRunnerLoadTracker(options: {
    turns: number;
    concurrency: number;
    startedAtMs: number;
  }): RunnerLoadTracker;
  createRunnerLoadSseDecoder(): RunnerLoadDecoder;
}

let load: RunnerLoadApi;
beforeAll(async () => {
  // The standalone .mjs helper has an explicit test boundary; it is not an app or database import.
  const module: unknown = await import(new URL("../scripts/lib/runner-load.mjs", import.meta.url).href);
  load = module as RunnerLoadApi;
});

const bytes = (value: string) => new TextEncoder().encode(value);
const fixedError = (action: () => unknown, message: string) => {
  let received: unknown;
  try {
    action();
  } catch (error) {
    received = error;
  }
  expect(received).toBeInstanceOf(Error);
  expect((received as Error).message).toBe(message);
};

describe("runner load closed argument parser", () => {
  it("uses the finite default workload and only permits standalone help", () => {
    expect(load.parseRunnerLoadArgs([])).toEqual({
      turns: 1_000, concurrency: 1_000, ttftMs: 30_000, deadlineMs: 180_000,
    });
    expect(load.parseRunnerLoadArgs(["--help"])).toEqual({ help: true });
    fixedError(() => load.parseRunnerLoadArgs(["--help", "--turns", "2"]),
      "runner load arguments rejected");
  });

  it("caps omitted concurrency to a smaller turn count without silently changing explicit values", () => {
    expect(load.parseRunnerLoadArgs(["--turns", "3"])).toEqual({
      turns: 3, concurrency: 3, ttftMs: 30_000, deadlineMs: 180_000,
    });
    expect(load.parseRunnerLoadArgs([
      "--turns", "2000", "--concurrency", "1000", "--ttft-ms", "60000",
      "--deadline-ms", "600000",
    ])).toEqual({ turns: 2_000, concurrency: 1_000, ttftMs: 60_000, deadlineMs: 600_000 });
    expect(load.parseRunnerLoadArgs([
      "--turns", "1", "--concurrency", "1", "--ttft-ms", "1", "--deadline-ms", "1000",
    ])).toEqual({ turns: 1, concurrency: 1, ttftMs: 1, deadlineMs: 1_000 });
    fixedError(() => load.parseRunnerLoadArgs(["--turns", "2", "--concurrency", "3"]),
      "runner load arguments rejected");
  });

  for (const argv of [
    ["--turns", "0"], ["--turns", "2001"], ["--concurrency", "1001"],
    ["--ttft-ms", "60001"], ["--deadline-ms", "999"], ["--deadline-ms", "600001"],
    ["--turns", "01"], ["--turns", "+1"], ["--turns", "1.0"], ["--turns", "1e3"],
    ["--turns", " 1"], ["--turns", "9007199254740992"], ["--turns"],
    ["--turns=1"], ["--unknown", "1"], ["--turns", "2", "--turns", "3"],
    ["--secret-token", "secret-canary"], ["secret-canary"],
  ]) {
    it(`rejects a malformed or noncanonical vector ${argv[0]}`, () => {
      fixedError(() => load.parseRunnerLoadArgs(argv), "runner load arguments rejected");
    });
  }

  it("does not echo a secret supplied as an unexpected argument or malformed value", () => {
    for (const argv of [["--api-key", "sensitive-canary"], ["--turns", "sensitive-canary"]]) {
      fixedError(() => load.parseRunnerLoadArgs(argv), "runner load arguments rejected");
    }
  });
});

describe("runner load tracker uses real started-to-terminal overlap", () => {
  it("does not count 1000 queued requests as 1000 active turns", () => {
    const tracker = load.createRunnerLoadTracker({ turns: 1_000, concurrency: 1_000, startedAtMs: 0 });
    for (let index = 0; index < 1_000; index += 1) tracker.schedule(index, 0);
    for (let index = 0; index < 1_000; index += 1) {
      tracker.started(index, index * 2 + 1);
      tracker.terminal(index, { atMs: index * 2 + 2, outcome: "completed" });
    }
    expect(tracker.report(2_000)).toMatchObject({
      scheduled: 1_000, started: 1_000, terminal: 1_000, completed: 1_000,
      activePeak: 1, inFlight: 0, targetConcurrencyMet: false,
    });
  });

  it("counts overlapping active turns and only all-completed work as target met", () => {
    const tracker = load.createRunnerLoadTracker({ turns: 3, concurrency: 2, startedAtMs: 100 });
    for (let index = 0; index < 3; index += 1) tracker.schedule(index, 100);
    tracker.started(0, 101);
    tracker.started(1, 102);
    expect(tracker.report(102)).toMatchObject({
      scheduled: 3, started: 2, terminal: 0, inFlight: 2, activePeak: 2,
      targetConcurrencyMet: false,
    });
    tracker.terminal(0, { atMs: 103, outcome: "completed" });
    tracker.started(2, 104);
    tracker.terminal(1, { atMs: 105, outcome: "completed" });
    tracker.terminal(2, { atMs: 106, outcome: "completed" });
    expect(tracker.report(106)).toMatchObject({
      turns: 3, concurrency: 2, scheduled: 3, started: 3, terminal: 3,
      completed: 3, failed: 0, inFlight: 0, activePeak: 2,
      startLatencyMs: { p50: 2, p95: 4, p99: 4 },
      completionLatencyMs: { p50: 5, p95: 6, p99: 6 },
      elapsedMs: 6, throughputPerSecond: 500, targetConcurrencyMet: true,
    });
  });

  it("reports nearest-rank p50/p95/p99 at a 100-sample boundary", () => {
    const tracker = load.createRunnerLoadTracker({ turns: 100, concurrency: 1, startedAtMs: 0 });
    for (let index = 0; index < 100; index += 1) tracker.schedule(index, 0);
    for (let index = 0; index < 100; index += 1) tracker.started(index, index + 1);
    for (let index = 0; index < 100; index += 1) {
      tracker.terminal(index, { atMs: index + 101, outcome: "completed" });
    }
    expect(tracker.report(200)).toMatchObject({
      startLatencyMs: { p50: 50, p95: 95, p99: 99 },
      completionLatencyMs: { p50: 150, p95: 195, p99: 199 },
      throughputPerSecond: 500,
    });
  });

  it("keeps closed outcome counts, no-sample percentiles, and no identity fields", () => {
    const tracker = load.createRunnerLoadTracker({ turns: 5, concurrency: 1, startedAtMs: 500 });
    expect(tracker.report(500)).toMatchObject({
      scheduled: 0, started: 0, terminal: 0, activePeak: 0,
      startLatencyMs: { p50: null, p95: null, p99: null },
      completionLatencyMs: { p50: null, p95: null, p99: null },
      throughputPerSecond: 0, targetConcurrencyMet: false,
    });
    const errors: Outcome[] = ["http_error", "protocol_error", "deadline", "transport_error"];
    for (let index = 0; index < errors.length; index += 1) tracker.schedule(index, 500);
    for (let index = 0; index < errors.length; index += 1) {
      tracker.started(index, 501 + index * 2);
      tracker.terminal(index, { atMs: 502 + index * 2, outcome: errors[index]! });
    }
    const report = tracker.report(508);
    expect(report).toMatchObject({
      terminal: 4, completed: 0, failed: 4, activePeak: 1, targetConcurrencyMet: false,
      outcomes: {
        completed: 0, http_error: 1, protocol_error: 1, deadline: 1, transport_error: 1,
      },
    });
    expect(Object.keys(report).sort()).toEqual([
      "activePeak", "completed", "completionLatencyMs", "concurrency", "elapsedMs", "failed",
      "inFlight", "outcomes", "scheduled", "startLatencyMs", "started", "targetConcurrencyMet",
      "terminal", "throughputPerSecond", "turns",
    ].sort());
    expect(JSON.stringify(report)).not.toContain("session");
  });

  it("accounts for every failure before turn/started without inventing active concurrency", () => {
    const tracker = load.createRunnerLoadTracker({ turns: 4, concurrency: 4, startedAtMs: 10 });
    const failures: Outcome[] = ["http_error", "protocol_error", "deadline", "transport_error"];
    for (let index = 0; index < failures.length; index += 1) tracker.schedule(index, 10);
    for (let index = 0; index < failures.length; index += 1) {
      tracker.terminal(index, { atMs: 11 + index, outcome: failures[index]! });
      fixedError(() => tracker.terminal(index, { atMs: 11 + index, outcome: failures[index]! }),
        "runner load tracker rejected");
    }
    expect(tracker.report(14)).toMatchObject({
      scheduled: 4, started: 0, terminal: 4, completed: 0, failed: 4,
      inFlight: 0, activePeak: 0, targetConcurrencyMet: false,
      outcomes: { completed: 0, http_error: 1, protocol_error: 1, deadline: 1, transport_error: 1 },
      startLatencyMs: { p50: null, p95: null, p99: null },
      completionLatencyMs: { p50: 2, p95: 4, p99: 4 },
    });
  });

  it("rejects unscheduled, duplicate, premature, invalid and time-reversed transitions", () => {
    const tracker = load.createRunnerLoadTracker({ turns: 2, concurrency: 2, startedAtMs: 100 });
    fixedError(() => tracker.started(0, 100), "runner load tracker rejected");
    fixedError(() => tracker.terminal(0, { atMs: 100, outcome: "completed" }), "runner load tracker rejected");
    fixedError(() => tracker.terminal(0, { atMs: 100, outcome: "http_error" }),
      "runner load tracker rejected");
    fixedError(() => tracker.schedule(2, 100), "runner load tracker rejected");
    fixedError(() => tracker.schedule(0, 99), "runner load tracker rejected");
    tracker.schedule(0, 100);
    fixedError(() => tracker.schedule(0, 100), "runner load tracker rejected");
    fixedError(() => tracker.terminal(0, { atMs: 100, outcome: "completed" }), "runner load tracker rejected");
    tracker.started(0, 101);
    fixedError(() => tracker.started(0, 101), "runner load tracker rejected");
    fixedError(() => tracker.terminal(0, { atMs: 100, outcome: "completed" }), "runner load tracker rejected");
    fixedError(() => tracker.terminal(0, { atMs: 102, outcome: "sensitive-canary" as Outcome }),
      "runner load tracker rejected");
    tracker.terminal(0, { atMs: 102, outcome: "completed" });
    fixedError(() => tracker.terminal(0, { atMs: 102, outcome: "completed" }), "runner load tracker rejected");
    fixedError(() => tracker.report(101), "runner load tracker rejected");
    expect(tracker.report(102)).toMatchObject({ terminal: 1, completed: 1, activePeak: 1 });
  });

  it("rejects malformed tracker inputs and does not echo caller fields", () => {
    for (const value of [
      { turns: 0, concurrency: 1, startedAtMs: 0 },
      { turns: 2_001, concurrency: 1, startedAtMs: 0 },
      { turns: 1, concurrency: 2, startedAtMs: 0 },
      { turns: 1, concurrency: 1, startedAtMs: -1 },
      { turns: 1, concurrency: 1, startedAtMs: Number.NaN },
      { turns: 1, concurrency: 1, startedAtMs: 0, secret: "sensitive-canary" },
    ]) {
      fixedError(() => load.createRunnerLoadTracker(value), "runner load tracker rejected");
    }
  });
});

describe("runner load bounded SSE decoder", () => {
  it("handles byte-split UTF-8, CRLF and multiline JSON without returning irrelevant frames", () => {
    const decoder = load.createRunnerLoadSseDecoder();
    const wire = bytes(
      ": keep-alive\r\n\r\n"
      + "event: other\r\ndata: sensitive-canary\r\n\r\n"
      + "event: turn/started\r\ndata: {\"label\":\r\ndata: \"你好\"}\r\n\r\n"
      + "event: turn/completed\r\ndata: {\"ok\":true}\r\n\r\n",
    );
    const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
    for (const byte of wire) frames.push(...decoder.feed(Uint8Array.of(byte)));
    frames.push(...decoder.end());
    expect(frames).toEqual([
      { event: "turn/started", data: { label: "你好" } },
      { event: "turn/completed", data: { ok: true } },
    ]);
    expect(JSON.stringify(frames)).not.toContain("sensitive-canary");
  });

  it("dispatches a final relevant frame at EOF and makes end idempotent", () => {
    const decoder = load.createRunnerLoadSseDecoder();
    expect(decoder.feed(bytes("event: turn/started\ndata: {\"ok\":true}"))).toEqual([]);
    expect(decoder.end()).toEqual([{ event: "turn/started", data: { ok: true } }]);
    expect(decoder.end()).toEqual([]);
    fixedError(() => decoder.feed(bytes("event: other\n\n")), "runner load SSE rejected");
  });

  for (const wire of [
    "event: turn/started\ndata: sensitive-canary\n\n",
    "event: turn/completed\ndata: []\n\n",
    "event: turn/completed\ndata: null\n\n",
    "event: turn/started\n\n",
  ]) {
    it("rejects a malformed relevant frame with a fixed content-free error", () => {
      const decoder = load.createRunnerLoadSseDecoder();
      fixedError(() => decoder.feed(bytes(wire)), "runner load SSE rejected");
    });
  }

  it("does not parse unrelated event JSON and never echoes its body", () => {
    const decoder = load.createRunnerLoadSseDecoder();
    expect(decoder.feed(bytes("event: other\ndata: sensitive-canary\n\n"))).toEqual([]);
    expect(decoder.end()).toEqual([]);
  });

  it("rejects invalid UTF-8, oversized lines and oversized multi-line frames", () => {
    fixedError(() => load.createRunnerLoadSseDecoder().feed(Uint8Array.from([
      ...bytes("event: turn/started\ndata: "), 0xc3, 0x28, 10, 10,
    ])), "runner load SSE rejected");
    fixedError(() => load.createRunnerLoadSseDecoder().feed(bytes("data: " + "x".repeat(65_536))),
      "runner load SSE rejected");
    const frame = "event: turn/started\n" + "data: x\n".repeat(8_200);
    fixedError(() => load.createRunnerLoadSseDecoder().feed(bytes(frame)), "runner load SSE rejected");
  });

  it("rejects non-byte input without retaining it", () => {
    const decoder = load.createRunnerLoadSseDecoder();
    fixedError(() => decoder.feed("sensitive-canary" as unknown as Uint8Array), "runner load SSE rejected");
  });
});
