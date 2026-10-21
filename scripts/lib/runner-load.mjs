const ARGUMENT_ERROR = "runner load arguments rejected";
const TRACKER_ERROR = "runner load tracker rejected";
const SSE_ERROR = "runner load SSE rejected";
const MAX_SSE_FRAME_BYTES = 64 * 1024;

const OUTCOMES = Object.freeze([
  "completed",
  "http_error",
  "protocol_error",
  "deadline",
  "transport_error",
]);

function reject(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, minimum, maximum, message) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject(message);
  return value;
}

function canonicalArgumentInteger(value, minimum, maximum) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) reject(ARGUMENT_ERROR);
  return boundedInteger(Number(value), minimum, maximum, ARGUMENT_ERROR);
}

/** Parse only the bounded, content-free local load-driver arguments. */
export function parseRunnerLoadArgs(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    reject(ARGUMENT_ERROR);
  }
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (argv.includes("--help")) reject(ARGUMENT_ERROR);

  const limits = {
    "--turns": [1, 2_000],
    "--concurrency": [1, 1_000],
    "--ttft-ms": [1, 60_000],
    "--deadline-ms": [1_000, 600_000],
  };
  const seen = new Set();
  const values = new Map();
  let providerGateway = false;
  for (let index = 0; index < argv.length;) {
    const flag = argv[index];
    if (flag === "--provider-gateway") {
      if (providerGateway) reject(ARGUMENT_ERROR);
      providerGateway = true; index += 1; continue;
    }
    if (!Object.hasOwn(limits, flag) || seen.has(flag)) reject(ARGUMENT_ERROR);
    seen.add(flag);
    const [minimum, maximum] = limits[flag];
    values.set(flag, canonicalArgumentInteger(argv[index + 1], minimum, maximum));
    index += 2;
  }

  const turns = values.get("--turns") ?? 1_000;
  // A small diagnostic run should not require a second flag solely to cap its default target.
  const concurrency = values.get("--concurrency") ?? Math.min(1_000, turns);
  if (concurrency > turns) reject(ARGUMENT_ERROR);
  return {
    turns,
    concurrency,
    ttftMs: values.get("--ttft-ms") ?? 30_000,
    deadlineMs: values.get("--deadline-ms") ?? 180_000,
    ...(providerGateway ? { providerGateway: true } : {}),
  };
}

/** Closed projection of the real runner registry. Never retain arbitrary labels or metric text. */
export function parseRunnerLoadGatewayMetrics(text) {
  const error = "runner load gateway metrics rejected";
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 256 * 1024) reject(error);
  const outcomes = ["completed", "http_error", "transport_error", "cancelled", "local_abort"];
  const reasons = ["quota_rpm", "quota_concurrency", "quota_unavailable", "breaker_open", "breaker_disabled",
    "breaker_unavailable", "subject_deleting", "cancelled", "local_unavailable"];
  const scopes = Object.fromEntries(["platform", "byok"].map(scope => [scope, {
    attempts: 0, active: 0, completions: Object.fromEntries(outcomes.map(outcome => [outcome, 0])),
    rejections: Object.fromEntries(reasons.map(reason => [reason, 0])), durationCount: 0, durationSum: 0,
  }]));
  const seen = new Set(), histograms = new Map();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || !line.startsWith("agent_service_provider_gateway_")) continue;
    const match = /^agent_service_provider_gateway_([a-z_]+)\{component="runner",scope="(platform|byok)"(?:,(outcome|reason)="([a-z_]+)")?(?:,le="([0-9.]+|\+Inf)")?\} ([0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)$/.exec(line);
    if (!match) reject(error);
    const [, name, scope, label, labelValue, le, raw] = match;
    const identity = line.slice(0, line.lastIndexOf(" "));
    if (seen.has(identity)) reject(error); seen.add(identity);
    const value = Number(raw), series = scopes[scope];
    if (!Number.isFinite(value) || value < 0 || name !== "io_duration_seconds_sum" && !Number.isSafeInteger(value)) reject(error);
    if ((name === "attempts_total" || name === "attempts_in_progress") && !label && !le) {
      series[name === "attempts_total" ? "attempts" : "active"] = value;
    } else if (name === "rejections_total" && label === "reason" && reasons.includes(labelValue) && !le) {
      series.rejections[labelValue] = value;
    } else if (name === "io_completions_total" && label === "outcome" && outcomes.includes(labelValue) && !le) {
      series.completions[labelValue] = value;
    } else if (["io_duration_seconds_bucket", "io_duration_seconds_sum", "io_duration_seconds_count"].includes(name)
      && label === "outcome" && outcomes.includes(labelValue) && (name === "io_duration_seconds_bucket" ? !!le : !le)) {
      const key = `${scope}|${labelValue}`, histogram = histograms.get(key) ?? { buckets: new Map(), count: undefined, sum: undefined };
      if (le) histogram.buckets.set(le, value);
      else histogram[name === "io_duration_seconds_sum" ? "sum" : "count"] = value;
      histograms.set(key, histogram);
    } else reject(error);
  }
  for (const [key, histogram] of histograms) {
    const expectedBounds = ["0.005", "0.01", "0.025", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10", "30", "+Inf"];
    if (histogram.count === undefined || histogram.sum === undefined || histogram.buckets.get("+Inf") !== histogram.count
      || JSON.stringify([...histogram.buckets.keys()]) !== JSON.stringify(expectedBounds)) reject(error);
    let previous = 0, previousBound = -1;
    for (const [bound, value] of histogram.buckets) {
      const numeric = bound === "+Inf" ? Infinity : Number(bound);
      if (!(numeric > previousBound) || value < previous || value > histogram.count) reject(error);
      previousBound = numeric; previous = value;
    }
    const [scope, outcome] = key.split("|");
    if (scopes[scope].completions[outcome] !== histogram.count) reject(error);
    scopes[scope].durationCount += histogram.count; scopes[scope].durationSum += histogram.sum;
  }
  return scopes;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function percentiles(values) {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
}

/** Count actual turn/started-to-terminal overlap, never merely queued HTTP calls. */
export function createRunnerLoadTracker(options) {
  if (!isRecord(options) || Object.keys(options).some((key) => (
    key !== "turns" && key !== "concurrency" && key !== "startedAtMs"
  ))) reject(TRACKER_ERROR);
  const turns = boundedInteger(options.turns, 1, 2_000, TRACKER_ERROR);
  const concurrency = boundedInteger(options.concurrency, 1, Math.min(1_000, turns), TRACKER_ERROR);
  const startedAtMs = boundedInteger(options.startedAtMs, 0, Number.MAX_SAFE_INTEGER, TRACKER_ERROR);
  const states = Array(turns).fill(undefined);
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  const startDelays = [];
  const completionDelays = [];
  let lastAtMs = startedAtMs;
  let scheduled = 0;
  let started = 0;
  let terminal = 0;
  let inFlight = 0;
  let activePeak = 0;

  function checkTime(atMs) {
    boundedInteger(atMs, lastAtMs, Number.MAX_SAFE_INTEGER, TRACKER_ERROR);
    lastAtMs = atMs;
  }

  function stateFor(index) {
    boundedInteger(index, 0, turns - 1, TRACKER_ERROR);
    return states[index];
  }

  return {
    schedule(index, atMs) {
      if (stateFor(index) !== undefined) reject(TRACKER_ERROR);
      checkTime(atMs);
      states[index] = { scheduleAtMs: atMs, phase: "scheduled" };
      scheduled += 1;
    },
    started(index, atMs) {
      const state = stateFor(index);
      if (state?.phase !== "scheduled") reject(TRACKER_ERROR);
      checkTime(atMs);
      state.phase = "started";
      state.startedAtMs = atMs;
      startDelays.push(atMs - state.scheduleAtMs);
      started += 1;
      inFlight += 1;
      activePeak = Math.max(activePeak, inFlight);
    },
    terminal(index, result) {
      const state = stateFor(index);
      if (!isRecord(result) || Object.keys(result).some((key) => key !== "atMs" && key !== "outcome")
          || !OUTCOMES.includes(result.outcome)
          || (state?.phase !== "started" && state?.phase !== "scheduled")
          || (result.outcome === "completed" && state.phase !== "started")) reject(TRACKER_ERROR);
      const { atMs, outcome } = result;
      checkTime(atMs);
      const wasStarted = state.phase === "started";
      state.phase = "terminal";
      completionDelays.push(atMs - state.scheduleAtMs);
      terminal += 1;
      if (wasStarted) inFlight -= 1;
      outcomes[outcome] += 1;
    },
    report(atMs) {
      checkTime(atMs);
      const elapsedMs = atMs - startedAtMs;
      const completed = outcomes.completed;
      return {
        turns,
        concurrency,
        scheduled,
        started,
        terminal,
        completed,
        failed: terminal - completed,
        inFlight,
        activePeak,
        outcomes: { ...outcomes },
        startLatencyMs: percentiles(startDelays),
        completionLatencyMs: percentiles(completionDelays),
        elapsedMs,
        throughputPerSecond: elapsedMs === 0 ? 0 : (completed * 1_000) / elapsedMs,
        targetConcurrencyMet: terminal === turns && completed === turns && activePeak >= concurrency,
      };
    },
  };
}

/**
 * Incremental, bounded SSE parser. It drops SSE id and unrelated frames. Selected JSON data may
 * contain business IDs: callers must inspect it transiently and never put it in tracker reports.
 */
export function createRunnerLoadSseDecoder() {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let lineBytes = [];
  let frameBytes = 0;
  let event;
  let dataLines = [];
  let ended = false;
  let failed = false;

  function fail() {
    failed = true;
    reject(SSE_ERROR);
  }

  function dispatch(frames) {
    const selected = event === "turn/started" || event === "turn/completed";
    const raw = selected ? dataLines.join("\n") : undefined;
    const selectedEvent = event;
    event = undefined;
    dataLines = [];
    frameBytes = 0;
    if (!selected) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      fail();
    }
    if (!isRecord(data)) fail();
    frames.push({ event: selectedEvent, data });
  }

  function processLine(frames) {
    if (lineBytes.at(-1) === 13) lineBytes.pop();
    if (lineBytes.length === 0) {
      dispatch(frames);
      return;
    }
    let line;
    try {
      line = decoder.decode(Uint8Array.from(lineBytes));
    } catch {
      fail();
    } finally {
      lineBytes = [];
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  return {
    feed(bytes) {
      if (ended || failed || !(bytes instanceof Uint8Array)) fail();
      const frames = [];
      for (const byte of bytes) {
        frameBytes += 1;
        if (frameBytes > MAX_SSE_FRAME_BYTES) fail();
        if (byte === 10) {
          processLine(frames);
        } else {
          lineBytes.push(byte);
          if (lineBytes.length > MAX_SSE_FRAME_BYTES) fail();
        }
      }
      return frames;
    },
    end() {
      if (failed) fail();
      if (ended) return [];
      ended = true;
      const frames = [];
      if (lineBytes.length > 0) processLine(frames);
      if (event !== undefined || dataLines.length > 0) dispatch(frames);
      return frames;
    },
  };
}
