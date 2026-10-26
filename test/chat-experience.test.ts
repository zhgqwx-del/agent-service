import { beforeAll, describe, expect, it, vi } from "vitest";

type ComponentState = "ready" | "stopped" | "unknown";
type Component = { id: string; name: string; state: ComponentState };
type Operation = { id: string; action: string; state: string; phase: string; message: string; startedAt: string;
  finishedAt?: string; error: string | null };
type Status = { enabled: true; checkedAt: string; overall: string; components: Component[];
  actions: { id: string; enabled: boolean; reason?: string }[]; operation: Operation | null };
type Input = { action: string; idempotencyKey: string };
type Controller = { status(): Promise<Status>; act(input: Input): Promise<{ operation: Operation }> };
type StartupOptions = { controller: Controller; recordAction?: (...args: unknown[]) => Promise<void>;
  recordPhase?: (...args: unknown[]) => Promise<void>; pause?: (milliseconds: number) => Promise<unknown>;
  pollIntervalMs?: number; timeoutMs?: number; shouldCancel?: () => boolean };
let launcher: { validateLaunchConfig(value: unknown): unknown; safeExperienceCode(error: unknown): string; ensureServicesReady(controller: Controller,
  options?: Omit<StartupOptions, "controller" | "recordPhase">): Promise<Status> };
let runtime: { runExperienceStartup(options: StartupOptions & { startH5(): Promise<unknown> }): Promise<{ h5: unknown; status: Status }> };

beforeAll(async () => {
  launcher = await import(new URL("../scripts/ops/chat-experience.mjs", import.meta.url).href) as typeof launcher;
  runtime = await import(new URL("../scripts/ops/chat-experience-runtime.mjs", import.meta.url).href) as typeof runtime;
});

const ACTIONS = ["start-services", "stop-services", "restart-services", "start-infrastructure", "stop-infrastructure", "restart-infrastructure"];
const ROLES = ["router", "runner"], INFRASTRUCTURE = ["mysql", "redis"], ALL = ["owner", ...ROLES, ...INFRASTRUCTURE];
const NOW = "2026-10-26T12:00:00.000Z";
const OLD_ID = "00000000-0000-4000-8000-000000000001";
const pause = async () => {};

function fixture(initial: Partial<Record<string, ComponentState>> = {}) {
  const components = ALL.map(id => ({ id, name: id, state: initial[id] ?? (id === "owner" ? "ready" : "stopped") } as Component));
  const events: string[] = [], calls: Input[] = [];
  const f = { components, events, calls, operation: null as Operation | null, remainingPolls: 0,
    failure: null as "failed" | "unknown" | null, returnWrongId: false, controller: {} as Controller,
    recordAction: vi.fn(async (...args: unknown[]) => {
      const value = args[0];
      const action = value as { action?: string; state?: string } | undefined;
      if (action?.state === "intent") events.push(`intent:${action.action}`);
    }),
    snapshot(): Status {
      const ready = (names: string[]) => names.every(id => components.find(row => row.id === id)?.state === "ready");
      const stopped = (names: string[]) => names.every(id => components.find(row => row.id === id)?.state === "stopped");
      const unknown = components.some(row => row.state === "unknown");
      return { enabled: true, checkedAt: NOW, overall: unknown ? "unknown" : ready(ALL) ? "ready" : stopped([...ROLES, ...INFRASTRUCTURE]) ? "stopped" : "partial",
        components: structuredClone(components), operation: structuredClone(f.operation),
        actions: ACTIONS.map(id => ({ id, enabled: !unknown && (id === "start-infrastructure" ? stopped(ROLES) && !ready(INFRASTRUCTURE)
          : id === "start-services" ? ready(INFRASTRUCTURE) && !ready(ROLES) : false) })) };
    },
  };
  f.controller = {
    async status() {
      if (f.operation?.state === "running" && f.remainingPolls-- <= 0) {
        if (f.failure) f.operation = { ...f.operation, state: f.failure, phase: "retained", error: "fixture_retained", finishedAt: NOW };
        else {
          const selected = f.operation.action === "start-infrastructure" ? INFRASTRUCTURE : ROLES;
          for (const row of components) if (selected.includes(row.id)) row.state = "ready";
          f.operation = { ...f.operation, state: "succeeded", phase: "completed", finishedAt: NOW };
          events.push(`ready:${f.operation.action}`);
        }
      }
      const snapshot = f.snapshot();
      if (f.returnWrongId && snapshot.operation) snapshot.operation.id = OLD_ID;
      return snapshot;
    },
    async act(input) {
      calls.push(structuredClone(input)); events.push(`dispatch:${input.action}`);
      f.operation = { id: input.idempotencyKey, action: input.action, state: "running", phase: "fixture", message: "fixture", startedAt: NOW, error: null };
      f.remainingPolls = 1;
      return { operation: structuredClone(f.operation) };
    },
  };
  return f;
}

describe("manual chat experience startup orchestration", () => {
  it("records and executes database startup before roles and opens H5 only when all components are ready", async () => {
    const f = fixture(), h5 = { url: "http://127.0.0.1:58655/", fixture: true };
    const startH5 = vi.fn(async () => { expect(f.snapshot().overall).toBe("ready"); f.events.push("h5"); return h5; });
    const result = await runtime.runExperienceStartup({ controller: f.controller, startH5, recordAction: f.recordAction, pause,
      pollIntervalMs: 1, timeoutMs: 10_000 });
    expect(result.h5).toBe(h5); expect(result.status.overall).toBe("ready");
    expect(f.calls.map(row => row.action)).toEqual(["start-infrastructure", "start-services"]);
    expect(f.events).toEqual(["intent:start-infrastructure", "dispatch:start-infrastructure", "ready:start-infrastructure",
      "intent:start-services", "dispatch:start-services", "ready:start-services", "h5"]);
    expect(new Set(f.calls.map(row => row.idempotencyKey)).size).toBe(2);
    for (const row of f.calls) expect(row.idempotencyKey).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(startH5).toHaveBeenCalledOnce();
  });

  it("reuses an entirely ready environment without invoking any lifecycle action", async () => {
    const f = fixture(Object.fromEntries(ALL.map(id => [id, "ready"])));
    const status = await launcher.ensureServicesReady(f.controller, { recordAction: f.recordAction, pause });
    expect(status.overall).toBe("ready"); expect(f.calls).toEqual([]); expect(f.recordAction).not.toHaveBeenCalled();
  });

  it("starts only missing services when the retained databases are already ready", async () => {
    const f = fixture({ mysql: "ready", redis: "ready", runner: "ready" });
    expect((await launcher.ensureServicesReady(f.controller, { recordAction: f.recordAction, pause })).overall).toBe("ready");
    expect(f.calls.map(row => row.action)).toEqual(["start-services"]);
    expect(f.components.find(row => row.id === "runner")?.state).toBe("ready");
  });

  it.each(["owner", "router", "mysql"])("refuses an unknown %s identity before dispatching or opening H5", async id => {
    const f = fixture({ [id]: "unknown" }), startH5 = vi.fn(async () => ({}));
    await expect(runtime.runExperienceStartup({ controller: f.controller, startH5, pause })).rejects.toThrow();
    expect(f.calls).toEqual([]); expect(startH5).not.toHaveBeenCalled();
  });

  it.each(["running", "unknown", "failed"])("retains a prior %s operation and performs no automatic recovery action", async state => {
    const f = fixture(), startH5 = vi.fn(async () => ({}));
    f.operation = { id: OLD_ID, action: "stop-infrastructure", state, phase: "retained", message: "retained", startedAt: NOW, error: null };
    // No simulated completion of a pre-existing operation: it belongs to an earlier invocation.
    const controller = { ...f.controller, status: async () => f.snapshot() };
    await expect(runtime.runExperienceStartup({ controller, startH5, pause })).rejects.toThrow();
    expect(f.calls).toEqual([]); expect(f.operation.state).toBe(state); expect(startH5).not.toHaveBeenCalled();
  });

  it.each(["failed", "unknown"] as const)("does not replay or advance when an accepted startup operation becomes %s", async outcome => {
    const f = fixture(), startH5 = vi.fn(async () => ({})); f.failure = outcome;
    await expect(runtime.runExperienceStartup({ controller: f.controller, startH5, recordAction: f.recordAction, pause })).rejects.toThrow();
    expect(f.calls.map(row => row.action)).toEqual(["start-infrastructure"]);
    expect(f.operation?.state).toBe(outcome); expect(startH5).not.toHaveBeenCalled();
  });

  it("does not interpret an unrelated operation result as completion of its accepted action", async () => {
    const f = fixture(), startH5 = vi.fn(async () => ({})); f.returnWrongId = true;
    await expect(runtime.runExperienceStartup({ controller: f.controller, startH5, pause, pollIntervalMs: 1, timeoutMs: 30 })).rejects.toThrow();
    expect(f.calls.map(row => row.action)).toEqual(["start-infrastructure"]); expect(startH5).not.toHaveBeenCalled();
  });

  it("does not dispatch an action whose durable intent could not be recorded", async () => {
    const f = fixture(), startH5 = vi.fn(async () => ({}));
    await expect(runtime.runExperienceStartup({ controller: f.controller, startH5, pause,
      recordAction: async () => { throw new Error("fixture intent write unavailable"); } })).rejects.toThrow();
    expect(f.calls).toEqual([]); expect(startH5).not.toHaveBeenCalled();
  });

  it("retains one dispatched action when its acceptance is lost and never submits a second key", async () => {
    const f = fixture(), startH5 = vi.fn(async () => ({}));
    const controller = { ...f.controller, async act(input: Input) {
      await f.controller.act(input); throw new Error("fixture connection ended after action dispatch");
    } };
    await expect(runtime.runExperienceStartup({ controller, startH5, recordAction: f.recordAction, pause })).rejects.toThrow();
    expect(f.calls.map(row => row.action)).toEqual(["start-infrastructure"]);
    expect(f.recordAction.mock.calls.map(args => (args[0] as { state: string }).state)).toEqual(["intent"]);
    expect(startH5).not.toHaveBeenCalled();
  });

  it("retains a timed-out running action and never proceeds to roles or H5", async () => {
    const f = fixture(), startH5 = vi.fn(async () => ({}));
    const controller = { ...f.controller, status: async () => f.snapshot() };
    await expect(runtime.runExperienceStartup({ controller, startH5, recordAction: f.recordAction,
      pause: milliseconds => new Promise(done => setTimeout(done, milliseconds)), pollIntervalMs: 1, timeoutMs: 10 }))
      .rejects.toThrow("chat_experience_action_timeout_retained");
    expect(f.calls.map(row => row.action)).toEqual(["start-infrastructure"]);
    expect(f.recordAction.mock.calls.map(args => (args[0] as { state: string }).state)).toEqual(["intent"]);
    expect(f.operation?.state).toBe("running"); expect(startH5).not.toHaveBeenCalled();
  });

  it("rejects an unavailable startup capability instead of retrying or changing the requested action", async () => {
    const f = fixture(), controller = { ...f.controller, status: async () => ({ ...f.snapshot(), actions: [] }) };
    await expect(launcher.ensureServicesReady(controller, { pause })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it("cancels before the first accepted action without starting services or H5", async () => {
    const f = fixture(), startH5 = vi.fn(async () => ({}));
    await expect(runtime.runExperienceStartup({ controller: f.controller, startH5, pause, shouldCancel: () => true }))
      .rejects.toThrow("chat_experience_start_cancelled_retained");
    expect(f.calls).toEqual([]); expect(startH5).not.toHaveBeenCalled();
  });

  it("settles the exact accepted operation after cancellation and dispatches no subsequent action", async () => {
    const f = fixture(), startH5 = vi.fn(async () => ({})); let cancelled = false;
    const controller = { ...f.controller, async act(input: Input) {
      const result = await f.controller.act(input); cancelled = true; return result;
    } };
    await expect(runtime.runExperienceStartup({ controller, startH5, pause, shouldCancel: () => cancelled }))
      .rejects.toThrow("chat_experience_start_cancelled_retained");
    expect(f.calls.map(row => row.action)).toEqual(["start-infrastructure"]);
    expect(f.operation?.state).toBe("succeeded"); expect(startH5).not.toHaveBeenCalled();
  });
});

describe("manual chat experience launch configuration boundary", () => {
  function configuration() {
    return { schema: "chat-experience-launch-v1", profilePath: "/private/tmp/fixture/profile.json",
      clientConfigPath: "/private/tmp/fixture/client.json", initialControlConfigPath: "/private/tmp/fixture/control.json",
      stateDirectory: "/private/tmp/fixture/launcher", port: 58655, controlParentDirectory: "/private/tmp" };
  }

  it("accepts an explicit existing-environment selection without resolving it from ambient configuration", () => {
    const selected = configuration();
    expect(launcher.validateLaunchConfig(selected)).toBe(selected);
  });

  it.each([
    ["unknown schema", { schema: "new-environment-with-initialization-v1" }],
    ["relative profile", { profilePath: "./profile.json" }],
    ["noncanonical path", { clientConfigPath: "/private/tmp/fixture/../client.json" }],
    ["control characters", { initialControlConfigPath: "/private/tmp/fixture/control\n.json" }],
    ["coincident profiles", { profilePath: "/private/tmp/fixture/client.json" }],
    ["state replacing config", { stateDirectory: "/private/tmp/fixture/client.json" }],
    ["noncanonical control directory", { controlParentDirectory: "/private/tmp/../tmp" }],
    ["overlong control directory", { controlParentDirectory: `/private/tmp/${"x".repeat(100)}` }],
    ["ephemeral requested port", { port: 0 }],
    ["out-of-range port", { port: 65536 }],
    ["noninteger port", { port: 58655.5 }],
    ["string port", { port: "58655" }],
    ["boot override", { bootId: "fixture-boot-override" }],
    ["initialization option", { initialize: true }],
  ] as const)("rejects %s before any environment operation", (_name, changed) => {
    expect(() => launcher.validateLaunchConfig({ ...configuration(), ...changed })).toThrow("chat_experience_config_invalid");
  });

  it("rejects missing fields, arrays and null rather than filling values from .env", () => {
    const selected: Record<string, unknown> = configuration(); delete selected.initialControlConfigPath;
    for (const value of [selected, [], null, "profile.json"]) expect(() => launcher.validateLaunchConfig(value)).toThrow("chat_experience_config_invalid");
  });

  it("redacts unknown diagnostic content to a fixed launcher error", () => {
    expect(launcher.safeExperienceCode(new Error("fixture DSN and provider credentials must never be copied"))).toBe("chat_experience_start_failed_retained");
    expect(launcher.safeExperienceCode(new Error("chat_experience_port_in_use"))).toBe("chat_experience_port_in_use");
  });
});
