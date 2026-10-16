import { describe, expect, it } from 'vitest';
import { HelloEnv, HelloScope } from '@reticlehq/core';
import { admitHello, PRODUCTION_HELLO_REFUSED } from './production-hello.js';

const ACT = { scope: HelloScope.ACT };

describe('which HELLO may open a production session', () => {
  it('leaves a development HELLO without a production nonce as it was', () => {
    expect(admitHello({}, undefined)).toEqual({ ok: true });
  });

  it('refuses a production HELLO that has no production nonce, whatever token it carried', () => {
    expect(admitHello({ env: HelloEnv.PRODUCTION, scope: HelloScope.ACT }, undefined)).toEqual({
      ok: false,
      reason: PRODUCTION_HELLO_REFUSED,
    });
  });

  it('refuses a production HELLO that does not name its scope', () => {
    expect(admitHello({ env: HelloEnv.PRODUCTION }, ACT).ok).toBe(false);
  });

  it('opens a production session with the scope the nonce granted', () => {
    expect(admitHello({ env: HelloEnv.PRODUCTION, scope: HelloScope.ACT }, ACT)).toEqual({
      ok: true,
      production: { scope: HelloScope.ACT },
    });
  });

  it('lets the page narrow act to observe, and never widen observe to act', () => {
    const narrowed = admitHello({ env: HelloEnv.PRODUCTION, scope: HelloScope.OBSERVE }, ACT);
    expect(narrowed).toEqual({ ok: true, production: { scope: HelloScope.OBSERVE } });
    const widened = admitHello(
      { env: HelloEnv.PRODUCTION, scope: HelloScope.ACT },
      { scope: HelloScope.OBSERVE },
    );
    expect(widened).toEqual({ ok: true, production: { scope: HelloScope.OBSERVE } });
  });

  it('keeps a production nonce production even when the page claims development', () => {
    expect(admitHello({}, ACT)).toEqual({ ok: true, production: { scope: HelloScope.ACT } });
  });
});
