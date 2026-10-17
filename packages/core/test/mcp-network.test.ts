import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpHttpFetch, type McpHttpOptions, type McpHttpFetch } from "../src/mcp/http.js";
import { createMcpMetadataFetch, createMcpRegistrationFetch, createMcpResourceFetch, createMcpTokenFetch } from "../src/mcp/network.js";

const servers: Server[] = [], fetches: McpHttpFetch[] = [];
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); });
afterEach(async () => {
  await Promise.all(fetches.splice(0).map(fetch => fetch.close()));
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  vi.unstubAllEnvs();
});
function track(fetch: McpHttpFetch): McpHttpFetch { fetches.push(fetch); return fetch; }
function options(endpoint: string): McpHttpOptions { return { endpoint, maxRequestBytes: 1024, maxResponseBytes: 1024, timeoutMs: 1000,
  allowLoopbackForTests: true, lookup: async () => [{ address: "127.0.0.1", family: 4 }] }; }
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture did not listen.");
  return `http://mcp.fixture.test:${address.port}/purpose`;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("MCP purpose-specific network channels", () => {
  it("metadata GET has no ambient or resource credentials and cannot POST or change destination", async () => {
    let calls = 0;
    const endpoint = await serve((request, response) => { calls++; expect(request.method).toBe("GET"); expect(request.headers.authorization).toBeUndefined(); expect(request.headers.cookie).toBeUndefined(); response.end("{}"); });
    const fetch = track(createMcpMetadataFetch(options(endpoint)));
    expect(await (await fetch(endpoint, { headers: { accept: "application/json" } })).json()).toEqual({});
    await expect(fetch(endpoint, { headers: { authorization: "Bearer fixture-access" } })).rejects.toMatchObject({ code: "header_rejected" });
    await expect(fetch(endpoint, { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "method_rejected" });
    await expect(fetch(endpoint + "/other")).rejects.toMatchObject({ code: "endpoint_mismatch" });
    expect(calls).toBe(1);
  });
  it("token form POST injects AS-only Basic at final send; registration JSON POST remains anonymous", async () => {
    const seen: { authorization?: string; type?: string }[] = [];
    const endpoint = await serve((request, response) => { seen.push({ authorization: request.headers.authorization, type: request.headers["content-type"] }); request.resume(); response.end("{}"); });
    const token = track(createMcpTokenFetch(options(endpoint), { basicCredential: async () => Buffer.from("fixture-client:fixture-material").toString("base64") }));
    await (await token(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&code=fixture" })).text();
    const registration = track(createMcpRegistrationFetch(options(endpoint)));
    await (await registration(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).text();
    expect(seen).toEqual([{ authorization: `Basic ${Buffer.from("fixture-client:fixture-material").toString("base64")}`, type: "application/x-www-form-urlencoded" }, { authorization: undefined, type: "application/json" }]);
    await expect(registration(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-access" }, body: "{}" })).rejects.toMatchObject({ code: "header_rejected" });
  });
  it("resource injects only its own Bearer and leaves the old anonymous contract unchanged", async () => {
    const seen: (string | undefined)[] = [];
    const endpoint = await serve((request, response) => { seen.push(request.headers.authorization); request.resume(); response.end("{}"); });
    const input = { method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28" }, body: "{}" };
    const resource = track(createMcpResourceFetch(options(endpoint), { protocolVersion: "2026-07-28", accessToken: async () => "fixture-resource-access" }));
    await (await resource(endpoint, input)).text();
    const anonymous = track(createMcpHttpFetch(options(endpoint)));
    await (await anonymous(endpoint, input)).text();
    await expect(anonymous(endpoint, { ...input, headers: { ...input.headers, authorization: "Bearer fixture" } })).rejects.toMatchObject({ code: "header_rejected" });
    expect(seen).toEqual(["Bearer fixture-resource-access", undefined]);
  });
  it("permits only explicitly pinned legacy endpoint GET/DELETE, never modern fallback", async () => {
    const seen: string[] = [];
    const endpoint = await serve((request, response) => { seen.push(request.method!); response.end("{}"); });
    const legacy = track(createMcpResourceFetch(options(endpoint), { protocolVersion: "2025-11-25" }));
    await (await legacy(endpoint, { headers: { "mcp-session-id": "fixture-session" } })).text();
    await (await legacy(endpoint, { method: "DELETE", headers: { "mcp-session-id": "fixture-session" } })).text();
    const modern = track(createMcpResourceFetch(options(endpoint), { protocolVersion: "2026-07-28" }));
    await expect(modern(endpoint)).rejects.toMatchObject({ code: "method_rejected" });
    expect(seen).toEqual(["GET", "DELETE"]);
  });
  it("abort/close waits for the actual pending DNS lookup before claiming drained", async () => {
    const started = deferred<void>(), answers = deferred<readonly { address: string; family: 4 }[]>();
    const endpoint = "https://mcp.fixture.test/purpose", abort = new AbortController();
    const fetch = track(createMcpMetadataFetch({ ...options(endpoint), lookup: async () => { started.resolve(); return answers.promise; } }));
    const request = fetch(endpoint, { signal: abort.signal }).catch(error => error);
    await started.promise; abort.abort(); let drained = false;
    const close = fetch.close().then(() => { drained = true; });
    await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
    answers.resolve([{ address: "127.0.0.1", family: 4 }]);
    expect(await request).toMatchObject({ code: "aborted" }); await close; expect(drained).toBe(true);
  });
  it("abort/close also waits for an actual credential read and never sends late credentials", async () => {
    const started = deferred<void>(), secret = deferred<string>(); let calls = 0;
    const endpoint = await serve((_request, response) => { calls++; response.end("{}"); });
    const fetch = track(createMcpResourceFetch(options(endpoint), { protocolVersion: "2026-07-28", accessToken: async () => { started.resolve(); return secret.promise; } }));
    const request = fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(error => error);
    await started.promise; let drained = false; const close = fetch.close().then(() => { drained = true; });
    await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false);
    secret.resolve("fixture-resource-access"); expect(await request).toMatchObject({ code: "aborted" }); await close; expect(calls).toBe(0);
  });
});
