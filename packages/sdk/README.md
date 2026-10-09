# @agent-service/sdk

TypeScript client for the public `agent-service` OpenAPI contract. Route, request and response types in `src/generated/schema.ts` are generated; do not edit that file by hand.

```ts
import { createAgentServiceClient } from "@agent-service/sdk";

const client = createAgentServiceClient({
  baseUrl: "http://127.0.0.1:8080",
  serviceApiKey: process.env.AGENT_SERVICE_API_KEY,
  userId: "u_42",
});

const { data, error } = await client.GET("/v1/sessions/{id}", {
  params: { path: { id: "sess_..." } },
});
```

Tenant-wide erasure uses a separate platform authority. Create its deliberately narrow client
instead of placing that credential in `serviceApiKey`:

```ts
import { createAgentServicePlatformClient } from "@agent-service/sdk";

const platform = createAgentServicePlatformClient({
  baseUrl: "http://127.0.0.1:8080",
  platformOperatorToken: process.env.AGENT_SERVICE_PLATFORM_OPERATOR_TOKEN!,
});

await platform.POST("/v1/tenant-erasure-requests", {
  params: { header: { "idempotency-key": "tenant-offboarding-123" } },
  body: { tenantId: "tenant-a" },
});
```

Streaming endpoints use incremental SSE helpers so model output is not buffered:

```ts
import { startTurnStream, subscribeSessionEvents } from "@agent-service/sdk";

const auth = {
  baseUrl: "http://127.0.0.1:8080",
  serviceApiKey: process.env.AGENT_SERVICE_API_KEY,
  userId: "u_42",
};

const started = await startTurnStream(auth, "sess_...", {
  input: [{ type: "text", text: "你好" }],
}, { idempotencyKey: "request-1" });

if (started.kind === "events") {
  for await (const event of started.events) {
    console.log(event.data.type);
  }
} else {
  // A completed Idempotency-Key replay is JSON, not a second event stream.
  console.log(started.data.turn);
}

const resumed = await subscribeSessionEvents(auth, "sess_...", { after: 12 });
for await (const event of resumed.events) console.log(event.id, event.data);
```

Use `pnpm generate:api` after changing protocol/HTTP schemas. `pnpm check:api` is read-only and fails when the committed OpenAPI document, runtime document or SDK types are stale.
