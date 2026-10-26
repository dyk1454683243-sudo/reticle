/**
 * `init` installs the prompt-capture hook for the agents used here, says so in one line, and
 * installs none under `--no-prompt-capture`.
 */
import { describe, expect, it } from 'vitest';
import { runInit, type InitOptions } from '@/run.js';
import { memoryIo } from '@/memory-io.test-helpers.js';
import { PROMPT_HOOK_MARKER } from '@/register/prompt-hooks.js';
import { PROMPT_CAPTURE_NOTICE } from './stop-hook-step.js';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'app',
    scripts: { dev: 'vite' },
    devDependencies: { vite: '^7.0.0' },
  }),
  'vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({});\n",
  'index.html': '<!doctype html><html><body></body></html>\n',
  // Cursor is used in this project; Gemini has its settings file in the home directory.
  '.cursor/hooks.json': JSON.stringify({ version: 1, hooks: { stop: [{ command: 'x' }] } }),
  '.cursor': '',
  '/home/u/.gemini/settings.json': '{}',
};

const OPTS: InitOptions = {
  cwd: '/project',
  port: undefined,
  mcp: true,
  install: false,
  dryRun: false,
};

const hooked = (written: Record<string, string>): string[] =>
  Object.entries(written)
    .filter(([, content]) => content.includes(PROMPT_HOOK_MARKER))
    .map(([path]) => path)
    .sort();

describe('init and the prompt-capture hook', () => {
  it('installs it for each agent used here, keeps their hooks, and says so once', () => {
    const io = memoryIo(FILES);
    runInit(OPTS, io);
    expect(hooked(io.written)).toEqual([
      '.claude/settings.json',
      '.cursor/hooks.json',
      '.gemini/settings.json',
    ]);
    const cursor = JSON.parse(io.written['.cursor/hooks.json'] ?? '{}') as {
      hooks?: { stop?: unknown };
    };
    expect(cursor.hooks?.stop).toEqual([{ command: 'x' }]);
    // Agents not used here get no config at all.
    expect(io.written['.codex/hooks.json']).toBeUndefined();
    expect(io.written['.factory/hooks.json']).toBeUndefined();
    expect(io.lines.filter((line) => line.includes(PROMPT_CAPTURE_NOTICE))).toHaveLength(1);
  });

  /** The consent line named only a sign-in. A key in the environment shares too, and it never said how to keep prompts local. */
  it('names every way a prompt is shared, and the switch that keeps it local', () => {
    expect(PROMPT_CAPTURE_NOTICE).toContain('RETICLE_API_KEY');
    expect(PROMPT_CAPTURE_NOTICE).toContain('"shareRequests": false');
    expect(PROMPT_CAPTURE_NOTICE).toContain('RETICLE_PROMPT_CAPTURE=0');
  });

  /** The hooks also keep tool calls, the model and closing messages; the notice named only prompts. */
  it('names all that the hooks keep, what a linked run sends, and the one switch for all of it', () => {
    for (const kept of ['prompt', 'tool calls', 'model', 'closing message']) {
      expect(PROMPT_CAPTURE_NOTICE).toContain(kept);
    }
    expect(PROMPT_CAPTURE_NOTICE).toContain('Tool calls stay on this machine');
    expect(PROMPT_CAPTURE_NOTICE).toMatch(/sends the model/);
    expect(PROMPT_CAPTURE_NOTICE).toMatch(
      /prompts and the closing messages[^.]*"shareRequests": false/,
    );
    expect(PROMPT_CAPTURE_NOTICE).toContain('Stop all of it: "promptCapture": false');
  });

  it('adds nothing on a second run', () => {
    const io = memoryIo(FILES);
    runInit(OPTS, io);
    const first = { ...io.written };
    runInit(OPTS, io);
    for (const path of hooked(first)) expect(io.written[path], path).toBe(first[path]);
  });

  it('installs none under --no-prompt-capture', () => {
    const io = memoryIo(FILES);
    runInit({ ...OPTS, promptCapture: false }, io);
    expect(hooked(io.written)).toEqual([]);
    expect(io.lines.some((line) => line.includes(PROMPT_CAPTURE_NOTICE))).toBe(false);
  });
});
