import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_FIXTURE_REPLIES, EXPERIENCE_FIXTURE_TOKEN, parseExperienceFixtureArgs,
  startExperienceFixture, type ExperienceFixtureDescriptor } from "../scripts/ops/experience-fixture.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "scripts/ops/experience-fixture.ts");
async function privateParent() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "agent-http-experience-fixture-"));
  await chmod(directory, 0o700); return directory;
}
function modelBody(stream = true) {
  return JSON.stringify({ model: "deepseek-chat", stream, messages: [{ role: "user", content: "synthetic fixture input" }] });
}
function call(descriptor: ExperienceFixtureDescriptor, stream = true) {
  return fetch(`${descriptor.baseUrl}/chat/completions`, { method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${descriptor.apiKey}`, "content-type": "application/json" }, body: modelBody(stream) });
}
function streamedText(body: string) {
  const frames = body.split("\n\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] });
  return frames.flatMap(frame => frame.choices ?? []).map(choice => choice.delta?.content ?? "").join("");
}
async function until(check: () => boolean) {
  const end = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > end) throw new Error("fixture native boundary not reached");
    await new Promise<void>(done => setTimeout(done, 1));
  }
}

function childFixture(stateDir: string, signal: AbortSignal) {
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, "--state-dir", stateDir], {
    cwd: ROOT, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, NODE_ENV: "test",
      API_BASE_URL: "https://unused.invalid", API_KEY: "AMBIENT_FIXTURE_CANARY", MYSQL_URL: "mysql://unused.invalid/unused",
      REDIS_URL: "redis://unused.invalid/0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = []; let output = "", stderr = "";
  let ready!: (value: Record<string, unknown>) => void, fail!: (error: Error) => void;
  const started = new Promise<Record<string, unknown>>((done, reject) => { ready = done; fail = reject; });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (output.length > 8 * 1_024) { fail(new Error("fixture output exceeded bound")); child.kill("SIGKILL"); return; }
    try {
      const parsed = output.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
      lines.splice(0, lines.length, ...parsed);
      const entry = lines.find(line => line.status === "ready"); if (entry) ready(entry);
    } catch { /* A pipe chunk may end inside the one small JSON line. */ }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 8 * 1_024) { fail(new Error("fixture stderr exceeded bound")); child.kill("SIGKILL"); }
  });
  child.once("error", fail);
  const kill = () => { child.kill("SIGKILL"); };
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  const closed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("close", (status, stopSignal) => {
      signal.removeEventListener("abort", kill); fail(new Error("fixture closed before readiness")); done({ status, signal: stopSignal });
    });
  });
  return { child, started, closed, lines, output: () => output, stderr: () => stderr };
}

describe("explicit unpaid HTTP experience fixture", () => {
  it("accepts only the exact new absolute state-directory argument shape", () => {
    expect(parseExperienceFixtureArgs(["--state-dir", "/private/example/new-state"])).toEqual({ stateDir: "/private/example/new-state", maxResponses: 3 });
    for (let max = 3; max <= 30; max += 3) expect(parseExperienceFixtureArgs(["--state-dir", "/private/example/new-state", "--max-responses", String(max)]))
      .toEqual({ stateDir: "/private/example/new-state", maxResponses: max });
    for (const args of [[], ["--help"], ["--state-dir", "relative"], ["--state-dir", "/private/../state"],
      ["--state-dir", "/private/state", "--api-key", "anything"], ["--url", "https://unused.invalid"],
      ["--state-dir", "/private/state", "--state-dir", "/private/other"],
      ...["0", "1", "4", "33", "03", "3.0", "-3", "Infinity"].map(value => ["--state-dir", "/private/state", "--max-responses", value])]) {
      expect(() => parseExperienceFixtureArgs(args)).toThrow("experience_fixture_invalid");
    }
  });

  it("uses only an explicitly bounded multiple of three for the separate retained manual environment", async () => {
    const parent = await privateParent(); let fixture: Awaited<ReturnType<typeof startExperienceFixture>> | undefined;
    try {
      fixture = await startExperienceFixture(join(parent, "manual-state"), 6);
      expect(fixture.descriptor.maxResponses).toBe(6);
      expect(JSON.parse(await readFile(fixture.descriptorPath, "utf8"))).toMatchObject({ maxResponses: 6 });
      for (let index = 0; index < 6; index++) {
        const response = await call(fixture.descriptor, false); expect(response.status).toBe(200);
        expect((await response.json() as { choices: { message: { content: string } }[] }).choices[0]!.message.content)
          .toBe(EXPERIENCE_FIXTURE_REPLIES[index % 3]);
      }
      const exhausted = await call(fixture.descriptor); expect(exhausted.status).toBe(429); await exhausted.text();
      expect(fixture.snapshot()).toMatchObject({ acceptedRequests: 6, capturedRequests: 0 });
    } finally { await fixture?.close(); await rm(parent, { recursive: true, force: true }); }
  });

  it("serves the three bounded scripted replies over real HTTP and refuses a fourth without capturing inputs", async () => {
    const parent = await privateParent(), stateDir = join(parent, "state");
    let fixture: Awaited<ReturnType<typeof startExperienceFixture>> | undefined;
    try {
      fixture = await startExperienceFixture(stateDir);
      const descriptor = JSON.parse(await readFile(fixture.descriptorPath, "utf8")) as ExperienceFixtureDescriptor;
      expect(descriptor).toMatchObject({ version: 1, kind: "http-experience-fixture-v1", provider: "deepseek", model: "deepseek-chat",
        apiKey: EXPERIENCE_FIXTURE_TOKEN, maxResponses: 3, notice: "Scripted fixture replies do not demonstrate model understanding." });
      expect(descriptor.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/v1$/);
      expect((await lstat(stateDir)).mode & 0o7777).toBe(0o700);
      expect((await lstat(fixture.descriptorPath)).mode & 0o7777).toBe(0o600);
      for (const [index, reply] of EXPERIENCE_FIXTURE_REPLIES.entries()) {
        const response = await call(descriptor, index !== 1); expect(response.status).toBe(200);
        if (index === 1) {
          const value = await response.json() as { choices: { message: { content: string } }[]; usage: unknown };
          expect(value.choices[0]!.message.content).toBe(reply);
          expect(value.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 5, prompt_cache_hit_tokens: 0 });
        } else {
          const text = await response.text(); expect(streamedText(text)).toBe(reply); expect(text).toContain("data: [DONE]\n\n");
        }
      }
      const extra = await call(descriptor); expect(extra.status).toBe(429);
      expect(await extra.json()).toMatchObject({ error: { code: "fixture_budget_exhausted" } });
      expect(fixture.snapshot()).toMatchObject({ acceptedRequests: 3, capturedRequests: 0 });
      await fixture.close(); await fixture.close();
      expect(fixture.snapshot()).toMatchObject({ activeRequests: 0, sockets: 0, pendingTasks: 0 });
      expect(JSON.parse(await readFile(fixture.descriptorPath, "utf8"))).toEqual(descriptor);
    } finally { await fixture?.close(); await rm(parent, { recursive: true, force: true }); }
  });

  it("rejects credentials, arbitrary routes, oversized bodies and other models without spending a response slot", async () => {
    const parent = await privateParent(); let fixture: Awaited<ReturnType<typeof startExperienceFixture>> | undefined;
    try {
      fixture = await startExperienceFixture(join(parent, "state")); const url = `${fixture.descriptor.baseUrl}/chat/completions`;
      const headers = { authorization: `Bearer ${EXPERIENCE_FIXTURE_TOKEN}`, "content-type": "application/json" };
      const denied = await fetch(url, { method: "POST", headers: { ...headers, authorization: "Bearer arbitrary-token" }, body: modelBody() });
      expect(denied.status).toBe(401); await denied.text();
      const route = await fetch(`${fixture.descriptor.baseUrl}/other`); expect(route.status).toBe(404); await route.text();
      const model = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "other", messages: [{}] }) });
      expect(model.status).toBe(400); await model.text();
      const huge = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "deepseek-chat", messages: ["x".repeat(70 * 1_024)] }) });
      expect(huge.status).toBe(413); await huge.text();
      expect(fixture.snapshot().acceptedRequests).toBe(0);
      const first = await call(fixture.descriptor, false); expect(first.status).toBe(200);
      expect((await first.json() as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe(EXPERIENCE_FIXTURE_REPLIES[0]);
    } finally { await fixture?.close(); await rm(parent, { recursive: true, force: true }); }
  });

  it("settles an interrupted streaming client and consumes its slot without replaying it", async () => {
    const parent = await privateParent(); let fixture: Awaited<ReturnType<typeof startExperienceFixture>> | undefined;
    try {
      fixture = await startExperienceFixture(join(parent, "state"));
      const response = await call(fixture.descriptor), reader = response.body!.getReader();
      expect(response.status).toBe(200); expect((await reader.read()).done).toBe(false); await reader.cancel();
      await until(() => fixture!.snapshot().activeRequests === 0 && fixture!.snapshot().pendingTasks === 0);
      expect(fixture.snapshot()).toMatchObject({ acceptedRequests: 1, abortedResponses: 1, capturedRequests: 0 });
      const next = await call(fixture.descriptor, false);
      expect((await next.json() as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe(EXPERIENCE_FIXTURE_REPLIES[1]);
      await fixture.close(); expect(fixture.snapshot()).toMatchObject({ sockets: 0, activeRequests: 0, pendingTasks: 0 });
    } finally { await fixture?.close(); await rm(parent, { recursive: true, force: true }); }
  });

  it("bounds idle native sockets as well as HTTP handlers and joins them on close", async () => {
    const parent = await privateParent(), clients: Socket[] = [], closed: Promise<void>[] = [];
    let fixture: Awaited<ReturnType<typeof startExperienceFixture>> | undefined;
    try {
      fixture = await startExperienceFixture(join(parent, "state"));
      const port = Number(new URL(fixture.descriptor.baseUrl).port);
      for (let index = 0; index < 8; index++) {
        const client = createConnection({ host: "127.0.0.1", port }); clients.push(client);
        client.on("error", () => {}); closed.push(new Promise<void>(done => client.once("close", () => done())));
        await new Promise<void>((done, fail) => { client.once("connect", done); client.once("error", fail); });
      }
      await until(() => fixture!.snapshot().sockets === 8);
      const extra = createConnection({ host: "127.0.0.1", port }); clients.push(extra);
      extra.on("error", () => {}); const extraClosed = new Promise<void>(done => extra.once("close", () => done())); closed.push(extraClosed);
      await extraClosed;
      expect(fixture.snapshot()).toMatchObject({ sockets: 8, activeRequests: 0, pendingTasks: 0, acceptedRequests: 0 });
      await fixture.close(); await Promise.all(closed);
      expect(fixture.snapshot()).toMatchObject({ sockets: 0, activeRequests: 0, pendingTasks: 0 });
    } finally {
      for (const client of clients) client.destroy();
      await fixture?.close(); await Promise.all(closed); await rm(parent, { recursive: true, force: true });
    }
  });

  for (const stopSignal of ["SIGTERM", "SIGINT"] as const) {
    it(`joins a real pending HTTP body and native sockets before ${stopSignal} exits, preserving state`, async context => {
      const parent = await privateParent(), stateDir = join(parent, "state"), worker = childFixture(stateDir, context.signal);
      let pending: ReturnType<typeof request> | undefined;
      let nativeRequestClosed: Promise<void> | undefined;
      try {
        const ready = await worker.started; expect(ready).toEqual({ status: "ready", descriptorPath: join(stateDir, "fixture.json") });
        const descriptor = JSON.parse(await readFile(join(stateDir, "fixture.json"), "utf8")) as ExperienceFixtureDescriptor;
        // Node's real 100 Continue confirms the server accepted this request; its body remains pending.
        pending = request(`${descriptor.baseUrl}/chat/completions`, { method: "POST", headers: {
          authorization: `Bearer ${descriptor.apiKey}`, "content-type": "application/json", "content-length": 1_000, expect: "100-continue" } });
        pending.on("error", () => {});
        nativeRequestClosed = new Promise<void>(done => pending!.once("close", done));
        const continued = new Promise<void>((done, fail) => { pending!.once("continue", done); pending!.once("error", fail); });
        pending.flushHeaders(); await continued;
        expect(worker.child.kill(stopSignal)).toBe(true);
        expect(await worker.closed).toEqual({ status: 0, signal: null }); await nativeRequestClosed;
        expect(worker.lines.at(-1)).toMatchObject({ status: "closed", descriptorPath: join(stateDir, "fixture.json"),
          activeRequests: 0, sockets: 0, pendingTasks: 0, capturedRequests: 0 });
        expect(worker.lines).toHaveLength(2); expect(worker.stderr()).toBe("");
        expect(worker.output()).not.toContain("AMBIENT_FIXTURE_CANARY");
        for (const text of EXPERIENCE_FIXTURE_REPLIES) expect(worker.output()).not.toContain(text);
        expect(JSON.parse(await readFile(join(stateDir, "fixture.json"), "utf8"))).toEqual(descriptor);
      } finally {
        pending?.destroy();
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
        await worker.closed; await nativeRequestClosed; await rm(parent, { recursive: true, force: true });
      }
    });
  }

  it("never reuses or overwrites an existing state directory or descriptor", async () => {
    const parent = await privateParent(), stateDir = join(parent, "state");
    try {
      await mkdir(stateDir, { mode: 0o700 }); await writeFile(join(stateDir, "fixture.json"), "original witness\n", { mode: 0o600 });
      await expect(startExperienceFixture(stateDir)).rejects.toThrow();
      expect(await readFile(join(stateDir, "fixture.json"), "utf8")).toBe("original witness\n");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("rejects public parent permissions and symlink parent/state paths before serving", async () => {
    const parent = await privateParent(), linked = await privateParent();
    try {
      await chmod(parent, 0o755);
      await expect(startExperienceFixture(join(parent, "public-state"))).rejects.toThrow("experience_fixture_invalid");
      await chmod(parent, 0o700);
      await symlink(parent, join(linked, "parent-alias"));
      await expect(startExperienceFixture(join(linked, "parent-alias", "new-state"))).rejects.toThrow("experience_fixture_invalid");
      await symlink(linked, join(parent, "state-alias"));
      await expect(startExperienceFixture(join(parent, "state-alias"))).rejects.toThrow();
      await expect(lstat(join(parent, "public-state"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(parent, "new-state"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await chmod(parent, 0o700); await rm(parent, { recursive: true, force: true }); await rm(linked, { recursive: true, force: true }); }
  });
});
