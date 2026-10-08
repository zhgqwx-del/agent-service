import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type ItemOutput,
  type SessionBlobContentType,
  readItemOutput,
  readSessionBlob,
  uploadSessionBlob,
} from "../src/index.js";

const SESSION_ID = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const BLOB_ID = "blob_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const ITEM_ID = "item_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";

function uploadResponse(contentType: SessionBlobContentType) {
  return {
    blobId: BLOB_ID,
    contentType,
    expiresAtMs: 123,
    purpose: "input_image" as const,
    sizeBytes: 6,
    state: "staging" as const,
  };
}

describe("owner-scoped blob helpers", () => {
  it("uploads a Uint8Array as unchanged raw bytes with the explicit image Content-Type", async () => {
    const input = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    let request: Request | undefined;
    const result = await uploadSessionBlob({
      baseUrl: "https://agent.example.test/api/",
      serviceApiKey: "service-key",
      userId: "u_sdk",
      headers: { "X-Request-Id": "request-blob-1", "Content-Type": "application/json" },
      fetch: async (url, init) => {
        request = new Request(url, init);
        return Response.json(uploadResponse("image/png"), { status: 201 });
      },
    }, SESSION_ID, input, "image/png");

    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(`https://agent.example.test/api/v1/sessions/${SESSION_ID}/blobs`);
    expect(request!.headers.get("authorization")).toBe("Bearer service-key");
    expect(request!.headers.get("x-user-id")).toBe("u_sdk");
    expect(request!.headers.get("x-request-id")).toBe("request-blob-1");
    expect(request!.headers.get("content-type")).toBe("image/png");
    expect(request!.headers.get("accept")).toBe("application/json");
    expect(new Uint8Array(await request!.arrayBuffer())).toEqual(input);
    expect(result.response.status).toBe(201);
    expect(result.data).toEqual(uploadResponse("image/png"));
  });

  it("accepts Blob bodies, infers their image media type, and rejects a mismatched override", async () => {
    const input = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    let request: Request | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      request = new Request(url, init);
      return Response.json(uploadResponse("image/gif"), { status: 201 });
    });
    await uploadSessionBlob({
      baseUrl: "https://agent.example.test",
      fetch: fetchImpl,
    }, SESSION_ID, new Blob([input], { type: "image/gif" }));

    expect(request!.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await request!.arrayBuffer())).toEqual(input);

    await expect(uploadSessionBlob({
      baseUrl: "https://agent.example.test",
      fetch: fetchImpl,
    }, SESSION_ID, new Blob([input], { type: "image/gif" }), "image/png")).rejects.toThrow(
      "does not match Blob type",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads the exact response bytes instead of coercing binary content to JSON or text", async () => {
    const expected = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x01]);
    let request: Request | undefined;
    const result = await readSessionBlob({
      baseUrl: "https://agent.example.test",
      endUserToken: "end-user-key",
      fetch: async (url, init) => {
        request = new Request(url, init);
        return new Response(expected, { headers: { "Content-Type": "image/webp" } });
      },
    }, SESSION_ID, BLOB_ID);

    expect(request!.method).toBe("GET");
    expect(request!.url).toBe(`https://agent.example.test/v1/sessions/${SESSION_ID}/blobs/${BLOB_ID}`);
    expect(request!.headers.get("x-end-user-token")).toBe("end-user-key");
    expect(request!.headers.get("accept")).toContain("image/webp");
    expect(result.response.headers.get("content-type")).toBe("image/webp");
    expect(result.bytes).toEqual(expected);
    expectTypeOf(result.bytes).toEqualTypeOf<Uint8Array>();
  });

  it("reads an offloaded item output as typed JSON for the exact session/item route", async () => {
    const expected: ItemOutput = {
      content: [{ type: "text", text: "full output" }],
      details: { rows: 2 },
    };
    let request: Request | undefined;
    const result = await readItemOutput({
      baseUrl: "https://agent.example.test/root",
      userId: "u_sdk",
      fetch: async (url, init) => {
        request = new Request(url, init);
        return Response.json(expected);
      },
    }, SESSION_ID, ITEM_ID);

    expect(request!.url).toBe(`https://agent.example.test/root/v1/sessions/${SESSION_ID}/items/${ITEM_ID}/output`);
    expect(request!.headers.get("accept")).toBe("application/json");
    expect(result.data).toEqual(expected);
    expectTypeOf(result.data).toEqualTypeOf<ItemOutput>();
  });

  it("uses the shared structured HTTP error path", async () => {
    const response = Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    await expect(readSessionBlob({
      baseUrl: "https://agent.example.test",
      fetch: async () => response,
    }, SESSION_ID, BLOB_ID)).rejects.toMatchObject({
      name: "AgentServiceHttpError",
      response: { status: 404 },
      body: { error: { code: "not_found", message: "not found" } },
    });
  });
});
