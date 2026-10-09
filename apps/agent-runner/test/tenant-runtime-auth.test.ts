import { SignJWT, generateKeyPair, type KeyObject } from "jose";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { TenantAuthPolicy } from "@agent-service/protocol";
import { MemorySessionStore, SubjectDeletingError, type TenantRecord } from "@agent-service/store";
import {
  TenantRuntimeCoordinator,
  TenantRuntimeDrainTimeoutError,
} from "@agent-service/core";
import { TenantPolicyCache, authMiddleware, hashApiKey, type AuthEnv } from "../src/auth.js";
import {
  IntrospectionEndUserVerifier,
  JwtEndUserVerifier,
  type EndUserVerifier,
} from "../src/end-user-auth.js";

const drainIdentity = (tenantId: string) => ({
  requestId: `ter_${tenantId}`,
  tenantId,
  subjectGeneration: 1,
  t3aReceiptSha256: "12".repeat(32),
});

describe("tenant runtime auth drain", () => {
  it("holds the auth operation through streaming response body lifetime and cancels it on drain", async () => {
    const runtime = new TenantRuntimeCoordinator();
    const store = new MemorySessionStore();
    await store.createApiKey("t_stream", "key-1", hashApiKey("service-key"), ["runtime"]);
    let bodyCancelled = false;
    const app = new Hono<AuthEnv>();
    app.use("*", authMiddleware({
      store,
      tenantRuntime: runtime,
      decryptSecret: async () => "unused",
    }));
    app.get("/stream", () => new Response(new ReadableStream({
      pull: () => new Promise<void>(() => {}),
      cancel: () => { bodyCancelled = true; },
    })));
    runtime.sealParticipants();

    const response = await app.request("/stream", { headers: { authorization: "Bearer service-key" } });
    expect(response.status).toBe(200);
    expect(runtime.snapshot("t_stream")).toMatchObject({ policyEntries: 1, authOperations: 1 });
    const result = await runtime.drain(drainIdentity("t_stream"), 1_000);
    expect(bodyCancelled).toBe(true);
    expect(result).toMatchObject({
      cacheEntryCountBefore: 1,
      cacheEntryCountAfter: 0,
      activeOperationCountBefore: 1,
      activeOperationCountAfter: 0,
    });
  });

  it("accounts a concurrent verifier build and disposes it instead of resurrecting the cache", async () => {
    const runtime = new TenantRuntimeCoordinator();
    const cache = new TenantPolicyCache(10_000, runtime);
    const policy: TenantAuthPolicy = {
      mode: "end_user_token",
      tokenHeader: "x-end-user-token",
      verifier: { kind: "jwt", hs256: true, algorithms: ["HS256"], subjectClaim: "sub", clockToleranceSec: 0 },
    };
    const record: TenantRecord = {
      tenantId: "t_build",
      authPolicy: policy,
      authSecret: { ciphertext: Buffer.from("ciphertext"), keyId: "local" },
      createdAtMs: 1,
    };
    let releaseBuild!: (verifier: EndUserVerifier) => void;
    const blockedBuild = new Promise<EndUserVerifier>((resolve) => { releaseBuild = resolve; });
    let buildStarted!: () => void;
    const started = new Promise<void>((resolve) => { buildStarted = resolve; });
    const get = cache.get(
      record.tenantId,
      async () => record,
      async () => { buildStarted(); return blockedBuild; },
    );
    await started;
    runtime.sealParticipants();

    const verifier: EndUserVerifier = {
      verify: async () => ({ userId: "u" }),
      dispose: vi.fn(),
    };
    const drain = runtime.drain(drainIdentity(record.tenantId), 1_000);
    releaseBuild(verifier);
    await expect(get).rejects.toBeInstanceOf(SubjectDeletingError);
    const result = await drain;
    expect(verifier.dispose).toHaveBeenCalled();
    expect(result).toMatchObject({
      cacheEntryCountBefore: 1,
      cacheEntryCountAfter: 0,
      activeOperationCountBefore: 1,
      activeOperationCountAfter: 0,
    });
    await expect(cache.get(record.tenantId, async () => record, async () => verifier))
      .rejects.toBeInstanceOf(SubjectDeletingError);
  });

  it("aborts a pending JWKS fetch and cannot authenticate after disposal", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "u_jwks" })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setExpirationTime("5m")
      .sign(privateKey as KeyObject);
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    let fetchAborted = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      fetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => { fetchAborted = true; reject(new Error("jwks aborted")); };
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        if (init?.signal?.aborted) onAbort();
      });
    };
    const verifier = new JwtEndUserVerifier({
      kind: "jwt",
      jwksUri: "https://auth.example/jwks.json",
      hs256: false,
      algorithms: ["RS256"],
      subjectClaim: "sub",
      clockToleranceSec: 0,
    }, undefined, fetchImpl);
    const verifying = verifier.verify(token);
    await started;
    verifier.dispose();
    await expect(verifying).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetchAborted).toBe(true);
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does not certify zero auth I/O while a non-cooperative JWKS fetch is still running", async () => {
    const runtime = new TenantRuntimeCoordinator();
    const tenantId = "t_jwks_ignores_abort";
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "u_jwks" })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setExpirationTime("5m")
      .sign(privateKey as KeyObject);
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    let releaseFetch!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const verifier = new JwtEndUserVerifier({
      kind: "jwt",
      jwksUri: "https://auth.example/jwks.json",
      hs256: false,
      algorithms: ["RS256"],
      subjectClaim: "sub",
      clockToleranceSec: 0,
    }, undefined, async () => {
      fetchStarted();
      await blocked; // deliberately ignores the supplied AbortSignal
      throw new Error("late JWKS failure");
    });
    runtime.registerParticipant({
      name: "test-jwks-verifier",
      snapshotTenant: () => ({}),
      fenceTenant: () => verifier.dispose(),
      purgeTenant: () => {},
    });
    runtime.sealParticipants();
    const lease = runtime.enter(tenantId, "auth");
    const verifying = verifier.verify(token, lease.signal).finally(() => lease.release());
    await started;

    await expect(runtime.drain(drainIdentity(tenantId), 20))
      .rejects.toBeInstanceOf(TenantRuntimeDrainTimeoutError);
    expect(runtime.snapshot(tenantId).authOperations).toBe(1);

    releaseFetch();
    await expect(verifying).rejects.toMatchObject({ code: "unauthorized" });
    await expect(runtime.drain(drainIdentity(tenantId), 1_000)).resolves.toMatchObject({
      activeOperationCountAfter: 0,
    });
  });

  it("keeps a non-200 JWKS response body active until cancellation settles", async () => {
    const runtime = new TenantRuntimeCoordinator();
    const tenantId = "t_jwks_error_body";
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "u_jwks" })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setExpirationTime("5m")
      .sign(privateKey as KeyObject);
    let cancelStarted!: () => void;
    const cancelling = new Promise<void>((resolve) => { cancelStarted = resolve; });
    let releaseCancel!: () => void;
    const cancelBlocked = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const verifier = new JwtEndUserVerifier({
      kind: "jwt",
      jwksUri: "https://auth.example/jwks.json",
      hs256: false,
      algorithms: ["RS256"],
      subjectClaim: "sub",
      clockToleranceSec: 0,
    }, undefined, async () => new Response(new ReadableStream({
      cancel: async () => {
        cancelStarted();
        await cancelBlocked;
      },
    }), { status: 500 }));
    runtime.registerParticipant({
      name: "test-jwks-error-verifier",
      snapshotTenant: () => ({}),
      fenceTenant: () => verifier.dispose(),
      purgeTenant: () => {},
    });
    runtime.sealParticipants();
    const lease = runtime.enter(tenantId, "auth");
    const verifying = verifier.verify(token, lease.signal).finally(() => lease.release());
    await cancelling;

    await expect(runtime.drain(drainIdentity(tenantId), 20))
      .rejects.toBeInstanceOf(TenantRuntimeDrainTimeoutError);
    expect(runtime.snapshot(tenantId).authOperations).toBe(1);

    releaseCancel();
    await expect(verifying).rejects.toMatchObject({ code: "unauthorized" });
    await expect(runtime.drain(drainIdentity(tenantId), 1_000)).resolves.toMatchObject({
      activeOperationCountAfter: 0,
    });
  });

  it("rejects an introspection response that arrives after disposal and clears positive results", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      await blocked;
      return Response.json({ active: true, sub: "u_late" });
    };
    const verifier = new IntrospectionEndUserVerifier({
      kind: "introspection",
      endpoint: "https://auth.example/introspect",
      method: "POST",
      tokenHeader: "authorization",
      activeField: "active",
      subjectField: "sub",
      useStoredSecret: false,
      cacheTtlMs: 60_000,
      timeoutMs: 2_000,
    }, undefined, fetchImpl);
    const verifying = verifier.verify("opaque-token");
    await Promise.resolve();
    verifier.dispose();
    release();
    await expect(verifying).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifier.verify("opaque-token")).rejects.toMatchObject({ code: "unauthorized" });
    expect(calls).toBe(1);
  });

  it("waits for a late introspection response body to cancel before releasing the auth operation", async () => {
    const runtime = new TenantRuntimeCoordinator();
    const tenantId = "t_late_introspection_body";
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    let releaseFetch!: () => void;
    const fetchBlocked = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let cancelStarted!: () => void;
    const cancelling = new Promise<void>((resolve) => { cancelStarted = resolve; });
    let releaseCancel!: () => void;
    const cancelBlocked = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const verifier = new IntrospectionEndUserVerifier({
      kind: "introspection",
      endpoint: "https://auth.example/introspect",
      method: "POST",
      tokenHeader: "authorization",
      activeField: "active",
      subjectField: "sub",
      useStoredSecret: false,
      cacheTtlMs: 0,
      timeoutMs: 2_000,
    }, undefined, async () => {
      fetchStarted();
      await fetchBlocked; // deliberately ignores the supplied AbortSignal
      return new Response(new ReadableStream({
        cancel: async () => {
          cancelStarted();
          await cancelBlocked;
        },
      }), { status: 200 });
    });
    runtime.registerParticipant({
      name: "test-introspection-verifier",
      snapshotTenant: () => ({}),
      fenceTenant: () => verifier.dispose(),
      purgeTenant: () => {},
    });
    runtime.sealParticipants();
    const lease = runtime.enter(tenantId, "auth");
    const verifying = verifier.verify("opaque-token", lease.signal).finally(() => lease.release());
    await started;
    const drainExpectation = expect(runtime.drain(drainIdentity(tenantId), 20))
      .rejects.toBeInstanceOf(TenantRuntimeDrainTimeoutError);
    releaseFetch();
    await cancelling;
    await drainExpectation;
    expect(runtime.snapshot(tenantId).authOperations).toBe(1);

    releaseCancel();
    await expect(verifying).rejects.toMatchObject({ code: "unauthorized" });
    await expect(runtime.drain(drainIdentity(tenantId), 1_000)).resolves.toMatchObject({
      activeOperationCountAfter: 0,
    });
  });

  it("keeps the auth operation active until a rejected introspection body is cancelled", async () => {
    const runtime = new TenantRuntimeCoordinator();
    const tenantId = "t_introspection_body";
    let cancelStarted!: () => void;
    const started = new Promise<void>((resolve) => { cancelStarted = resolve; });
    let releaseCancel!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const verifier = new IntrospectionEndUserVerifier({
      kind: "introspection",
      endpoint: "https://auth.example/introspect",
      method: "POST",
      tokenHeader: "authorization",
      activeField: "active",
      subjectField: "sub",
      useStoredSecret: false,
      cacheTtlMs: 0,
      timeoutMs: 2_000,
    }, undefined, async () => new Response(new ReadableStream({
      cancel: async () => {
        cancelStarted();
        await blocked;
      },
    }), { status: 401 }));
    runtime.sealParticipants();
    const lease = runtime.enter(tenantId, "auth");
    const verifying = verifier.verify("opaque-token", lease.signal).finally(() => lease.release());
    await started;

    await expect(runtime.drain(drainIdentity(tenantId), 20))
      .rejects.toBeInstanceOf(TenantRuntimeDrainTimeoutError);
    expect(runtime.snapshot(tenantId).authOperations).toBe(1);

    releaseCancel();
    await expect(verifying).rejects.toMatchObject({ code: "unauthorized" });
    await expect(runtime.drain(drainIdentity(tenantId), 1_000)).resolves.toMatchObject({
      activeOperationCountAfter: 0,
    });
  });
});
