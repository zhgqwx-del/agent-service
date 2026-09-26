import { randomBytes } from "node:crypto";
import type { IdPrefix } from "@agent-service/protocol";

let lastMs = 0;
let counter = 0;

/** RFC 9562 UUIDv7 with a 12-bit monotonic counter inside the same millisecond. */
export function uuidv7(): string {
  let now = Date.now();
  if (now === lastMs) {
    counter = (counter + 1) & 0xfff;
    if (counter === 0) now = ++lastMs; // counter overflow: borrow a millisecond
  } else {
    lastMs = now;
    counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  const rnd = randomBytes(8);
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  const tsHex = hex(now, 12);
  const randA = hex(0x7000 | counter, 4);
  const randB = hex(0x8000 | (rnd.readUInt16BE(0) & 0x3fff), 4);
  const tail = rnd.subarray(2, 8).toString("hex");
  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-${randA}-${randB}-${tail}`;
}

export const newId = (prefix: IdPrefix): string => `${prefix}_${uuidv7()}`;
