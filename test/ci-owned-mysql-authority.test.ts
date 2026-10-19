import { beforeAll, describe, expect, it, vi } from "vitest";

interface Dependencies {
  openGithubEnv(path: string): Promise<{ append(text: string): Promise<void>; close(): Promise<void> }>;
  inspectContainer(id: string): Promise<unknown>;
  containerUuid(id: string): Promise<unknown>;
  nativeIdentity(input: { host: string; port: number }): Promise<unknown>;
}
interface AuthorityModule {
  attestCiOwnedMysqlAuthority(argv: readonly string[], env: NodeJS.ProcessEnv, dependencies: Dependencies): Promise<void>;
}
let authority: AuthorityModule;
beforeAll(async () => { authority = await import(new URL("../scripts/ci-owned-mysql-authority.mjs", import.meta.url).href) as AuthorityModule; });
const ID = "a".repeat(64), UUID = "01234567-89ab-cdef-0123-456789abcdef", CANARY = "private-native-inspect-env-canary";
function service() {
  return { Id: ID, State: { Running: true }, Config: { Image: "mysql:8.0.26", Env: [`PASSWORD=${CANARY}`] },
    NetworkSettings: { Ports: { "3306/tcp": [{ HostIp: "0.0.0.0", HostPort: "33306" }, { HostIp: "::", HostPort: "33306" }] } } };
}
function fixture() {
  const events: string[] = [], written: string[] = [];
  const state: { inspect: unknown; uuid: unknown; native: unknown } = { inspect: [service()], uuid: UUID + "\n",
    native: { server_uuid: UUID, mandatory_roles: "", external_clients: 0 } };
  const handle = { append: vi.fn(async (text: string) => { events.push("append"); written.push(text); }), close: vi.fn(async () => { events.push("close"); }) };
  const dependencies: Dependencies = {
    openGithubEnv: vi.fn(async () => { events.push("file"); return handle; }),
    inspectContainer: vi.fn(async () => { events.push("inspect"); return state.inspect; }),
    containerUuid: vi.fn(async () => { events.push("exec"); return state.uuid; }),
    nativeIdentity: vi.fn(async () => { events.push("native"); return state.native; }),
  };
  const env: NodeJS.ProcessEnv = { GITHUB_ACTIONS: "true", MYSQL_TEST_SERVICE_CONTAINER_ID: ID,
    MYSQL_TEST_URL: "mysql://root@127.0.0.1:33306/agent_service_test", GITHUB_ENV: "/private/ci-github-env" };
  return { state, events, written, handle, dependencies, env };
}
async function rejected(f: ReturnType<typeof fixture>, argv: readonly string[] = []) {
  const error: unknown = await authority.attestCiOwnedMysqlAuthority(argv, f.env, f.dependencies).then(() => undefined, (failure: unknown) => failure);
  expect(error).toMatchObject({ name: "CiMysqlAuthorityError", code: "mysql_test_authority_unproven",
    message: "Dedicated MySQL test authority could not be established." });
  expect(Object.hasOwn(error as object, "cause")).toBe(false);
  expect(String(error)).not.toContain(CANARY);
  if (f.env.MYSQL_TEST_URL) expect(String(error)).not.toContain(f.env.MYSQL_TEST_URL);
  expect(f.written).toEqual([]);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("CI dedicated MySQL authority guard (pure dependency doubles, not Docker proof)", () => {
  it("requires the container and native observations before appending only the exact nonsecret capability", async () => {
    const f = fixture(); await authority.attestCiOwnedMysqlAuthority([], f.env, f.dependencies);
    expect(f.events).toEqual(["file", "inspect", "exec", "native", "append", "close"]);
    expect(f.dependencies.inspectContainer).toHaveBeenCalledExactlyOnceWith(ID);
    expect(f.dependencies.containerUuid).toHaveBeenCalledExactlyOnceWith(ID);
    expect(f.dependencies.nativeIdentity).toHaveBeenCalledExactlyOnceWith({ host: "127.0.0.1", port: 33306 });
    expect(f.written).toEqual([`MYSQL_TEST_OWNED_SERVER_UUID=${UUID}\nMYSQL_TEST_AUTHORITY_ACK=dedicated-disposable-server-v1\n`]);
    expect(f.written[0]).not.toContain(CANARY); expect(f.written[0]).not.toContain(ID); expect(f.handle.close).toHaveBeenCalledOnce();
    expect(f.env).not.toHaveProperty("MYSQL_TEST_AUTHORITY_ACK");
  });

  it("accepts explicit IPv6 loopback only when the published binding has that family", async () => {
    const f = fixture(); f.env.MYSQL_TEST_URL = "mysql://root@[::1]:33306/agent_service_test_main";
    await authority.attestCiOwnedMysqlAuthority([], f.env, f.dependencies);
    expect(f.dependencies.nativeIdentity).toHaveBeenCalledWith({ host: "::1", port: 33306 });
  });

  it.each([
    { GITHUB_ACTIONS: undefined }, { GITHUB_ACTIONS: "false" }, { GITHUB_ACTIONS: "1" },
    { MYSQL_TEST_SERVICE_CONTAINER_ID: undefined }, { MYSQL_TEST_SERVICE_CONTAINER_ID: "a".repeat(63) }, { MYSQL_TEST_SERVICE_CONTAINER_ID: "A".repeat(64) },
    { GITHUB_ENV: undefined }, { GITHUB_ENV: "" }, { GITHUB_ENV: "relative-file" }, { GITHUB_ENV: "/private/../private/file" }, { GITHUB_ENV: "/private/bad\nfile" },
    { MYSQL_TEST_URL: undefined }, { MYSQL_TEST_URL: "" },
    { MYSQL_TEST_URL: "mysql://root@localhost:33306/agent_service_test" }, { MYSQL_TEST_URL: "mysql://root@10.0.0.1:33306/agent_service_test" },
    { MYSQL_TEST_URL: "mysql://root:secret@127.0.0.1:33306/agent_service_test" }, { MYSQL_TEST_URL: "mysql://other@127.0.0.1:33306/agent_service_test" },
    { MYSQL_TEST_URL: "mysql://root@127.0.0.1/agent_service_test" }, { MYSQL_TEST_URL: "mysql://root@127.0.0.1:65536/agent_service_test" },
    { MYSQL_TEST_URL: "mysql://root@127.0.0.1:33306/agent_service" }, { MYSQL_TEST_URL: "mysql://root@127.0.0.1:33306/mysql" },
    { MYSQL_TEST_URL: "mysql://root@127.0.0.1:33306/agent_service_test?" }, { MYSQL_TEST_URL: "mysql://root@127.0.0.1:33306/agent_service_test#" },
  ])("rejects an invalid declared context before resources: %j", async extra => {
    const f = fixture(); Object.assign(f.env, extra); await rejected(f);
    expect(f.events).toEqual([]);
  });

  it.each(["MYSQL_TEST_AUTHORITY_ACK", "MYSQL_TEST_OWNED_SERVER_UUID"])("rejects provided %s even empty/undefined/hidden", async key => {
    for (const value of [undefined, "", CANARY]) { const f = fixture(); f.env[key] = value; await rejected(f); expect(f.events).toEqual([]); }
    const f = fixture(); Object.defineProperty(f.env, key, { value: CANARY }); await rejected(f); expect(f.events).toEqual([]);
  });

  it("rejects extra argv and authority getters without evaluating them", async () => {
    const f = fixture(); await rejected(f, ["--force"]); expect(f.events).toEqual([]);
    const g = fixture(), getter = vi.fn(() => CANARY); Object.defineProperty(g.env, "MYSQL_TEST_SERVICE_CONTAINER_ID", { enumerable: true, get: getter });
    await rejected(g); expect(getter).not.toHaveBeenCalled(); expect(g.events).toEqual([]);
  });

  it.each([
    (row: ReturnType<typeof service>) => { row.Id = "b".repeat(64); },
    (row: ReturnType<typeof service>) => { row.State.Running = false; },
    (row: ReturnType<typeof service>) => { row.Config.Image = "mysql:8.0"; },
    (row: ReturnType<typeof service>) => { row.NetworkSettings.Ports["3306/tcp"] = []; },
    (row: ReturnType<typeof service>) => { row.NetworkSettings.Ports["3306/tcp"][0]!.HostPort = "3306"; },
    (row: ReturnType<typeof service>) => { row.NetworkSettings.Ports["3306/tcp"] = [{ HostIp: "::", HostPort: "33306" }]; },
  ])("rejects wrong actual Docker state/image/published endpoint", async mutate => {
    const f = fixture(), row = service(); mutate(row); f.state.inspect = [row]; await rejected(f);
    expect(f.dependencies.containerUuid).not.toHaveBeenCalled(); expect(f.dependencies.nativeIdentity).not.toHaveBeenCalled(); expect(f.handle.close).toHaveBeenCalledOnce();
  });

  it.each([{ inspect: [] }, { inspect: [service(), service()] }, { inspect: {} }, { inspect: [null] }])
    ("rejects missing/ambiguous inspect data: %j", async extra => { const f = fixture(); Object.assign(f.state, extra); await rejected(f); });

  it("does not evaluate or report secret inspect Env and refuses a selected-field getter", async () => {
    const f = fixture(), row = service(), secret = vi.fn(() => { throw new Error(CANARY); });
    Object.defineProperty(row.Config, "Env", { enumerable: true, get: secret });
    f.state.inspect = [row]; await authority.attestCiOwnedMysqlAuthority([], f.env, f.dependencies); expect(secret).not.toHaveBeenCalled();
    const g = fixture(), other = service(), getter = vi.fn(() => ID); Object.defineProperty(other, "Id", { enumerable: true, get: getter });
    g.state.inspect = [other]; await rejected(g); expect(getter).not.toHaveBeenCalled();
  });

  it.each([UUID.toUpperCase(), UUID + "\nextra", " " + UUID, UUID + "\n\n", "not-a-uuid", null])
    ("rejects an invalid container socket UUID before host-port proof: %j", async uuid => {
      const f = fixture(); f.state.uuid = uuid; await rejected(f); expect(f.dependencies.nativeIdentity).not.toHaveBeenCalled();
    });

  it.each([
    { server_uuid: "ffffffff-ffff-ffff-ffff-ffffffffffff", mandatory_roles: "", external_clients: 0 },
    { server_uuid: UUID, mandatory_roles: "some_role", external_clients: 0 }, { server_uuid: UUID, mandatory_roles: null, external_clients: 0 },
    { server_uuid: UUID, mandatory_roles: "", external_clients: 1 }, { server_uuid: UUID, mandatory_roles: "", external_clients: "00" },
    { server_uuid: UUID, mandatory_roles: "", external_clients: 0, extra: CANARY },
  ])("refuses a different native server, role state, external client or unclosed result", async native => {
    const f = fixture(); f.state.native = native; await rejected(f); expect(f.handle.close).toHaveBeenCalledOnce();
  });

  it("accepts only the exact native string zero alternative", async () => {
    const f = fixture(); f.state.native = { server_uuid: UUID, mandatory_roles: "", external_clients: "0" };
    await authority.attestCiOwnedMysqlAuthority([], f.env, f.dependencies); expect(f.written).toHaveLength(1);
  });

  it.each(["openGithubEnv", "inspectContainer", "containerUuid", "nativeIdentity"] as const)("maps %s failure to fixed output without granting authority", async name => {
    const f = fixture(); vi.mocked(f.dependencies[name]).mockRejectedValueOnce(new Error(CANARY, { cause: { url: CANARY } }));
    await rejected(f); if (name !== "openGithubEnv") expect(f.handle.close).toHaveBeenCalledOnce();
  });

  it("does not append or return before the native adapter's actual settlement barrier", async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    vi.mocked(f.dependencies.nativeIdentity).mockImplementationOnce(async () => { entered.resolve(); await release.promise; return f.state.native; });
    let settled = false;
    const pending = authority.attestCiOwnedMysqlAuthority([], f.env, f.dependencies).then(() => { settled = true; });
    try { await entered.promise; expect(settled).toBe(false); expect(f.written).toEqual([]); expect(f.handle.close).not.toHaveBeenCalled(); }
    finally { release.resolve(); }
    await pending; expect(settled).toBe(true); expect(f.written).toHaveLength(1);
  });

  it("waits for the environment file close and reports append errors without raw causes", async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.handle.close.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    let settled = false; const pending = authority.attestCiOwnedMysqlAuthority([], f.env, f.dependencies).then(() => { settled = true; });
    try { await entered.promise; expect(settled).toBe(false); } finally { release.resolve(); }
    await pending;
    const g = fixture(); g.handle.append.mockRejectedValueOnce(new Error(CANARY)); await rejected(g); expect(g.handle.close).toHaveBeenCalledOnce();
  });
});
