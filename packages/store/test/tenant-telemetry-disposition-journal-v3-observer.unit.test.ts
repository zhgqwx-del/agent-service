import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { TenantTelemetryDispositionCorruptError } from "../src/tenant-telemetry-disposition.js";
import { canonicalJson } from "../src/tenant-telemetry-disposition-adapter/common.js";
import {
  buildFixtureTenantTelemetryDispositionEventV3,
  emptyTenantTelemetryDispositionHeadV3,
  headAfterTenantTelemetryDispositionEventV3,
  type TenantTelemetryDispositionEventV3,
  type TenantTelemetryDispositionJournalIdentityV3,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3.js";
import {
  TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE,
  TENANT_TELEMETRY_DISPOSITION_V3_HEAD_CONTENT_TYPE,
  encodeTenantTelemetryDispositionV3Envelope,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3-envelope.js";
import {
  S3TenantTelemetryDispositionJournalV3Observer,
  S3TenantTelemetryDispositionJournalV3ObserverTemporaryError,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3-s3-observer.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function s3Error(name: string, status: number, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error("private backend detail must not escape"), {
    name, $metadata: { httpStatusCode: status }, ...extra,
  });
}

type Stored = { body: Buffer; contentType: string; etag: string; versionId?: string };
class FakeGetOnlyS3 {
  readonly objects = new Map<string, Stored>();
  readonly commands: string[] = [];
  readonly keys: string[] = [];
  onGet?: (key: string, readNumber: number) => void;
  getError?: (key: string) => Error | undefined;
  neverResolve = false;
  lateGet?: Promise<unknown>;
  private serial = 0;

  set(key: string, kind: "head" | "event", value: unknown): void {
    this.serial += 1;
    this.objects.set(key, {
      body: encodeTenantTelemetryDispositionV3Envelope(kind, canonicalJson(value)),
      contentType: kind === "head" ? TENANT_TELEMETRY_DISPOSITION_V3_HEAD_CONTENT_TYPE
        : TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE,
      etag: `"${this.serial}"`,
    });
  }

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command?.constructor?.name ?? "unknown");
    if (!(command instanceof GetObjectCommand)) {
      throw new Error("GET-only observer attempted an S3 mutation or LIST");
    }
    const key = command.input.Key ?? "";
    this.keys.push(key);
    this.onGet?.(key, this.keys.length);
    if (this.neverResolve) return new Promise<never>(() => undefined);
    if (this.lateGet) return this.lateGet;
    const error = this.getError?.(key);
    if (error) throw error;
    const object = this.objects.get(key);
    if (!object) throw s3Error("NoSuchKey", 404);
    return {
      Body: Buffer.from(object.body), ContentLength: object.body.length,
      ContentType: object.contentType, ETag: object.etag,
      ...(object.versionId === undefined ? {} : { VersionId: object.versionId }),
    };
  }
}

function setup(timeoutMs = 1_000, maxEvents = 10) {
  const fake = new FakeGetOnlyS3();
  const prefix = "v3-observer-unit";
  const options = {
    independentFailureDomain: true as const,
    privateBucketAccessVerified: true as const,
    bucket: "v3-observer-unit", namespaceId: "namespace-unit",
    failureDomainId: "failure-domain-unit", logicalDatabaseNamespaceSha256: hash("database"),
    prefix, region: "us-east-1", endpoint: "http://127.0.0.1:9000",
    forcePathStyle: true, operationTimeoutMs: timeoutMs, maxEvents,
    client: fake as unknown as S3Client,
  };
  const observer = new S3TenantTelemetryDispositionJournalV3Observer(options);
  const root = `${prefix}/targets-v3/${observer.identity.journalTargetSha256}`;
  return {
    fake, observer, options,
    headKey: `${root}/authority/head-v3`,
    eventKey: (sequence: number) => `${root}/events-v3/${String(sequence).padStart(16, "0")}`,
  };
}

function authorized(identity: TenantTelemetryDispositionJournalIdentityV3,
  head = emptyTenantTelemetryDispositionHeadV3(identity), index = 1): TenantTelemetryDispositionEventV3 {
  const h = (part: string) => hash(`${index}-${part}`);
  return buildFixtureTenantTelemetryDispositionEventV3({
    identity,
    source: {
      tenantRefSha256: h("tenant"), domain: "logs", targetSha256: h("target"),
      artifactIdSha256: h("artifact"), artifactGeneration: 1,
      dispositionOperationSha256: h("operation"), subjectGeneration: 1, buildGeneration: 1,
      artifactGroupSha256: h("group"), catalogEntryReceiptSha256: h("catalog-entry"),
      catalogReceiptSha256: h("catalog"), sourceAccountingReceiptSha256: h("source"),
      targetManifestReceiptSha256: h("manifest"), ownerClosureReceiptSha256: h("closure"),
      databasePurgeReceiptSha256: h("t3f"), pregrantIntentSha256: h("intent"),
      pregrantClaimSha256: h("claim"),
    },
    restore: {
      runtimeEpochSha256: h("epoch"), runtimeControlEvidenceSha256: h("runtime"),
      backupCatalogControlEvidenceSha256: h("backup"),
      restoreRunSha256: null, restoreReplayReceiptSha256: null,
      backupReservationReceiptSha256: null,
    },
    grantReceiptSha256: h("grant"), claimAttempt: 1, claimTokenSha256: h("token"),
    grantedAtDbMs: 1_000, leaseUntilDbMs: 2_000,
    terminal: null, head, nonProductionFixture: true,
  });
}

function terminal(identity: TenantTelemetryDispositionJournalIdentityV3,
  event: TenantTelemetryDispositionEventV3): TenantTelemetryDispositionEventV3 {
  return buildFixtureTenantTelemetryDispositionEventV3({
    identity, source: event.source, restore: event.restore,
    grantReceiptSha256: event.authorization.grantReceiptSha256,
    claimAttempt: event.authorization.claimAttempt,
    claimTokenSha256: event.authorization.claimTokenSha256,
    grantedAtDbMs: event.authorization.grantedAtDbMs,
    leaseUntilDbMs: event.authorization.leaseUntilDbMs,
    terminal: {
      authorizationReceiptSha256: event.authorization.authorizationReceiptSha256,
      sameKeyTombstoneReceiptSha256: hash("same-key-ack"),
      tombstoneMarkerSha256: hash("marker"),
      originalObjectEtagSha256: hash("etag"),
    },
    head: headAfterTenantTelemetryDispositionEventV3(event),
    nonProductionFixture: true,
  });
}

describe("independent GET-only v3 telemetry disposition journal observer", () => {
  it("requires HTTPS for a production custom endpoint", () => {
    const { options } = setup();
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => new S3TenantTelemetryDispositionJournalV3Observer(options))
        .toThrow(/production endpoint must use HTTPS/);
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects missing genesis without creating objects or authority", async () => {
    const f = setup();
    await expect(f.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(f.fake.objects.size).toBe(0);
    expect(f.fake.commands).toEqual(["GetObjectCommand"]);
  });

  it("observes a sealed authorization and terminal chain twice with all authority flags false", async () => {
    const f = setup();
    const one = authorized(f.observer.identity);
    const two = terminal(f.observer.identity, one);
    f.fake.set(f.eventKey(1), "event", one);
    f.fake.set(f.eventKey(2), "event", two);
    f.fake.set(f.headKey, "head", headAfterTenantTelemetryDispositionEventV3(two));
    const view = await f.observer.observeSealedChain();
    expect(view.events).toEqual([one, two]);
    expect(view.sealedHead.journalSequence).toBe(2);
    expect([view.grantReady, view.executionReady, view.externalAuthorityVerified,
      view.restoreFenceVerified, view.physicalAck]).toEqual([false, false, false, false, false]);
    expect(f.fake.keys).toEqual([
      f.headKey, f.eventKey(1), f.eventKey(2), f.eventKey(3), f.headKey, f.eventKey(3),
    ]);
    expect(new Set(f.fake.commands)).toEqual(new Set(["GetObjectCommand"]));
  });

  it("fails closed on pending, missing committed, duplicate-operation and changed head evidence", async () => {
    const pending = setup();
    const first = authorized(pending.observer.identity);
    const second = authorized(pending.observer.identity,
      headAfterTenantTelemetryDispositionEventV3(first), 2);
    pending.fake.set(pending.headKey, "head", headAfterTenantTelemetryDispositionEventV3(first));
    pending.fake.set(pending.eventKey(1), "event", first);
    pending.fake.set(pending.eventKey(2), "event", second);
    await expect(pending.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    pending.fake.objects.delete(pending.eventKey(1));
    await expect(pending.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const duplicate = setup();
    const a = authorized(duplicate.observer.identity);
    const b = authorized(duplicate.observer.identity,
      headAfterTenantTelemetryDispositionEventV3(a));
    duplicate.fake.set(duplicate.headKey, "head", headAfterTenantTelemetryDispositionEventV3(b));
    duplicate.fake.set(duplicate.eventKey(1), "event", a);
    duplicate.fake.set(duplicate.eventKey(2), "event", b);
    await expect(duplicate.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const drift = setup();
    drift.fake.set(drift.headKey, "head", emptyTenantTelemetryDispositionHeadV3(drift.observer.identity));
    drift.fake.onGet = (key, readNumber) => {
      if (key === drift.headKey && readNumber === 3) {
        // Same head bytes but a different ETag must still fail the stable-head check.
        drift.fake.set(drift.headKey, "head",
          emptyTenantTelemetryDispositionHeadV3(drift.observer.identity));
      }
    };
    await expect(drift.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const latePending = setup();
    latePending.fake.set(latePending.headKey, "head",
      emptyTenantTelemetryDispositionHeadV3(latePending.observer.identity));
    latePending.fake.onGet = (key, readNumber) => {
      if (key === latePending.eventKey(1) && readNumber === 4) {
        latePending.fake.set(key, "event", authorized(latePending.observer.identity));
      }
    };
    await expect(latePending.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(latePending.fake.keys).toEqual([
      latePending.headKey, latePending.eventKey(1), latePending.headKey, latePending.eventKey(1),
    ]);
  });

  it("rejects wrong target, corrupt envelopes, version evidence and ambiguous 404", async () => {
    const f = setup();
    f.fake.set(f.headKey, "head", emptyTenantTelemetryDispositionHeadV3(f.observer.identity));
    f.fake.set(f.headKey, "head", emptyTenantTelemetryDispositionHeadV3({
      ...f.observer.identity, journalTargetSha256: hash("other-target"),
    }));
    await expect(f.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    f.fake.set(f.headKey, "head", emptyTenantTelemetryDispositionHeadV3(f.observer.identity));
    const stored = f.fake.objects.get(f.headKey)!;
    stored.body = Buffer.from(stored.body);
    stored.body[stored.body.length - 1] = stored.body[stored.body.length - 1]! ^ 1;
    await expect(f.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    f.fake.set(f.headKey, "head", emptyTenantTelemetryDispositionHeadV3(f.observer.identity));
    f.fake.objects.get(f.headKey)!.versionId = "forbidden";
    await expect(f.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    delete f.fake.objects.get(f.headKey)!.versionId;

    f.fake.getError = () => s3Error("NoSuchBucket", 404);
    await expect(f.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(f.fake.commands.every((name) => name === "GetObjectCommand")).toBe(true);
  });

  it("enforces event and whole-operation bounds and does not expose private transport errors", async () => {
    const tooLong = setup(1_000, 0);
    const one = authorized(tooLong.observer.identity);
    tooLong.fake.set(tooLong.headKey, "head", headAfterTenantTelemetryDispositionEventV3(one));
    await expect(tooLong.observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const timeout = setup(100);
    timeout.fake.neverResolve = true;
    const error = await timeout.observer.observeSealedChain().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(S3TenantTelemetryDispositionJournalV3ObserverTemporaryError);
    expect(String(error)).not.toContain("private backend detail");
    expect(timeout.fake.commands).toEqual(["GetObjectCommand"]);
  }, 3_000);

  it("destroys a late response body after the whole-operation deadline", async () => {
    const f = setup(100);
    let release: ((value: unknown) => void) | undefined;
    let destroyed = 0;
    f.fake.lateGet = new Promise((resolve) => { release = resolve; });
    await expect(f.observer.observeSealedChain()).rejects
      .toBeInstanceOf(S3TenantTelemetryDispositionJournalV3ObserverTemporaryError);
    release?.({ Body: { destroy() { destroyed += 1; } } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(destroyed).toBe(1);
  }, 3_000);

  it("bounds an already-returned streaming body by the same operation deadline", async () => {
    const f = setup(100);
    const stream = new Readable({ read() { /* Wait until the deadline closes the stream. */ } });
    const destroy = vi.spyOn(stream, "destroy");
    f.fake.lateGet = Promise.resolve({
      Body: stream, ContentLength: 1,
      ContentType: TENANT_TELEMETRY_DISPOSITION_V3_HEAD_CONTENT_TYPE, ETag: '"head"',
    });
    await expect(f.observer.observeSealedChain()).rejects
      .toBeInstanceOf(S3TenantTelemetryDispositionJournalV3ObserverTemporaryError);
    expect(destroy).toHaveBeenCalled();
  }, 3_000);
});
