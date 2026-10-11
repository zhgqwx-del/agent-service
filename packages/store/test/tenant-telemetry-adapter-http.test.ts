import { afterEach, describe, expect, it } from "vitest";
import {
  HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
  HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  HttpTenantTelemetryWriteAdapter,
  TenantTelemetryWriteAdapterConflictError,
  TenantTelemetryWriteAdapterTemporaryError,
  tenantTelemetryWriteAdapterResult,
  type HttpTenantTelemetryWriteRequest,
} from "../src/index.js";
import { telemetryAdapterFixture } from "./tenant-telemetry-adapter.fixture.js";

const adapters: HttpTenantTelemetryWriteAdapter[] = [];
const D = (character: string) => character.repeat(64);

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function httpAdapter(
  fetchImpl: typeof fetch,
  target: { targetSha256: string; receiptSha256: string },
  options: Partial<ConstructorParameters<typeof HttpTenantTelemetryWriteAdapter>[0]> = {},
): HttpTenantTelemetryWriteAdapter {
  const adapter = new HttpTenantTelemetryWriteAdapter({
    endpointUrl: "http://127.0.0.1:4318/collector",
    expectedTargets: [{
      targetSha256: target.targetSha256,
      targetReceiptSha256: target.receiptSha256,
    }],
    allowInsecureHttpForLocalTest: true,
    fetchImpl,
    ...options,
  });
  adapters.push(adapter);
  return adapter;
}

describe("HttpTenantTelemetryWriteAdapter", () => {
  it("uses a closed create/inspect protocol without transmitting raw owner ids or config", async () => {
    const fixture = await telemetryAdapterFixture(
      HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
      "raw-tenant-must-not-leave-the-process",
    );
    const seenBodies: string[] = [];
    const seenUrls: string[] = [];
    const seenAuthorization: boolean[] = [];
    const seenRedirects: Array<string | undefined> = [];
    let created = false;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const raw = String(init?.body ?? "");
      seenBodies.push(raw);
      seenUrls.push(String(input));
      seenRedirects.push(init?.redirect);
      seenAuthorization.push(
        new Headers(init?.headers).get("authorization") === "Bearer sink-super-secret",
      );
      const envelope = JSON.parse(raw) as HttpTenantTelemetryWriteRequest;
      expect(envelope.protocol).toBe(HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL);
      expect(envelope.targetSha256).toBe(fixture.input.target.targetSha256);
      expect(envelope.targetReceiptSha256).toBe(fixture.input.target.receiptSha256);
      expect(envelope.writeOperationSha256).toBe(fixture.input.writeOperationSha256);
      if (envelope.action === "inspect") {
        return json(created ? {
          protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
          targetSha256: fixture.input.target.targetSha256,
          targetReceiptSha256: fixture.input.target.receiptSha256,
          status: "exact",
          result: tenantTelemetryWriteAdapterResult(
            HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
            fixture.input,
            "already_present",
            true,
          ),
        } : {
          protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
          targetSha256: fixture.input.target.targetSha256,
          targetReceiptSha256: fixture.input.target.receiptSha256,
          status: "absent",
        });
      }
      created = true;
      return json({
        protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
        targetSha256: fixture.input.target.targetSha256,
        targetReceiptSha256: fixture.input.target.receiptSha256,
        status: "exact",
        result: tenantTelemetryWriteAdapterResult(
          HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
          fixture.input,
          "written",
          false,
        ),
      }, 201);
    }) as typeof fetch;
    const sink = httpAdapter(fetchImpl, fixture.input.target, {
      authorizationToken: "sink-super-secret",
      headers: { "x-private-fixture": "header-super-secret" },
    });

    await expect(sink.inspectWrite(fixture.input)).resolves.toEqual({ status: "absent" });
    await expect(sink.createWrite(fixture.input)).resolves.toMatchObject({
      outcome: "written",
      replayed: false,
    });
    await expect(sink.inspectWrite(fixture.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
    expect(seenAuthorization).toEqual([true, true, true]);
    expect(seenRedirects).toEqual(["manual", "manual", "manual"]);
    expect(seenUrls.every((value) => (
      value.startsWith("http://127.0.0.1:4318/collector/v1/tenant-telemetry/writes/")
      && !value.includes("sink-super-secret")
      && !value.includes("header-super-secret")
    ))).toBe(true);
    expect(seenBodies.every((value) => (
      !value.includes(fixture.claim.tenantId)
      && !value.includes("sink-super-secret")
      && !value.includes("header-super-secret")
    ))).toBe(true);
    expect(seenBodies[0]).not.toContain('"payload"');
    expect(seenBodies[1]).toContain('"schema":"agent-service.telemetry-artifact.v1"');
  });

  it("refuses redirects and malformed or oversized acknowledgements", async () => {
    const fixture = await telemetryAdapterFixture(
      HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    );
    let mode: "redirect" | "malformed" | "oversized" | "unbound_conflict" = "redirect";
    const fetchImpl = (async () => {
      if (mode === "redirect") {
        return new Response(null, {
          status: 307,
          headers: { location: "https://secret.invalid/private-sink-token" },
        });
      }
      if (mode === "malformed") {
        return json({
          protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
          targetSha256: fixture.input.target.targetSha256,
          targetReceiptSha256: fixture.input.target.receiptSha256,
          status: "exact",
          result: { credential: "must-not-be-accepted" },
        });
      }
      if (mode === "unbound_conflict") {
        return json({
          protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
          status: "conflict",
        }, 409);
      }
      return json({ padding: "x".repeat(2_000) });
    }) as typeof fetch;
    const sink = httpAdapter(fetchImpl, fixture.input.target, { maxResponseBytes: 1_024 });

    await expect(sink.inspectWrite(fixture.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    mode = "malformed";
    await expect(sink.inspectWrite(fixture.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    mode = "unbound_conflict";
    await expect(sink.inspectWrite(fixture.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    mode = "oversized";
    await expect(sink.inspectWrite(fixture.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
  });

  it("requires the exact application/json media type while allowing parameters", async () => {
    const fixture = await telemetryAdapterFixture(
      HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    );
    const body = JSON.stringify({
      protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
      targetSha256: fixture.input.target.targetSha256,
      targetReceiptSha256: fixture.input.target.receiptSha256,
      status: "absent",
    });
    const jsonp = httpAdapter((async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/jsonp" },
    })) as typeof fetch, fixture.input.target);
    await expect(jsonp.inspectWrite(fixture.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);

    const parameterized = httpAdapter((async () => new Response(body, {
      status: 200,
      headers: { "content-type": "Application/JSON ; charset=utf-8" },
    })) as typeof fetch, fixture.input.target);
    await expect(parameterized.inspectWrite(fixture.input)).resolves.toEqual({ status: "absent" });
  });

  it("allows a committed HTTP response loss to be resolved by a later exact inspect", async () => {
    const fixture = await telemetryAdapterFixture(
      HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    );
    let created = false;
    let creates = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body ?? "")) as HttpTenantTelemetryWriteRequest;
      if (envelope.action === "create") {
        created = true;
        creates += 1;
        throw new TypeError("private transport response-loss detail");
      }
      return json(created ? {
        protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
        targetSha256: fixture.input.target.targetSha256,
        targetReceiptSha256: fixture.input.target.receiptSha256,
        status: "exact",
        result: tenantTelemetryWriteAdapterResult(
          HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
          fixture.input,
          "already_present",
          true,
        ),
      } : {
        protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
        targetSha256: fixture.input.target.targetSha256,
        targetReceiptSha256: fixture.input.target.receiptSha256,
        status: "absent",
      });
    }) as typeof fetch;
    const sink = httpAdapter(fetchImpl, fixture.input.target);

    const error = await sink.createWrite(fixture.input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantTelemetryWriteAdapterTemporaryError);
    expect(String((error as Error).message)).not.toContain("private transport");
    await expect(sink.inspectWrite(fixture.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
    expect(creates).toBe(1);
  });

  it("bounds the whole request and returns only a content-free temporary error", async () => {
    const fixture = await telemetryAdapterFixture(
      HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    );
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException("private upstream detail", "AbortError"));
        if (init?.signal?.aborted) rejectAbort();
        else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
      })
    )) as typeof fetch;
    const sink = httpAdapter(fetchImpl, fixture.input.target, {
      authorizationToken: "timeout-super-secret-token",
      timeoutMs: 25,
    });

    const error = await sink.inspectWrite(fixture.input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TenantTelemetryWriteAdapterTemporaryError);
    expect(String((error as Error).message)).not.toContain("timeout-super-secret-token");
    expect(String((error as Error).message)).not.toContain("private upstream detail");
  });

  it("rejects embedded credentials and unsafe non-loopback cleartext without echoing config", () => {
    const secretUrl = "https://secret-user:secret-password@example.invalid/private";
    const expectedTargets = [{ targetSha256: D("1"), targetReceiptSha256: D("2") }];
    expect(() => new HttpTenantTelemetryWriteAdapter({ endpointUrl: secretUrl, expectedTargets }))
      .toThrow("tenant telemetry HTTP sink endpoint configuration is invalid");
    try {
      new HttpTenantTelemetryWriteAdapter({ endpointUrl: secretUrl, expectedTargets });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret-user");
      expect(String((error as Error).message)).not.toContain("secret-password");
    }
    expect(() => new HttpTenantTelemetryWriteAdapter({
      endpointUrl: "http://example.invalid/private",
      expectedTargets,
      allowInsecureHttpForLocalTest: true,
    })).toThrow("tenant telemetry HTTP sink endpoint configuration is invalid");
  });

  it("binds the configured target before fetch and rejects a mismatched response identity", async () => {
    const fixture = await telemetryAdapterFixture(
      HTTP_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    );
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return json({
        protocol: HTTP_TENANT_TELEMETRY_SINK_WIRE_PROTOCOL,
        targetSha256: fixture.input.target.targetSha256,
        targetReceiptSha256: D("f"),
        status: "absent",
      });
    }) as typeof fetch;
    const mismatchedSink = httpAdapter(fetchImpl, {
      targetSha256: D("e"),
      receiptSha256: D("d"),
    });
    await expect(mismatchedSink.inspectWrite(fixture.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    expect(fetches).toBe(0);
    const sink = httpAdapter(fetchImpl, fixture.input.target);
    await expect(sink.inspectWrite(fixture.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    expect(fetches).toBe(1);
  });
});
