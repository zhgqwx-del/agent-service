import { afterEach, describe, expect, it } from "vitest";
import {
  SessionBlobService,
  SessionHost,
  StaticToolRegistry,
  newId,
  type ResolvedModel,
} from "@agent-service/core";
import {
  TOOL_OUTPUT_CONTENT_TYPE,
  MemoryBlobStore,
  MemoryEventBus,
  MemoryLeaseStore,
  MemorySessionStore,
} from "@agent-service/store";
import type { AgentDefinition, Item, ToolOutputPayload } from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { createApp, type AppDeps } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";

const MASTER_KEY = "77".repeat(32);
const INTERNAL_TOKEN = "blob-test-internal-router-token-0001";
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const hosts: SessionHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.drain(1_000).catch(() => {})));
});

const json = async <T>(response: Response): Promise<T> => await response.json() as T;

async function fixture() {
  const store = new MemorySessionStore();
  await store.createApiKey("t_blob", "primary", hashApiKey("blob-key"), ["runtime", "admin"]);
  await store.createApiKey("t_other", "other", hashApiKey("other-key"), ["runtime", "admin"]);

  const agent: AgentDefinition = {
    id: newId("agt"),
    tenantId: "t_blob",
    version: 1,
    name: "blob-test",
    instructions: "",
    model: { provider: "fake", model: "fake" },
    tools: [],
    mcpServers: [],
    skills: [],
    limits: {},
    approvalPolicy: "on-request",
    busyPolicy: "reject",
    sandbox: "none",
    metadata: {},
    createdAtMs: Date.now(),
  };
  await store.createAgent(agent);

  const objects = new MemoryBlobStore();
  const blobs = new SessionBlobService(store, objects, {
    maxBlobBytes: 256,
    maxHydratedBytes: 1_024,
    stagingTtlMs: 60_000,
  });
  const tools = new StaticToolRegistry([]);
  const model: ResolvedModel = {
    handle: {}, provider: "fake", model: "fake", contextWindow: 1_000, input: ["text", "image"], apiKey: async () => "unused",
  };
  const host = new SessionHost({
    store,
    lease: new MemoryLeaseStore(),
    bus: new MemoryEventBus(),
    blobs,
    engine: {
      name: "noop",
      start: () => ({
        steer: () => {},
        interrupt: () => {},
        done: Promise.resolve({ steps: 0, aborted: false }),
      }),
    },
    providers: { resolve: async () => model },
    tools,
    config: {
      runnerId: "blob-runner",
      runnerAddr: "127.0.0.1:8787",
      leaseHoldMs: 10,
      blobAttachmentsEnabled: true,
      toolOutputBlobThresholdBytes: 32,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  hosts.push(host);

  const cipher = new LocalAesGcmCipher(MASTER_KEY);
  const providers = new ProviderService({ store, cipher, assertBaseUrl: async () => {} });
  const baseDeps: AppDeps = {
    store,
    host,
    providers,
    tools,
    runnerId: "blob-runner",
    internalRouterToken: INTERNAL_TOKEN,
    heartbeatMs: 60_000,
    maxBodyBytes: 1_024,
    maxBlobBytes: 256,
    ready: () => true,
    decryptSecret: (secret) => cipher.decrypt(secret.ciphertext, secret.keyId),
    encryptSecret: async (plaintext) => ({ ciphertext: await cipher.encrypt(plaintext), keyId: cipher.keyId }),
    assertPublicUrl: async () => {},
  };
  const app = (writesEnabled: boolean) => createApp({ ...baseDeps, blobAttachmentsEnabled: writesEnabled });
  const request = (
    target: ReturnType<typeof app>,
    path: string,
    init: RequestInit = {},
    identity: { key?: string; userId?: string } = {},
  ) => target.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${identity.key ?? "blob-key"}`,
      "x-user-id": identity.userId ?? "u_1",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const createSession = async (target: ReturnType<typeof app>) => {
    const response = await request(target, "/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: agent.id }),
    });
    expect(response.status).toBe(201);
    return await json<{ id: string }>(response);
  };
  return { app, request, createSession, store, blobs };
}

function expectPrivateBlobHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("agent-runner blob HTTP API", () => {
  it("defaults the writer capability off while keeping owner-scoped readers available", async () => {
    const { app, request, createSession } = await fixture();
    const disabled = app(false);
    const enabled = app(true);

    const capability = await disabled.request("/v1/capabilities");
    expect(await json<{ features: { blobAttachments: boolean } }>(capability)).toMatchObject({
      features: { blobAttachments: false },
    });
    const session = await createSession(disabled);
    const blocked = await request(disabled, `/v1/sessions/${session.id}/blobs`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMAGE,
    });
    expect(blocked.status).toBe(503);
    expect((await json<{ error: { code: string } }>(blocked)).error.code).toBe("draining");
    expectPrivateBlobHeaders(blocked);

    const uploaded = await request(enabled, `/v1/sessions/${session.id}/blobs`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMAGE,
    });
    expect(uploaded.status).toBe(201);
    const descriptor = await json<Record<string, unknown> & { blobId: string }>(uploaded);
    expect(descriptor).toMatchObject({
      purpose: "input_image",
      state: "staging",
      sizeBytes: IMAGE.byteLength,
      contentType: "image/png",
    });
    expect(descriptor).not.toHaveProperty("storageKey");
    expect(descriptor).not.toHaveProperty("uploadToken");
    expect(descriptor).not.toHaveProperty("sha256");
    expectPrivateBlobHeaders(uploaded);

    const staging = await request(disabled, `/v1/sessions/${session.id}/blobs/${descriptor.blobId}`);
    expect(staging.status).toBe(404);

    const turn = await request(enabled, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: [
          { type: "text", text: "inspect" },
          { type: "image", blobId: descriptor.blobId, mimeType: "image/png" },
        ],
        stream: false,
      }),
    });
    expect(turn.status).toBe(202);

    // The writer gate is still off on this app instance, but already-attached bytes remain readable
    // throughout a mixed-version rollout.
    const read = await request(disabled, `/v1/sessions/${session.id}/blobs/${descriptor.blobId}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("content-length")).toBe(String(IMAGE.byteLength));
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(IMAGE);
    expectPrivateBlobHeaders(read);
  });

  it("enforces raw-body and media-type bounds before staging data", async () => {
    const { app, request, createSession } = await fixture();
    const target = app(true);
    const session = await createSession(target);

    for (const [contentType, body] of [
      ["application/octet-stream", IMAGE],
      ["image/png; name=quoted", IMAGE],
      ["image/jpeg", IMAGE],
      ["image/png", new Uint8Array()],
    ] as const) {
      const response = await request(target, `/v1/sessions/${session.id}/blobs`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      expect(response.status).toBe(400);
      expectPrivateBlobHeaders(response);
    }

    const oversized = await request(target, `/v1/sessions/${session.id}/blobs`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(257),
    });
    expect(oversized.status).toBe(400);
    expect((await json<{ error: { message: string } }>(oversized)).error.message).toContain("256");
    expectPrivateBlobHeaders(oversized);
  });

  it("makes ready image and tool-output reads indistinguishable across ownership boundaries", async () => {
    const { app, request, createSession, store, blobs } = await fixture();
    const target = app(true);
    const session = await createSession(target);
    const otherSession = await createSession(target);

    const upload = await request(target, `/v1/sessions/${session.id}/blobs`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: IMAGE,
    });
    const { blobId } = await json<{ blobId: string }>(upload);
    const bind = await request(target, `/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: [{ type: "text", text: "inspect" }, { type: "image", blobId }], stream: false }),
    });
    expect(bind.status).toBe(202);

    const foreignReads = await Promise.all([
      request(target, `/v1/sessions/${session.id}/blobs/${blobId}`, {}, { userId: "u_2" }),
      request(target, `/v1/sessions/${otherSession.id}/blobs/${blobId}`),
      request(target, `/v1/sessions/${session.id}/blobs/${blobId}`, {}, { key: "other-key" }),
      request(target, `/v1/sessions/${session.id}/blobs/blob_not-canonical`),
    ]);
    expect(foreignReads.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    foreignReads.forEach(expectPrivateBlobHeaders);

    const toolSession = await createSession(target);
    const owner = { tenantId: "t_blob", userId: "u_1" };
    const persisted = await store.getSession(owner.tenantId, toolSession.id);
    expect(persisted).not.toBeNull();
    const payload: ToolOutputPayload = {
      content: [{ type: "text", text: "complete private tool output" }],
      details: { source: "test" },
    };
    const staged = await blobs.stageAndUpload({
      owner,
      sessionId: toolSession.id,
      fence: persisted!.fenceToken,
      purpose: "tool_output",
      data: Buffer.from(JSON.stringify(payload)),
      contentType: TOOL_OUTPUT_CONTENT_TYPE,
    });
    const itemId = newId("item");
    const item: Extract<Item, { type: "toolResult" }> = {
      id: itemId,
      sessionId: toolSession.id,
      turnId: newId("turn"),
      seq: 0,
      step: 1,
      status: "completed",
      createdAtMs: Date.now(),
      completedAtMs: Date.now(),
      type: "toolResult",
      toolCallId: "call_blob",
      name: "large_tool",
      content: [{ type: "text", text: "preview" }],
      isError: false,
      outputRef: staged.blobId,
    };
    await store.commit({
      sessionId: toolSession.id,
      fence: persisted!.fenceToken,
      items: [item],
      blobBindings: [blobs.binding(staged.blobId, itemId, "tool_output")],
    });

    const output = await request(target, `/v1/sessions/${toolSession.id}/items/${itemId}/output`);
    expect(output.status).toBe(200);
    expect(await output.json()).toEqual(payload);
    expectPrivateBlobHeaders(output);

    for (const response of await Promise.all([
      request(target, `/v1/sessions/${toolSession.id}/items/${itemId}/output`, {}, { userId: "u_2" }),
      request(target, `/v1/sessions/${otherSession.id}/items/${itemId}/output`),
      request(target, `/v1/sessions/${toolSession.id}/items/${newId("item")}/output`),
    ])) {
      expect(response.status).toBe(404);
      expectPrivateBlobHeaders(response);
    }
  });
});
