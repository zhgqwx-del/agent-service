import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agent-service/protocol";
import { createSkillRegistryAccess, MemorySessionStore, S3BlobStore, type S3BlobStoreOptions } from "@agent-service/store";
import { RegisteredSkillService } from "../src/skills/registered.js";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";

type SdkClient = NonNullable<S3BlobStoreOptions["client"]>;
interface CommandInput { readonly input: Record<string, unknown> }
const requireStore = createRequire(new URL("../../store/package.json", import.meta.url));
const sdk = requireStore("@aws-sdk/client-s3") as {
  S3Client: new (config: NonNullable<S3BlobStoreOptions["clientConfig"]>) => SdkClient;
  PutObjectCommand: new (input: Record<string, unknown>) => CommandInput;
  GetObjectCommand: new (input: Record<string, unknown>) => CommandInput;
};
const principal = { tenantId: "skills-io-tenant", userId: "skills-io-user" };
const owner = { scope: "user" as const, tenantId: principal.tenantId, userId: principal.userId };
const access = createSkillRegistryAccess({ principal, owner, authority: "user_self", access: "manage" });
const document = Buffer.from("---\nname: review\ndescription: Review a requested change\n---\nKeep this exact instruction.\n");
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.useRealTimers(); });

// The source, Memory registry, coordinator, actual AWS S3Client object and actual
// S3BlobStore are product implementations. Only SDK send/response Body are an
// adversarial transport seam: they deliberately acknowledge cancellation late.
function setup(mode: "sdk" | "body") {
  const entered = gate(), release = gate(), objects = new Map<string, Buffer>();
  const client = new sdk.S3Client({ region: "us-east-1", endpoint: "http://127.0.0.1:9", forcePathStyle: true,
    credentials: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" }, maxAttempts: 2 });
  let sdkSignal: AbortSignal | undefined, actualSettled = false, lateBody: Readable | undefined;
  const destroyBody = vi.fn();
  const send = async (command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> => {
    if (command instanceof sdk.PutObjectCommand) {
      const key = command.input.Key, body = command.input.Body;
      if (typeof key !== "string" || !(body instanceof Uint8Array) || command.input.IfNoneMatch !== "*") throw new Error("Unexpected fixture put.");
      if (objects.has(key)) throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      objects.set(key, Buffer.from(body)); return { ETag: '"fixture-object"' };
    }
    if (!(command instanceof sdk.GetObjectCommand) || typeof command.input.Key !== "string") throw new Error("Unexpected fixture command.");
    const bytes = objects.get(command.input.Key); if (!bytes) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    sdkSignal = options?.abortSignal;
    if (mode === "sdk") {
      entered.release(); await release.promise; actualSettled = true;
      lateBody = Readable.from([bytes]);
      return { Body: lateBody, ContentLength: bytes.length, ETag: '"fixture-object"' };
    }
    return { ContentLength: bytes.length, ETag: '"fixture-object"', Body: {
      // A destroy call is not itself proof that a vendor Body iterator settled.
      destroy: destroyBody,
      async *[Symbol.asyncIterator]() { entered.release(); await release.promise; actualSettled = true; yield bytes; },
    } };
  };
  // Narrow the overloaded SDK method only at this explicit transport test seam.
  const transport = client as unknown as { send: typeof send };
  const sendSpy = vi.spyOn(transport, "send").mockImplementation(send);
  const blobs = new S3BlobStore({ bucket: "skills-io-test", prefix: "registry-fixture", namespaceId: "skills-io-fixture", client, requestTimeoutMs: 100 });
  const store = new MemorySessionStore(), runtime = new TenantRuntimeCoordinator();
  const source = new RegisteredSkillService({ store, blobs, namespaceSha256: blobs.namespaceSha256, tenantRuntime: runtime });
  cleanup.push(async () => { release.release(); await source.close(); await blobs.close(); });
  return { entered, release, source, store, runtime, objects, sendSpy, destroyBody,
    actualSettled: () => actualSettled, sdkSignal: () => sdkSignal, lateBody: () => lateBody };
}

describe("registered skills actual S3 I/O settlement lease", () => {
  it.each(["sdk", "body"] as const)("does not release a provider lease or close before timed-out %s work actually settles", async mode => {
    const f = setup(mode); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false, closed = false;
    const installation = f.source.install(owner, { access, document, expectedRevision: 0, idempotencyKey: "exact-install" })
      .then(version => { settled = true; return version; }, error => { settled = true; return error as ApiError; });
    try {
      await f.entered.promise;
      expect(f.runtime.snapshot(principal.tenantId).providerOperations).toBe(1); expect(f.actualSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(101);
      // The public adapter's original 100ms deadline has expired. Its underlying
      // SDK/Body has not settled; neither the source nor T3b may claim drained.
      expect(settled).toBe(false); expect(f.actualSettled()).toBe(false);
      expect(f.runtime.snapshot(principal.tenantId).providerOperations).toBe(1);
      if (mode === "sdk") expect(f.sdkSignal()?.aborted).toBe(true);
      else expect(f.destroyBody).toHaveBeenCalled();
      const closing = f.source.close().then(() => { closed = true; });
      await Promise.resolve(); expect(closed).toBe(false); expect(settled).toBe(false);
      expect(f.runtime.snapshot(principal.tenantId).providerOperations).toBe(1);
      f.release.release();
      const result = await installation; await closing;
      expect(f.actualSettled()).toBe(true); expect(closed).toBe(true);
      expect(result).toBeInstanceOf(ApiError); expect(result).toMatchObject({ code: "draining", status: 503, retryable: true, message: "Skill request unavailable." });
      expect(f.runtime.snapshot(principal.tenantId).providerOperations).toBe(0);
      if (mode === "sdk") expect(f.lateBody()?.destroyed).toBe(true);
      const slot = await f.store.getSkillSlot({ owner, access, name: "review" });
      expect(slot).toMatchObject({ revision: 1, currentVersionId: null });
      expect((await f.store.listSkillVersions({ owner, access, name: "review", cursor: null, limit: 10 })).items).toEqual([]);
      expect(f.store.blobManifests.size).toBe(0); expect(f.objects.size).toBe(1);
      // A staged immutable object can remain, but no ready package/version was
      // published. No automatic replay/second write or fake purge is asserted.
      expect(f.sendSpy.mock.calls.filter(([command]) => command instanceof sdk.PutObjectCommand)).toHaveLength(1);
      expect(f.sendSpy.mock.calls.filter(([command]) => command instanceof sdk.GetObjectCommand)).toHaveLength(1);
    } finally { f.release.release(); await installation; }
  });
});
