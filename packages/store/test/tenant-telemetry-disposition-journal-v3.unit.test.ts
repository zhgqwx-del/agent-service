import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  TenantTelemetryDispositionConflictError,
  TenantTelemetryDispositionCorruptError,
} from "../src/tenant-telemetry-disposition.js";
import { canonicalJson } from "../src/tenant-telemetry-disposition-adapter/common.js";
import {
  assertTenantTelemetryDispositionChainV3,
  buildFixtureTenantTelemetryDispositionEventV3,
  emptyTenantTelemetryDispositionHeadV3,
  headAfterTenantTelemetryDispositionEventV3,
  type TenantTelemetryDispositionEventV3,
  type TenantTelemetryDispositionRestoreLineageV3,
  type TenantTelemetryDispositionSourceV3,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3.js";
import {
  TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE,
  TENANT_TELEMETRY_DISPOSITION_V3_HEAD_CONTENT_TYPE,
  decodeTenantTelemetryDispositionV3Envelope,
  encodeTenantTelemetryDispositionV3Envelope,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3-envelope.js";
import {
  S3TenantTelemetryDispositionJournalV3Fixture,
  S3TenantTelemetryDispositionJournalV3TemporaryError,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3-s3-fixture.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function source(index = 1): TenantTelemetryDispositionSourceV3 {
  return {
    tenantRefSha256: hash(`tenant-${index}`), domain: "logs",
    targetSha256: hash(`target-${index}`), artifactIdSha256: hash(`artifact-${index}`),
    artifactGeneration: 1, dispositionOperationSha256: hash(`operation-${index}`),
    subjectGeneration: 1, buildGeneration: 1,
    artifactGroupSha256: hash(`group-${index}`),
    catalogEntryReceiptSha256: hash(`catalog-entry-${index}`),
    catalogReceiptSha256: hash(`catalog-${index}`),
    sourceAccountingReceiptSha256: hash(`accounting-${index}`),
    targetManifestReceiptSha256: hash(`manifest-${index}`),
    ownerClosureReceiptSha256: hash(`closure-${index}`),
    databasePurgeReceiptSha256: hash(`database-purge-${index}`),
    pregrantIntentSha256: hash(`intent-${index}`),
    pregrantClaimSha256: hash(`pregrant-claim-${index}`),
  };
}

function restore(index = 1): TenantTelemetryDispositionRestoreLineageV3 {
  return {
    runtimeEpochSha256: hash(`epoch-${index}`),
    runtimeControlEvidenceSha256: hash(`runtime-control-${index}`),
    backupCatalogControlEvidenceSha256: hash(`backup-catalog-${index}`),
    restoreRunSha256: null, restoreReplayReceiptSha256: null,
    backupReservationReceiptSha256: null,
  };
}

function authorizationInput(index = 1) {
  return {
    source: source(index), restore: restore(index),
    grantReceiptSha256: hash(`grant-${index}`), claimAttempt: 1,
    claimTokenSha256: hash(`claim-token-${index}`),
    grantedAtDbMs: 1_000, leaseUntilDbMs: 2_000,
  };
}

interface FakeObject { body: Buffer; contentType: string; etag: string; versionId?: string }

function s3Error(name: string, status: number, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error("private backend detail must not escape"), {
    name, $metadata: { httpStatusCode: status }, ...extra,
  });
}

class FakeConditionalS3 {
  readonly objects = new Map<string, FakeObject>();
  readonly commands: string[] = [];
  readonly getKeys: string[] = [];
  readonly putKeys: string[] = [];
  getError?: (key: string) => Error | undefined;
  dropResponseAfterPut = false;
  addVersionToPut = false;
  neverResolveGet = false;
  beforePut?: (command: PutObjectCommand) => void;
  private etagSequence = 0;

  set(key: string, kind: "head" | "event", value: unknown): void {
    this.etagSequence += 1;
    this.objects.set(key, {
      body: encodeTenantTelemetryDispositionV3Envelope(kind, canonicalJson(value)),
      contentType: kind === "head" ? TENANT_TELEMETRY_DISPOSITION_V3_HEAD_CONTENT_TYPE
        : TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE,
      etag: `"${this.etagSequence}"`,
    });
  }

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command?.constructor?.name ?? "unknown");
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key ?? "";
      this.getKeys.push(key);
      if (this.neverResolveGet) return new Promise<never>(() => undefined);
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
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? "";
      this.putKeys.push(key);
      this.beforePut?.(command);
      const existing = this.objects.get(key);
      if (command.input.IfNoneMatch === "*" && existing) {
        throw s3Error("PreconditionFailed", 412);
      }
      if (command.input.IfMatch !== undefined && command.input.IfMatch !== existing?.etag) {
        throw s3Error("PreconditionFailed", 412);
      }
      if (command.input.IfNoneMatch !== "*" && command.input.IfMatch === undefined) {
        throw new Error("unconditional fixture overwrite");
      }
      const body = command.input.Body;
      if (!(body instanceof Uint8Array)) throw new Error("unexpected fixture body");
      this.etagSequence += 1;
      this.objects.set(key, {
        body: Buffer.from(body), contentType: command.input.ContentType ?? "",
        etag: `"${this.etagSequence}"`,
      });
      if (this.dropResponseAfterPut) {
        this.dropResponseAfterPut = false;
        throw s3Error("NetworkError", 503);
      }
      return this.addVersionToPut ? { VersionId: "forbidden-version" } : {};
    }
    throw new Error("unexpected LIST, delete, or other S3 operation");
  }
}

function fixture(options: { timeoutMs?: number } = {}) {
  const client = new FakeConditionalS3();
  const prefix = "journal-v3-unit";
  const journal = new S3TenantTelemetryDispositionJournalV3Fixture({
    nonProductionFixture: true, independentFailureDomain: true,
    privateBucketAccessVerified: true, bucket: "telemetry-v3-unit",
    namespaceId: "namespace-unit", failureDomainId: "domain-unit",
    logicalDatabaseNamespaceSha256: hash("database-unit"), prefix,
    region: "us-east-1", endpoint: "http://127.0.0.1:9000", forcePathStyle: true,
    client: client as unknown as S3Client, operationTimeoutMs: options.timeoutMs ?? 1_000,
    maxEvents: 10,
  });
  const base = `${prefix}/targets-v3/${journal.identity.journalTargetSha256}`;
  const headKey = `${base}/authority/head-v3`;
  const eventKey = (sequence: number) =>
    `${base}/events-v3/${String(sequence).padStart(16, "0")}`;
  return { client, journal, headKey, eventKey };
}

function buildAuthorization(f: ReturnType<typeof fixture>, index = 1,
  head = emptyTenantTelemetryDispositionHeadV3(f.journal.identity)) {
  return buildFixtureTenantTelemetryDispositionEventV3({
    identity: f.journal.identity, ...authorizationInput(index),
    terminal: null, head, nonProductionFixture: true,
  });
}

function buildTerminal(f: ReturnType<typeof fixture>, authorization: TenantTelemetryDispositionEventV3) {
  return buildFixtureTenantTelemetryDispositionEventV3({
    identity: f.journal.identity,
    source: authorization.source, restore: authorization.restore,
    grantReceiptSha256: authorization.authorization.grantReceiptSha256,
    claimAttempt: authorization.authorization.claimAttempt,
    claimTokenSha256: authorization.authorization.claimTokenSha256,
    grantedAtDbMs: authorization.authorization.grantedAtDbMs,
    leaseUntilDbMs: authorization.authorization.leaseUntilDbMs,
    terminal: {
      authorizationReceiptSha256: authorization.authorization.authorizationReceiptSha256,
      sameKeyTombstoneReceiptSha256: hash("same-key-ack"),
      tombstoneMarkerSha256: hash("tombstone-marker"),
      originalObjectEtagSha256: hash("object-etag"),
    },
    head: headAfterTenantTelemetryDispositionEventV3(authorization),
    nonProductionFixture: true,
  });
}

describe("v3 telemetry disposition journal fixture protocol", () => {
  it("round-trips canonical v3 envelopes and a sealed authorization/terminal chain", () => {
    const f = fixture();
    const authorization = buildAuthorization(f);
    const terminal = buildTerminal(f, authorization);
    const head = headAfterTenantTelemetryDispositionEventV3(terminal);
    for (const [kind, value] of [["event", authorization], ["event", terminal], ["head", head]] as const) {
      const encoded = encodeTenantTelemetryDispositionV3Envelope(kind, canonicalJson(value));
      expect(JSON.parse(decodeTenantTelemetryDispositionV3Envelope(kind, encoded))).toEqual(value);
      const corrupted = Buffer.from(encoded);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
      expect(() => decodeTenantTelemetryDispositionV3Envelope(kind, corrupted))
        .toThrow(TenantTelemetryDispositionCorruptError);
      expect(() => decodeTenantTelemetryDispositionV3Envelope(kind === "head" ? "event" : "head", encoded))
        .toThrow(TenantTelemetryDispositionCorruptError);
    }
    expect(() => assertTenantTelemetryDispositionChainV3(f.journal.identity,
      [authorization, terminal], head)).not.toThrow();
    expect(authorization.eventType).toBe("delete_authorized");
    expect(terminal.eventType).toBe("delete_tombstoned");
    expect(JSON.stringify([authorization, terminal])).not.toMatch(/tenant-1|claim-token-1/);
  });

  it("rejects tamper, gaps, duplicate operations, terminal-before-authorization and lineage drift", () => {
    const f = fixture();
    const authorization = buildAuthorization(f);
    const terminal = buildTerminal(f, authorization);
    const terminalHead = headAfterTenantTelemetryDispositionEventV3(terminal);
    const altered = structuredClone(authorization);
    altered.source.catalogReceiptSha256 = hash("tampered-catalog");
    expect(() => assertTenantTelemetryDispositionChainV3(f.journal.identity,
      [altered, terminal], terminalHead)).toThrow(TenantTelemetryDispositionCorruptError);
    expect(() => assertTenantTelemetryDispositionChainV3(f.journal.identity,
      [terminal], terminalHead)).toThrow(TenantTelemetryDispositionCorruptError);
    expect(() => assertTenantTelemetryDispositionChainV3(f.journal.identity,
      [authorization], terminalHead)).toThrow(TenantTelemetryDispositionCorruptError);
    const repeated = buildFixtureTenantTelemetryDispositionEventV3({
      identity: f.journal.identity, ...authorizationInput(), terminal: null,
      head: headAfterTenantTelemetryDispositionEventV3(authorization),
      nonProductionFixture: true,
    });
    expect(() => assertTenantTelemetryDispositionChainV3(f.journal.identity,
      [authorization, repeated], headAfterTenantTelemetryDispositionEventV3(repeated)))
      .toThrow(TenantTelemetryDispositionCorruptError);
    const alternateAuthorization = buildFixtureTenantTelemetryDispositionEventV3({
      identity: f.journal.identity, source: authorization.source, restore: restore(2),
      grantReceiptSha256: authorization.authorization.grantReceiptSha256,
      claimAttempt: authorization.authorization.claimAttempt,
      claimTokenSha256: authorization.authorization.claimTokenSha256,
      grantedAtDbMs: authorization.authorization.grantedAtDbMs,
      leaseUntilDbMs: authorization.authorization.leaseUntilDbMs,
      terminal: null,
      head: emptyTenantTelemetryDispositionHeadV3(f.journal.identity),
      nonProductionFixture: true,
    });
    const wrongLineage = buildFixtureTenantTelemetryDispositionEventV3({
      identity: f.journal.identity, source: authorization.source, restore: restore(2),
      grantReceiptSha256: authorization.authorization.grantReceiptSha256,
      claimAttempt: authorization.authorization.claimAttempt,
      claimTokenSha256: authorization.authorization.claimTokenSha256,
      grantedAtDbMs: authorization.authorization.grantedAtDbMs,
      leaseUntilDbMs: authorization.authorization.leaseUntilDbMs,
      terminal: {
        authorizationReceiptSha256: alternateAuthorization.authorization.authorizationReceiptSha256,
        sameKeyTombstoneReceiptSha256: hash("same-key-ack"),
        tombstoneMarkerSha256: hash("tombstone-marker"),
        originalObjectEtagSha256: hash("object-etag"),
      },
      head: headAfterTenantTelemetryDispositionEventV3(authorization),
      nonProductionFixture: true,
    });
    expect(() => assertTenantTelemetryDispositionChainV3(f.journal.identity,
      [authorization, wrongLineage], headAfterTenantTelemetryDispositionEventV3(wrongLineage)))
      .toThrow(TenantTelemetryDispositionCorruptError);
  });

  it("keeps observation GET-only, never initializes genesis, and returns no execution authority", async () => {
    const f = fixture();
    await expect(f.journal.observeSealedChain()).rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(f.client.commands).toEqual(["GetObjectCommand"]);
    expect(f.client.objects.size).toBe(0);
    const genesis = await f.journal.initializeFixture();
    const before = f.client.putKeys.length;
    const observation = await f.journal.observeSealedChain();
    expect(observation.sealedHead).toEqual(genesis);
    expect(observation.events).toEqual([]);
    expect(observation).toMatchObject({ sealedChainObserved: true, grantReady: false,
      executionReady: false, externalAuthorityVerified: false,
      restoreFenceVerified: false, physicalAck: false });
    expect(f.client.putKeys.length).toBe(before);
    expect("deleteObject" in f.journal).toBe(false);
  });

  it("appends exact authorization and terminal events, including lost PUT responses and exact replay", async () => {
    const f = fixture();
    f.client.dropResponseAfterPut = true;
    await f.journal.initializeFixture();
    f.client.dropResponseAfterPut = true;
    const authorization = await f.journal.appendFixtureAuthorization(authorizationInput());
    expect(authorization.eventType).toBe("delete_authorized");
    expect(await f.journal.appendFixtureAuthorization(authorizationInput())).toEqual(authorization);
    await expect(f.journal.appendFixtureAuthorization({ ...authorizationInput(),
      grantReceiptSha256: hash("conflicting-grant") }))
      .rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    f.client.dropResponseAfterPut = true;
    const terminalInput = {
      dispositionOperationSha256: authorization.source.dispositionOperationSha256,
      sameKeyTombstoneReceiptSha256: hash("same-key-ack"),
      tombstoneMarkerSha256: hash("tombstone-marker"),
      originalObjectEtagSha256: hash("object-etag"),
    };
    const terminal = await f.journal.appendFixtureTerminal(terminalInput);
    expect(terminal.eventType).toBe("delete_tombstoned");
    expect(await f.journal.appendFixtureTerminal(terminalInput)).toEqual(terminal);
    await expect(f.journal.appendFixtureTerminal({ ...terminalInput,
      tombstoneMarkerSha256: hash("different-marker") }))
      .rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    const observation = await f.journal.observeSealedChain();
    expect(observation.events).toEqual([authorization, terminal]);
    expect(observation.physicalAck).toBe(false);
    expect(f.client.objects.has(f.eventKey(1))).toBe(true);
    expect(f.client.objects.has(f.eventKey(2))).toBe(true);
    expect(f.client.commands.every((command) => ["GetObjectCommand", "PutObjectCommand"].includes(command)))
      .toBe(true);
  });

  it("advances an exact pending event and resolves a competing create-only sequence without overwrite", async () => {
    const pending = fixture();
    const genesis = await pending.journal.initializeFixture();
    const proposed = buildAuthorization(pending, 1, genesis);
    pending.client.set(pending.eventKey(1), "event", proposed);
    expect(await pending.journal.appendFixtureAuthorization(authorizationInput())).toEqual(proposed);
    expect((await pending.journal.observeSealedChain()).events).toEqual([proposed]);

    const race = fixture();
    const raceGenesis = await race.journal.initializeFixture();
    const competitor = buildAuthorization(race, 2, raceGenesis);
    race.client.beforePut = (command) => {
      if (command.input.Key === race.eventKey(1)) {
        race.client.beforePut = undefined;
        race.client.set(race.eventKey(1), "event", competitor);
      }
    };
    const own = await race.journal.appendFixtureAuthorization(authorizationInput());
    expect(own.journalSequence).toBe(2);
    expect((await race.journal.observeSealedChain()).events).toEqual([competitor, own]);
    expect(race.client.objects.size).toBe(3);
  });

  it("rejects version evidence on a PUT even if the object appears to have been written", async () => {
    const genesis = fixture();
    genesis.client.addVersionToPut = true;
    await expect(genesis.journal.initializeFixture())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const event = fixture();
    await event.journal.initializeFixture();
    event.client.addVersionToPut = true;
    await expect(event.journal.appendFixtureAuthorization(authorizationInput()))
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
  });

  it("fails closed on a pending event, missing committed event, bad envelope and versioned response", async () => {
    const pending = fixture();
    const genesis = await pending.journal.initializeFixture();
    pending.client.set(pending.eventKey(1), "event", buildAuthorization(pending, 1, genesis));
    const before = pending.client.putKeys.length;
    await expect(pending.journal.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(pending.client.putKeys.length).toBe(before);

    const gap = fixture();
    await gap.journal.initializeFixture();
    await gap.journal.appendFixtureAuthorization(authorizationInput());
    gap.client.objects.delete(gap.eventKey(1));
    await expect(gap.journal.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const corrupt = fixture();
    await corrupt.journal.initializeFixture();
    const corruptBody = corrupt.client.objects.get(corrupt.headKey)!.body;
    corruptBody[0] = corruptBody[0]! ^ 1;
    await expect(corrupt.journal.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);

    const versioned = fixture();
    await versioned.journal.initializeFixture();
    versioned.client.objects.get(versioned.headKey)!.versionId = "forbidden-version";
    await expect(versioned.journal.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
  });

  it("does not treat bucket 404, ambiguous 404, or version evidence as a missing key", async () => {
    for (const error of [
      s3Error("NoSuchBucket", 404),
      s3Error("NotFound", 404),
      s3Error("NoSuchKey", 404, { VersionId: "forbidden-version" }),
    ]) {
      const f = fixture();
      f.client.getError = () => error;
      await expect(f.journal.observeSealedChain())
        .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
      expect(f.client.objects.size).toBe(0);
    }
  });

  it("bounds a stalled whole operation and sanitizes transport diagnostics", async () => {
    const f = fixture({ timeoutMs: 100 });
    f.client.neverResolveGet = true;
    const start = performance.now();
    await expect(f.journal.observeSealedChain())
      .rejects.toBeInstanceOf(S3TenantTelemetryDispositionJournalV3TemporaryError);
    expect(performance.now() - start).toBeLessThan(1_000);
    f.client.neverResolveGet = false;
    f.client.getError = () => s3Error("NetworkError", 503);
    await expect(f.journal.observeSealedChain())
      .rejects.toBeInstanceOf(S3TenantTelemetryDispositionJournalV3TemporaryError);
  });
});
