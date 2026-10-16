import { describe, expect, it } from 'vitest';
import { CHROMIUM_ANTI_THROTTLING_ARGS, chromiumLaunchOptions } from './chromium-launch-options.js';

describe('chromiumLaunchOptions', () => {
  it('carries the anti-throttling switches next to the headless flag', () => {
    const opts = chromiumLaunchOptions(true);
    expect(opts.headless).toBe(true);
    for (const flag of CHROMIUM_ANTI_THROTTLING_ARGS) {
      expect(opts.args).toContain(flag);
    }
  });

  // A public page (a production drive) dials the bridge on loopback. Chromium 151 blocks that with
  // ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS unless the check is off, and a leased browser has
  // no person to answer the permission prompt.
  it('turns off the Local Network Access check, so a public page can reach the bridge', () => {
    expect(chromiumLaunchOptions(true).args).toContain(
      '--disable-features=LocalNetworkAccessChecks',
    );
  });

  it('passes headless:false through untouched', () => {
    expect(chromiumLaunchOptions(false).headless).toBe(false);
  });

  it('carries an executable path when one is given, and none otherwise', () => {
    expect(chromiumLaunchOptions(true, undefined, '/opt/chromium/chrome')).toMatchObject({
      executablePath: '/opt/chromium/chrome',
    });
    expect(chromiumLaunchOptions(true)).not.toHaveProperty('executablePath');
  });

  it('hands out a fresh array each call, so a caller cannot mutate the constant', () => {
    const a = chromiumLaunchOptions(true);
    const b = chromiumLaunchOptions(true);
    expect(a.args).not.toBe(b.args);
    a.args.push('--sneaky');
    expect(b.args).not.toContain('--sneaky');
  });
});
