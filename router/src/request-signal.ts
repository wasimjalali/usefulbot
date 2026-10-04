/**
 * The deadline for one upstream call. Before the first response header it is
 * `headerMs`; once headers arrive, only `totalMs` (a backstop) remains, because
 * a stream that keeps producing is governed by the idle timers in index.ts.
 * Both end the call with a TimeoutError, which abortKind reads as "total".
 */
export function requestSignal(
  controller: AbortController,
  limits: { headerMs: number; totalMs: number },
): { signal: AbortSignal; headersArrived: () => void; dispose: () => void } {
  const headerTimer = setTimeout(
    () => controller.abort(new DOMException("header timeout", "TimeoutError")),
    limits.headerMs,
  );
  return {
    signal: AbortSignal.any([AbortSignal.timeout(limits.totalMs), controller.signal]),
    headersArrived: () => clearTimeout(headerTimer),
    dispose: () => clearTimeout(headerTimer),
  };
}
