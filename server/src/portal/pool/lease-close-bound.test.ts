/**
 * A context close that never returns must not hold a lease slot, or keep the tab open.
 *
 * The release awaited `context.close()` with no bound. When that close hung, the release never
 * returned, so the sweep never returned, and the reaper wrote no `lease_reaped_expired` line. The
 * leased tab stayed open after the agent was gone, and its slot stayed taken.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEASE_CLOSE_TIMEOUT_MS } from '@reticlehq/core';
import {
  BrowserPool,
  type PooledBrowser,
  type PooledContext,
  type PooledPage,
} from './browser-pool.js';
import { LeaseReaper } from './lease-reaper.js';

const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
vi.mock('@/log.js', () => ({
  log: (event: string, fields: Record<string, unknown> = {}): void => {
    logged.push({ event, fields });
  },
}));

const NEVER = new Promise<void>(() => undefined);
const TTL_MS = 1_000;
const SWEEP_MS = 100;

function page(): PooledPage {
  return {
    goto: () => Promise.resolve(undefined),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
  };
}

/** A browser whose contexts never finish closing. */
function wedgedBrowser(): PooledBrowser & { closed: number } {
  const browser = {
    closed: 0,
    isConnected: () => true,
    newContext: (): Promise<PooledContext> =>
      Promise.resolve({ newPage: () => Promise.resolve(page()), close: () => NEVER }),
    close: (): Promise<void> => {
      browser.closed += 1;
      return Promise.resolve();
    },
    onDisconnected: () => undefined,
  };
  return browser;
}

beforeEach(() => {
  vi.useFakeTimers();
  logged.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a lease whose context never closes', () => {
  it('frees the slot, closes the browser and logs the reap after the bound', async () => {
    const browser = wedgedBrowser();
    let clock = 0;
    let n = 0;
    const pool = new BrowserPool(() => Promise.resolve(browser), {
      maxContexts: 1,
      genSessionId: () => `s${String(++n)}`,
      now: () => clock,
      leaseTtlMs: TTL_MS,
    });
    const lease = await pool.acquire('http://localhost:3000/');
    clock += TTL_MS + 1;

    const reaper = new LeaseReaper(pool, SWEEP_MS);
    reaper.start();
    await vi.advanceTimersByTimeAsync(SWEEP_MS + LEASE_CLOSE_TIMEOUT_MS);
    reaper.stop();

    expect(logged).toContainEqual({
      event: 'lease_reaped_expired',
      fields: { leases: [lease.sessionId] },
    });
    expect(logged.map((l) => l.event)).toContain('lease_close_timed_out');
    expect(pool.activeCount()).toBe(0);
    expect(browser.closed).toBeGreaterThan(0);
    // The slot is free: an acquire that refuses to queue gets one.
    const next = await pool.acquire('http://localhost:3000/', { whenFull: 'refuse' });
    expect(next.sessionId).toBe('s2');
  });
});
