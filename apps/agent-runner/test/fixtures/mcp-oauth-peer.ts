import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import { FakeMcp } from "@agent-service/testkit";

/** Local AS plus a Bearer-checking proxy to the official MCP fixture. Secrets remain in
 * memory; only fixed violation labels/counters may escape into assertion diagnostics. */
export class McpOAuthPeer {
  readonly clientId = "oauth-main-fixture";
  readonly clientSecret = randomBytes(24).toString("base64url");
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
  private readonly codes = new Map<string, { challenge: string; redirect: string }>();
  private readonly tokens = new Set<string>();
  private exchanges = 0;
  private accepted = 0;
  private rejected = 0;
  private metadata = 0;
  constructor(private readonly callbackUrl: string) { this.sensitive.add(this.clientSecret); }
  get issuer(): string { return this.origin; } // Deliberately valid issuer without a trailing '/'.
  get endpoint(): string { return `${this.origin}/mcp`; }
  counts() { return { exchanges: this.exchanges, accepted: this.accepted, rejected: this.rejected, metadata: this.metadata }; }
  containsSensitive(text: string): boolean { return [...this.sensitive].some(value => text.includes(value)); }
  assertHealthy(): void {
    if (this.failures.size) throw new Error(`OAuth main fixture rejected its contract: ${[...this.failures].sort().join(",")}`);
  }
  private require(ok: boolean, label: string): void { if (!ok) { this.failures.add(label); throw new Error("OAuth peer contract rejected"); } }
  private async body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      this.require(size <= 65_536, "request_body_bound"); chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  async start(): Promise<void> {
    this.upstream = await this.mcp.start();
    this.server = createServer((request, response) => {
      const task = (async () => {
        const url = new URL(request.url ?? "/", this.origin);
        if (url.pathname.startsWith("/.well-known/")) {
          this.require(request.method === "GET" && !request.headers.authorization && !request.headers.cookie, "metadata_authority");
          this.metadata++; response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(url.pathname.includes("oauth-protected-resource")
            ? { resource: this.endpoint, authorization_servers: [this.issuer] }
            : { issuer: this.issuer, authorization_endpoint: `${this.origin}/authorize`, token_endpoint: `${this.origin}/token`,
              response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["client_secret_basic"], authorization_response_iss_parameter_supported: true }));
          return;
        }
        if (url.pathname === "/authorize") {
          const q = url.searchParams, allowed = ["response_type", "client_id", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "resource", "state"];
          this.require(request.method === "GET" && !request.headers.authorization && !request.headers.cookie, "browser_authority");
          this.require([...q.keys()].every(key => allowed.includes(key) && q.getAll(key).length === 1), "authorization_parameters");
          this.require(q.get("response_type") === "code" && q.get("client_id") === this.clientId && q.get("redirect_uri") === this.callbackUrl
            && q.get("scope") === "echo" && q.get("resource") === this.endpoint && q.get("code_challenge_method") === "S256"
            && /^[A-Za-z0-9_-]{43}$/.test(q.get("state") ?? "") && /^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") ?? ""), "authorization_binding");
          const code = randomBytes(24).toString("base64url"), state = q.get("state")!;
          this.sensitive.add(code); this.sensitive.add(state);
          this.codes.set(code, { challenge: q.get("code_challenge")!, redirect: this.callbackUrl });
          const callback = new URL(this.callbackUrl); callback.searchParams.set("state", state); callback.searchParams.set("code", code); callback.searchParams.set("iss", this.issuer);
          response.writeHead(302, { location: callback.href, "cache-control": "no-store" }); response.end(); return;
        }
        if (url.pathname === "/token") {
          this.require(request.method === "POST" && !request.headers.cookie, "token_method");
          const basic = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
          this.sensitive.add(basic);
          this.require(request.headers.authorization === basic, "client_authentication");
          const q = new URLSearchParams((await this.body(request)).toString("utf8"));
          this.require([...q.keys()].every(key => q.getAll(key).length === 1), "token_duplicate_parameters");
          const code = q.get("code"), entry = code === null ? undefined : this.codes.get(code), verifier = q.get("code_verifier") ?? "";
          this.sensitive.add(verifier);
          this.require(q.get("grant_type") === "authorization_code" && q.get("client_id") === this.clientId && q.get("resource") === this.endpoint
            && entry !== undefined && q.get("redirect_uri") === entry.redirect && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
            && createHash("sha256").update(verifier).digest("base64url") === entry.challenge, "token_binding");
          this.codes.delete(code!); this.exchanges++;
          const accessToken = randomBytes(32).toString("base64url"), refreshToken = randomBytes(32).toString("base64url");
          this.tokens.add(accessToken); this.sensitive.add(accessToken); this.sensitive.add(refreshToken);
          response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
          response.end(JSON.stringify({ token_type: "Bearer", access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, scope: "echo" })); return;
        }
        if (url.pathname === "/mcp") {
          this.require(request.method === "POST" && !request.headers.cookie, "resource_method");
          this.require(!request.headers.authorization?.startsWith("Basic "), "client_secret_at_resource");
          const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
          if (!bearer || !this.tokens.has(bearer)) { this.rejected++; response.writeHead(401, { "www-authenticate": "Bearer" }); response.end(); return; }
          this.accepted++;
          const body = await this.body(request);
          // Only this exact local resource proxy consumes the bearer. FakeMcp itself deliberately
          // rejects Authorization; neither AS Basic nor resource credentials are forwarded there.
          await new Promise<void>((resolve, reject) => {
            const outgoing = httpRequest(this.upstream, { method: "POST", headers: {
              "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": body.length,
              "mcp-protocol-version": "2026-07-28",
              ...(typeof request.headers["mcp-method"] === "string" ? { "mcp-method": request.headers["mcp-method"] } : {}),
              ...(typeof request.headers["mcp-name"] === "string" ? { "mcp-name": request.headers["mcp-name"] } : {}),
            } }, incoming => {
              response.writeHead(incoming.statusCode ?? 502, incoming.headers);
              void pipeline(incoming, response).then(resolve, reject);
            });
            this.outbound.add(outgoing); outgoing.once("close", () => this.outbound.delete(outgoing));
            outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("OAuth local resource deadline")));
            outgoing.once("error", reject); outgoing.end(body);
          });
          return;
        }
        response.writeHead(404); response.end();
      })().catch(() => { if (!this.closing) this.failures.add("request_failed"); response.destroy(); });
      this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
    });
    this.server.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", () => reject(new Error("OAuth peer listen failed"))); this.server!.listen(0, "127.0.0.1", resolve); });
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.closing = true;
    const closed = this.server?.listening ? new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(new Error("OAuth peer close failed")) : resolve())) : Promise.resolve();
    for (const request of this.outbound) request.destroy();
    for (const socket of this.sockets) socket.destroy();
    await closed; await Promise.all([...this.tasks]); await this.mcp.stop();
  }
}
