import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AgentServiceHttpError,
  type StartTurnInput,
  createAgentServiceClient,
  startTurnStream,
  subscribeSessionEvents,
} from "../src/client.js";

const SESSION_ID = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";

describe("generated SDK client", () => {
  it("types the current turn contract as text-only", () => {
    expectTypeOf<StartTurnInput["input"][number]["type"]>().toEqualTypeOf<"text">();
  });

  it("performs a typed GET with service, trusted-user, and tenant-specific end-user authentication", async () => {
    const serviceApiKey = "service-secret-must-stay-in-authorization";
    const endUserToken = "end-user-secret-must-stay-in-custom-header";
    const requests: Request[] = [];
    const responseBody = {
      id: SESSION_ID,
      tenantId: "t_sdk",
      userId: "u_sdk",
      agentId: "agt_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b",
      agentVersion: 1,
      status: { type: "idle" },
      lastSeq: 1,
      contextEpoch: "epoch",
      fenceToken: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
      autoApprovedTools: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      metadata: {},
    };
    const client = createAgentServiceClient({
      baseUrl: "https://agent.example.test",
      serviceApiKey,
      userId: "u_sdk",
      endUserToken,
      endUserTokenHeader: "X-Tenant-End-User-Token",
      headers: { "X-Request-Id": "request-1" },
      fetch: async (request) => {
        requests.push(request);
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await client.GET("/v1/sessions/{id}", {
      params: { path: { id: SESSION_ID } },
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url).toBe(`https://agent.example.test/v1/sessions/${SESSION_ID}`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${serviceApiKey}`);
    expect(request.headers.get("x-user-id")).toBe("u_sdk");
    expect(request.headers.get("x-tenant-end-user-token")).toBe(endUserToken);
    expect(request.headers.get("x-end-user-token")).toBeNull();
    expect(request.headers.get("x-request-id")).toBe("request-1");
    expect(await request.clone().text()).toBe("");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual(responseBody);
    if (result.data) expectTypeOf(result.data.id).toEqualTypeOf<string>();

    const nonHeaderSurfaces = [request.url, await request.clone().text(), JSON.stringify(result.data), JSON.stringify(result.error)];
    for (const surface of nonHeaderSurfaces) {
      expect(surface ?? "").not.toContain(serviceApiKey);
      expect(surface ?? "").not.toContain(endUserToken);
    }
  });

  it("subscribes to typed SSE events with replay and authentication headers", async () => {
    let request: Request | undefined;
    const result = await subscribeSessionEvents({
      baseUrl: "https://agent.example.test/api/",
      serviceApiKey: "service-key",
      userId: "u_sdk",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(`event: heartbeat\ndata: {"type":"heartbeat","sessionId":"${SESSION_ID}","emittedAtMs":7}\n\n`, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      },
    }, SESSION_ID, {
      after: 4,
      lastEventId: 3,
      exclude: ["heartbeat", "usage/updated"],
    });

    expect(request!.url).toBe(
      `https://agent.example.test/api/v1/sessions/${SESSION_ID}/events?after=4&exclude=heartbeat%2Cusage%2Fupdated`,
    );
    expect(request!.headers.get("authorization")).toBe("Bearer service-key");
    expect(request!.headers.get("x-user-id")).toBe("u_sdk");
    expect(request!.headers.get("last-event-id")).toBe("3");
    expect(request!.headers.get("accept")).toBe("text/event-stream");

    const first = await result.events.next();
    expect(first.value?.data).toEqual({ type: "heartbeat", sessionId: SESSION_ID, emittedAtMs: 7 });
    await result.events.return(undefined);
  });

  it("starts a streaming turn without buffering SSE and handles idempotent JSON replay", async () => {
    const requests: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) {
        return new Response(`data: {"type":"heartbeat","sessionId":"${SESSION_ID}","emittedAtMs":8}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({ turn: { id: "turn_replayed" } });
    };
    const options = {
      baseUrl: "https://agent.example.test",
      serviceApiKey: "service-key",
      userId: "u_sdk",
      fetch: fetchImpl,
    };
    const input = { input: [{ type: "text" as const, text: "hello" }] };

    const streamed = await startTurnStream(options, SESSION_ID, input, {
      idempotencyKey: "request-1",
      exclude: "item/reasoning/delta",
    });
    expect(streamed.kind).toBe("events");
    if (streamed.kind === "events") {
      expect((await streamed.events.next()).value?.data.type).toBe("heartbeat");
      await streamed.events.return(undefined);
    }
    expect(requests[0]!.url).toBe(
      `https://agent.example.test/v1/sessions/${SESSION_ID}/turns?exclude=item%2Freasoning%2Fdelta`,
    );
    expect(requests[0]!.headers.get("idempotency-key")).toBe("request-1");
    expect(await requests[0]!.clone().json()).toEqual({ input: [{ type: "text", text: "hello" }], stream: true });

    const replayed = await startTurnStream(options, SESSION_ID, input, { idempotencyKey: "request-1" });
    expect(replayed).toMatchObject({ kind: "replay", data: { turn: { id: "turn_replayed" } } });
  });

  it("surfaces structured streaming HTTP failures without including credentials in the message", async () => {
    const secret = "must-not-appear";
    let error: unknown;
    try {
      await subscribeSessionEvents({
        baseUrl: "https://agent.example.test",
        serviceApiKey: secret,
        fetch: async () => Response.json({ error: { code: "unauthorized", message: "bad key" } }, { status: 401 }),
      }, SESSION_ID);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AgentServiceHttpError);
    expect((error as AgentServiceHttpError).response.status).toBe(401);
    expect((error as AgentServiceHttpError).body).toEqual({ error: { code: "unauthorized", message: "bad key" } });
    expect((error as Error).message).not.toContain(secret);
  });
});
