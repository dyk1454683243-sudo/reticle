/**
 * A close that has a time limit.
 *
 * Playwright's `context.close()` and `browser.close()` can wait forever on a browser that stopped
 * answering. The pool awaited them with no limit, so one such close held a lease slot and kept the
 * tab open after the agent was gone.
 */

/** Logged when a leased tab did not close within LEASE_CLOSE_TIMEOUT_MS. */
export const LEASE_CLOSE_TIMED_OUT = 'lease_close_timed_out';

/**
 * Dispose the lease's init script, then close its context. False when that took longer than `ms`.
 * The disposal is best-effort: a context that is already gone (a crash) makes it moot.
 */
export function closeLeaseTab(
  tab: { hostStub?: { dispose(): Promise<void> }; context: { close(): Promise<void> } },
  ms: number,
): Promise<boolean> {
  const closing = (async (): Promise<void> => {
    await tab.hostStub?.dispose().catch(() => undefined);
    await tab.context.close();
  })();
  return settledWithin(closing, ms);
}

/** Whether `work` settled within `ms`. A rejection counts as settled: the close is over. */
export async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      late,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
