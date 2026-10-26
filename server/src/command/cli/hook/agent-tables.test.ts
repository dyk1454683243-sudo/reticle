/**
 * Five tables name the coding agents, in three packages and with two spellings of an id:
 * `McpClient` and `PromptHookAgent` in init, `AgentClient` in core, the handshake labels in
 * `hooks/coding-agents.ts`, and the environment markers in `telemetry/agent-client.ts`.
 *
 * The defect this would have caught: Factory Droid got a prompt hook with no `McpClient` row and no
 * `AgentClient` value, so `init` could capture its prompts but not register it, and its events
 * reported as `other`, and nothing said so. A new agent must now be placed in each table, or be
 * listed below as missing from it on purpose.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpClient, PROMPT_HOOK_AGENTS, PromptHookAgent } from '@reticlehq/init';
import { AgentClient } from '@reticlehq/core/telemetry';
import { agentClientOf } from '@/hooks/coding-agents.js';

/** For each prompt-hook agent: its MCP registration, and what its telemetry reports as. */
const EXPECTED: Record<PromptHookAgent, { mcp: McpClient | null; client: AgentClient | null }> = {
  [PromptHookAgent.CLAUDE_CODE]: { mcp: McpClient.CLAUDE_CODE, client: AgentClient.CLAUDE_CODE },
  [PromptHookAgent.CURSOR]: { mcp: McpClient.CURSOR, client: AgentClient.CURSOR },
  [PromptHookAgent.CODEX]: { mcp: McpClient.CODEX, client: AgentClient.CODEX },
  [PromptHookAgent.GEMINI]: { mcp: McpClient.GEMINI, client: AgentClient.GEMINI_CLI },
  [PromptHookAgent.WINDSURF]: { mcp: McpClient.WINDSURF, client: AgentClient.WINDSURF },
  [PromptHookAgent.COPILOT]: { mcp: McpClient.VSCODE, client: AgentClient.VSCODE },
  // Hook only, on purpose: Reticle does not register itself with Factory Droid yet.
  [PromptHookAgent.FACTORY]: { mcp: null, client: null },
};

describe('the agent tables agree', () => {
  it('places every prompt-hook agent in every table, or says why not', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(PromptHookAgent).sort());
    expect(PROMPT_HOOK_AGENTS.map((spec) => spec.id).sort()).toEqual(
      Object.values(PromptHookAgent).sort(),
    );
    const mcp: readonly string[] = Object.values(McpClient);
    for (const spec of PROMPT_HOOK_AGENTS) {
      const want = EXPECTED[spec.id];
      if (want.mcp !== null) expect(mcp, spec.id).toContain(want.mcp);
      // The registered client's name is what its handshake carries: it must map to the client.
      if (want.mcp !== null) expect(agentClientOf(want.mcp), spec.id).toBe(want.client);
    }
  });

  it('gives every MCP client a telemetry value', () => {
    for (const id of Object.values(McpClient)) {
      const client = agentClientOf(id);
      expect(client, id).toBeDefined();
      expect(client, id).not.toBe(AgentClient.OTHER);
    }
  });

  it('keeps no second copy of an agent id in the prompt hook', () => {
    for (const file of ['prompt-hook.ts', 'hook-command.ts']) {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8');
      for (const id of Object.values(PromptHookAgent))
        expect(source, `${file} spells '${id}'`).not.toContain(`'${id}'`);
    }
  });
});
