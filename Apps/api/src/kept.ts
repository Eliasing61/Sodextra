/**
 * A value worth keeping a while (site-wide totals that take a moment to add up): the first
 * ask computes it; later asks get the kept one at once, and one older than `maxAgeMs` is
 * computed again after the answer has gone out, never by the visitor who happened to ask.
 * A failed computation is tried again on the next ask.
 */
export function kept<T>(
  compute: () => T | Promise<T>,
  maxAgeMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let value: { at: number; v: T } | undefined;
  let running: Promise<T> | undefined;
  const run = (later: boolean): Promise<T> => {
    if (!running) {
      // In the background: after the current request's answer (setImmediate), as SQLite reads
      // hold the event loop while they run.
      const start = later ? new Promise<void>((r) => setImmediate(r)) : Promise.resolve();
      running = start
        .then(compute)
        .then((v) => {
          value = { at: now(), v };
          return v;
        })
        .finally(() => {
          running = undefined;
        });
    }
    return running;
  };
  return async () => {
    if (!value) return run(false);
    if (now() - value.at > maxAgeMs) run(true).catch(() => undefined);
    return value.v;
  };
}
