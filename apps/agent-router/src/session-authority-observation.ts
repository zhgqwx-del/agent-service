import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_SESSION_AUTHORITY_OWNER_PATH,
  INTERNAL_SESSION_AUTHORITY_ACK_HEADER, INTERNAL_SESSION_AUTHORITY_ACK_VALUE,
  SessionAuthorityObservationResponse, type SessionAuthorityObservation } from "@agent-service/protocol";

/** One exact configured target; native close is joined even on abort, redirect or invalid body. */
export async function observeSessionAuthorityTarget(target: string, sessionId: string, nonce: string,
  token: string, signal: AbortSignal): Promise<SessionAuthorityObservation> {
  signal.throwIfAborted();
  const url = new URL(target + INTERNAL_SESSION_AUTHORITY_OWNER_PATH);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error("authority_observation_unavailable");
  const body = JSON.stringify({ sessionId, nonce });
  const lookups = new Set<Promise<void>>();
  const lookup: NonNullable<RequestOptions["lookup"]> = (hostname, options, callback) => {
    let settled!: () => void;
    const done = new Promise<void>(resolve => { settled = resolve; }); lookups.add(done);
    void done.then(() => lookups.delete(done));
    try { dnsLookup(hostname, options, (failure, address, family) => {
      try { callback(failure, address, family); } finally { settled(); }
    }); } catch (failure) { settled(); throw failure; }
  };
  let request: ClientRequest | undefined, response: IncomingMessage | undefined;
  let requestClosed: Promise<void> = Promise.resolve(), responseClosed: Promise<void> = Promise.resolve(), socketClosed: Promise<void> = Promise.resolve();
  let rejectPending: ((failure: Error) => void) | undefined;
  const cancel = () => { response?.destroy(); request?.destroy(); rejectPending?.(Error("authority_observation_unavailable")); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      rejectPending = reject;
      request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'POST', agent: false, lookup, headers: { 'content-type': 'application/json', accept: 'application/json',
          'content-length': Buffer.byteLength(body), connection: 'close', [INTERNAL_ROUTER_TOKEN_HEADER]: token },
      });
      requestClosed = new Promise(done => request!.once('close', done));
      request.once('socket', socket => { socketClosed = new Promise(done => socket.once('close', () => done())); });
      request.on('error', () => reject(Error("authority_observation_unavailable")));
      request.once('response', value => {
        response = value; responseClosed = new Promise(done => value.once('close', done));
        value.on('error', () => reject(Error("authority_observation_unavailable")));
        value.once('aborted', () => reject(Error("authority_observation_unavailable")));
        value.once('close', () => { if (!value.complete) reject(Error("authority_observation_unavailable")); });
        if (value.statusCode !== 200 || value.headers[INTERNAL_SESSION_AUTHORITY_ACK_HEADER] !== INTERNAL_SESSION_AUTHORITY_ACK_VALUE
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(value.headers['content-type'] ?? ''))
          || value.headers['content-length'] !== undefined && (!/^\d+$/.test(String(value.headers['content-length'])) || Number(value.headers['content-length']) > 4096)) {
          reject(Error("authority_observation_unavailable")); value.destroy(); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        value.on('data', chunk => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.byteLength;
          if (size > 4096) { reject(Error("authority_observation_unavailable")); value.destroy(); }
          else chunks.push(bytes);
        });
        value.once('end', () => {
          try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
          catch { reject(Error("authority_observation_unavailable")); }
        });
      });
      if (signal.aborted) { cancel(); reject(Error("authority_observation_unavailable")); }
      else request.end(body);
    });
    signal.throwIfAborted();
    const parsed = SessionAuthorityObservationResponse.parse(raw);
    if (parsed.nonce !== nonce || parsed.sessionId !== sessionId) throw Error("authority_observation_unavailable");
    return parsed;
  } finally {
    signal.removeEventListener('abort', cancel); cancel();
    await requestClosed; await Promise.all([responseClosed, socketClosed]);
    // Cancellation cannot interrupt libc lookup; its original callback is still joined.
    while (lookups.size) await Promise.all([...lookups]);
  }
}
