import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { createRouterApp, type RouterAppDeps } from "../apps/agent-router/src/app.js";
import { createApp, type AppDeps } from "../apps/agent-runner/src/app.js";
import { Event, EventStreamEvent } from "../packages/protocol/src/index.js";

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
const OPENAPI_FILE = new URL("../packages/protocol/openapi.json", import.meta.url);

interface OpenApiOperation {
  operationId?: string;
  parameters?: { in?: string; name?: string }[];
  responses?: Record<string, unknown>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

interface RegisteredRoute {
  method: string;
  path: string;
}

let document: OpenApiDocument;

beforeAll(async () => {
  document = JSON.parse(await readFile(OPENAPI_FILE, "utf8")) as OpenApiDocument;
});

function unreachable<T extends object>(name: string): T {
  return new Proxy({}, {
    get() {
      throw new Error(`${name} must not be accessed while serving the public OpenAPI document`);
    },
  }) as T;
}

function runnerApp() {
  return createApp({
    store: unreachable<AppDeps["store"]>("store"),
    host: unreachable<AppDeps["host"]>("host"),
    providers: unreachable<AppDeps["providers"]>("providers"),
    tools: unreachable<AppDeps["tools"]>("tools"),
    runnerId: "contract-test",
    internalRouterToken: "contract-test-internal-token-0001",
    heartbeatMs: 60_000,
    maxBodyBytes: 1_000_000,
    ready: () => true,
    decryptSecret: async () => "unused",
    encryptSecret: async () => ({ ciphertext: Buffer.alloc(0), keyId: "unused" }),
  });
}

function routerApp() {
  return createRouterApp({
    registry: unreachable<RouterAppDeps["registry"]>("registry"),
    logger: { info() {}, warn() {}, error() {} },
  });
}

function specOperations() {
  const operations: { method: string; path: string; operationId: string | undefined }[] = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      operations.push({ method: method.toUpperCase(), path, operationId: operation.operationId });
    }
  }
  return operations;
}

function registeredOperations() {
  const routes = (runnerApp() as unknown as { routes: RegisteredRoute[] }).routes;
  return routes
    .filter(({ method }) => HTTP_METHODS.has(method.toLowerCase()))
    .filter(({ path }) => !path.startsWith("/v1/_internal/"))
    .map(({ method, path }) => ({
      method: method.toUpperCase(),
      path: path.replace(/:([^/]+)/g, "{$1}"),
    }));
}

const operationKey = ({ method, path }: { method: string; path: string }) => `${method} ${path}`;

describe("committed OpenAPI contract", () => {
  it.each([
    ["agent-runner", runnerApp],
    ["agent-router", routerApp],
  ] as const)("serves the exact committed document publicly from %s", async (_name, create) => {
    const response = await create().request("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(document);
  });

  it("has unique operationIds and contains no planned-only M3 or ghost routes", () => {
    const operations = specOperations();
    const operationIds = operations.map(({ operationId }) => operationId);

    expect(operations).toHaveLength(50);
    expect(operationIds.every((operationId) => typeof operationId === "string" && operationId.length > 0)).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const paths = Object.keys(document.paths);
    expect(paths.filter((path) => /\/(?:mcp-servers|skills|plugins|hooks)(?:\/|$)/i.test(path))).toEqual([]);
    expect(paths).not.toContain("/_router/targets");
    expect(paths).not.toContain("/v1/agents/{id}/versions");
    expect(paths).not.toContain("/v1/sessions/{id}/fork");
    expect(paths).toEqual(expect.arrayContaining([
      "/v1/sessions/{id}/blobs",
      "/v1/sessions/{id}/blobs/{blobId}",
      "/v1/sessions/{id}/items/{itemId}/output",
      "/v1/data-erasure-requests",
      "/v1/data-erasure-requests/{requestId}",
    ]));
  });

  it("keeps every domain event variant in the OpenAPI-safe SSE schema", () => {
    const domainTypes = Event.options.map((option) => option.shape.type.value).sort();
    const openApiTypes = EventStreamEvent.options.map((option) => option.shape.type.value).sort();

    expect(new Set(domainTypes).size).toBe(domainTypes.length);
    expect(new Set(openApiTypes).size).toBe(openApiTypes.length);
    expect(openApiTypes).toEqual(domainTypes);
  });

  it("only advertises sortDirection on the collection that implements it", () => {
    const queryNames = (path: string, method: string) =>
      (document.paths[path]?.[method]?.parameters ?? [])
        .filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name);

    expect(queryNames("/v1/agents", "get")).not.toContain("sortDirection");
    expect(queryNames("/v1/sessions", "get")).not.toContain("sortDirection");
    expect(queryNames("/v1/sessions/{id}/turns", "get")).toContain("sortDirection");
  });

  it("publishes protocol-unavailable and current-only input constraints", () => {
    expect(document.paths["/v1/capabilities"]?.get?.responses?.["503"]).toBeDefined();
    expect(document.components?.schemas?.ExcludableEventType).toMatchObject({
      type: "string",
      enum: [
        "item/reasoning/delta",
        "item/toolCall/argsDelta",
        "item/agentMessage/delta",
        "usage/updated",
        "heartbeat",
      ],
    });
    expect(document.components?.schemas?.StartTurnRequest).toMatchObject({
      properties: {
        input: {
          items: {
            oneOf: [
              { properties: { type: { enum: ["text"] } }, required: ["type", "text"] },
              { properties: { type: { enum: ["image"] } }, required: ["type", "blobId"] },
            ],
          },
        },
      },
    });
    expect(document.components?.schemas?.AgentDefinitionRequest).toMatchObject({
      properties: { mcpServers: { maxItems: 0 }, skills: { maxItems: 0 } },
    });
    expect(document.paths["/v1/retention-policies/{policyVersion}"]?.put?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "policyVersion",
          schema: expect.objectContaining({
            pattern: "^(?!active$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
          }),
        }),
      ]),
    );
    expect(document.components?.schemas?.RetentionPolicyPutRequest).toMatchObject({
      properties: {
        policy: {
          properties: {
            sessionContentRetentionMs: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            userErasureGraceMs: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            operationalUsageRetentionMs: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            idempotencyReceiptRetentionMs: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            billingFactRetentionMs: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            lifecycleAuditRetentionMs: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            exportArtifactTtlMs: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
      },
    });
    expect(document.components?.schemas?.ErrorBody).toMatchObject({
      properties: {
        error: {
          properties: {
            code: { enum: expect.arrayContaining(["session_has_children"]) },
          },
        },
      },
    });
    expect(document.components?.schemas?.Capabilities).toMatchObject({
      properties: {
        protocolVersion: { enum: ["2026-10-08"] },
        features: {
          properties: {
            erasureJobControl: {
              items: {
                enum: ["quarantine-v1", "legacy-tombstone-compensation-v1"],
              },
              maxItems: 2,
            },
            dataGovernance: {
              items: {
                enum: ["canonical-retention-v1", "multi-legal-hold-v1"],
              },
              maxItems: 2,
            },
            dataGovernanceManagement: {
              default: false,
              type: "boolean",
            },
          },
        },
      },
    });
  });

  it("matches all 49 implemented runner routes plus the OpenAPI route in both directions", () => {
    const registered = registeredOperations();
    const registeredKeys = registered.map(operationKey).sort();
    const specKeys = specOperations().map(operationKey).sort();

    expect(registered.filter(({ path }) => path !== "/openapi.json")).toHaveLength(49);
    expect(registered).toHaveLength(50);
    expect(new Set(registeredKeys).size).toBe(registeredKeys.length);
    expect(registeredKeys).toEqual(specKeys);
  });

  it("keeps the versioned router-to-runner tombstone route out of the public OpenAPI/SDK", () => {
    const routes = (runnerApp() as unknown as { routes: RegisteredRoute[] }).routes
      .filter(({ method }) => HTTP_METHODS.has(method.toLowerCase()))
      .map(({ method, path }) => ({ method: method.toUpperCase(), path }));

    expect(routes).toContainEqual({ method: "POST", path: "/v1/_internal/session-tombstone/:id" });
    expect(Object.keys(document.paths).some((path) => path.startsWith("/v1/_internal/"))).toBe(false);
  });
});
