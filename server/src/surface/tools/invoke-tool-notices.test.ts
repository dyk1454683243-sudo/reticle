import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRules, ReticleDir, ReticleTool } from '@reticlehq/core';
import { NOTICE_FOLD } from './invoke-tool.js';
import { EnvelopeKey } from './tool-kit.js';
import { forTheAgent } from './agent/for-the-agent.js';
import { resetNotices } from './agent/notices.js';

/**
 * A version-skew warning is decisive: it explains every tool result after it and names the command
 * that fixes it. Folding it into a notice line turned it into a string under another key, and the
 * e2e battery's skewed peer read an empty `reticle_sessions` answer with no `version_skew` at all.
 */
beforeEach(() => resetNotices());

const skew = { pair: 'daemon', action: 'run `npx @reticlehq/server stop`, then retry' };

describe('version_skew is never folded or trimmed', () => {
  it('is not one of the advisories that become notice lines', () => {
    expect(NOTICE_FOLD.advisories).not.toContain(EnvelopeKey.VERSION_SKEW);
  });

  it('reaches the agent intact on an empty session list, which is otherwise cut to one sentence', () => {
    const out = forTheAgent({
      name: ReticleTool.SESSIONS,
      args: {},
      result: { sessions: [], why: 'no browser session connected. More text.', version_skew: skew },
      attach: 'peer',
      root: undefined,
      fold: NOTICE_FOLD,
    }) as Record<string, unknown>;
    expect(out[EnvelopeKey.VERSION_SKEW]).toEqual(skew);
  });

  it('and again on the next call that carries it — it is never deduplicated away', () => {
    const call = () =>
      forTheAgent({
        name: ReticleTool.ACT_AND_WAIT,
        args: {},
        result: { verified: 'unknown', because: 'b', since: 1, version_skew: skew },
        attach: 'peer',
        root: undefined,
        fold: NOTICE_FOLD,
      }) as Record<string, unknown>;
    call();
    expect(call()[EnvelopeKey.VERSION_SKEW]).toEqual(skew);
  });
});

/**
 * The first answer said "Reticle's rules are in the Reticle section of your CLAUDE.md / AGENTS.md"
 * in a project where `init` never ran, so no such section existed. The pointer sent the agent to
 * read a file that was not there.
 */
describe('the pointer to the rules file', () => {
  const RULES = /Reticle section of your CLAUDE\.md/;
  const notices = (root: string | undefined, attach: string): string =>
    JSON.stringify(
      forTheAgent({
        name: ReticleTool.ACT_AND_WAIT,
        args: {},
        result: { verified: 'unknown', because: 'b', since: 1 },
        attach,
        root,
        fold: NOTICE_FOLD,
      }),
    );
  const project = (rules: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-pointer-'));
    mkdirSync(join(dir, '.git'));
    for (const [name, body] of Object.entries(rules)) {
      writeFileSync(join(dir, name), body);
    }
    return join(dir, ReticleDir.ROOT);
  };

  it('is left out where no rules file has the Reticle section', () => {
    expect(notices(undefined, 'a1')).not.toMatch(RULES);
    expect(notices(project({}), 'a2')).not.toMatch(RULES);
    expect(notices(project({ 'CLAUDE.md': '# Mine\n' }), 'a3')).not.toMatch(RULES);
  });

  it('is given where CLAUDE.md or AGENTS.md has the section', () => {
    const section = `${AgentRules.BEGIN}\nrules\n`;
    expect(notices(project({ 'CLAUDE.md': section }), 'a4')).toMatch(RULES);
    expect(notices(project({ 'AGENTS.md': section }), 'a5')).toMatch(RULES);
  });

  it('finds the section at the repository root when the app is in a subfolder', () => {
    const app = join(dirname(project({ 'AGENTS.md': `${AgentRules.BEGIN}\n` })), 'apps', 'web');
    mkdirSync(app, { recursive: true });
    expect(notices(join(app, ReticleDir.ROOT), 'a6')).toMatch(RULES);
  });
});
