import { randomUUID } from "node:crypto";
import {
  ImageMediaType,
  ToolOutputPayload,
  type InputPart,
  type Item,
  type Principal,
  type ToolOutputPayload as ToolOutputPayloadValue,
} from "@agent-service/protocol";
import {
  BLOB_STORAGE_FORMAT,
  TOOL_OUTPUT_CONTENT_TYPE,
  blobStorageKey,
  type BlobBinding,
  type BlobDescriptor,
  type BlobManifest,
  type BlobManifestStore,
  type BlobObject,
  type BlobPurpose,
  type BlobStore,
} from "@agent-service/store";
import { newId } from "../ids.js";
import type { EngineInputPart } from "../engine/types.js";

export interface SessionBlobServiceOptions {
  maxBlobBytes: number;
  stagingTtlMs: number;
  /** Aggregate cap for one model-context materialization, including base64 image expansion. */
  maxHydratedBytes?: number;
}

export interface UploadedSessionBlob extends BlobDescriptor {
  blobId: string;
  purpose: BlobPurpose;
  uploadToken: string;
  expiresAtMs: number;
}

export class BlobDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobDataError";
  }
}

/** Request-local accounting shared by every Blob materialized for one model invocation. */
export class BlobHydrationBudget {
  private consumedBytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error("Blob hydration budget must be a non-negative safe integer");
    }
  }

  get usedBytes(): number {
    return this.consumedBytes;
  }

  get remainingBytes(): number {
    return this.maxBytes - this.consumedBytes;
  }

  reserve(sizeBytes: number): boolean {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new BlobDataError("Blob hydration size is outside the safe integer range");
    }
    if (sizeBytes > this.remainingBytes) return false;
    this.consumedBytes += sizeBytes;
    return true;
  }

  /** Restore a checkpoint when validation succeeded but the corresponding durable admission failed. */
  rollbackTo(usedBytes: number): void {
    if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 || usedBytes > this.consumedBytes) {
      throw new Error("invalid Blob hydration budget checkpoint");
    }
    this.consumedBytes = usedBytes;
  }
}

/** Cheap content sniffing: the declared image MIME must match the file signature we support. */
export function matchesImageSignature(data: Uint8Array, contentType: string): boolean {
  const startsWith = (...bytes: number[]) => (
    data.byteLength >= bytes.length && bytes.every((byte, index) => data[index] === byte)
  );
  switch (contentType) {
    case "image/png":
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return startsWith(0xff, 0xd8, 0xff);
    case "image/gif":
      return startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61)
        || startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
    case "image/webp":
      return data.byteLength >= 12
        && startsWith(0x52, 0x49, 0x46, 0x46)
        && data[8] === 0x57
        && data[9] === 0x45
        && data[10] === 0x42
        && data[11] === 0x50;
    default:
      return false;
  }
}

type HistoryBlobCandidate =
  | { kind: "image"; itemIndex: number; partIndex: number; seq: number; blobId: string; itemId: string }
  | { kind: "tool_output"; itemIndex: number; seq: number; blobId: string; itemId: string };

const omittedHistoryImage = (blobId: string): Extract<InputPart, { type: "text" }> => ({
  type: "text",
  text: `[historical image ${blobId} omitted: Blob hydration budget exceeded]`,
});

/**
 * Joins the physical object adapter with the durable owner manifest. Backend locators never leave
 * this class; callers and persisted items use only opaque blob ids.
 */
export class SessionBlobService {
  private readonly maxHydratedBytes: number;
  readonly maxBlobBytes: number;

  constructor(
    private readonly store: BlobManifestStore,
    readonly objects: BlobStore,
    private readonly options: SessionBlobServiceOptions,
  ) {
    if (!Number.isSafeInteger(options.maxBlobBytes) || options.maxBlobBytes < 1) {
      throw new Error("maxBlobBytes must be a positive safe integer");
    }
    this.maxBlobBytes = options.maxBlobBytes;
    if (!Number.isSafeInteger(options.stagingTtlMs) || options.stagingTtlMs < 1) {
      throw new Error("blob stagingTtlMs must be a positive safe integer");
    }
    this.maxHydratedBytes = options.maxHydratedBytes ?? Math.max(options.maxBlobBytes, 4 * options.maxBlobBytes);
    if (!Number.isSafeInteger(this.maxHydratedBytes) || this.maxHydratedBytes < options.maxBlobBytes) {
      throw new Error("maxHydratedBytes must be a safe integer at least as large as maxBlobBytes");
    }
  }

  createHydrationBudget(): BlobHydrationBudget {
    return new BlobHydrationBudget(this.maxHydratedBytes);
  }

  async stageAndUpload(input: {
    owner: Principal;
    sessionId: string;
    fence: number;
    purpose: BlobPurpose;
    data: Buffer;
    contentType?: string;
  }): Promise<UploadedSessionBlob> {
    if (
      input.purpose === "input_image"
      && (!input.contentType || !matchesImageSignature(input.data, input.contentType))
    ) {
      throw new BlobDataError("image bytes do not match the declared content type");
    }
    const blobId = newId("blob");
    const uploadToken = randomUUID();
    const storageKey = blobStorageKey(blobId);
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + this.options.stagingTtlMs;
    await this.store.stageBlob({
      owner: input.owner,
      sessionId: input.sessionId,
      fence: input.fence,
      blobId,
      purpose: input.purpose,
      storageBackend: this.objects.backend,
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey,
      uploadToken,
      createdAtMs,
      stagingExpiresAtMs: expiresAtMs,
    });
    const descriptor = await this.objects.putIfAbsent(storageKey, input.data, {
      uploadToken,
      maxBytes: this.maxBlobBytes,
      contentType: input.contentType,
    });
    if (descriptor.contentType !== input.contentType) {
      throw new BlobDataError("blob storage adapter changed the requested content type");
    }
    await this.store.markBlobUploaded({
      owner: input.owner,
      sessionId: input.sessionId,
      fence: input.fence,
      blobId,
      uploadToken,
      sha256: descriptor.sha256,
      sizeBytes: descriptor.sizeBytes,
      contentType: descriptor.contentType,
      uploadedAtMs: Date.now(),
    });
    return { blobId, purpose: input.purpose, uploadToken, expiresAtMs, ...descriptor };
  }

  binding(blobId: string, itemId: string, purpose: BlobPurpose): BlobBinding {
    return { blobId, itemId, purpose };
  }

  async materializeBindableInput(
    owner: Principal,
    sessionId: string,
    parts: readonly InputPart[],
    hydrationBudget?: BlobHydrationBudget,
  ): Promise<EngineInputPart[]> {
    const budget = this.requestBudget(hydrationBudget);
    const output: EngineInputPart[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        output.push(part);
        continue;
      }
      if (part.type !== "image") continue;
      const manifest = await this.store.getBindableBlob({ owner, sessionId, blobId: part.blobId, purpose: "input_image" });
      if (!manifest) throw new BlobDataError("image blob is unavailable");
      if (!budget.reserve(this.hydratedSize(manifest, true))) {
        throw new BlobDataError("blob-backed model context exceeds the hydration limit");
      }
      output.push(await this.materializeImage(part, manifest));
    }
    return output;
  }

  /**
   * Materialize the retained history tail within one aggregate byte budget.
   *
   * Candidates are considered newest-first regardless of the store's result ordering. A candidate
   * that does not fit does not fail the session: an image becomes an explicit text marker and an
   * offloaded tool result keeps the durable marker already stored in its item row. Every referenced
   * ready manifest is still looked up with its complete owner/session/item/purpose identity; a missing
   * or cross-owner reference is data corruption, not permission to read a different object.
   *
   * Callers should plan/compact raw items with `projectItemsForPlanning`, select the retained items,
   * and only then call this method. Submitted input uses `materializeBindableInput` instead and remains
   * strict: exceeding the same aggregate cap rejects the request rather than degrading it.
   */
  async materializeReadyHistory(
    owner: Principal,
    sessionId: string,
    items: readonly Item[],
    hydrationBudget?: BlobHydrationBudget,
  ): Promise<Item[]> {
    return (await this.materializeReadyHistoryWithinBudget(owner, sessionId, items, hydrationBudget)).items;
  }

  /**
   * Compaction may permanently advance the projection watermark past the selected items. Returning
   * null when even one offloaded tool result could not be materialized prevents a durable storage
   * marker from being mistaken for the underlying fact and then summarized away forever.
   */
  async materializeReadyHistoryForCompaction(
    owner: Principal,
    sessionId: string,
    items: readonly Item[],
    hydrationBudget?: BlobHydrationBudget,
  ): Promise<Item[] | null> {
    const result = await this.materializeReadyHistoryWithinBudget(owner, sessionId, items, hydrationBudget);
    return result.omittedToolOutput ? null : result.items;
  }

  private async materializeReadyHistoryWithinBudget(
    owner: Principal,
    sessionId: string,
    items: readonly Item[],
    hydrationBudget?: BlobHydrationBudget,
  ): Promise<{ items: Item[]; omittedToolOutput: boolean }> {
    const budget = this.requestBudget(hydrationBudget);
    const hydrated = items.map((item) => structuredClone(item));
    const candidates: HistoryBlobCandidate[] = [];

    for (const [itemIndex, item] of hydrated.entries()) {
      if (item.type === "userMessage") {
        for (const [partIndex, part] of item.content.entries()) {
          if (part.type === "image") {
            candidates.push({ kind: "image", itemIndex, partIndex, seq: item.seq, blobId: part.blobId, itemId: item.id });
          }
        }
      } else if (item.type === "toolResult" && item.outputRef) {
        candidates.push({ kind: "tool_output", itemIndex, seq: item.seq, blobId: item.outputRef, itemId: item.id });
      }
    }

    candidates.sort((left, right) => (
      right.seq - left.seq
      || right.itemIndex - left.itemIndex
      || (left.kind === "image" && right.kind === "image" ? left.partIndex - right.partIndex : 0)
    ));

    let omittedToolOutput = false;
    for (const candidate of candidates) {
      const manifest = await this.store.getReadyBlob({
        owner,
        sessionId,
        blobId: candidate.blobId,
        itemId: candidate.itemId,
        purpose: candidate.kind === "image" ? "input_image" : "tool_output",
      });
      if (!manifest) {
        throw new BlobDataError(candidate.kind === "image"
          ? "persisted image blob is unavailable"
          : "persisted tool output blob is unavailable");
      }

      const addedBytes = this.hydratedSize(manifest, candidate.kind === "image");
      if (!budget.reserve(addedBytes)) {
        if (candidate.kind === "image") {
          const item = hydrated[candidate.itemIndex];
          if (item?.type !== "userMessage") throw new BlobDataError("persisted image item changed during hydration");
          const part = item.content[candidate.partIndex];
          if (part?.type !== "image" || part.blobId !== candidate.blobId) {
            throw new BlobDataError("persisted image reference changed during hydration");
          }
          item.content[candidate.partIndex] = omittedHistoryImage(candidate.blobId);
        } else {
          omittedToolOutput = true;
        }
        continue;
      }

      if (candidate.kind === "image") {
        const item = hydrated[candidate.itemIndex];
        if (item?.type !== "userMessage") throw new BlobDataError("persisted image item changed during hydration");
        const part = item.content[candidate.partIndex];
        if (part?.type !== "image" || part.blobId !== candidate.blobId) {
          throw new BlobDataError("persisted image reference changed during hydration");
        }
        item.content[candidate.partIndex] = await this.materializeImage(part, manifest);
      } else {
        const item = hydrated[candidate.itemIndex];
        if (item?.type !== "toolResult" || item.outputRef !== candidate.blobId) {
          throw new BlobDataError("persisted tool output reference changed during hydration");
        }
        const payload = await this.readToolOutput(manifest);
        item.content = payload.content;
        item.details = payload.details;
      }
    }
    return { items: hydrated, omittedToolOutput };
  }

  /** @deprecated Prefer `materializeReadyHistory` after planning the raw persisted items. */
  async hydrateReadyItems(owner: Principal, sessionId: string, items: readonly Item[]): Promise<Item[]> {
    return this.materializeReadyHistory(owner, sessionId, items);
  }

  async readReadyInputBlob(owner: Principal, sessionId: string, blobId: string): Promise<BlobObject | null> {
    const manifest = await this.store.getReadyBlob({ owner, sessionId, blobId, purpose: "input_image" });
    return manifest ? this.readVerified(manifest) : null;
  }

  async readReadyToolOutput(
    owner: Principal,
    sessionId: string,
    itemId: string,
    blobId: string,
  ): Promise<ToolOutputPayloadValue | null> {
    const manifest = await this.store.getReadyBlob({ owner, sessionId, blobId, itemId, purpose: "tool_output" });
    return manifest ? this.readToolOutput(manifest) : null;
  }

  private requestBudget(hydrationBudget?: BlobHydrationBudget): BlobHydrationBudget {
    const budget = hydrationBudget ?? this.createHydrationBudget();
    if (budget.maxBytes > this.maxHydratedBytes) {
      throw new BlobDataError("Blob hydration budget exceeds the configured limit");
    }
    return budget;
  }

  private hydratedSize(manifest: BlobManifest, image: boolean): number {
    if (manifest.sizeBytes === undefined) throw new BlobDataError("ready blob has no size");
    if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 0 || manifest.sizeBytes > this.maxBlobBytes) {
      throw new BlobDataError("ready blob has an invalid size");
    }
    let added = manifest.sizeBytes;
    if (image) {
      const mediaType = ImageMediaType.safeParse(manifest.contentType);
      if (!mediaType.success) throw new BlobDataError("image blob has an unsupported image content type");
      const base64Bytes = Math.ceil(manifest.sizeBytes / 3) * 4;
      const prefixBytes = Buffer.byteLength(`data:${mediaType.data};base64,`, "utf8");
      added = base64Bytes + prefixBytes;
    }
    if (!Number.isSafeInteger(added)) throw new BlobDataError("ready blob hydration size is outside the safe integer range");
    return added;
  }

  private async materializeImage(
    part: Extract<InputPart, { type: "image" }>,
    manifest: BlobManifest,
  ): Promise<EngineInputPart> {
    const object = await this.readVerified(manifest);
    const mediaType = ImageMediaType.safeParse(object.contentType);
    if (!mediaType.success) throw new BlobDataError("image blob has an unsupported image content type");
    const contentType = mediaType.data;
    if (part.mimeType && part.mimeType !== contentType) throw new BlobDataError("image MIME type does not match its manifest");
    return {
      type: "image",
      blobId: part.blobId,
      mimeType: contentType,
      url: `data:${contentType};base64,${object.data.toString("base64")}`,
    };
  }

  private async readToolOutput(manifest: BlobManifest): Promise<ToolOutputPayloadValue> {
    const object = await this.readVerified(manifest);
    if (object.contentType !== TOOL_OUTPUT_CONTENT_TYPE) throw new BlobDataError("tool output has an invalid content type");
    let parsed: unknown;
    try {
      parsed = JSON.parse(object.data.toString("utf8"));
    } catch {
      throw new BlobDataError("tool output is not valid JSON");
    }
    const result = ToolOutputPayload.safeParse(parsed);
    if (!result.success) throw new BlobDataError("tool output does not match the protocol schema");
    return result.data;
  }

  private async readVerified(manifest: BlobManifest): Promise<BlobObject> {
    if (
      manifest.storageBackend !== this.objects.backend
      || manifest.storageFormat !== BLOB_STORAGE_FORMAT
      || manifest.storageKey !== blobStorageKey(manifest.blobId)
    ) {
      throw new BlobDataError("blob storage adapter does not match the manifest");
    }
    if (manifest.sha256 === undefined || manifest.sizeBytes === undefined) {
      throw new BlobDataError("blob manifest has no integrity descriptor");
    }
    const object = await this.objects.get(manifest.storageKey, { maxBytes: this.maxBlobBytes });
    if (!object) throw new BlobDataError("blob object is missing");
    if (
      object.sha256 !== manifest.sha256
      || object.sizeBytes !== manifest.sizeBytes
      || object.contentType !== manifest.contentType
    ) throw new BlobDataError("blob object does not match its manifest");
    return object;
  }
}
