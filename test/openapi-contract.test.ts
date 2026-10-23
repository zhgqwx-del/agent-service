import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { createRouterApp, type RouterAppDeps } from "../apps/agent-router/src/app.js";
import { createApp, type AppDeps } from "../apps/agent-runner/src/app.js";
import { Event, EventStreamEvent, INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH,
  INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX, INTERNAL_MCP_REGISTRY_CALLBACK_PATH, INTERNAL_MCP_REGISTRY_READY_PATH,
  MCP_OAUTH_CALLBACK_PATH, INTERNAL_RUNTIME_EXTENSIONS_READY_PATH,
  INTERNAL_PROVIDER_GATEWAY_READY_PATH, INTERNAL_SESSION_AUTHORITY_OWNER_PATH } from "../packages/protocol/src/index.js";

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
const OPENAPI_FILE = new URL("../packages/protocol/openapi.json", import.meta.url);
const MCP_OPERATIONS = [
  ["POST", "/v1/mcp-servers", "upsertMcpRegistration"],
  ["GET", "/v1/mcp-servers", "listMcpRegistrations"],
  ["GET", "/v1/mcp-servers/{name}", "getMcpRegistration"],
  ["DELETE", "/v1/mcp-servers/{name}", "deleteMcpRegistration"],
  ["POST", "/v1/mcp-servers/{name}/state", "setMcpRegistrationState"],
  ["GET", "/v1/mcp-servers/{name}/tools", "discoverMcpTools"],
  ["POST", "/v1/mcp-servers/{name}/refresh", "refreshMcpCatalog"],
  ["POST", "/v1/mcp-servers/{name}/oauth/begin", "beginMcpAuthorization"],
  ["GET", "/v1/mcp-servers/{name}/oauth/status", "getMcpAuthorization"],
  ["POST", "/v1/mcp-servers/{name}/oauth/disconnect", "disconnectMcpAuthorization"],
  ["POST", "/v1/mcp-servers/{name}/oauth/client/register", "registerMcpDynamicClient"],
  ["GET", "/v1/mcp-servers/{name}/oauth/client/status", "getMcpDynamicClientStatus"],
  ["POST", "/v1/platform/mcp-servers", "upsertPlatformMcpRegistration"],
  ["GET", "/v1/platform/mcp-servers", "listPlatformMcpRegistrations"],
  ["GET", "/v1/platform/mcp-servers/{name}", "getPlatformMcpRegistration"],
  ["DELETE", "/v1/platform/mcp-servers/{name}", "deletePlatformMcpRegistration"],
  ["POST", "/v1/platform/mcp-servers/{name}/state", "setPlatformMcpRegistrationState"],
  ["POST", "/v1/platform/mcp-servers/{name}/oauth/client/register", "registerPlatformMcpDynamicClient"],
  ["GET", "/v1/platform/mcp-servers/{name}/oauth/client/status", "getPlatformMcpDynamicClientStatus"],
  ["GET", MCP_OAUTH_CALLBACK_PATH, "completeMcpAuthorization"],
] as const;
const MCP_EDGE_OPERATION_KEYS = new Set(MCP_OPERATIONS.filter(([, path]) => path.startsWith("/v1/platform/") || path === MCP_OAUTH_CALLBACK_PATH)
  .map(([method, path]) => `${method} ${path}`));
const TENANT_HOOK_OPERATIONS = [
  ["POST", "/v1/tenant-hooks", "upsertTenantHook"], ["GET", "/v1/tenant-hooks", "listTenantHooks"],
  ["GET", "/v1/tenant-hooks/{name}", "getTenantHook"], ["DELETE", "/v1/tenant-hooks/{name}", "deleteTenantHook"],
  ["POST", "/v1/tenant-hooks/{name}/state", "setTenantHookState"],
  ["GET", "/v1/tenant-hooks/{name}/deliveries", "listTenantHookDeliveries"],
] as const;
const SUBAGENT_OPERATIONS = [
  ["GET", "/v1/sessions/{id}/subagents", "listSubagentTasks"],
  ["GET", "/v1/sessions/{id}/subagents/{taskId}", "getSubagentTask"],
  ["POST", "/v1/sessions/{id}/subagents/{taskId}/approvals/{approvalId}", "resolveSubagentApproval"],
  ["POST", "/v1/sessions/{id}/subagents/{taskId}/tool-results", "submitSubagentToolResult"],
  ["POST", "/v1/sessions/{id}/subagents/{taskId}/interrupt", "interruptSubagentTask"],
  ["DELETE", "/v1/sessions/{id}/subagents/{taskId}/session", "deleteSubagentSession"],
] as const;

interface OpenApiOperation {
  operationId?: string;
  parameters?: { in?: string; name?: string }[];
  responses?: Record<string, unknown>;
  requestBody?: unknown;
  security?: Record<string, unknown>[];
  "x-required-api-key-scopes"?: string[];
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
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
    // The fresh capture probe is a private, token-authenticated runner control route outside
    // the older /v1/_internal namespace. Exclude this exact route, not arbitrary ghost paths.
    .filter(({ path }) => path !== INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH)
    // The new POST is also a private nonce/token probe, not a tenant runtime operation.
    // Keep an exact exclusion; an arbitrary ghost route must still fail the bidirectional set.
    .filter(({ path }) => path !== INTERNAL_RUNTIME_EXTENSIONS_READY_PATH)
    // This exact nonce/token admission probe is private; no public runtime route was added.
    .filter(({ path }) => path !== INTERNAL_PROVIDER_GATEWAY_READY_PATH)
    // Session ownership observation is a private nonce/token probe, outside the public API.
    .filter(({ path }) => path !== INTERNAL_SESSION_AUTHORITY_OWNER_PATH)
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
  ] as const)("serves the exact committed document artifact from %s", async (_name, create) => {
    const response = await create().request("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(document);
  });

  it("has unique operationIds and contains no planned-only M3 or ghost routes", () => {
    const operations = specOperations();
    const operationIds = operations.map(({ operationId }) => operationId);

    expect(operations).toHaveLength(100);
    expect(operationIds.every((operationId) => typeof operationId === "string" && operationId.length > 0)).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const paths = Object.keys(document.paths);
    expect(paths.filter((path) => /\/(?:plugins|hooks)(?:\/|$)/i.test(path))).toEqual([]);
    expect(operations.filter(({ path }) => /\/mcp-servers(?:\/|$)/.test(path) || path === MCP_OAUTH_CALLBACK_PATH)
      .map(({ method, path, operationId }) => [method, path, operationId].join(" ")).sort())
      .toEqual(MCP_OPERATIONS.map(operation => operation.join(" ")).sort());
    expect(operations.filter(({ path }) => /^\/v1\/tenant-hooks(?:\/|$)/.test(path))
      .map(({ method, path, operationId }) => [method, path, operationId].join(" ")).sort())
      .toEqual(TENANT_HOOK_OPERATIONS.map(operation => operation.join(" ")).sort());
    expect(operations.filter(({ path }) => /\/subagents(?:\/|$)/.test(path))
      .map(({ method, path, operationId }) => [method, path, operationId].join(" ")).sort())
      .toEqual(SUBAGENT_OPERATIONS.map(operation => operation.join(" ")).sort());
    expect(paths.filter((path) => /\/skills(?:\/|$)/.test(path)).sort()).toEqual([
      "/v1/platform/skills", "/v1/platform/skills/{name}", "/v1/platform/skills/{name}/versions", "/v1/platform/skills/{name}/versions/{versionId}",
      "/v1/skills", "/v1/skills/export", "/v1/skills/{name}", "/v1/skills/{name}/versions", "/v1/skills/{name}/versions/{versionId}",
    ].sort());
    expect(paths).not.toContain("/_router/targets");
    expect(paths).not.toContain(INTERNAL_SESSION_AUTHORITY_OWNER_PATH);
    expect(paths).not.toContain("/v1/agents/{id}/versions");
    expect(paths).not.toContain("/v1/sessions/{id}/fork");
    expect(paths).toEqual(expect.arrayContaining([
      "/v1/sessions/{id}/blobs",
      "/v1/sessions/{id}/blobs/{blobId}",
      "/v1/sessions/{id}/items/{itemId}/output",
      "/v1/data-erasure-requests",
      "/v1/data-erasure-requests/{requestId}",
      "/v1/data-export-requests",
      "/v1/data-export-requests/{requestId}",
      "/v1/data-export-requests/{requestId}/download",
      "/v1/tenant-erasure-requests",
      "/v1/tenant-erasure-requests/{requestId}",
    ]));
  });

  it("keeps every domain event variant in the OpenAPI-safe SSE schema", () => {
    const domainTypes = Event.options.map((option) => option.shape.type.value).sort();
    const openApiTypes = EventStreamEvent.options.map((option) => option.shape.type.value).sort();

    expect(new Set(domainTypes).size).toBe(domainTypes.length);
    expect(new Set(openApiTypes).size).toBe(openApiTypes.length);
    expect(openApiTypes).toEqual(domainTypes);
  });

  it("retains seq on every persisted SSE variant and omits it only on live-only variants", () => {
    const generated = document.components?.schemas?.Event as {
      oneOf: { properties: Record<string, { type?: string; enum?: string[]; minimum?: number }>; required: string[] }[];
    };
    expect(generated.oneOf.map((option) => option.properties.type?.enum?.[0]).sort())
      .toEqual(Event.options.map((option) => option.shape.type.value).sort());
    for (const domainOption of Event.options) {
      const type = domainOption.shape.type.value;
      const wireOption = EventStreamEvent.options.find((option) => option.shape.type.value === type);
      const documentOption = generated.oneOf.find((option) => option.properties.type?.enum?.[0] === type)!;
      expect(wireOption, type).toBeDefined();
      if (domainOption.shape.seq.isOptional()) {
        expect(wireOption!.shape, type).not.toHaveProperty("seq");
        expect(documentOption.properties, type).not.toHaveProperty("seq");
        expect(documentOption.required, type).not.toContain("seq");
      } else {
        expect(wireOption!.shape, type).toHaveProperty("seq", domainOption.shape.seq);
        expect(documentOption.properties.seq, type).toMatchObject({ type: "integer", minimum: 0 });
        expect(documentOption.required, type).toContain("seq");
      }
    }
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
        "item/mcpToolCall/progress",
        "item/agentMessage/delta",
        "usage/updated",
        "heartbeat",
      ],
    });
    for (const request of ["StartTurnRequest", "SteerRequest"]) {
      expect(document.components?.schemas?.[request], request).toMatchObject({
        properties: {
          input: {
            items: {
              oneOf: [
                { properties: { type: { enum: ["text"] } }, required: ["type", "text"] },
                { properties: { type: { enum: ["image"] } }, required: ["type", "blobId"] },
                {
                  properties: {
                    type: { enum: ["skill"] },
                    name: { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 },
                    args: { maxLength: 8192 },
                  },
                  required: ["type", "name"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
      });
    }
    expect(document.components?.schemas?.AgentDefinitionRequest).toMatchObject({
      properties: { mcpServers: { maxItems: 8 }, mcpRegistrations: { maxItems: 8, default: [],
        items: { additionalProperties: false, required: ["scope", "name"], properties: {
          scope: { enum: ["platform", "tenant", "user"] }, name: { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 },
        } } }, skills: { maxItems: 8 } },
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
            userDataExport: {
              items: { enum: ["artifact-ndjson-v1"] },
              maxItems: 1,
            },
            dataExportRequests: {
              default: false,
              type: "boolean",
            },
            tenantErasureControl: {
              items: { enum: ["platform-control-v1"] },
              maxItems: 1,
            },
            tenantErasureRequests: {
              default: false,
              type: "boolean",
            },
            tenantRestoreJournal: {
              items: { enum: ["independent-restore-journal-v1"] },
              maxItems: 1,
            },
            tenantRestoreJournalWorker: {
              default: false,
              type: "boolean",
            },
            tenantRestoreJournalNamespaceSha256: {
              default: null,
              pattern: "^[0-9a-f]{64}$",
            },
            tenantRestoreJournalTargetRootSha256: {
              default: null,
              pattern: "^[0-9a-f]{64}$",
            },
            tenantRestoreRuntimeEpochSha256: {
              default: null,
              pattern: "^[0-9a-f]{64}$",
            },
          },
        },
      },
    });
  });

  it("publishes the private admin-and-user data export contract", () => {
    const post = document.paths["/v1/data-export-requests"]?.post;
    const status = document.paths["/v1/data-export-requests/{requestId}"]?.get;
    const download = document.paths["/v1/data-export-requests/{requestId}/download"]?.get;
    for (const operation of [post, status, download]) {
      expect(operation?.security).toEqual([
        { ServiceApiKey: [], TrustedCallerUser: [] },
        { EndUserToken: [], ServiceApiKey: [] },
      ]);
      expect(operation?.["x-required-api-key-scopes"]).toEqual(["admin"]);
    }
    expect(post?.requestBody).toBeUndefined();
    expect(post?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "header", name: "idempotency-key", required: true }),
    ]));

    const postResponses = post?.responses as Record<string, {
      headers?: Record<string, unknown>;
      content?: Record<string, unknown>;
    }>;
    const statusResponses = status?.responses as typeof postResponses;
    const downloadResponses = download?.responses as typeof postResponses;
    for (const response of [
      postResponses["202"],
      postResponses.default,
      statusResponses["200"],
      statusResponses.default,
      downloadResponses["200"],
      downloadResponses.default,
    ]) {
      expect(response?.headers).toEqual(expect.objectContaining({
        "Cache-Control": expect.any(Object),
        "X-Content-Type-Options": expect.any(Object),
      }));
    }
    expect(downloadResponses["200"]?.content).toHaveProperty(
      "application/vnd.agent-service.user-export+ndjson",
    );
    expect(downloadResponses["200"]?.headers).toEqual(expect.objectContaining({
      "Content-Disposition": expect.any(Object),
      "Content-Digest": expect.any(Object),
      "Content-Length": expect.not.objectContaining({ required: true }),
      "X-Artifact-Size": expect.any(Object),
    }));

    const exportSchema = document.components?.schemas?.DataExportRequest as {
      oneOf?: { additionalProperties?: boolean; properties?: Record<string, unknown> }[];
    };
    expect(exportSchema.oneOf).toHaveLength(6);
    expect(exportSchema.oneOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
    expect(exportSchema.oneOf?.filter((branch) => "artifact" in (branch.properties ?? {}))).toHaveLength(1);
  });

  it("publishes an independent platform-only tenant-erasure control plane", () => {
    expect(document.components?.securitySchemes?.PlatformOperatorToken).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    const post = document.paths["/v1/tenant-erasure-requests"]?.post;
    const status = document.paths["/v1/tenant-erasure-requests/{requestId}"]?.get;
    expect(post?.security).toEqual([{ PlatformOperatorToken: [] }]);
    expect(status?.security).toEqual([{ PlatformOperatorToken: [] }]);
    expect(post?.["x-required-api-key-scopes"]).toBeUndefined();
    expect(status?.["x-required-api-key-scopes"]).toBeUndefined();
    expect(post?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "header", name: "idempotency-key", required: true }),
    ]));
    expect(status?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "query", name: "tenantId", required: true }),
    ]));
    for (const response of [
      post?.responses?.["202"],
      post?.responses?.default,
      status?.responses?.["200"],
      status?.responses?.default,
    ] as Array<{ headers?: Record<string, unknown> } | undefined>) {
      expect(response?.headers).toEqual(expect.objectContaining({
        "Cache-Control": expect.any(Object),
        "X-Content-Type-Options": expect.any(Object),
      }));
    }
  });

  it("matches all 83 tenant-runtime runner routes plus the OpenAPI route in both directions", () => {
    const registered = registeredOperations();
    const registeredKeys = registered.map(operationKey).sort();
    // Tenant erasure is an edge-owned platform control plane. The router authenticates its
    // independent bearer credential and rewrites onto a versioned runner-only route; direct
    // runners intentionally do not register those two public paths.
    const specKeys = specOperations()
      .filter(({ path }) => !path.startsWith("/v1/tenant-erasure-requests"))
      .filter(({ path }) => !path.startsWith("/v1/platform/skills"))
      .filter(operation => !MCP_EDGE_OPERATION_KEYS.has(operationKey(operation)))
      .map(operationKey)
      .sort();

    expect(registered.filter(({ path }) => path !== "/openapi.json")).toHaveLength(83);
    expect(registered).toHaveLength(84);
    expect(new Set(registeredKeys).size).toBe(registeredKeys.length);
    expect(registeredKeys).toEqual(specKeys);
  });

  it("keeps managed MCP registration ownership, actual-user OAuth and independent platform authority distinct", () => {
    expect(MCP_EDGE_OPERATION_KEYS.size).toBe(8);
    for (const [method, path] of MCP_OPERATIONS) {
      const operation = document.paths[path]?.[method.toLowerCase()]; expect(operation, `${method} ${path}`).toBeDefined();
      if (path.startsWith("/v1/platform/")) expect(operation!.security).toEqual([{ McpRegistryOperatorToken: [] }]);
      else if (path === MCP_OAUTH_CALLBACK_PATH) expect(operation!.security).toEqual([]);
      else if (/\/(?:tools|refresh|oauth\/(?:begin|status|disconnect))$/.test(path)) {
        expect(operation!.security).toEqual([{ ServiceApiKey: [], TrustedCallerUser: [] }, { ServiceApiKey: [], EndUserToken: [] }]);
        expect(operation).not.toHaveProperty("x-required-api-key-scopes");
      }
      if (method === "DELETE" || method === "POST" && !path.endsWith("/refresh")) expect(operation!.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idempotency-key", in: "header", required: true }),
      ]));
    }
    expect(document.components?.securitySchemes?.McpRegistryOperatorToken).toMatchObject({ type: "http", scheme: "bearer" });
    expect(document.components?.securitySchemes?.McpRegistryOperatorToken).not.toEqual(document.components?.securitySchemes?.PlatformOperatorToken);
    expect(document.components?.securitySchemes?.McpRegistryOperatorToken).not.toEqual(document.components?.securitySchemes?.SkillRegistryOperatorToken);
    const runnerRoutes = registeredOperations().map(operationKey);
    for (const operation of MCP_EDGE_OPERATION_KEYS) expect(runnerRoutes).not.toContain(operation);
    const routerRoutes = (routerApp() as unknown as { routes: RegisteredRoute[] }).routes;
    expect(routerRoutes).toContainEqual(expect.objectContaining({ method: "GET", path: MCP_OAUTH_CALLBACK_PATH }));
    expect(routerRoutes).toContainEqual(expect.objectContaining({ method: "ALL", path: "/v1/platform/mcp-servers" }));
    expect(routerRoutes).toContainEqual(expect.objectContaining({ method: "POST", path: INTERNAL_MCP_REGISTRY_READY_PATH }));
  });

  it("publishes strict MCP CAS/OAuth inputs while excluding write-only and internal authority from responses", () => {
    interface Schema { $ref?: string; properties?: Record<string, Schema>; anyOf?: Schema[]; enum?: string[]; [key: string]: unknown }
    const resolve = (schema: unknown): Schema => {
      let value = schema as Schema;
      for (let depth = 0; value?.$ref && depth < 8; depth++) {
        expect(value.$ref).toMatch(/^#\/components\/schemas\//);
        value = document.components?.schemas?.[value.$ref.split("/").at(-1)!] as Schema;
      }
      expect(value).toBeDefined(); expect(value).not.toHaveProperty("$ref"); return value;
    };
    const request = resolve(document.components?.schemas?.McpRegistrationUpsertRequest);
    expect(request).toMatchObject({ additionalProperties: false, required: ["scope", "name", "expectedRevision", "config"],
      properties: { scope: { enum: ["tenant", "user"] }, expectedRevision: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } });
    const config = resolve(request.properties!.config);
    expect(config).toMatchObject({ additionalProperties: false, required: ["endpoint", "description", "protocolVersion", "authentication"],
      properties: { protocolVersion: { enum: ["2026-07-28", "2025-11-25"] } } });
    const authentication = resolve(config.properties!.authentication);
    expect(authentication.anyOf).toHaveLength(3);
    const oauth = authentication.anyOf!.map(resolve).find(option => option.properties?.kind?.enum?.[0] === "oauth")!;
    expect(oauth).toMatchObject({ additionalProperties: false, properties: {
      clientAuthentication: { enum: ["none", "client_secret_basic"] },
      clientSecret: { maxLength: 8192, description: expect.stringContaining("Write-only") },
      scopes: { maxItems: 32, default: [], items: { pattern: expect.any(String) } },
    } });
    for (const field of ["authorizationEndpoint", "tokenEndpoint", "redirectUri", "metadataSha256", "headers", "clientProfileId"]) expect(oauth.properties).not.toHaveProperty(field);
    const none = authentication.anyOf!.map(resolve).find(option => option.properties?.kind?.enum?.[0] === "none")!;
    expect(Object.keys(none.properties!)).toEqual(["kind"]);
    const dynamic = authentication.anyOf!.map(resolve).find(option => option.properties?.kind?.enum?.[0] === "oauth_dynamic")!;
    expect(dynamic).toMatchObject({ additionalProperties: false, properties: { clientAuthentication: { enum: ["none", "client_secret_basic"] } } });
    expect(Object.keys(dynamic.properties!).sort()).toEqual(["kind", "issuer", "clientAuthentication", "scopes"].sort());
    const responses = JSON.stringify([document.components?.schemas?.McpRegistrationResponse,
      document.components?.schemas?.McpInstalledRegistrationResponse, document.components?.schemas?.McpRegistrationListResponse,
      document.components?.schemas?.McpAuthorizationStatusResponse, document.components?.schemas?.McpDynamicClientStatusResponse]);
    for (const field of ["clientSecret", "authorizationEndpoint", "tokenEndpoint", "redirectUri", "metadataSha256", "accessToken", "refreshToken", "pkceVerifier", "stateSha256", "claimToken", "subject", "tenantId", "userId"])
      expect(responses).not.toMatch(new RegExp(`"${field}"\\s*:`));
    expect(document.components?.schemas?.McpAuthorizationDisconnectRequest).toMatchObject({ additionalProperties: false,
      required: ["scope", "expectedAuthorizationEpoch"], properties: { expectedAuthorizationEpoch: { minimum: 0 } } });
    const callback = document.paths[MCP_OAUTH_CALLBACK_PATH]!.get!;
    expect(callback.parameters?.filter(parameter => parameter.in === "query").map(parameter => parameter.name).sort())
      .toEqual(["code", "error", "error_description", "iss", "state"].sort());
    expect(callback.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "state", in: "query", required: true,
      schema: expect.objectContaining({ pattern: "^[A-Za-z0-9_-]{43}$" }) })]));
    for (const status of ["200", "400"]) expect(callback.responses?.[status]).toMatchObject({
      headers: { "Cache-Control": expect.any(Object), "X-Content-Type-Options": expect.any(Object) }, content: { "text/html": expect.any(Object) },
    });
    const completedHeaders = (callback.responses?.["200"] as { headers: Record<string, unknown> }).headers;
    expect(Object.keys(completedHeaders).sort()).toEqual(["Cache-Control", "X-Content-Type-Options", "Referrer-Policy"].sort());
    expect(completedHeaders).toMatchObject({
      "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
      "X-Content-Type-Options": { schema: { type: "string", enum: ["nosniff"] } },
      "Referrer-Policy": { schema: { type: "string", enum: ["no-referrer"] } },
    });
  });

  it("publishes registry CAS, immutable selection and the separate platform operator credential exactly", () => {
    for (const path of ["/v1/skills", "/v1/platform/skills"]) {
      expect(document.paths[path]?.post?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idempotency-key", in: "header", required: true }),
      ]));
    }
    expect(document.paths["/v1/platform/skills"]?.post?.security).toEqual([{ SkillRegistryOperatorToken: [] }]);
    expect(document.components?.securitySchemes?.SkillRegistryOperatorToken).toMatchObject({ type: "http", scheme: "bearer" });
    expect(document.components?.schemas?.SkillInstallRequest).toMatchObject({ additionalProperties: false,
      required: ["scope", "document", "expectedRevision"], properties: { scope: { enum: ["tenant", "user"] }, expectedRevision: { minimum: 0 } } });
    expect(document.components?.schemas?.StartTurnRequest).toMatchObject({ properties: { skillOverrides: { maxItems: 8,
      items: { additionalProperties: false, required: ["name", "versionId"], properties: { versionId: { format: "uuid" } } } } } });
    expect(document.components?.schemas?.SteerRequest).not.toHaveProperty("properties.skillOverrides");
    expect(document.components?.schemas?.SkillExportResponse).toMatchObject({ additionalProperties: false,
      properties: { schema: { enum: ["user-skill-registry-export-v1"] }, scope: { enum: ["user"] }, physicalErasureComplete: { enum: [false] } } });
    expect(document.paths["/v1/skills/export"]?.get?.parameters?.some(p => p.name === "scope")).toBe(false);
  });

  it("publishes only admin tenant observer paths, explicit CAS and content-free response metadata", () => {
    for (const [method, path] of TENANT_HOOK_OPERATIONS) {
      const operation = document.paths[path]?.[method.toLowerCase()];
      expect(operation?.security).toEqual([{ ServiceApiKey: [] }]);
      expect(operation?.["x-required-api-key-scopes"]).toEqual(["admin"]);
      if (method !== "GET") expect(operation?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idempotency-key", in: "header", required: true }),
      ]));
    }
    expect(document.components?.schemas?.TenantHookUpsertRequest).toMatchObject({ additionalProperties: false,
      required: ["name", "expectedRevision", "config", "signingKey"], properties: {
        signingKey: { pattern: "^[a-f0-9]{64}$", writeOnly: true },
        disclosureAck: { enum: ["tenant-admin-body-disclosure-v1"] },
      } });
    const responses = JSON.stringify([document.components?.schemas?.TenantHookResponse,
      document.components?.schemas?.InstalledTenantHookResponse, document.components?.schemas?.TenantHookListResponse,
      document.components?.schemas?.TenantHookDeliveriesResponse]);
    for (const field of ["signingKey", "keyCommitmentSha256", "payload", "ciphertext", "tag", "adminApiKeyId", "tenantId", "userId", "arguments", "prompt", "result"])
      expect(responses).not.toMatch(new RegExp(`"${field}"\\s*:`));
  });

  it("keeps every router-to-runner control route out of the public OpenAPI/SDK", async () => {
    const routes = (runnerApp() as unknown as { routes: RegisteredRoute[] }).routes
      .filter(({ method }) => HTTP_METHODS.has(method.toLowerCase()))
      .map(({ method, path }) => ({ method: method.toUpperCase(), path }));

    expect(routes).toContainEqual({ method: "POST", path: "/v1/_internal/session-tombstone/:id" });
    expect(routes).toContainEqual({
      method: "POST",
      path: "/v1/_internal/tenant-erasure-control-v1",
    });
    expect(routes).toContainEqual({
      method: "GET",
      path: "/v1/_internal/tenant-erasure-control-v1/:requestId",
    });
    expect(routes).toContainEqual({
      method: "POST",
      path: "/v1/_internal/tenant-erasure-replay-v1",
    });
    expect(routes).toContainEqual({
      method: "GET",
      path: INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH,
    });
    expect(routes).toContainEqual({ method: "GET", path: INTERNAL_MCP_REGISTRY_CALLBACK_PATH });
    expect(routes).toContainEqual({ method: "POST", path: INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX });
    expect(routes.filter(({ path }) => path === INTERNAL_RUNTIME_EXTENSIONS_READY_PATH))
      .toEqual([{ method: "POST", path: INTERNAL_RUNTIME_EXTENSIONS_READY_PATH }]);
    expect(routes.filter(({ path }) => path === INTERNAL_PROVIDER_GATEWAY_READY_PATH))
      .toEqual([{ method: "POST", path: INTERNAL_PROVIDER_GATEWAY_READY_PATH }]);
    expect(createRouterApp({ registry: unreachable("registry") } as RouterAppDeps).routes
      .filter(({ method, path }) => method !== "ALL" && path === INTERNAL_PROVIDER_GATEWAY_READY_PATH)
      .map(({ method, path }) => ({ method, path })))
      .toEqual([{ method: "POST", path: INTERNAL_PROVIDER_GATEWAY_READY_PATH }]);
    expect(routes).not.toContainEqual({ method: "GET", path: MCP_OAUTH_CALLBACK_PATH });
    expect(Object.keys(document.paths).some((path) => path.startsWith("/v1/_internal/"))).toBe(false);
    expect(Object.keys(document.paths).some((path) => path.startsWith("/_internal/"))).toBe(false);
    const sdkSchema = await readFile(new URL("../packages/sdk/src/generated/schema.ts", import.meta.url), "utf8");
    expect(sdkSchema).not.toContain(INTERNAL_PERSISTED_PROVIDER_CAPTURE_READY_PATH);
    expect(sdkSchema).not.toContain(INTERNAL_MCP_REGISTRY_CALLBACK_PATH);
    expect(sdkSchema).not.toContain(INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX);
    expect(sdkSchema).not.toContain(INTERNAL_MCP_REGISTRY_READY_PATH);
    expect(sdkSchema).not.toContain(INTERNAL_RUNTIME_EXTENSIONS_READY_PATH);
    expect(sdkSchema).not.toContain(INTERNAL_PROVIDER_GATEWAY_READY_PATH);
    expect(sdkSchema).not.toContain("/v1/_internal/");
    expect(sdkSchema).not.toContain("/_internal/");
  });
});
