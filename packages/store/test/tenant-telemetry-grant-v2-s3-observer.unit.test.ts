import {
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TenantTelemetryDispositionCorruptError,
  tenantTelemetryDispositionAuthorizationGrantSha256,
  type TenantTelemetryDispositionAuthorizationGrant,
  type TenantTelemetryDispositionJournalIdentity,
} from "../src/tenant-telemetry-disposition.js";
import { canonicalJson } from "../src/tenant-telemetry-disposition-adapter/common.js";
import {
  buildFixtureTenantTelemetryGrantAuthorizationEventV2,
  emptyTenantTelemetryGrantJournalHeadV2,
  headAfterTenantTelemetryGrantAuthorizationEventV2,
  type TenantTelemetryGrantAuthorizationEventV2,
  type TenantTelemetryGrantJournalHeadV2,
} from "../src/tenant-telemetry-disposition-adapter/grant-v2.js";
import {
  TENANT_TELEMETRY_GRANT_JOURNAL_V2_EVENT_CONTENT_TYPE,
  TENANT_TELEMETRY_GRANT_JOURNAL_V2_HEAD_CONTENT_TYPE,
  decodeTenantTelemetryGrantJournalV2Envelope,
  encodeTenantTelemetryGrantJournalV2Envelope,
} from "../src/tenant-telemetry-disposition-adapter/grant-v2-envelope.js";
import {
  S3TenantTelemetryGrantJournalObserverError,
  S3TenantTelemetryGrantJournalObserverV2,
} from "../src/tenant-telemetry-disposition-adapter/grant-v2-s3-observer.js";
import { dispositionDigest, dispositionEvidence } from "./tenant-telemetry-disposition.fixture.js";

interface FakeObject {
  body: Buffer;
  contentType: string;
  etag: string;
  versionId?: string;
}

function notFound(): Error {
  return Object.assign(new Error("fixture 404"), {
    name: "NoSuchKey",
    $metadata: { httpStatusCode: 404 },
  });
}

class ReadOnlyFakeS3 {
  readonly objects = new Map<string, FakeObject>();
  readonly commands: string[] = [];
  headReads = 0;
  afterFirstHeadRead?: () => void;
  afterSecondHeadRead?: () => void;
  failSecondPendingWithBucket404 = false;
  secondPendingError?: Error;
  pendingReads = 0;
  forbiddenMutation = false;

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command?.constructor?.name ?? "unknown");
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key ?? "";
      const object = this.objects.get(key);
      if (!object) {
        if (key.includes("/events-v2/")) {
          this.pendingReads += 1;
          if (this.pendingReads === 2 && this.secondPendingError) {
            throw this.secondPendingError;
          }
          if (this.failSecondPendingWithBucket404 && this.pendingReads === 2) {
            throw Object.assign(new Error("private bucket name"), {
              name: "NoSuchBucket",
              $metadata: { httpStatusCode: 404 },
            });
          }
        }
        throw notFound();
      }
      if (key.endsWith("/authority/head-v2")) {
        this.headReads += 1;
        if (this.headReads === 1) this.afterFirstHeadRead?.();
        if (this.headReads === 2) this.afterSecondHeadRead?.();
      }
      return {
        Body: Buffer.from(object.body),
        ContentType: object.contentType,
        ContentLength: object.body.length,
        ETag: object.etag,
        ...(object.versionId === undefined ? {} : { VersionId: object.versionId }),
      };
    }
    this.forbiddenMutation = true;
    throw new Error("observer attempted an S3 mutation or LIST");
  }
}

function grant(index: number): TenantTelemetryDispositionAuthorizationGrant {
  const body = {
    scope: TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    tenantId: `private-tenant-${index}`,
    requestId: `private-request-${index}`,
    ...dispositionEvidence(index),
    claimAttempt: 1,
    claimTokenSha256: dispositionDigest(`claim-${index}`),
    grantedAtDbMs: 1_000,
    leaseUntilDbMs: 2_000,
  };
  return {
    ...body,
    grantReceiptSha256: tenantTelemetryDispositionAuthorizationGrantSha256(body),
  };
}

function fixture() {
  const client = new ReadOnlyFakeS3();
  const prefix = "telemetry-grant-v2-unit";
  const observer = new S3TenantTelemetryGrantJournalObserverV2({
    independentFailureDomain: true,
    privateBucketAccessVerified: true,
    bucket: "telemetry-grant-unit",
    prefix,
    namespaceId: "unit-namespace",
    failureDomainId: "unit-domain",
    logicalDatabaseNamespaceSha256: dispositionDigest("unit-database"),
    region: "us-east-1",
    endpoint: "http://127.0.0.1:9000",
    forcePathStyle: true,
    client: client as unknown as S3Client,
    maxEvents: 10,
  });
  const identity: TenantTelemetryDispositionJournalIdentity = {
    adapterProtocol: observer.adapterProtocol,
    journalNamespaceSha256: observer.journalNamespaceSha256,
    journalTargetSha256: observer.journalTargetSha256,
    failureDomainSha256: observer.failureDomainSha256,
    logicalDatabaseNamespaceSha256: observer.logicalDatabaseNamespaceSha256,
  };
  const base = `${prefix}/targets/${observer.journalTargetSha256}`;
  const headKey = `${base}/authority/head-v2`;
  const eventKey = (sequence: number) =>
    `${base}/events-v2/${String(sequence).padStart(16, "0")}`;
  let etagCounter = 0;
  function set(
    key: string,
    kind: "head" | "event",
    value: unknown,
    contentType = kind === "head"
      ? TENANT_TELEMETRY_GRANT_JOURNAL_V2_HEAD_CONTENT_TYPE
      : TENANT_TELEMETRY_GRANT_JOURNAL_V2_EVENT_CONTENT_TYPE,
  ): void {
    etagCounter += 1;
    client.objects.set(key, {
      body: encodeTenantTelemetryGrantJournalV2Envelope(kind, canonicalJson(value)),
      contentType,
      etag: `"${etagCounter}"`,
    });
  }
  function publish(events: TenantTelemetryGrantAuthorizationEventV2[]): TenantTelemetryGrantJournalHeadV2 {
    const head = events.at(-1) === undefined
      ? emptyTenantTelemetryGrantJournalHeadV2(identity)
      : headAfterTenantTelemetryGrantAuthorizationEventV2(events.at(-1)!);
    events.forEach((event) => set(eventKey(event.journalSequence), "event", event));
    set(headKey, "head", head);
    return head;
  }
  function next(
    head: TenantTelemetryGrantJournalHeadV2,
    index: number,
  ): TenantTelemetryGrantAuthorizationEventV2 {
    return buildFixtureTenantTelemetryGrantAuthorizationEventV2(identity, grant(index), head, true);
  }
  return { client, observer, identity, headKey, eventKey, set, publish, next };
}

describe("v2 S3 telemetry grant journal sealed-chain observer", () => {
  it("observes an exact empty genesis with GET only and never returns a grant", async () => {
    const f = fixture();
    const head = f.publish([]);
    const observation = await f.observer.observeSealedChain();
    expect(observation).toEqual({
      sealedHead: head,
      observedEventCount: 0,
      sealedChainObserved: true,
      grantReady: false,
      executionReady: false,
      externalAuthorityVerified: false,
      restoreFenceVerified: false,
    });
    expect(f.client.commands).toEqual(Array(4).fill("GetObjectCommand"));
    expect(f.client.forbiddenMutation).toBe(false);
    expect("authorizeDeletion" in f.observer).toBe(false);
  });

  it("validates every event, exact identity/sequence/root and an unchanged sealed head", async () => {
    const f = fixture();
    const genesis = emptyTenantTelemetryGrantJournalHeadV2(f.identity);
    const first = f.next(genesis, 1);
    const second = f.next(headAfterTenantTelemetryGrantAuthorizationEventV2(first), 2);
    const head = f.publish([first, second]);
    const observation = await f.observer.observeSealedChain();
    expect(observation.sealedHead).toEqual(head);
    expect(observation.observedEventCount).toBe(2);
    expect(observation.grantReady).toBe(false);
    expect(JSON.stringify(observation)).not.toMatch(/private-tenant|private-request/);
    expect(f.client.commands).toEqual(Array(6).fill("GetObjectCommand"));
  });

  it("fails closed for missing head, gaps and a pending unsealed event without repairing them", async () => {
    const missing = fixture();
    await expect(missing.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(missing.client.objects.size).toBe(0);

    const gap = fixture();
    const genesis = emptyTenantTelemetryGrantJournalHeadV2(gap.identity);
    const event = gap.next(genesis, 3);
    gap.publish([event]);
    gap.client.objects.delete(gap.eventKey(1));
    await expect(gap.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const pending = fixture();
    const empty = pending.publish([]);
    pending.set(pending.eventKey(1), "event", pending.next(empty, 4));
    await expect(pending.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(pending.client.objects.get(pending.headKey)?.body)
      .toEqual(encodeTenantTelemetryGrantJournalV2Envelope("head", canonicalJson(empty)));
    expect(pending.client.forbiddenMutation).toBe(false);
  });

  it("rejects identity, digest, sequence and canonical-payload tampering", async () => {
    const wrongIdentity = fixture();
    const foreignIdentity = {
      ...wrongIdentity.identity,
      journalTargetSha256: dispositionDigest("other-target"),
    };
    const foreignEvent = buildFixtureTenantTelemetryGrantAuthorizationEventV2(
      foreignIdentity,
      grant(5),
      emptyTenantTelemetryGrantJournalHeadV2(foreignIdentity),
      true,
    );
    wrongIdentity.set(wrongIdentity.eventKey(1), "event", foreignEvent);
    wrongIdentity.set(wrongIdentity.headKey, "head", {
      ...headAfterTenantTelemetryGrantAuthorizationEventV2(foreignEvent),
      ...wrongIdentity.identity,
    });
    await expect(wrongIdentity.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const wrongSequence = fixture();
    const first = wrongSequence.next(
      emptyTenantTelemetryGrantJournalHeadV2(wrongSequence.identity), 6,
    );
    const later = wrongSequence.next(
      headAfterTenantTelemetryGrantAuthorizationEventV2(first), 7,
    );
    wrongSequence.publish([first]);
    wrongSequence.set(wrongSequence.eventKey(1), "event", later);
    await expect(wrongSequence.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const duplicateKey = fixture();
    duplicateKey.publish([duplicateKey.next(
      emptyTenantTelemetryGrantJournalHeadV2(duplicateKey.identity), 8,
    )]);
    duplicateKey.client.objects.get(duplicateKey.eventKey(1))!.body =
      encodeTenantTelemetryGrantJournalV2Envelope(
        "event", '{"journalSequence":1,"journalSequence":1}',
      );
    await expect(duplicateKey.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const wrongRoot = fixture();
    const rootEvent = wrongRoot.next(
      emptyTenantTelemetryGrantJournalHeadV2(wrongRoot.identity), 10,
    );
    wrongRoot.publish([rootEvent]);
    wrongRoot.set(wrongRoot.headKey, "head", {
      ...headAfterTenantTelemetryGrantAuthorizationEventV2(rootEvent),
      journalEventRootSha256: dispositionDigest("forged-root"),
    });
    await expect(wrongRoot.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
  });

  it("rejects head drift, corrupt envelope, wrong media type and versioned evidence", async () => {
    const drift = fixture();
    drift.publish([]);
    drift.client.afterFirstHeadRead = () => {
      const object = drift.client.objects.get(drift.headKey)!;
      drift.client.objects.set(drift.headKey, { ...object, etag: '"replacement"' });
    };
    await expect(drift.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const corrupt = fixture();
    corrupt.publish([]);
    const corruptBytes = corrupt.client.objects.get(corrupt.headKey)!.body;
    corruptBytes[5] = (corruptBytes[5] ?? 0) ^ 1;
    await expect(corrupt.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const media = fixture();
    media.publish([]);
    media.client.objects.get(media.headKey)!.contentType = "application/json";
    await expect(media.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const versioned = fixture();
    versioned.publish([]);
    versioned.client.objects.get(versioned.headKey)!.versionId = "version-1";
    await expect(versioned.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
  });

  it("rejects a pending slot that appears during the final head GET", async () => {
    const f = fixture();
    const genesis = f.publish([]);
    f.client.afterSecondHeadRead = () => {
      f.set(f.eventKey(1), "event", f.next(genesis, 9));
    };
    await expect(f.observer.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(f.client.commands).toEqual(Array(4).fill("GetObjectCommand"));
    expect(f.client.forbiddenMutation).toBe(false);
  });

  it("does not mistake a final NoSuchBucket 404 for an absent pending key", async () => {
    const f = fixture();
    f.publish([]);
    f.client.failSecondPendingWithBucket404 = true;
    await expect(f.observer.observeSealedChain())
      .rejects.toBeInstanceOf(S3TenantTelemetryGrantJournalObserverError);
    expect(f.client.commands).toEqual(Array(4).fill("GetObjectCommand"));
    expect(f.client.forbiddenMutation).toBe(false);
  });

  it("rejects a named missing-key error unless its HTTP status is 404", async () => {
    const f = fixture();
    f.publish([]);
    f.client.secondPendingError = Object.assign(new Error("private upstream detail"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 503 },
    });
    await expect(f.observer.observeSealedChain())
      .rejects.toBeInstanceOf(S3TenantTelemetryGrantJournalObserverError);
    expect(f.client.commands).toEqual(Array(4).fill("GetObjectCommand"));
    expect(f.client.forbiddenMutation).toBe(false);
  });

  it("rejects 404 missing-key responses carrying delete-marker or version metadata", async () => {
    for (const evidence of [
      { DeleteMarker: true },
      { VersionId: "hidden-version" },
      { $response: { headers: { "x-amz-delete-marker": "true" } } },
      { $metadata: { httpStatusCode: 404, versionId: "hidden-version" } },
    ]) {
      const f = fixture();
      f.publish([]);
      f.client.secondPendingError = Object.assign(new Error("private marker detail"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
        ...evidence,
      });
      await expect(f.observer.observeSealedChain())
        .rejects.toBeInstanceOf(S3TenantTelemetryGrantJournalObserverError);
      expect(f.client.commands).toEqual(Array(4).fill("GetObjectCommand"));
      expect(f.client.forbiddenMutation).toBe(false);
    }
  });

  it("uses a separate v2 envelope and fails closed after close", async () => {
    const f = fixture();
    const genesis = f.publish([]);
    const encoded = encodeTenantTelemetryGrantJournalV2Envelope("head", canonicalJson(genesis));
    expect(decodeTenantTelemetryGrantJournalV2Envelope("head", encoded))
      .toBe(canonicalJson(genesis));
    expect(() => decodeTenantTelemetryGrantJournalV2Envelope("event", encoded))
      .toThrow(TenantTelemetryDispositionCorruptError);
    await f.observer.close();
    await expect(f.observer.observeSealedChain()).rejects.toThrow("closed");
  });
});
