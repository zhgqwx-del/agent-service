/** Abort a native request and bound even a provider that fails to settle after cancellation. */
export async function runAbortableRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operationSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const fail = (name: "AbortError" | "TimeoutError") => {
      const error = Object.assign(new Error("Object-store operation cancelled"), { name });
      controller.abort(error);
      reject(error);
    };
    onAbort = () => fail("AbortError");
    operationSignal?.addEventListener("abort", onAbort, { once: true });
    if (operationSignal?.aborted) onAbort();
    else timer = setTimeout(() => fail("TimeoutError"), timeoutMs);
  });
  const operation = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw Object.assign(new Error("Object-store operation cancelled"), { name: "AbortError" });
    return request(controller.signal);
  });
  void operation.catch(() => {});
  try { return await Promise.race([operation, cancelled]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    operationSignal?.removeEventListener("abort", onAbort);
  }
}
