/**
 * `reticle hook install` adds the prompt hook to a project set up before the hook existed.
 *
 * The defect: it counted an agent as used when its folder was in the HOME directory. In a repo that
 * had only `.claude/`, it also wrote `.codex/hooks.json`, `.gemini/settings.json`,
 * `.cursor/hooks.json`, `.factory/hooks.json` and `.github/hooks/…`: committable files that make
 * every teammate's prompts run `npx`.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHook } from './hook-command.js';

const HOME_AGENTS = ['.codex', '.cursor', '.factory', '.copilot', '.vscode', '.gemini'];
const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
let project = '';

beforeEach(() => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-hook-home-')));
  for (const dir of HOME_AGENTS) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, '.gemini', 'settings.json'), '{}');
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  project = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-hook-project-')));
  writeFileSync(join(project, '.reticle.json'), JSON.stringify({ projectId: 'p-1' }));
  mkdirSync(join(project, '.claude'));
  vi.spyOn(process, 'cwd').mockReturnValue(project);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('reticle hook install', () => {
  it('writes a config only for an agent the project uses', async () => {
    const lines: string[] = [];
    await handleHook(['install'], (line) => lines.push(line));
    expect(existsSync(join(project, '.claude', 'settings.json'))).toBe(true);
    for (const config of [
      '.codex/hooks.json',
      '.cursor/hooks.json',
      '.factory/hooks.json',
      '.gemini/settings.json',
      '.github/hooks/reticle-prompt-capture.json',
    ]) {
      expect(existsSync(join(project, config)), config).toBe(false);
    }
  });
});
