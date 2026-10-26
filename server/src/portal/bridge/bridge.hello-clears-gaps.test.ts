/**
 * A fresh HELLO drops the gaps that earlier verdicts recorded for the session (#1655).
 *
 * A gap recorded before the app registered its store stayed in the map for the life of the daemon.
 * A reload keeps the session id, and nothing called `forgetRecordedGaps`. So `reticle doctor` and
 * the Harness gate went on to list app state as missing after the page announced `state`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ChannelId, CoverageCapability, InstrumentationGapKind } from '@reticlehq/core';
import {
  forgetAllRecordedGaps,
  instrumentationOf,
  recordGaps,
  recordedGaps,
} from '@/portal/session/recorded-gaps.js';
import { Bridge } from './bridge.js';
import { FakeBrowser, waitUntil } from './bridge.test-harness.js';

const NO_STORE = {
  kind: InstrumentationGapKind.NO_STORE_REGISTERED,
  missing: 'no store',
  fix: 'register the store',
};
const WITH_STATE = [ChannelId.UI, ChannelId.NET, ChannelId.LOG, ChannelId.STATE];

afterEach(() => forgetAllRecordedGaps());

describe('a fresh hello clears the gaps recorded before it', () => {
  it('a repeat hello that announces state makes app state seen', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    const browser = new FakeBrowser(port, 'gaps-1');
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count());
    recordGaps('gaps-1', [NO_STORE], 1);

    browser.reannounce({ hasCapabilities: true, channels: WITH_STATE });
    await waitUntil(() => true === bridge.sessions.get('gaps-1')?.hasCapabilities);

    const session = bridge.sessions.get('gaps-1');
    expect(recordedGaps('gaps-1')).toEqual([]);
    expect(session === undefined ? [] : instrumentationOf(session).seen).toContain(
      CoverageCapability.APP_STATE,
    );
    browser.close();
    await bridge.close();
  });

  it('a reload, a new socket with the same session id, clears them too', async () => {
    const bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    const first = new FakeBrowser(port, 'gaps-2');
    await first.open();
    await waitUntil(() => 1 === bridge.sessions.count());
    recordGaps('gaps-2', [NO_STORE], 1);
    const before = bridge.sessions.get('gaps-2');

    const reloaded = new FakeBrowser(port, 'gaps-2');
    await reloaded.open();
    await waitUntil(() => before !== bridge.sessions.get('gaps-2'));

    expect(recordedGaps('gaps-2')).toEqual([]);
    first.close();
    reloaded.close();
    await bridge.close();
  });
});
