/**
 * A verdict from `reticle_act { steps }` counts as a verification, once (#1770).
 *
 * On the default surface a sequence runs under the `reticle_act` name. That name was not in
 * `VERDICT_TOOLS`, so a sequence that answered `verified: "yes"` emitted no `verification_completed`
 * and did not settle the driven actions. The next call then carried `verify_next`, which said that
 * no verdict was asked for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as telemetryModule from '@/telemetry/telemetry.js';
import { LastAct } from '@/portal/session/last-act.js';
import { ReticleTool, SessionState, Verified, type CommandResult } from '@reticlehq/core';
import { getSessionMetrics, resetSessionMetrics } from '@/telemetry/session-metrics.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { EnvelopeKey, type ToolDef, type ToolDeps } from './tool-kit.js';
import { runTool } from './invoke-tool.js';
import { resetFeedbackPrompt } from './feedback-tools.js';

const ROOT = '/tmp/reticle-act-steps-verdict/.reticle';
const CALLS = 4;

function deps(): ToolDeps {
  const session: Partial<Session> = {
    id: 'tab',
    url: 'http://localhost:15999/',
    elapsed: () => 0,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command: (): Promise<CommandResult> =>
      Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} }),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    takeSessionLease: () => undefined,
    ageWarning: () => undefined,
  };
  const sessions: Partial<SessionManager> = {
    resolve: () => session as Session,
    list: () => [{ sessionId: 'tab', url: session.url }] as ReturnType<SessionManager['list']>,
  };
  return {
    sessions: sessions as SessionManager,
    fs: createNodeFileSystem(),
    reticleRoot: ROOT,
    now: () => 0,
  } as unknown as ToolDeps;
}

/** `reticle_act` as the default surface registers it, with the result a handler gives back. */
function act(result: Record<string, unknown>): ToolDef {
  return {
    name: ReticleTool.ACT,
    description: 'act',
    inputSchema: {},
    handler: () => Promise.resolve(result),
  };
}

afterEach(() => {
  resetSessionMetrics();
  resetFeedbackPrompt();
  vi.restoreAllMocks();
});

describe('reticle_act { steps } with a verdict is a verification', () => {
  it('counts each sequence verdict once and gives no verify_next nudge', async () => {
    const steps = act({ verified: Verified.YES, because: 'each step expect held', steps: [] });
    let last: unknown;
    for (let i = 0; i < CALLS; i += 1) {
      last = await runTool(steps, deps(), { steps: [{ ref: 'e1', action: 'click' }] });
    }
    expect(getSessionMetrics().summarize(false).verifications).toBe(CALLS);
    expect(JSON.stringify(last)).not.toContain(EnvelopeKey.VERIFY_NEXT);
  });

  it('does not count a single action that carries no verdict', async () => {
    const single = act({ dispatched: true, settled: true });
    for (let i = 0; i < CALLS; i += 1) {
      await runTool(single, deps(), { ref: 'e1', action: 'click' });
    }
    expect(getSessionMetrics().summarize(false).verifications).toBe(0);
  });

  it('does not ask for feedback after a single action, which is not a verification', async () => {
    vi.spyOn(telemetryModule, 'getTelemetry').mockReturnValue({
      emit: () => Promise.resolve(true),
      enabled: true,
      firstRun: false,
    });
    const result = await runTool(act({ dispatched: true }), deps(), { ref: 'e1', action: 'click' });
    expect(JSON.stringify(result)).not.toContain(EnvelopeKey.FEEDBACK_PROMPT);
  });
});
