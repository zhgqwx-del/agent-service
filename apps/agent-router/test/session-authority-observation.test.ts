import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_SESSION_AUTHORITY_OWNER_PATH,
  INTERNAL_SESSION_AUTHORITY_ACK_HEADER, INTERNAL_SESSION_AUTHORITY_ACK_VALUE } from "@agent-service/protocol";
import { observeSessionAuthorityTarget } from "../src/session-authority-observation.js";
import { RunnerRegistry } from "../src/registry.js";

const sid = "sess_00000000-0000-7000-8000-000000000001", nonce = "a".repeat(64), token = "private-fixture-router-token";
const identity = { protocol: "mysql-live-session-v1", backend: "mysql", namespaceSha256: "b".repeat(64) };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { const failed = (await Promise.allSettled(cleanups.splice(0).reverse().map(close => close()))).find(row => row.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function endpoint(reply: (req: IncomingMessage, res: ServerResponse, body: { sessionId: string; nonce: string }) => void) {
  const sockets = new Set<Socket>(), closes = new Set<Promise<void>>(); let calls = 0;
  const server = createServer((req, res) => { let body = ""; req.setEncoding("utf8");
    req.on("error", () => {}); res.on("error", () => {});
    req.on("data", chunk => { body += chunk; }); req.once("end", () => { calls++; reply(req, res, JSON.parse(body)); }); });
  server.on("connection", socket => { sockets.add(socket); const closed = new Promise<void>(done => socket.once("close", () => { sockets.delete(socket); done(); }));
    closes.add(closed); void closed.then(() => closes.delete(closed)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture_address");
  const url = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { const closed = new Promise<void>((resolve, reject) => server.close(failure => failure ? reject(failure) : resolve()));
    for (const socket of sockets) socket.destroy(); await closed; while (closes.size) await Promise.all([...closes]); });
  return { url, sockets, calls: () => calls, async joined() { while (closes.size) await Promise.all([...closes]); } };
}
function write(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json", [INTERNAL_SESSION_AUTHORITY_ACK_HEADER]: INTERNAL_SESSION_AUTHORITY_ACK_VALUE });
  const encoded = JSON.stringify(body); res.write(encoded.slice(0, 12)); res.end(encoded.slice(12));
}
function registry(runners: string[]) { const value = new RunnerRegistry({ runners, internalRouterToken: token, healthTimeoutMs: 1000 }); cleanups.push(() => value.close()); return value; }

describe("fresh private session authority observation", () => {
  it("binds chunked native HTTP to the exact session/nonce/token and joins the actual socket", async () => {
    const target = await endpoint((req, res, body) => {
      expect(req.url).toBe(INTERNAL_SESSION_AUTHORITY_OWNER_PATH); expect(req.headers[INTERNAL_ROUTER_TOKEN_HEADER]).toBe(token);
      write(res, { ...body, identity, owner: null });
    });
    expect((await observeSessionAuthorityTarget(target.url, sid, nonce, token, new AbortController().signal)).owner).toBeNull();
    await target.joined(); expect(target.sockets.size).toBe(0); expect(target.calls()).toBe(1);
  });
  it("treats different native authority namespaces and mixed owner samples as unknown", async () => {
    let different = true, mixed = false;
    const first = await endpoint((_req, res, body) => write(res, { ...body, identity, owner: null }));
    const second = await endpoint((_req, res, body) => write(res, { ...body,
      identity: { ...identity, namespaceSha256: different ? "c".repeat(64) : identity.namespaceSha256 },
      owner: mixed ? { ownerId: "r", ownerAddr: first.url, fence: 1, observedAtDbMs: 1, expiresAtDbMs: 10, authority: identity.protocol } : null }));
    const fleet = registry([first.url, second.url]); expect(await fleet.hasLeaseOwner(sid)).toBeUndefined();
    different = false; mixed = true; expect(await fleet.hasLeaseOwner(sid)).toBeUndefined();
    mixed = false; expect(await fleet.hasLeaseOwner(sid)).toBe(false);
  });
  it("requires the complete configured fleet and does not interpret an unavailable target as absence", async () => {
    const good = await endpoint((_req, res, body) => write(res, { ...body, identity, owner: null }));
    const bad = await endpoint((_req, res) => { res.writeHead(503); res.end(); });
    expect(await registry([good.url, bad.url]).hasLeaseOwner(sid)).toBeUndefined();
    expect(await registry([good.url]).hasLeaseOwner(sid)).toBe(false);
  });
  it("rejects separate Memory authorities across runners while permitting a single local store", async () => {
    const memory = { protocol: "memory-live-session-v1", backend: "memory", namespaceSha256: "d".repeat(64) };
    const a = await endpoint((_req, res, body) => write(res, { ...body, identity: memory, owner: null }));
    const b = await endpoint((_req, res, body) => write(res, { ...body, identity: memory, owner: null }));
    expect(await registry([a.url, b.url]).hasLeaseOwner(sid)).toBeUndefined(); expect(await registry([a.url]).hasLeaseOwner(sid)).toBe(false);
  });
  it("does not follow redirects or accept a mismatched nonce as an authority observation", async () => {
    let redirect = true;
    const target = await endpoint((_req, res, body) => { if (redirect) { res.writeHead(302, { location: "/other" }); res.end(); }
      else write(res, { ...body, nonce: "e".repeat(64), identity, owner: null }); });
    await expect(observeSessionAuthorityTarget(target.url, sid, nonce, token, new AbortController().signal)).rejects.toThrow("authority_observation_unavailable");
    expect(target.calls()).toBe(1); redirect = false;
    await expect(observeSessionAuthorityTarget(target.url, sid, nonce, token, new AbortController().signal)).rejects.toThrow("authority_observation_unavailable");
    await target.joined(); expect(target.sockets.size).toBe(0);
  });
  it("cancels a partial native response and registry close joins its owned observation", async () => {
    const received = deferred<void>(); const target = await endpoint((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", [INTERNAL_SESSION_AUTHORITY_ACK_HEADER]: INTERNAL_SESSION_AUTHORITY_ACK_VALUE });
      res.write('{"nonce":'); received.resolve();
    });
    const fleet = registry([target.url]), pending = fleet.hasLeaseOwner(sid);
    await Promise.race([received.promise, pending.then(() => { throw Error("observation_finished_before_partial_response"); })]);
    await fleet.close(); expect(await pending).toBeUndefined(); await target.joined(); expect(target.sockets.size).toBe(0);
  });
});
