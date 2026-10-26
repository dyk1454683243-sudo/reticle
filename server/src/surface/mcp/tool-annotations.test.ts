/**
 * Every advertised tool tells the client whether it changes anything.
 *
 * The defect: no Reticle tool declared MCP `annotations`. A client that decides approval from them
 * then treats every tool as a write. Under Codex with `approval_policy = "never"`, every Reticle
 * call was refused, the read-only ones too, and the agent said that the environment blocked
 * browser verification.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { staticToolCatalog } from './mcp.js';
import { TOOL_SURFACE } from '@/surface/tools/tool-surface.js';

interface Listed {
  name: string;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown };
}

describe('the annotations on the tool list', () => {
  it.each(Object.values(TOOL_SURFACE))('are on every tool of the %s surface', async (surface) => {
    const tools = (await staticToolCatalog(surface)) as Listed[];
    const missing = tools.filter(
      (tool) =>
        'boolean' !== typeof tool.annotations?.readOnlyHint ||
        false !== tool.annotations.destructiveHint ||
        'boolean' !== typeof tool.annotations.openWorldHint,
    );
    expect(missing.map((tool) => tool.name)).toEqual([]);
  });

  it('mark reading as read-only and acting as not read-only', async () => {
    const lists = await Promise.all(Object.values(TOOL_SURFACE).map(staticToolCatalog));
    const tools = lists.flat() as Listed[];
    const readOnly = (name: string): unknown =>
      tools.find((tool) => name === tool.name)?.annotations?.readOnlyHint;
    expect(readOnly(ReticleTool.LOOK)).toBe(true);
    expect(readOnly(ReticleTool.OBSERVE)).toBe(true);
    expect(readOnly(ReticleTool.TOOLS)).toBe(true);
    expect(readOnly(ReticleTool.SESSIONS)).toBe(true);
    expect(readOnly(ReticleTool.ACT)).toBe(false);
    expect(readOnly(ReticleTool.NAVIGATE)).toBe(false);
    expect(readOnly(ReticleTool.RUN)).toBe(false);
  });
});
