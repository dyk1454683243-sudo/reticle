/**
 * Every tool call lands in the episode log with its whole result and the page events it caused.
 *
 * Before this, the trajectory an agent took was kept only where it drove the page (the journal's
 * act/navigate/assert actions), with a bounded effect summary and never the result it was told. A
 * read, its answer, and every call made before a tab connected were gone once the agent compacted.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, ReticleDir, ReticleTool } from '@reticlehq/core';
import { createFakeSession } from '@/portal/session/fake-session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import {
  EpisodeRecordKind,
  episodePath,
  flushEpisodeLogs,
  setEpisodeLogEnabled,
} from '@/memory/journal/episode-log.js';
import type { ToolDef, ToolDeps } from './tools.js';
import { runTool } from './invoke-tool.js';
import { noteAgentSession } from '@/hooks/coding-agents.js';

/**
 * A `git` that answers slowly, first on the PATH. The first episode line waits on git, and on
 * Windows a git process takes longer to start than the fixed wait this test used to read after.
 * Windows does not run a file with no extension, so there the real git is used.
 */
function slowGitFirstOnPath(): void {
  const bin = mkdtempSync(join(tmpdir(), 'slow-git-'));
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nsleep 0.3\nexit 1\n');
  chmodSync(join(bin, 'git'), 0o755);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
}

describe('the episode log at the dispatcher', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the call, its full result, its tab, and the events it caused', async () => {
    slowGitFirstOnPath();
    const root = join(mkdtempSync(join(tmpdir(), 'dispatch-episode-')), ReticleDir.ROOT);
    mkdirSync(root, { recursive: true });
    const tab = createFakeSession({}, { sessionId: 'tab-1', url: 'http://localhost:5173/' });
    tab.artifactRoot = root;
    const sessions: Partial<SessionManager> = {
      resolve: () => tab,
      list: () => [{ sessionId: tab.id, url: tab.url }] as ReturnType<SessionManager['list']>,
    };
    const fs = createNodeFileSystem();
    const now = (): number => 0;
    const deps: ToolDeps = {
      sessions: sessions as SessionManager,
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
      flows: new FlowStore(fs, root, { now }),
      project: new ProjectStore(fs, root, { now }),
      annotations: new AnnotationStore(),
      fs,
      reticleRoot: root,
      now,
      attachId: 'conn-1',
    };
    const longAnswer = { nodes: Array.from({ length: 50 }, (_, i) => ({ ref: `e${String(i)}` })) };
    const tool: ToolDef = {
      name: ReticleTool.QUERY,
      description: '',
      inputSchema: {},
      handler: () => {
        // The page answers while the call runs: this is the call's effect on the environment.
        tab.pushEvent({ t: 0, type: EventType.NET_REQUEST, sessionId: tab.id, seq: 9, data: {} });
        return Promise.resolve(longAnswer);
      },
    };

    // What the MCP attach does when the agent's MCP server announced its session.
    noteAgentSession('conn-1', 'claude-sess-1');
    // What `attachJournal` does when the daemon starts with the journal on.
    setEpisodeLogEnabled(true);
    await runTool(tool, deps, { selector: 'button' });
    setEpisodeLogEnabled(false);
    // The writes are queued off the call's path. Wait until they reach the disk.
    await flushEpisodeLogs();

    const lines = readFileSync(episodePath(root, 'conn-1'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      kind: EpisodeRecordKind.START,
      // The agent session joins this connection to the agent hooks' agent-<session>.jsonl.
      agentSession: 'claude-sess-1',
    });
    expect(lines[1]).toMatchObject({
      kind: EpisodeRecordKind.CALL,
      tool: ReticleTool.QUERY,
      args: { selector: 'button' },
      result: longAnswer,
      sessionId: 'tab-1',
      effect: { counts: { [EventType.NET_REQUEST]: 1 }, seqRange: { from: 9, to: 9 } },
    });
  });
});
