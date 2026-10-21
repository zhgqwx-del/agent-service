import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import { FakeMcp } from "@agent-service/testkit";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
interface TokenIdentity { authorizationFingerprint: string; tokenFingerprint: string; ordinal: number }
interface RegistrationGate {
  entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; nativeClosed: ReturnType<typeof deferred>;
  handlerSettled: ReturnType<typeof deferred>; responseSettled: ReturnType<typeof deferred>;
  responseTerminal: "finish" | "close" | "discarded" | null; didFinish201: boolean;
}
/** Native loopback AS with independent DCR clients. Only fixed labels/counters leave the peer. */
export class McpDcrPeer {
  readonly mcp = new FakeMcp();
  private origin = "";
  private server?: Server;
  private upstream = "";
  private closing = false;
  private readonly sockets = new Set<Socket>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly outbound = new Set<ReturnType<typeof httpRequest>>();
  private readonly failures = new Set<string>();
  private readonly sensitive = new Set<string>();
  private readonly clients = new Map<string, { method: "none" | "client_secret_basic"; secret: string | null }>();
  private readonly identityKey = randomBytes(32);
  private readonly codes = new Map<string, { challenge: string; redirect: string; clientId: string; authorizationFingerprint: string }>();
  private readonly tokens = new Map<string, TokenIdentity>();
  private readonly refresh = new Map<string, { clientId: string; authorizationFingerprint: string }>();
  private readonly tokenChains = new Map<string, TokenIdentity[]>();
  private readonly resourceTokens: TokenIdentity[] = [];
  private nextGate?: RegistrationGate;
  private readonly releases = new Set<() => void>();
  private loseNext = false;
  private nextLifetime = 3600;
  private registrations = 0;
  private exchanges = 0;
  private refreshes = 0;
  private accepted = 0;
  private rejected = 0;
  private metadata = 0;
  constructor(private readonly callbackUrl: string) {}
  get issuer(): string { return this.origin; }
  get endpoint(): string { return `${this.origin}/mcp`; }
  counts() { return { registrations: this.registrations, clients: this.clients.size, exchanges: this.exchanges,
    refreshes: this.refreshes, accepted: this.accepted, rejected: this.rejected, metadata: this.metadata }; }
  containsSensitive(text: string): boolean { return [...this.sensitive].some(value => text.includes(value)); }
  /** Opaque independent oracle: no raw state, code, token or AS client secret is returned. */
  tokenIdentityForState(state: string) {
    const authorizationFingerprint = createHmac("sha256", this.identityKey).update("dcr-peer-authorization-v1\0").update(state).digest("hex");
    return { authorizationFingerprint, tokens: (this.tokenChains.get(authorizationFingerprint) ?? []).map(value => ({ ...value })) };
  }
  resourceTokenIdentities() { return this.resourceTokens.map(value => ({ ...value })); }
  assertHealthy(): void { if (this.failures.size) throw new Error(`DCR peer rejected: ${[...this.failures].sort().join(",")}`); }
  holdNextRegistration() {
    if (this.nextGate) throw new Error("DCR peer already holds one registration");
    const held: RegistrationGate = { entered: deferred(), release: deferred(), nativeClosed: deferred(), handlerSettled: deferred(),
      responseSettled: deferred(), responseTerminal: null, didFinish201: false }; this.nextGate = held; this.releases.add(held.release.resolve);
    return { entered: held.entered.promise, release: held.release.resolve, nativeClosed: held.nativeClosed.promise,
      handlerSettled: held.handlerSettled.promise, responseSettled: held.responseSettled.promise,
      responseTerminal: () => held.responseTerminal, response201WasFinished: () => held.didFinish201,
      discardUnentered: () => { if (this.nextGate !== held) return false;
        this.nextGate = undefined; this.releases.delete(held.release.resolve); held.release.resolve();
        // No native response existed. Settle only the response observer with an
        // explicit discarded label; do not fabricate a socket-close or finish.
        held.responseTerminal = "discarded"; held.responseSettled.resolve(); return true; } };
  }
  loseNextRegistrationResponse(): void { this.loseNext = true; }
  setNextTokenLifetimeSeconds(seconds: number): void {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("DCR peer lifetime invalid"); this.nextLifetime = seconds;
  }
  private require(ok: boolean, label: string): void { if (!ok) { this.failures.add(label); throw new Error("DCR peer contract rejected"); } }
  private async body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; this.require(size <= 65_536, "body_bound"); chunks.push(bytes); }
    return Buffer.concat(chunks);
  }
  async start(): Promise<void> {
    this.upstream = await this.mcp.start();
    this.server = createServer((request, response) => {
      let heldRegistration: RegistrationGate | undefined;
      const task = (async () => {
        const url = new URL(request.url ?? "/", this.origin);
        if (url.pathname.startsWith("/.well-known/")) {
          this.require(request.method === "GET" && !request.headers.authorization && !request.headers.cookie, "metadata_authority"); this.metadata++;
          response.setHeader("content-type", "application/json"); response.end(JSON.stringify(url.pathname.includes("oauth-protected-resource")
            ? { resource: this.endpoint, authorization_servers: [this.issuer] }
            : { issuer: this.issuer, authorization_endpoint: `${this.origin}/authorize`, token_endpoint: `${this.origin}/token`, registration_endpoint: `${this.origin}/register`,
              response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
              authorization_response_iss_parameter_supported: true })); return;
        }
        if (url.pathname === "/register") {
          this.require(request.method === "POST" && !request.headers.authorization && !request.headers.cookie, "registration_anonymous");
          const value: unknown = JSON.parse((await this.body(request)).toString("utf8"));
          this.require(!!value && typeof value === "object" && !Array.isArray(value), "registration_object");
          const input = value as Record<string, unknown>, fields = ["redirect_uris", "token_endpoint_auth_method", "grant_types", "response_types", "client_name", "scope"];
          this.require(Object.keys(input).length === fields.length && Object.keys(input).every(key => fields.includes(key)), "registration_closed");
          this.require(JSON.stringify(input.redirect_uris) === JSON.stringify([this.callbackUrl]) && input.scope === "echo" && input.client_name === "agent-service MCP"
            && JSON.stringify(input.grant_types) === '["authorization_code","refresh_token"]' && JSON.stringify(input.response_types) === '["code"]'
            && (input.token_endpoint_auth_method === "none" || input.token_endpoint_auth_method === "client_secret_basic"), "registration_binding");
          this.registrations++;
          const clientId = `dcr-native-client-${this.registrations}`, method = input.token_endpoint_auth_method as "none" | "client_secret_basic";
          const secret = method === "none" ? null : randomBytes(24).toString("base64url");
          if (secret) this.sensitive.add(secret); this.clients.set(clientId, { method, secret });
          const held = this.nextGate; this.nextGate = undefined;
          if (held) {
            heldRegistration = held;
            // Install terminal observers before entered/release: a real caller
            // abort can close this response while the handler remains held.
            const settleResponse = (terminal: "finish" | "close") => {
              if (held.responseTerminal !== null) return;
              held.responseTerminal = terminal; held.responseSettled.resolve();
            };
            response.once("finish", () => { held.didFinish201 = response.statusCode === 201; settleResponse("finish"); });
            response.once("close", () => settleResponse("close"));
            request.socket.once("close", () => { held.nativeClosed.resolve(); settleResponse("close"); });
            if (request.socket.closed) { held.nativeClosed.resolve(); settleResponse("close"); }
            else if (response.closed) settleResponse("close");
            held.entered.resolve(); await held.release.promise; this.releases.delete(held.release.resolve);
          }
          if (this.loseNext) { this.loseNext = false; response.destroy(); return; }
          response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ ...input, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000),
            ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) })); return;
        }
        if (url.pathname === "/authorize") {
          const q = url.searchParams, allowed = ["response_type", "client_id", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "resource", "state"];
          this.require(request.method === "GET" && !request.headers.authorization && !request.headers.cookie, "browser_authority");
          this.require([...q.keys()].every(key => allowed.includes(key) && q.getAll(key).length === 1), "authorization_parameters");
          const clientId = q.get("client_id") ?? "";
          this.require(q.get("response_type") === "code" && this.clients.has(clientId) && q.get("redirect_uri") === this.callbackUrl && q.get("scope") === "echo"
            && q.get("resource") === this.endpoint && q.get("code_challenge_method") === "S256" && /^[A-Za-z0-9_-]{43}$/.test(q.get("state") ?? "")
            && /^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? ""), "authorization_binding");
          const code = randomBytes(24).toString("base64url"), state = q.get("state")!; this.sensitive.add(code); this.sensitive.add(state);
          this.codes.set(code, { challenge: q.get("code_challenge")!, redirect: this.callbackUrl, clientId,
            authorizationFingerprint: this.tokenIdentityForState(state).authorizationFingerprint });
          const callback = new URL(this.callbackUrl); callback.searchParams.set("state", state); callback.searchParams.set("code", code); callback.searchParams.set("iss", this.issuer);
          response.writeHead(302, { location: callback.href, "cache-control": "no-store" }); response.end(); return;
        }
        if (url.pathname === "/token") {
          this.require(request.method === "POST" && !request.headers.cookie, "token_method");
          const q = new URLSearchParams((await this.body(request)).toString("utf8")), clientId = q.get("client_id") ?? "", client = this.clients.get(clientId);
          this.require([...q.keys()].every(key => q.getAll(key).length === 1) && client !== undefined && q.get("resource") === this.endpoint, "token_parameters");
          const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
          const basic = client!.secret === null ? undefined : `Basic ${Buffer.from(`${encode(clientId)}:${encode(client!.secret!)}`).toString("base64")}`;
          if (basic) this.sensitive.add(basic);
          this.require(request.headers.authorization === basic, "client_authentication");
          let authorizationFingerprint: string;
          if (q.get("grant_type") === "refresh_token") {
            const token = q.get("refresh_token") ?? "", entry = this.refresh.get(token);
            this.require(entry?.clientId === clientId, "refresh_binding"); authorizationFingerprint = entry!.authorizationFingerprint; this.refresh.delete(token); this.refreshes++;
          } else {
            const code = q.get("code") ?? "", entry = this.codes.get(code), verifier = q.get("code_verifier") ?? ""; this.sensitive.add(verifier);
            this.require(q.get("grant_type") === "authorization_code" && entry !== undefined && entry.clientId === clientId && q.get("redirect_uri") === entry.redirect
              && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && createHash("sha256").update(verifier).digest("base64url") === entry.challenge, "token_binding");
            authorizationFingerprint = entry!.authorizationFingerprint; this.codes.delete(code); this.exchanges++;
          }
          const accessToken = randomBytes(32).toString("base64url"), refreshToken = randomBytes(32).toString("base64url"), expires = this.nextLifetime; this.nextLifetime = 3600;
          const chain = this.tokenChains.get(authorizationFingerprint) ?? [], identity = { authorizationFingerprint,
            tokenFingerprint: createHmac("sha256", this.identityKey).update("dcr-peer-token-v1\0").update(accessToken).digest("hex"), ordinal: chain.length + 1 };
          chain.push(identity); this.tokenChains.set(authorizationFingerprint, chain); this.tokens.set(accessToken, identity);
          this.refresh.set(refreshToken, { clientId, authorizationFingerprint }); this.sensitive.add(accessToken); this.sensitive.add(refreshToken);
          response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
          response.end(JSON.stringify({ token_type: "Bearer", access_token: accessToken, refresh_token: refreshToken, expires_in: expires, scope: "echo" })); return;
        }
        if (url.pathname === "/mcp") {
          this.require(request.method === "POST" && !request.headers.cookie && !request.headers.authorization?.startsWith("Basic "), "resource_authority");
          const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
          const identity = bearer === undefined ? undefined : this.tokens.get(bearer);
          if (!identity) { this.rejected++; response.writeHead(401); response.end(); return; }
          this.resourceTokens.push({ ...identity }); this.accepted++; const body = await this.body(request);
          await new Promise<void>((resolve, reject) => {
            const outgoing = httpRequest(this.upstream, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": body.length,
              "mcp-protocol-version": "2026-07-28", ...(typeof request.headers["mcp-method"] === "string" ? { "mcp-method": request.headers["mcp-method"] } : {}),
              ...(typeof request.headers["mcp-name"] === "string" ? { "mcp-name": request.headers["mcp-name"] } : {}) } }, incoming => {
              response.writeHead(incoming.statusCode ?? 502, incoming.headers); void pipeline(incoming, response).then(resolve, reject);
            });
            this.outbound.add(outgoing); outgoing.once("close", () => this.outbound.delete(outgoing));
            outgoing.setTimeout(5000, () => outgoing.destroy(new Error("DCR proxy deadline"))); outgoing.once("error", reject); outgoing.end(body);
          }); return;
        }
        response.writeHead(404); response.end();
      })().catch(() => { if (!this.closing) this.failures.add("request_failed"); response.destroy(); })
        .finally(() => { heldRegistration?.handlerSettled.resolve(); });
      this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
    });
    this.server.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", () => reject(new Error("DCR peer listen failed"))); this.server!.listen(0, "127.0.0.1", resolve); });
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.closing = true; for (const release of this.releases) release(); this.releases.clear();
    const closed = this.server?.listening ? new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(new Error("DCR peer close failed")) : resolve())) : Promise.resolve();
    for (const request of this.outbound) request.destroy(); for (const socket of this.sockets) socket.destroy();
    await closed; await Promise.all([...this.tasks]); await this.mcp.stop(); this.identityKey.fill(0);
  }
}
