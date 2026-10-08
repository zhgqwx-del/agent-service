import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  Capabilities,
  INTERNAL_ERASURE_DRAIN_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_ACK_VALUE,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE,
  INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX,
  INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX,
  INTERNAL_TOMBSTONE_ACK_HEADER,
  INTERNAL_TOMBSTONE_ACK_VALUE,
  INTERNAL_TOMBSTONE_PATH_PREFIX,
  INTERNAL_ROUTER_TOKEN_HEADER,
  OPENAPI_DOCUMENT,
  PROTOCOL_VERSION,
  UserErasureDrainRequest,
  isCanonicalId,
} from "@agent-service/protocol";
import type { RunnerRegistry } from "./registry.js";

export interface RouterAppDeps {
  registry: RunnerRegistry;
  /** total attempts per request, including the first (2 = one re-route on 409) */
  maxAttempts?: number;
  /** cap on waiting for the upstream RESPONSE HEADERS; never applied to the body (SSE runs for minutes) */
  upstreamHeaderTimeoutMs?: number;
  /** reject a request body larger than this before forwarding anything */
  maxBodyBytes?: number;
  /** separate raw-binary ceiling for the blob upload route */
  maxBlobBytes?: number;
  /** when set, `/_router/*` requires `Authorization: Bearer <token>`; when unset those routes are off */
  adminToken?: string;
  /** false once draining, so the load balancer stops sending new work */
  ready?: () => boolean;
  /** Explicit deployment activation gate, in addition to the observed fleet capability. */
  tombstoneEnabled?: () => boolean;
  /** Explicit deployment activation gate for new blob writes. Blob reads remain available. */
  blobAttachmentsEnabled?: () => boolean;
  /** Explicit deployment activation gate for the subject-level durable write barrier. */
  erasureRequestsEnabled?: () => boolean;
  /** Shared runner-internal credential. Omission keeps destructive routing disabled. */
  internalRunnerToken?: string;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * `/v1/sessions/{id}/...` — the session id decides the target runner.
 *
 * The segment is captured loosely and then checked for the canonical shape. A case-sensitive pattern
 * here would let `SESS_…` fall through to "no session id", scattering requests for one session across
 * runners while the runner still resolved them to the same row.
 */
const SESSION_PATH = /^\/v1\/sessions\/([^/]+)(\/|$)/;

function sessionIdFrom(pathname: string): string | undefined {
  const raw = SESSION_PATH.exec(pathname)?.[1];
  if (!raw) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return isCanonicalId("sess", id) ? id : undefined;
}

/** Hop-by-hop headers must not be forwarded, and the upstream sets its own content headers. */
const STRIP_REQUEST = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "te", "content-length", INTERNAL_ROUTER_TOKEN_HEADER]);
/** `x-owner` is internal topology: the runner needs it, an external client must not see it. */
const STRIP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "x-owner",
  INTERNAL_TOMBSTONE_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_ACK_HEADER,
  INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER,
]);

/** Methods that are safe to send again after a transport failure, with no risk of doing the work twice. */
const REPLAYABLE = new Set(["GET", "HEAD", "OPTIONS"]);
/** The runner currently implements Idempotency-Key only for this collection POST. */
const IDEMPOTENT_TURN_POST = /^\/v1\/sessions\/[^/]+\/turns\/?$/;
/** Fenced tombstoning is idempotent even when the first 204 was lost in transit. */
const IDEMPOTENT_SESSION_DELETE = /^\/v1\/sessions\/[^/]+\/?$/;
const SESSION_BLOB_UPLOAD = /^\/v1\/sessions\/[^/]+\/blobs\/?$/;
const USER_ERASURE_REQUEST = /^\/v1\/data-erasure-requests\/?$/;
const USER_ERASURE_STATUS = /^\/v1\/data-erasure-requests\/[^/]+\/?$/;
const USER_SCOPED_RUNTIME = /^\/v1\/(?:sessions(?:\/|$)|usage\/?$|data-erasure-requests(?:\/|$))/;
const INTERNAL_ERASURE_BODY_MAX_BYTES = 4_096;

function internalTokenMatches(received: string | undefined, expected: string | undefined): boolean {
  const left = createHash("sha256").update(received ?? "").digest();
  const right = createHash("sha256").update(expected ?? "").digest();
  return received !== undefined && expected !== undefined && timingSafeEqual(left, right);
}

function privateInternalHeaders(c: { header: (name: string, value: string) => void }): void {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
}

function internalNotFound(c: { json: (body: object, status: 404) => Response }): Response {
  return c.json({ error: { code: "not_found", message: "not found" } }, 404);
}

/**
 * agent-router: stateless. It authenticates nothing itself (the runner is the authority) and holds no
 * business state — only the connection while it streams a response through. Its whole job is picking a
 * runner and honouring the runner's 409 + `X-Owner` re-route.
 */
export function createRouterApp(deps: RouterAppDeps) {
  const app = new Hono();
  const log = deps.logger ?? console;
  const maxAttempts = deps.maxAttempts ?? 2;
  const maxBodyBytes = deps.maxBodyBytes ?? 1_000_000;
  const maxBlobBytes = deps.maxBlobBytes ?? 1_000_000;
  const tombstoneAvailable = () => (
    !!deps.internalRunnerToken
    && (deps.tombstoneEnabled?.() ?? false)
    && deps.registry.allHealthySupportLifecycle("tombstone")
  );
  const blobAttachmentsAvailable = () => (
    (deps.blobAttachmentsEnabled?.() ?? false)
    && deps.registry.allHealthySupportBlobAttachments()
  );
  const erasureWriterGateEnabled = () => deps.erasureRequestsEnabled?.() ?? false;
  const erasureRequestsAvailable = () => (
    erasureWriterGateEnabled()
    // Unlike a reversible read, this durable gate must account for unavailable configured writers:
    // an old runner that recovers later could otherwise ignore the already-accepted subject gate.
    && deps.registry.allConfiguredSupportDataErasureRequests()
  );

  app.get("/healthz", (c) => c.text("ok"));
  // Serve the immutable contract locally. Forwarding this endpoint would make API discovery depend
  // on fleet health and could expose a mixed-version runner's document during a rolling upgrade.
  app.get("/openapi.json", (c) => c.json(OPENAPI_DOCUMENT));
  app.get("/readyz", (c) => {
    if (deps.ready && !deps.ready()) return c.text("draining", 503);
    const healthy = deps.registry.list().filter((t) => t.healthy).length;
    return healthy > 0 ? c.text(`ready (${healthy} runners)`) : c.text("no healthy runner", 503);
  });
  app.get("/v1/capabilities", async (c) => {
    // Ask a runner rather than hardcoding: the router must not claim capabilities the fleet lacks.
    const target = deps.registry.anyHealthy();
    if (target) {
      try {
        const res = await fetch(`${target}/v1/capabilities`, { signal: AbortSignal.timeout(2_000) });
        if (res.ok) {
          // A mixed or malformed runner must not make this router violate the contract it serves at
          // /openapi.json. Deployment still drains old runners before promoting the new router.
          const parsed = Capabilities.safeParse(await res.json());
          if (parsed.success) {
            const lifecycle = parsed.data.features.sessionLifecycle.filter(
              (feature) => feature !== "tombstone" || tombstoneAvailable(),
            );
            return c.json({
              ...parsed.data,
              service: "agent-router",
              features: {
                ...parsed.data.features,
                sessionLifecycle: lifecycle,
                blobAttachments: parsed.data.features.blobAttachments && blobAttachmentsAvailable(),
                dataErasureRequests: parsed.data.features.dataErasureRequests && erasureRequestsAvailable(),
                userErasureWorker: deps.internalRunnerToken
                  && deps.registry.allHealthySupportUserErasureWorker()
                  ? ["drain-v1"]
                  : [],
              },
            } satisfies Capabilities);
          }
        }
      } catch {
        /* report unavailable below */
      }
    }
    return c.json({
      error: {
        code: "draining",
        message: `no healthy runner with protocol ${PROTOCOL_VERSION} is available`,
        retryable: true,
      },
    }, 503);
  });

  /**
   * Operational view. Off unless an admin token is configured: it lists every internal runner address
   * and would otherwise let anyone probe whether an arbitrary session id exists.
   */
  app.get("/_router/targets", async (c) => {
    if (!deps.adminToken) return c.json({ error: { code: "not_found", message: "not found" } }, 404);
    if (c.req.header("authorization") !== `Bearer ${deps.adminToken}`) return c.json({ error: { code: "unauthorized", message: "admin token required" } }, 401);
    const sessionId = c.req.query("sessionId");
    const valid = sessionId && isCanonicalId("sess", sessionId) ? sessionId : undefined;
    return c.json({
      runners: deps.registry.list(),
      ...(valid ? { owner: (await deps.registry.owner(valid)) ?? null, candidate: deps.registry.candidate(valid) ?? null } : {}),
    });
  });

  /**
   * Runner-worker to router control plane. The shared credential is checked before the session id
   * or body is parsed, and only the fixed claim envelope is ever forwarded to a configured target.
   */
  app.post(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/:id`, async (c) => {
    privateInternalHeaders(c);
    if (!internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER), deps.internalRunnerToken)) {
      return internalNotFound(c);
    }

    const sessionId = c.req.param("id");
    if (!isCanonicalId("sess", sessionId)) return internalNotFound(c);

    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (declaredLength > INTERNAL_ERASURE_BODY_MAX_BYTES) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const read = await readCapped(c.req.raw.body, INTERNAL_ERASURE_BODY_MAX_BYTES);
    if (!read.ok) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const parsed = UserErasureDrainRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_request", message: "validation failed" } }, 400);
    }
    const body = new TextEncoder().encode(JSON.stringify(parsed.data));
    const upstreamUrl = new URL(c.req.url);
    upstreamUrl.pathname = `${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/${sessionId}`;
    upstreamUrl.search = "";
    const upstreamHeaders = new Headers({
      "content-type": "application/json",
      [INTERNAL_ROUTER_TOKEN_HEADER]: deps.internalRunnerToken!,
    });

    const owner = await deps.registry.owner(sessionId);
    let target = owner ?? deps.registry.candidate(sessionId);
    if (owner && !deps.registry.supportsUserErasureWorker(owner)) {
      return c.json({
        error: { code: "draining", message: "session erasure owner is upgrading", retryable: true },
      }, 503);
    }
    if (!target || !deps.registry.supportsUserErasureWorker(target)) {
      target = deps.registry.list().find((candidate) => (
        candidate.healthy && deps.registry.supportsUserErasureWorker(candidate.url)
      ))?.url;
    }
    if (!target) {
      return c.json({
        error: { code: "draining", message: "no erasure-capable runner is available", retryable: true },
      }, 503);
    }

    const tried = new Set<string>();
    let rerouted = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!deps.registry.supportsUserErasureWorker(target)) {
        return c.json({
          error: { code: "draining", message: "session erasure target is upgrading", retryable: true },
        }, 503);
      }
      tried.add(target);
      let response: Response;
      try {
        response = await forward(
          target,
          upstreamUrl,
          "POST",
          upstreamHeaders,
          body,
          deps.upstreamHeaderTimeoutMs,
        );
      } catch {
        deps.registry.markFailure(target);
        const retry = deps.registry.list().find((candidate) => (
          candidate.healthy
          && !tried.has(candidate.url)
          && deps.registry.supportsUserErasureWorker(candidate.url)
        ))?.url;
        if (!retry || attempt === 1) {
          return c.json({
            error: { code: "draining", message: "session erasure owner is unavailable", retryable: true },
          }, 503);
        }
        target = retry;
        continue;
      }

      if (response.headers.get(INTERNAL_ERASURE_DRAIN_ACK_HEADER) !== INTERNAL_ERASURE_DRAIN_ACK_VALUE) {
        await response.body?.cancel().catch(() => {});
        return c.json({
          error: { code: "draining", message: "runner lacks the erasure drain-v1 contract", retryable: true },
        }, 503);
      }

      if (response.status === 409 && !rerouted && attempt === 0) {
        const localFenced = response.headers.get(INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER)
          === INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE;
        if (localFenced) {
          // While Redis still names any authoritative owner, bypassing this process could overlap
          // provider/tool side effects. Once that lease naturally disappears, retrying the same
          // locally-fenced hash candidate can never make progress, so exclude it exactly once.
          const ownerPresent = await deps.registry.hasLeaseOwner(sessionId);
          if (ownerPresent === false) {
            const retry = deps.registry.list().find((candidate) => (
              candidate.healthy
              && !tried.has(candidate.url)
              && deps.registry.supportsUserErasureWorker(candidate.url)
            ))?.url;
            if (retry) {
              await response.body?.cancel().catch(() => {});
              rerouted = true;
              target = retry;
              continue;
            }
          }
        }
        if (!localFenced) {
          const advertisedOwner = response.headers.get("x-owner");
          const ownerUrl = advertisedOwner ? deps.registry.routeableUrl(advertisedOwner) : undefined;
          if (
            ownerUrl
            && !tried.has(ownerUrl)
            && deps.registry.supportsUserErasureWorker(ownerUrl)
          ) {
            await response.body?.cancel().catch(() => {});
            rerouted = true;
            target = ownerUrl;
            continue;
          }
        }
      }

      const result = streamBack(response);
      result.headers.set(INTERNAL_ERASURE_DRAIN_ACK_HEADER, INTERNAL_ERASURE_DRAIN_ACK_VALUE);
      result.headers.set("Cache-Control", "no-store");
      result.headers.set("X-Content-Type-Options", "nosniff");
      return result;
    }

    return c.json({
      error: { code: "draining", message: "session erasure owner is unavailable", retryable: true },
    }, 503);
  });

  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    if (
      url.pathname === INTERNAL_TOMBSTONE_PATH_PREFIX
      || url.pathname.startsWith(`${INTERNAL_TOMBSTONE_PATH_PREFIX}/`)
      || url.pathname === INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX
      || url.pathname.startsWith(`${INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX}/`)
      || url.pathname === INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX
      || url.pathname.startsWith(`${INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX}/`)
    ) {
      privateInternalHeaders(c);
      return c.json({ error: { code: "not_found", message: "not found" } }, 404);
    }
    const sessionId = sessionIdFrom(url.pathname);
    const method = c.req.method;
    const isTombstoneDelete = method === "DELETE"
      && !!sessionId
      && IDEMPOTENT_SESSION_DELETE.test(url.pathname);
    const isBlobUpload = method === "POST"
      && !!sessionId
      && SESSION_BLOB_UPLOAD.test(url.pathname);
    const isErasureRequest = method === "POST" && USER_ERASURE_REQUEST.test(url.pathname);
    const isErasureStatus = method === "GET" && USER_ERASURE_STATUS.test(url.pathname);
    const requiresErasureCapableTarget = erasureWriterGateEnabled()
      && USER_SCOPED_RUNTIME.test(url.pathname);
    if (isErasureRequest || isErasureStatus) {
      // The same admin credential can act for multiple users, so URI-only caches must never retain
      // either an owned status body or an owner-hiding 404. This also covers router-generated gates.
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
    }

    // The new router is intentionally deployed before new runners. It keeps the rest of the API
    // available during that rollout, but does not activate tombstoning until the healthy fleet is
    // homogeneous. This prevents one session from receiving old direct-delete semantics merely
    // because its owner or hash-ring target has not been upgraded yet.
    if (
      isTombstoneDelete
      && !tombstoneAvailable()
    ) {
      return c.json({
        error: {
          code: "draining",
          message: "session deletion is unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }
    if (isBlobUpload && !blobAttachmentsAvailable()) {
      return c.json({
        error: {
          code: "draining",
          message: "blob uploads are unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }
    if (isErasureRequest && !erasureRequestsAvailable()) {
      return c.json({
        error: {
          code: "draining",
          message: "data erasure requests are unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }
    if (isErasureStatus && !deps.registry.allHealthySupportDataErasureRequests()) {
      return c.json({
        error: {
          code: "draining",
          message: "data erasure request status is unavailable while the runner fleet is upgrading",
          retryable: true,
        },
      }, 503);
    }

    // Buffer the body once (a re-route replays it) but refuse an unbounded upload first: without this the
    // router OOMs before the runner's own body limit is ever consulted.
    let body: Uint8Array | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const requestBodyLimit = isBlobUpload ? maxBlobBytes : maxBodyBytes;
      const declared = Number(c.req.header("content-length") ?? "0");
      if (declared > requestBodyLimit) return c.json({ error: { code: "invalid_request", message: `request body exceeds ${requestBodyLimit} bytes` } }, 400);
      const read = await readCapped(c.req.raw.body, requestBodyLimit);
      if (!read.ok) return c.json({ error: { code: "invalid_request", message: `request body exceeds ${requestBodyLimit} bytes` } }, 400);
      body = read.bytes;
    }

    // Never send a capability-gated destructive request to the legacy public DELETE route. If a
    // configured target is accidentally a load-balancer and chooses an old pod after a new-pod
    // health probe, the versioned path fails closed instead of executing the old delete semantics.
    const upstreamUrl = new URL(url);
    const upstreamMethod = isTombstoneDelete ? "POST" : method;
    if (isTombstoneDelete) upstreamUrl.pathname = `${INTERNAL_TOMBSTONE_PATH_PREFIX}/${sessionId}`;
    const upstreamHeaders = requestHeaders(c.req.raw.headers);
    if (isTombstoneDelete) upstreamHeaders.set(INTERNAL_ROUTER_TOKEN_HEADER, deps.internalRunnerToken!);

    const tried = new Set<string>();
    let target = (sessionId ? await deps.registry.owner(sessionId) : undefined) ?? (sessionId ? deps.registry.candidate(sessionId) : deps.registry.anyHealthy());
    if (!target) return c.json({ error: { code: "draining", message: "no healthy runner available" } }, 503);

    // MAX_ATTEMPTS is the total upstream-send budget, including the initial request and any 409 route.
    let reroutes = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // owner() and every upstream attempt cross an async boundary. Revalidate both the fleet and
      // the selected destination here so a health probe cannot admit an old runner between the
      // entry gate above and the irreversible lifecycle write.
      if (
        isTombstoneDelete
        && (!tombstoneAvailable() || !deps.registry.supportsLifecycle(target, "tombstone"))
      ) {
        return c.json({
          error: {
            code: "draining",
            message: "session deletion is unavailable while the runner fleet is upgrading",
            retryable: true,
          },
        }, 503);
      }
      if (
        isBlobUpload
        && (!blobAttachmentsAvailable() || !deps.registry.supportsBlobAttachments(target))
      ) {
        return c.json({
          error: {
            code: "draining",
            message: "blob uploads are unavailable while the runner fleet is upgrading",
            retryable: true,
          },
        }, 503);
      }
      const targetSupportsErasure = deps.registry.supportsDataErasureRequests(target);
      if (
        (isErasureRequest && (!erasureRequestsAvailable() || !targetSupportsErasure))
        || (isErasureStatus && (
          !deps.registry.allHealthySupportDataErasureRequests() || !targetSupportsErasure
        ))
        || (requiresErasureCapableTarget && !targetSupportsErasure)
      ) {
        return c.json({
          error: {
            code: "draining",
            message: "user-scoped runtime is unavailable while the runner fleet is upgrading",
            retryable: true,
          },
        }, 503);
      }
      tried.add(target);
      let res: Response;
      try {
        res = await forward(target, upstreamUrl, upstreamMethod, upstreamHeaders, body, deps.upstreamHeaderTimeoutMs);
      } catch (err) {
        deps.registry.markFailure(target);
        const name = err instanceof Error ? err.name : "unknown error";
        log.warn(`[router] ${target} unreachable (${name})`);
        // Only this exact POST is deduplicated by the runner. A caller-provided Idempotency-Key on an
        // agent/session/api-key POST does not magically make that endpoint safe to replay.
        const safeToRetry = REPLAYABLE.has(method) ||
          (method === "POST" && !!sessionId && IDEMPOTENT_TURN_POST.test(url.pathname) && !!c.req.header("idempotency-key")?.trim()) ||
          (method === "POST" && isErasureRequest && !!c.req.header("idempotency-key")?.trim()) ||
          (method === "DELETE" && !!sessionId && IDEMPOTENT_SESSION_DELETE.test(url.pathname));
        const next = safeToRetry ? pickOther(deps, sessionId, tried) : undefined;
        if (!next || attempt >= maxAttempts) {
          return c.json({ error: { code: "provider_error", message: "runner unreachable", retryable: safeToRetry } }, 502);
        }
        target = next;
        continue;
      }


      if (isTombstoneDelete && res.headers.get(INTERNAL_TOMBSTONE_ACK_HEADER) !== INTERNAL_TOMBSTONE_ACK_VALUE) {
        await res.body?.cancel().catch(() => {});
        return c.json({
          error: {
            code: "draining",
            message: "session deletion reached a runner without the tombstone-v1 internal contract",
            retryable: true,
          },
        }, 503);
      }

      // The runner tells us who really owns this session; follow it exactly once.
      if (res.status === 409 && sessionId && reroutes < 1 && attempt < maxAttempts) {
        const owner = res.headers.get("x-owner");
        const ownerUrl = owner ? deps.registry.routeableUrl(owner) : undefined;
        if (owner && !ownerUrl) log.warn(`[router] session ${sessionId}: owner "${owner}" is not a configured runner; check RUNNER_ADDR matches RUNNERS`);
        if (ownerUrl && !tried.has(ownerUrl)) {
          log.info(`[router] session ${sessionId}: re-routing to owner ${ownerUrl}`);
          reroutes += 1;
          target = ownerUrl;
          continue;
        }
      }
      const response = streamBack(res);
      if (isErasureRequest || isErasureStatus) {
        // New runners already send these headers. Reassert them at the public edge so a proxying
        // regression or an unexpected upstream error can never make this identity-scoped route cacheable.
        response.headers.set("Cache-Control", "no-store");
        response.headers.set("X-Content-Type-Options", "nosniff");
      }
      return response;
    }
    return c.json({ error: { code: "session_lease_conflict", message: "could not reach the session owner" } }, 409);
  });

  return app;
}

/** Read a body with a hard cap, without buffering more than the cap. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!stream) return { ok: true, bytes: new Uint8Array() };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes: out };
}

function pickOther(deps: RouterAppDeps, sessionId: string | undefined, tried: Set<string>): string | undefined {
  const healthy = deps.registry.list().filter((t) => t.healthy && !tried.has(t.url));
  if (!healthy.length) return undefined;
  if (!sessionId) return healthy[0]!.url;
  const candidate = deps.registry.candidate(sessionId);
  return candidate && !tried.has(candidate) ? candidate : healthy[0]!.url;
}

function requestHeaders(from: Headers): Headers {
  const h = new Headers();
  from.forEach((v, k) => {
    if (!STRIP_REQUEST.has(k.toLowerCase())) h.set(k, v);
  });
  return h;
}

async function forward(target: string, url: URL, method: string, headers: Headers, body: Uint8Array | undefined, headerTimeoutMs?: number): Promise<Response> {
  const dest = `${target}${url.pathname}${url.search}`;
  const controller = headerTimeoutMs ? new AbortController() : undefined;
  let timer: NodeJS.Timeout | undefined;
  if (controller) timer = setTimeout(() => controller.abort(new Error(`upstream did not send headers within ${headerTimeoutMs}ms`)), headerTimeoutMs);
  try {
    // Once fetch resolves the response headers are available. Clear the timer immediately; leaving
    // the controller un-aborted means a long-lived SSE response body can continue indefinitely.
    return await fetch(dest, {
      method,
      headers,
      body: body && body.byteLength ? body : undefined,
      redirect: "manual",
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Pass the upstream response through untouched, including the SSE body as a stream. */
function streamBack(res: Response): Response {
  const headers = new Headers();
  // getSetCookie preserves multiple Set-Cookie values that a plain set() would collapse to one.
  const cookies = res.headers.getSetCookie?.() ?? [];
  res.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (STRIP_RESPONSE.has(key) || key === "set-cookie") return;
    headers.set(k, v);
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  if (headers.get("content-type")?.includes("text/event-stream")) headers.set("X-Accel-Buffering", "no");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
