import type { ReadableStreamReadResult } from "node:stream/web";

/** Internal process-owner implementation. It defines no HTTP/SDK protocol or retry authority. */
export class CloseFailures {
  private failed = false;
  private first: unknown;

  record(reason: unknown): void {
    if (!this.failed) { this.failed = true; this.first = reason; }
  }

  /** Fence/cancel independent owners now; caller may join this promise after users are stopped. */
  start(actions: readonly (() => unknown | Promise<unknown>)[]): Promise<void> {
    const pending = actions.map(action => {
      try { return Promise.resolve(action()).catch(reason => { this.record(reason); }); }
      catch (reason) { this.record(reason); return Promise.resolve(); }
    });
    return Promise.allSettled(pending).then(() => {});
  }

  /** Start every independent action, observe synchronous throws, and join the original promises. */
  async stage(actions: readonly (() => unknown | Promise<unknown>)[]): Promise<void> {
    await Promise.allSettled(actions.map(action => Promise.resolve().then(action).catch(reason => {
      this.record(reason);
    })));
  }

  throwIfAny(): void { if (this.failed) throw this.first; }
}

/** One role's actual fetch handlers and response-body readers. No buffering or automatic retry. */
export class ProcessHttpOwner {
  private accepting = true;
  private readonly work = new Set<Promise<unknown>>();
  private readonly requests = new Set<AbortController>();
  private readonly bodies = new Set<() => Promise<void>>();
  private readonly failures = new CloseFailures();

  constructor(private readonly dispatch: (request: Request) => Response | Promise<Response>) {}

  stopAccepting(): void { this.accepting = false; }

  /** Synchronous fencing; cancellation is only a request, never a settlement receipt. */
  abort(): void {
    this.stopAccepting();
    for (const request of this.requests) request.abort();
    for (const cancel of this.bodies) this.own(cancel());
  }

  async settle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
    this.failures.throwIfAny();
  }

  private own<T>(work: Promise<T>): Promise<T> {
    this.work.add(work);
    void work.then(() => this.work.delete(work), () => this.work.delete(work));
    return work;
  }

  readonly fetch = (request: Request): Promise<Response> => {
    if (!this.accepting) {
      // Do not invoke app handlers during shutdown, including on existing keep-alive connections.
      const path = new URL(request.url).pathname;
      if (path === "/healthz") return Promise.resolve(new Response("ok"));
      if (path === "/readyz") return Promise.resolve(new Response("draining", { status: 503 }));
      return Promise.resolve(Response.json({ error: { code: "draining", message: "Service is draining." } },
        { status: 503, headers: { "Cache-Control": "no-store" } }));
    }
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    this.requests.add(abort);
    const cleanup = () => {
      this.requests.delete(abort);
      request.signal.removeEventListener("abort", onAbort);
    };
    // Register the task before the dispatch can suspend or a shutdown callback can enter.
    const work = Promise.resolve().then(async () => {
      let bodyOwnsRequest = false;
      try {
        const response = await this.dispatch(new Request(request, { signal: abort.signal }));
        if (!response.body) return response;
        const observed = this.observeBody(response, abort.signal, cleanup);
        bodyOwnsRequest = true;
        return observed;
      } finally { if (!bodyOwnsRequest) cleanup(); }
    });
    return this.own(work);
  };

  private observeBody(response: Response, signal: AbortSignal, cleanup: () => void): Response {
    const reader = response.body!.getReader();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let read: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let cancellation: Promise<void> | undefined;
    let ended = false;
    let finished = false;
    let cancelSettled = false;
    // An already-errored WebStream rejects reader.cancel with its stored body error without
    // invoking the underlying source cancel. That business/transport error is not a failed close.
    // Actual source.cancel rejection happens after the stream transitions closed (closed fulfills).
    let sourceErrored = false;
    void reader.closed.then(() => {}, () => { sourceErrored = true; });
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const release = () => {
      if (!ended || read || finished) return;
      if (!cancellation || cancelSettled) complete();
    };
    const complete = () => {
      if (finished || read) return;
      finished = true;
      signal.removeEventListener("abort", onAbort);
      this.bodies.delete(cancel);
      try { reader.releaseLock(); }
      catch (error) { this.failures.record(error); }
      finally { cleanup(); finish(); }
    };
    const cancel = (): Promise<void> => {
      if (!ended) ended = true;
      if (!cancellation && !finished) {
        // Both the original read and this actual source cancel must settle before releasing ownership.
        try { cancellation = Promise.resolve(reader.cancel()); }
        catch (error) { cancellation = Promise.reject(error); }
        void cancellation.then(() => { cancelSettled = true; release(); }, error => {
          if (!sourceErrored) this.failures.record(error);
          cancelSettled = true; release();
        });
      }
      try { controller?.error(new DOMException("Response observation closed.", "AbortError")); } catch { /* Already terminal. */ }
      release();
      return done;
    };
    const onAbort = () => { this.own(cancel()); };
    this.bodies.add(cancel);
    this.own(done);
    const body = new ReadableStream<Uint8Array>({
      start: value => { controller = value; },
      pull: async value => {
        if (ended) return;
        // The ReadableStream machinery invokes only one pull at a time; retain its original read.
        read = reader.read();
        try {
          const next = await read;
          if (ended) return;
          if (next.done) { ended = true; value.close(); }
          else value.enqueue(next.value);
        } catch (error) {
          ended = true;
          try { value.error(error); } catch { /* Already terminal. */ }
        } finally { read = undefined; release(); }
      },
      cancel: () => cancel(),
    }, { highWaterMark: 0 });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
