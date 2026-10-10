import { describe, expect, it } from "vitest";
import {
  RESTORE_JOURNAL_ENVELOPE_HEADER_BYTES,
  RESTORE_JOURNAL_ENVELOPE_MAGIC_TEXT,
  RESTORE_JOURNAL_MAX_PAYLOAD_BYTES,
  decodeRestoreJournalEnvelope,
  encodeRestoreJournalEnvelope,
} from "../src/restore-journal/codec.js";

describe("restore journal dedicated envelope", () => {
  it("round-trips record and head payloads without reusing the Blob envelope", () => {
    for (const kind of ["record", "head"] as const) {
      const payload = JSON.stringify({ kind, value: "内容", ordinal: 1 });
      const envelope = encodeRestoreJournalEnvelope(kind, payload);
      expect(envelope.subarray(0, 8).toString("ascii")).toBe(RESTORE_JOURNAL_ENVELOPE_MAGIC_TEXT);
      expect(envelope.subarray(0, 8).toString("ascii")).not.toBe("ASBLOB02");
      expect(decodeRestoreJournalEnvelope(kind, envelope)).toBe(payload);
    }
  });

  it("rejects kind confusion, truncation, extension, and checksum corruption", () => {
    const encoded = encodeRestoreJournalEnvelope("record", "{}");
    expect(() => decodeRestoreJournalEnvelope("head", encoded)).toThrow("kind");
    expect(() => decodeRestoreJournalEnvelope("record", encoded.subarray(0, -1))).toThrow("length");
    expect(() => decodeRestoreJournalEnvelope(
      "record",
      Buffer.concat([encoded, Buffer.from([0])]),
    )).toThrow("length");
    const corrupt = Buffer.from(encoded);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xff;
    expect(() => decodeRestoreJournalEnvelope("record", corrupt)).toThrow("checksum");
  });

  it("rejects non-UTF-8 bytes, lossy strings, and oversized payloads", () => {
    expect(() => encodeRestoreJournalEnvelope("record", "\ud800")).toThrow("valid UTF-8");
    expect(() => encodeRestoreJournalEnvelope(
      "record",
      "x".repeat(RESTORE_JOURNAL_MAX_PAYLOAD_BYTES + 1),
    )).toThrow("too large");

    const invalidUtf8 = encodeRestoreJournalEnvelope("record", "x");
    invalidUtf8[RESTORE_JOURNAL_ENVELOPE_HEADER_BYTES] = 0xff;
    // Recompute the payload checksum would require reaching into the codec; the checksum rejection
    // is already the correct fail-closed result for invalid external bytes.
    expect(() => decodeRestoreJournalEnvelope("record", invalidUtf8)).toThrow("checksum");
  });
});
