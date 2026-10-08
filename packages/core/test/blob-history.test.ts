import { describe, expect, it } from "vitest";
import type { InputPart, Item, Principal } from "@agent-service/protocol";
import {
  BLOB_STORAGE_FORMAT,
  MemoryBlobStore,
  TOOL_OUTPUT_CONTENT_TYPE,
  type BindableBlobLookup,
  type BlobManifest,
  type BlobManifestStore,
  type MarkBlobUploadedInput,
  type ReadyBlobLookup,
  type StageBlobInput,
} from "@agent-service/store";
import {
  BlobDataError,
  SessionBlobService,
  matchesImageSignature,
  projectItems,
  projectItemsForPlanning,
} from "../src/index.js";

const owner: Principal = { tenantId: "tenant-a", userId: "user-a" };
const otherOwner: Principal = { tenantId: "tenant-b", userId: "user-b" };
const sessionId = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const turnId = "turn_019a2b3c-4d5e-7f00-8a9b-000000000001";

const itemId = (suffix: number) => `item_019a2b3c-4d5e-7f00-8a9b-${String(suffix).padStart(12, "0")}`;
const blobId = (suffix: number) => `blob_019a2b3c-4d5e-7f00-8a9b-${String(suffix).padStart(12, "0")}`;

class ManifestFixture implements BlobManifestStore {
  readonly manifests = new Map<string, BlobManifest>();
  readonly readyLookups: string[] = [];

  async stageBlob(_input: StageBlobInput): Promise<void> {
    throw new Error("not used by this fixture");
  }

  async markBlobUploaded(_input: MarkBlobUploadedInput): Promise<void> {
    throw new Error("not used by this fixture");
  }

  async getBindableBlob(input: BindableBlobLookup): Promise<BlobManifest | null> {
    const manifest = this.manifests.get(input.blobId);
    return this.matchesOwner(manifest, input.owner, input.sessionId)
      && manifest?.purpose === input.purpose
      ? structuredClone(manifest)
      : null;
  }

  async getReadyBlob(input: ReadyBlobLookup): Promise<BlobManifest | null> {
    this.readyLookups.push(input.blobId);
    const manifest = this.manifests.get(input.blobId);
    return this.matchesOwner(manifest, input.owner, input.sessionId)
      && manifest?.state === "ready"
      && (input.itemId === undefined || manifest.itemId === input.itemId)
      && (input.purpose === undefined || manifest.purpose === input.purpose)
      ? structuredClone(manifest)
      : null;
  }

  async getBlobManifest(id: string): Promise<BlobManifest | null> {
    const manifest = this.manifests.get(id);
    return manifest ? structuredClone(manifest) : null;
  }

  private matchesOwner(manifest: BlobManifest | undefined, principal: Principal, requestedSessionId: string): boolean {
    return !!manifest
      && manifest.tenantId === principal.tenantId
      && manifest.userId === principal.userId
      && manifest.sessionId === requestedSessionId;
  }
}

async function addReadyBlob(input: {
  fixture: ManifestFixture;
  objects: MemoryBlobStore;
  id: string;
  itemId: string;
  purpose: "input_image" | "tool_output";
  data: Buffer;
  contentType: string;
  principal?: Principal;
}) {
  const storageKey = `objects/aa/${input.id}`;
  const uploadToken = `upload-${input.id.slice(-12)}`;
  const descriptor = await input.objects.putIfAbsent(storageKey, input.data, {
    uploadToken,
    maxBytes: 128,
    contentType: input.contentType,
  });
  const principal = input.principal ?? owner;
  input.fixture.manifests.set(input.id, {
    blobId: input.id,
    tenantId: principal.tenantId,
    userId: principal.userId,
    sessionId,
    itemId: input.itemId,
    purpose: input.purpose,
    storageBackend: input.objects.backend,
    storageFormat: BLOB_STORAGE_FORMAT,
    uploadToken,
    state: "ready",
    ...descriptor,
    uploadedAtMs: 1,
    readyAtMs: 2,
    deletionGeneration: 0,
    createdAtMs: 1,
  });
}

const base = (id: string, seq: number) => ({
  id,
  sessionId,
  turnId,
  seq,
  step: 1,
  status: "completed" as const,
  createdAtMs: seq,
  completedAtMs: seq,
});

describe("Blob-backed history projection", () => {
  it("matches each supported image MIME to its file signature", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const gif = Buffer.from("GIF89a", "ascii");
    const webp = Buffer.from("RIFF0000WEBP", "ascii");
    expect(matchesImageSignature(png, "image/png")).toBe(true);
    expect(matchesImageSignature(jpeg, "image/jpeg")).toBe(true);
    expect(matchesImageSignature(gif, "image/gif")).toBe(true);
    expect(matchesImageSignature(webp, "image/webp")).toBe(true);
    expect(matchesImageSignature(png, "image/jpeg")).toBe(false);
    expect(matchesImageSignature(Buffer.from("RIFFWEBP", "ascii"), "image/webp")).toBe(false);
  });

  it("keeps normal projection strict while lightweight planning uses an explicit image marker", () => {
    const id = blobId(1);
    const items: Item[] = [{
      ...base(itemId(1), 1),
      type: "userMessage",
      content: [{ type: "image", blobId: id, mimeType: "image/png" }],
    }];

    expect(() => projectItems(items)).toThrow(`image blob ${id} was not materialized`);
    const planning = projectItemsForPlanning(items);
    expect(planning.messages).toEqual([{
      role: "user",
      content: [{ type: "text", text: `[historical image ${id} omitted from lightweight context planning]` }],
    }]);
  });

  it("hydrates newest history first and degrades old images and tool outputs without exceeding the aggregate budget", async () => {
    const fixture = new ManifestFixture();
    const objects = new MemoryBlobStore();
    const service = new SessionBlobService(fixture, objects, {
      maxBlobBytes: 128,
      stagingTtlMs: 60_000,
      maxHydratedBytes: 128,
    });
    const imageBlob = blobId(2);
    const oldToolBlob = blobId(3);
    const newToolBlob = blobId(4);
    const imageItemId = itemId(2);
    const oldToolItemId = itemId(3);
    const newToolItemId = itemId(4);
    const toolPayload = (text: string) => Buffer.from(JSON.stringify({
      content: [{ type: "text", text }],
      details: { source: text },
    }), "utf8");

    await addReadyBlob({
      fixture,
      objects,
      id: imageBlob,
      itemId: imageItemId,
      purpose: "input_image",
      data: Buffer.alloc(60, 1),
      contentType: "image/png",
    });
    await addReadyBlob({
      fixture,
      objects,
      id: oldToolBlob,
      itemId: oldToolItemId,
      purpose: "tool_output",
      data: toolPayload("old-output"),
      contentType: TOOL_OUTPUT_CONTENT_TYPE,
    });
    await addReadyBlob({
      fixture,
      objects,
      id: newToolBlob,
      itemId: newToolItemId,
      purpose: "tool_output",
      data: toolPayload("new-output"),
      contentType: TOOL_OUTPUT_CONTENT_TYPE,
    });

    const imageItem: Item = {
      ...base(imageItemId, 1),
      type: "userMessage",
      content: [{ type: "image", blobId: imageBlob, mimeType: "image/png" }],
    };
    const oldToolItem: Item = {
      ...base(oldToolItemId, 3),
      type: "toolResult",
      toolCallId: "old-call",
      name: "lookup",
      content: [{ type: "text", text: "durable old output marker" }],
      isError: false,
      outputRef: oldToolBlob,
    };
    const newToolItem: Item = {
      ...base(newToolItemId, 5),
      type: "toolResult",
      toolCallId: "new-call",
      name: "lookup",
      content: [{ type: "text", text: "durable new output marker" }],
      isError: false,
      outputRef: newToolBlob,
    };

    // Deliberately pass newest-first: priority must derive from seq, not input ordering assumptions.
    const result = await service.materializeReadyHistory(owner, sessionId, [newToolItem, imageItem, oldToolItem]);
    const newest = result.find((item) => item.id === newToolItemId);
    const oldTool = result.find((item) => item.id === oldToolItemId);
    const image = result.find((item) => item.id === imageItemId);
    expect(newest).toMatchObject({
      type: "toolResult",
      content: [{ type: "text", text: "new-output" }],
      details: { source: "new-output" },
    });
    expect(oldTool).toMatchObject({
      type: "toolResult",
      content: [{ type: "text", text: "durable old output marker" }],
      outputRef: oldToolBlob,
    });
    expect(image).toMatchObject({
      type: "userMessage",
      content: [{ type: "text", text: expect.stringContaining("Blob hydration budget exceeded") }],
    });
    expect(fixture.readyLookups).toEqual([newToolBlob, oldToolBlob, imageBlob]);
    expect(newToolItem.content).toEqual([{ type: "text", text: "durable new output marker" }]);
    expect(imageItem.content).toEqual([{ type: "image", blobId: imageBlob, mimeType: "image/png" }]);
  });

  it("rejects a selected history reference whose ready manifest is missing or belongs to another owner", async () => {
    const fixture = new ManifestFixture();
    const objects = new MemoryBlobStore();
    const service = new SessionBlobService(fixture, objects, {
      maxBlobBytes: 128,
      stagingTtlMs: 60_000,
      maxHydratedBytes: 128,
    });
    const foreignBlob = blobId(5);
    const foreignItem = itemId(5);
    await addReadyBlob({
      fixture,
      objects,
      id: foreignBlob,
      itemId: foreignItem,
      purpose: "tool_output",
      data: Buffer.from(JSON.stringify({ content: [{ type: "text", text: "secret" }] }), "utf8"),
      contentType: TOOL_OUTPUT_CONTENT_TYPE,
      principal: otherOwner,
    });
    const item: Item = {
      ...base(foreignItem, 10),
      type: "toolResult",
      toolCallId: "foreign-call",
      name: "lookup",
      content: [{ type: "text", text: "durable marker" }],
      isError: false,
      outputRef: foreignBlob,
    };

    await expect(service.materializeReadyHistory(owner, sessionId, [item]))
      .rejects.toThrowError(new BlobDataError("persisted tool output blob is unavailable"));
  });

  it("keeps current submitted input strict when image expansion exceeds the hydration budget", async () => {
    const fixture = new ManifestFixture();
    const objects = new MemoryBlobStore();
    const service = new SessionBlobService(fixture, objects, {
      maxBlobBytes: 128,
      stagingTtlMs: 60_000,
      maxHydratedBytes: 128,
    });
    const id = blobId(6);
    const currentItemId = itemId(6);
    await addReadyBlob({
      fixture,
      objects,
      id,
      itemId: currentItemId,
      purpose: "input_image",
      data: Buffer.alloc(100, 2),
      contentType: "image/png",
    });
    const input: InputPart[] = [{ type: "image", blobId: id, mimeType: "image/png" }];

    await expect(service.materializeBindableInput(owner, sessionId, input))
      .rejects.toThrow("blob-backed model context exceeds the hydration limit");
  });

  it("charges the complete image data URL, including its MIME/base64 prefix, at the exact boundary", async () => {
    const fixture = new ManifestFixture();
    const objects = new MemoryBlobStore();
    const id = blobId(9);
    const data = Buffer.alloc(60, 9);
    const expectedDataUrlBytes = Buffer.byteLength(`data:image/png;base64,${data.toString("base64")}`, "utf8");
    expect(expectedDataUrlBytes).toBe(102);
    await addReadyBlob({
      fixture,
      objects,
      id,
      itemId: itemId(9),
      purpose: "input_image",
      data,
      contentType: "image/png",
    });
    const input: InputPart[] = [{ type: "image", blobId: id, mimeType: "image/png" }];

    const exact = new SessionBlobService(fixture, objects, {
      maxBlobBytes: data.byteLength,
      stagingTtlMs: 60_000,
      maxHydratedBytes: expectedDataUrlBytes,
    });
    const materialized = await exact.materializeBindableInput(owner, sessionId, input);
    expect(materialized).toMatchObject([{ type: "image", blobId: id }]);
    expect(materialized[0]?.type === "image" ? Buffer.byteLength(materialized[0].url, "utf8") : 0)
      .toBe(expectedDataUrlBytes);

    const oneByteShort = new SessionBlobService(fixture, objects, {
      maxBlobBytes: data.byteLength,
      stagingTtlMs: 60_000,
      maxHydratedBytes: expectedDataUrlBytes - 1,
    });
    await expect(oneByteShort.materializeBindableInput(owner, sessionId, input))
      .rejects.toThrow("blob-backed model context exceeds the hydration limit");
  });

  it("shares one budget across current input and history while preserving current input", async () => {
    const fixture = new ManifestFixture();
    const objects = new MemoryBlobStore();
    const service = new SessionBlobService(fixture, objects, {
      maxBlobBytes: 128,
      stagingTtlMs: 60_000,
      maxHydratedBytes: 128,
    });
    const currentBlob = blobId(7);
    const historicalBlob = blobId(8);
    const historicalItemId = itemId(8);
    await addReadyBlob({
      fixture,
      objects,
      id: currentBlob,
      itemId: itemId(7),
      purpose: "input_image",
      data: Buffer.alloc(60, 7),
      contentType: "image/png",
    });
    const historicalPayload = Buffer.from(JSON.stringify({
      content: [{ type: "text", text: "historical-output" }],
    }), "utf8");
    expect(historicalPayload.byteLength).toBeGreaterThan(48);
    expect(historicalPayload.byteLength).toBeLessThanOrEqual(128);
    await addReadyBlob({
      fixture,
      objects,
      id: historicalBlob,
      itemId: historicalItemId,
      purpose: "tool_output",
      data: historicalPayload,
      contentType: TOOL_OUTPUT_CONTENT_TYPE,
    });
    const history: Item[] = [{
      ...base(historicalItemId, 1),
      type: "toolResult",
      toolCallId: "history-call",
      name: "lookup",
      content: [{ type: "text", text: "durable external marker" }],
      isError: false,
      outputRef: historicalBlob,
    }];

    const budget = service.createHydrationBudget();
    const current = await service.materializeBindableInput(owner, sessionId, [
      { type: "image", blobId: currentBlob, mimeType: "image/png" },
    ], budget);
    const hydratedHistory = await service.materializeReadyHistory(owner, sessionId, history, budget);

    expect(current).toMatchObject([{ type: "image", blobId: currentBlob }]);
    expect(hydratedHistory[0]).toMatchObject({
      type: "toolResult",
      content: [{ type: "text", text: "durable external marker" }],
      outputRef: historicalBlob,
    });
    expect(budget.usedBytes).toBe(102);
    expect(budget.remainingBytes).toBe(26);
  });
});
