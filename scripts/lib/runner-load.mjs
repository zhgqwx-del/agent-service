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
  if (argv.includes("--help") || argv.length % 2 !== 0) reject(ARGUMENT_ERROR);

  const limits = {
    "--turns": [1, 2_000],
    "--concurrency": [1, 1_000],
    "--ttft-ms": [1, 60_000],
    "--deadline-ms": [1_000, 600_000],
  };
  const seen = new Set();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!Object.hasOwn(limits, flag) || seen.has(flag)) reject(ARGUMENT_ERROR);
    seen.add(flag);
    const [minimum, maximum] = limits[flag];
    values.set(flag, canonicalArgumentInteger(argv[index + 1], minimum, maximum));
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
  };
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
