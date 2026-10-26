/**
 * The Harness plans its drive on the platform, and the user's latest request is one of the goals it
 * sends. That request is the user's own words, so it leaves only when runs would carry it too.
 *
 * The defect: `"shareRequests": false` kept the request off every run, but the Harness still sent it
 * to the platform planner as a goal, because it read `request.json` and never asked.
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import type { ToolDeps } from './tool-kit.js';
import { memoryGoals } from './harness-script.js';

const REQUEST = 'The refund must reach the customer within five days';
const NOW = 10_000;

async function goalsFor(config: Record<string, unknown>, shared: boolean): Promise<string[]> {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-harness-share-')));
  writeFileSync(join(project, '.reticle.json'), JSON.stringify(config));
  const root = join(project, '.reticle');
  const { fs } = createMemoryFs();
  await fs.writeFile(
    reticleDirPaths(root).request,
    JSON.stringify({ request: REQUEST, statements: [], at: NOW - 1, shared }),
  );
  const deps = {
    fs,
    reticleRoot: root,
    now: () => NOW,
    sessions: { resolve: () => undefined, count: () => 0 },
  } as unknown as ToolDeps;
  return memoryGoals(deps);
}

describe('the request the Harness sends to the platform planner', () => {
  it('is sent from a project that shares requests', async () => {
    expect(await goalsFor({ projectId: 'p', shareRequests: true }, true)).toEqual([REQUEST]);
  });

  it('is not sent when the project says "shareRequests": false', async () => {
    expect(await goalsFor({ projectId: 'p', shareRequests: false }, true)).toEqual([]);
  });

  it('is not sent when it was captured unshared', async () => {
    expect(await goalsFor({ projectId: 'p', shareRequests: true }, false)).toEqual([]);
  });
});
