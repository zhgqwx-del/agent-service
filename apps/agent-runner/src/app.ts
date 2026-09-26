import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  AgentDefinition,
  AgentDefinitionInput,
  ApiError,
  ApprovalResponseRequest,
  CreateApiKeyRequest,
  CreateSessionRequest,
  DynamicToolResultRequest,
  ErrorBody,
  EXCLUDABLE_EVENT_TYPES,
  PROTOCOL_VERSION,
  Pagination,
  isCanonicalId,
  type IdPrefix,
  ProviderConfigInput,
  StartTurnRequest,
  TenantAuthPolicyInput,
  UsageQuery,
  SteerRequest,
  type Capabilities,
  type Event,
} from "@agent-service/protocol";
import type { SessionHost, ToolRegistry } from "@agent-service/core";
import { newId } from "@agent-service/core";
import type { SessionStore } from "@agent-service/store";
import { redactProviderConfig, type ProviderService } from "@agent-service/providers";
import { assertMayActAs, authMiddleware, generateApiKey, hashApiKey, requireAdmin, requireUser, TenantPolicyCache, type AuthEnv } from "./auth.js";
import { needsSecret, validateAuthPolicy } from "./auth-policy.js";
import { sseResponse } from "./sse.js";

export interface AppDeps {
  store: SessionStore;
  host: SessionHost;
  providers: ProviderService;
  tools: ToolRegistry;
  runnerId: string;
  heartbeatMs: number;
  maxBodyBytes: number;
  ready: () => boolean;
  /** decrypts a tenant's stored auth secret (HS256 key / introspection credential) */
  decryptSecret: (secret: { ciphertext: Buffer; keyId: string }) => Promise<string>;
  encryptSecret: (plaintext: string) => Promise<{ ciphertext: Buffer; keyId: string }>;
  fetchImpl?: typeof fetch;
  /** tenant auth policy cache TTL; shorter means faster convergence across runners */
  policyCacheMs?: number;
  /** rejects a tenant-supplied URL that is not a public http(s) endpoint (SSRF guard); injectable for tests */
  assertPublicUrl?: (url: string) => Promise<void>;
}

const parse = async <T extends z.ZodTypeAny>(schema: T, body: unknown): Promise<z.infer<T>> => {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError("invalid_request", "validation failed", r.error.flatten());
  return r.data;
};
const json = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

export function createApp(deps: AppDeps) {
  const app = new Hono<AuthEnv>();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      // agent-router reads this to re-route the request to the current owner (design §4.2).
      const owner = (err.details as { ownerAddr?: string } | undefined)?.ownerAddr;
      if (err.code === "session_lease_conflict" && owner) {
        // The router needs the owner address; an external client must not learn internal topology.
        c.header("X-Owner", owner);
        const body = err.toBody();
        return c.json({ error: { ...body.error, details: undefined } } satisfies ErrorBody, err.status as 400);
      }
      return c.json(err.toBody() satisfies ErrorBody, err.status as 400);
    }
    console.error(err);
    return c.json({ error: { code: "internal_error", message: "internal error" } } satisfies ErrorBody, 500);
  });

  // ---------- unauthenticated ----------
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/readyz", (c) => (deps.ready() ? c.text("ready") : c.text("not ready", 503)));
  app.get("/v1/capabilities", (c) =>
    c.json({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: { streaming: true, replay: { persistedEvents: true, hotWindowMs: 3_600_000 }, approvals: true, dynamicTools: true, mcp: [], skills: false, sandbox: ["none"], byok: true },
    } satisfies Capabilities),
  );

  const v1 = new Hono<AuthEnv>();
  /**
   * Reject any non-canonical id before it reaches the store or the lease.
   * A case variant of a session id used to find the real row (MySQL's default collation is
   * case-insensitive) while hashing to a DIFFERENT Redis lease key — two writers, fencing bypassed.
   */
  v1.use("/sessions/:id/*", validateIdParams);
  v1.use("/sessions/:id", validateIdParams);
  v1.use("/agents/:id", validateIdParams);
  // Reject oversized bodies before they are buffered or parsed.
  v1.use("*", bodyLimit({ maxSize: deps.maxBodyBytes, onError: () => { throw new ApiError("invalid_request", `request body exceeds ${deps.maxBodyBytes} bytes`); } }));
  const policyCache = new TenantPolicyCache(deps.policyCacheMs);
  v1.use("*", authMiddleware({ store: deps.store, decryptSecret: deps.decryptSecret, fetchImpl: deps.fetchImpl, cache: policyCache }));

  // ---------- agents ----------
  v1.post("/agents", async (c) => {
    requireAdmin(c);
    const input = await parse(AgentDefinitionInput, await json(c));
    const def = AgentDefinition.parse({ ...input, id: newId("agt"), tenantId: c.get("tenantId"), version: 1, createdAtMs: Date.now() });
    await deps.store.createAgent(def);
    return c.json(def, 201);
  });
  v1.get("/agents", async (c) => {
    requireAdmin(c);
    const q = await parse(Pagination, c.req.query());
    return c.json(await deps.store.listAgents(c.get("tenantId"), { cursor: q.cursor, limit: q.limit }));
  });
  v1.get("/agents/:id", async (c) => {
    // `instructions` is the system prompt. A runtime key (which may live nearer the edge) must not read it.
    requireAdmin(c);
    const v = c.req.query("version");
    const def = await deps.store.getAgent(c.get("tenantId"), c.req.param("id"), v ? Number(v) : undefined);
    if (!def) throw new ApiError("not_found", "agent not found");
    return c.json(def);
  });
  v1.put("/agents/:id", async (c) => {
    requireAdmin(c);
    const prev = await deps.store.getAgent(c.get("tenantId"), c.req.param("id"));
    if (!prev) throw new ApiError("not_found", "agent not found");
    const input = await parse(AgentDefinitionInput, await json(c));
    const def = AgentDefinition.parse({ ...input, id: prev.id, tenantId: prev.tenantId, version: prev.version + 1, createdAtMs: Date.now() });
    await deps.store.createAgent(def);
    return c.json(def);
  });

  // ---------- providers / models / tools ----------
  v1.get("/providers", async (c) => c.json({ data: (await deps.providers.listVisible(c.get("tenantId"))).map(redactProviderConfig) }));
  v1.put("/providers/:id", async (c) => {
    requireAdmin(c);
    const input = await parse(ProviderConfigInput, { ...((await json(c)) as object), id: c.req.param("id") });
    return c.json(redactProviderConfig(await deps.providers.upsertTenantProvider(c.get("tenantId"), input)));
  });
  v1.delete("/providers/:id", async (c) => {
    requireAdmin(c);
    const ok = await deps.store.deleteProviderConfig(c.get("tenantId"), c.req.param("id"));
    if (!ok) throw new ApiError("not_found", "provider not found");
    return c.body(null, 204);
  });
  v1.get("/models", async (c) => {
    const providers = await deps.providers.listVisible(c.get("tenantId"));
    // models carry no secrets, so no redaction needed here
    return c.json({ data: providers.flatMap((p) => p.models.map((m) => ({ provider: p.id, ...m }))) });
  });
  v1.get("/tools", (c) => c.json({ data: deps.tools.list().map(({ execute: _e, ...t }) => t) }));

  // ---------- api keys ----------
  // A leaked key has to be revocable, and a new environment needs a way to mint its first non-bootstrap
  // key, without anyone reaching into the database.
  v1.get("/tenant/api-keys", async (c) => {
    requireAdmin(c);
    return c.json({ data: await deps.store.listApiKeys(c.get("tenantId")) });
  });
  v1.post("/tenant/api-keys", async (c) => {
    requireAdmin(c);
    const input = await parse(CreateApiKeyRequest, await json(c));
    const existing = await deps.store.listApiKeys(c.get("tenantId"));
    if (existing.some((k) => k.keyId === input.keyId && !k.revokedAtMs)) throw new ApiError("invalid_request", `an active key named "${input.keyId}" already exists`);
    const key = generateApiKey();
    await deps.store.createApiKey(c.get("tenantId"), input.keyId, hashApiKey(key), input.scopes);
    // The only time the secret is ever returned: it is stored as a hash.
    return c.json({ keyId: input.keyId, scopes: input.scopes, key }, 201);
  });
  v1.delete("/tenant/api-keys/:keyId", async (c) => {
    requireAdmin(c);
    const keyId = c.req.param("keyId");
    if (keyId === c.get("apiKeyId")) throw new ApiError("invalid_request", "refusing to revoke the key making this request");
    if (!(await deps.store.revokeApiKey(c.get("tenantId"), keyId))) throw new ApiError("not_found", "no active key with that id");
    return c.body(null, 204);
  });

  // ---------- tenant auth policy ----------
  // Who may set this: the service key itself. A tenant configures how its OWN users are identified.
  v1.get("/tenant/auth", async (c) => {
    requireAdmin(c);
    const t = await deps.store.getTenant(c.get("tenantId"));
    return c.json({ tenantId: c.get("tenantId"), policy: t?.authPolicy ?? { mode: "trusted_caller" }, hasSecret: !!t?.authSecret });
  });
  v1.put("/tenant/auth", async (c) => {
    requireAdmin(c);
    const input = await parse(TenantAuthPolicyInput, await json(c));
    const existing = await deps.store.getTenant(c.get("tenantId"));
    const storedKind = existing?.authPolicy.mode === "end_user_token" ? existing.authPolicy.verifier.kind : undefined;
    await validateAuthPolicy(input, !!existing?.authSecret, deps.assertPublicUrl, storedKind);
    const secret = input.secret ? await deps.encryptSecret(input.secret) : needsSecret(input.policy) ? undefined : null;
    await deps.store.setTenantAuth(c.get("tenantId"), input.policy, secret);
    policyCache.invalidate(c.get("tenantId")); // effective immediately here; other runners within the TTL
    return c.json({ tenantId: c.get("tenantId"), policy: input.policy, hasSecret: !!(secret || (await deps.store.getTenant(c.get("tenantId")))?.authSecret) });
  });

  // ---------- sessions ----------
  v1.post("/sessions", async (c) => {
    const req = await parse(CreateSessionRequest, await json(c));
    const principal = requireUser(c);
    assertMayActAs(c, req.userId);
    return c.json(await deps.host.createSession(principal, req), 201);
  });
  v1.get("/sessions", async (c) => {
    const q = await parse(Pagination.extend({ userId: z.string().optional(), includeArchived: z.coerce.boolean().optional() }), c.req.query());
    // A user-scoped caller sees only its own sessions. Listing across users is an admin operation:
    // without this, a service key with no user identity enumerated the whole tenant.
    const caller = c.get("principal").userId;
    if (!caller) requireAdmin(c);
    else if (q.userId && q.userId !== caller) throw new ApiError("forbidden", "cannot list another user's sessions");
    return c.json(await deps.store.listSessions(c.get("tenantId"), { userId: caller || q.userId, cursor: q.cursor, limit: q.limit, includeArchived: q.includeArchived }));
  });
  v1.get("/sessions/:id", async (c) => c.json(await deps.host.getSession(requireUser(c), c.req.param("id"))));
  v1.delete("/sessions/:id", async (c) => {
    // getSession enforces ownership first: deleting by tenant alone would let one user delete another's.
    const session = await deps.host.getSession(requireUser(c), c.req.param("id"));
    const ok = await deps.store.deleteSession(session.tenantId, session.id);
    if (!ok) throw new ApiError("not_found", "session not found");
    return c.body(null, 204);
  });
  v1.post("/sessions/:id/compact", async (c) => {
    return c.json(await deps.host.compactSession(requireUser(c), c.req.param("id")));
  });
  v1.post("/sessions/:id/archive", async (c) => {
    const session = await deps.host.getSession(requireUser(c), c.req.param("id"));
    if (session.archivedAtMs) return c.json(session);
    const now = Date.now();
    await deps.store.commit({ sessionId: session.id, fence: session.fenceToken, sessionPatch: { archivedAtMs: now } });
    return c.json({ ...session, archivedAtMs: now });
  });
  v1.post("/sessions/:id/resume", async (c) => {
    const session = await deps.host.getSession(requireUser(c), c.req.param("id"));
    const [turns, approvals] = await Promise.all([deps.store.listTurns(session.id, { limit: 20 }), deps.store.listApprovals(session.id, { pendingOnly: true })]);
    return c.json({ session, recentTurns: turns.data, pendingApprovalIds: approvals.map((a) => a.id), lastSeq: session.lastSeq });
  });

  // ---------- turns ----------
  v1.post("/sessions/:id/turns", async (c) => {
    const principal = requireUser(c);
    const sessionId = c.req.param("id");
    const idem = c.req.header("idempotency-key")?.trim();
    if (idem && idem.length > 256) throw new ApiError("invalid_request", "Idempotency-Key must be at most 256 characters");
    // Authorize the session before consulting replay state. Otherwise a same-tenant caller who knows
    // another user's session id and idempotency key can receive that user's completed turn.
    if (idem) await deps.host.getSession(principal, sessionId);
    const req = await parse(StartTurnRequest, await json(c));
    const exclude = parseExclude(c.req.query("exclude"));

    // Preflight runs BEFORE any stream is opened, so busy / lease / draining / provider failures are
    // real HTTP status codes instead of an error event inside a 200 response.
    const begun = await deps.host.beginTurn(principal, sessionId, req, { idempotencyKey: idem });
    if (begun.replayed) {
      c.header("Idempotency-Replayed", "true");
      return c.json({ turn: begun.turn }, 200);
    }

    if (!req.stream) {
      begun.run();
      return c.json({ turn: begun.turn, steered: begun.steered ?? false }, 202);
    }
    // `turn/started` is already persisted, so replaying from seqStart-1 delivers the whole turn.
    // When the input was steered into a running turn, that turn is replayed from its own beginning.
    const afterSeq = begun.turn.seqStart - 1;
    const turnId = begun.turn.id;
    return sseResponse(
      c,
      async (send, close) => {
        // End the stream once OUR turn completed and the session reported idle, so the client's last
        // event is the status it should resume from. Closing on any `idle` would end the stream early
        // (a stale-projection repair can emit one before our turn even starts).
        let completed = false;
        let fallback: NodeJS.Timeout | undefined;
        try {
          return await deps.host.subscribe(principal, sessionId, afterSeq, (e) => {
            send(e);
            if (e.type === "turn/completed" && e.turn.id === turnId) {
              completed = true;
              // The idle status is published right after, but a fenced-out turn never writes it.
              fallback = setTimeout(close, 2_000);
            } else if (completed && e.type === "session/status/changed" && e.status.type === "idle") {
              clearTimeout(fallback);
              close();
            }
          }, { exclude });
        } finally {
          begun.run(); // must run even if attaching failed, or the turn would hold its lease forever
        }
      },
      { heartbeatMs: deps.heartbeatMs },
    );
  });

  v1.get("/sessions/:id/turns", async (c) => {
    await deps.host.getSession(requireUser(c), c.req.param("id"));
    const q = await parse(Pagination, c.req.query());
    return c.json(await deps.store.listTurns(c.req.param("id"), { cursor: q.cursor, limit: q.limit, sortDirection: q.sortDirection }));
  });
  v1.get("/sessions/:id/turns/:turnId", async (c) => {
    await deps.host.getSession(requireUser(c), c.req.param("id"));
    const t = await deps.store.getTurn(c.req.param("id"), c.req.param("turnId"));
    if (!t) throw new ApiError("not_found", "turn not found");
    return c.json(t);
  });
  v1.post("/sessions/:id/turns/:turnId/interrupt", async (c) => c.json(await deps.host.interrupt(requireUser(c), c.req.param("id"), c.req.param("turnId"))));
  v1.post("/sessions/:id/turns/:turnId/steer", async (c) => {
    const req = await parse(SteerRequest, await json(c));
    await deps.host.steer(requireUser(c), c.req.param("id"), c.req.param("turnId"), req);
    return c.json({ ok: true }, 202);
  });
  v1.post("/sessions/:id/turns/:turnId/tool-results", async (c) => {
    await deps.host.getSession(requireUser(c), c.req.param("id"));
    const req = await parse(DynamicToolResultRequest, await json(c));
    await deps.host.submitDynamicToolResultOrThrow(c.req.param("id"), req.toolCallId, { content: req.content, isError: req.isError });
    return c.json({ ok: true }, 202);
  });

  // ---------- usage ----------
  v1.get("/usage", async (c) => {
    const q = await parse(UsageQuery, c.req.query());
    // Same rule as listing sessions: tenant-wide usage (and `groupBy=user`, which enumerates user ids)
    // is an admin view; a user-scoped caller is confined to its own numbers.
    const caller = c.get("principal").userId;
    if (!caller) requireAdmin(c);
    else if (q.userId && q.userId !== caller) throw new ApiError("forbidden", "cannot read another user's usage");
    return c.json(await deps.store.queryUsage(c.get("tenantId"), { ...q, userId: caller || q.userId }));
  });

  // ---------- items / events ----------
  v1.get("/sessions/:id/items", async (c) => {
    await deps.host.getSession(requireUser(c), c.req.param("id"));
    const q = await parse(z.object({ turnId: z.string().optional(), afterSeq: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }), c.req.query());
    return c.json({ data: await deps.store.listItems(c.req.param("id"), { turnId: q.turnId, afterSeq: q.afterSeq, limit: q.limit }) });
  });
  v1.get("/sessions/:id/events", async (c) => {
    const principal = requireUser(c);
    const sessionId = c.req.param("id");
    await deps.host.getSession(principal, sessionId);
    const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? -1);
    const exclude = parseExclude(c.req.query("exclude"));
    return sseResponse(c, (send) => deps.host.subscribe(principal, sessionId, Number.isFinite(after) ? after : -1, send, { exclude }), { heartbeatMs: deps.heartbeatMs });
  });

  // ---------- approvals ----------
  v1.get("/sessions/:id/approvals", async (c) => {
    await deps.host.getSession(requireUser(c), c.req.param("id"));
    return c.json({ data: await deps.store.listApprovals(c.req.param("id"), { pendingOnly: c.req.query("pending") === "true" }) });
  });
  v1.post("/sessions/:id/approvals/:approvalId", async (c) => {
    const req = await parse(ApprovalResponseRequest, await json(c));
    return c.json(await deps.host.resolveApproval(requireUser(c), c.req.param("id"), c.req.param("approvalId"), req.decision));
  });

  app.route("/v1", v1);
  return app;
}

/**
 * Only high-volume, non-terminal event types may be excluded. Excluding e.g. `session/status/changed`
 * would leave a streaming client waiting forever, so an unknown value is a client error.
 */
const ID_PARAMS: [string, IdPrefix][] = [
  ["id", "sess"],
  ["turnId", "turn"],
  ["approvalId", "apr"],
];

const validateIdParams: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const path = c.req.path;
  for (const [param, prefix] of ID_PARAMS) {
    const value = c.req.param(param as never) as string | undefined;
    if (!value) continue;
    // `/agents/:id` reuses the `id` param with a different prefix
    const expected = param === "id" && path.startsWith("/v1/agents") ? "agt" : prefix;
    if (!isCanonicalId(expected as IdPrefix, value)) throw new ApiError("not_found", "not found");
  }
  await next();
};

function parseExclude(q: string | undefined): Set<string> | undefined {
  if (!q) return undefined;
  const wanted = q.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = wanted.filter((t) => !(EXCLUDABLE_EVENT_TYPES as string[]).includes(t));
  if (bad.length) throw new ApiError("invalid_request", `these event types cannot be excluded: ${bad.join(", ")}`, { excludable: EXCLUDABLE_EVENT_TYPES });
  return new Set(wanted);
}
