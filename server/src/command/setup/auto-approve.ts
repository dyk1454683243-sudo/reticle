/**
 * Removing the Accept button, for the tools Reticle owns and nothing else.
 *
 * A drive that stops on a per-call approval dialog is not automated, and the dialog is per CALL:
 * a single verification run makes dozens, so a human sits there clicking through a loop that was
 * supposed to run without them. Every client below documents a way to pre-approve a named server,
 * and this writes exactly that rule, at install time, in the client's own spelling.
 *
 * Two limits, both deliberate:
 *
 * 1. ONLY `reticle` is allowed. Not `mcp(*)`, not a global auto-run switch. Reticle's tools drive
 *    the user's own dev server on their own machine, which is what makes pre-approving them
 *    defensible; the same edit made globally would hand the same pass to every other MCP server
 *    they ever install, including ones that reach the network. Their approval gate is not ours to
 *    dismantle, only ours to step out of.
 * 2. Nothing is CREATED where the file itself takes over settings we cannot read — Cursor's
 *    permissions.json supersedes its in-app allowlist and pins the run mode to Allowlist, so a user
 *    who ran everything without asking loses that and cannot switch back while the file exists.
 *    Merging into one they already have is fine; making one is not, so that case is DEFERRED with
 *    the in-app step to take instead. Nothing is written at all for an agent that is not installed:
 *    an absent agent has no Accept button to remove.
 *
 * Codex has a per-server rule, `default_tools_approval_mode`, in the `[mcp_servers.reticle]` table
 * that `codex mcp add` writes. Its config is TOML, which this repo does not reformat: the grant adds
 * one line under our own table header and changes no other line. When that header is not there in
 * its plain form, nothing is written and the setting is named instead.
 */

import { joinFor, parentOf, type PlatformPaths } from './agent-configs.js';
import type { AgentWriterIo } from './agent-writer.js';

const RETICLE_KEY = 'reticle';
const INDENT = 2;

/** A documented way to pre-approve one MCP server, in one client's own spelling. */
export interface ApprovalGrant {
  readonly id: string;
  readonly name: string;
  /** Home-relative, per platform. */
  readonly paths: PlatformPaths;
  /** Present if ANY of these exist. An agent that is not installed is not configured. */
  readonly markers: readonly PlatformPaths[];
  /** The rule, in the client's words, for the plan output. */
  readonly rule: string;
  /** Adds our rule to a parsed config, leaving everything else exactly as it was. */
  readonly grant: (current: Record<string, unknown>) => Record<string, unknown>;
  /**
   * True where CREATING this file supersedes in-app settings we can neither read nor restore. Such
   * a grant is only ever merged into a file the user already owns, never created.
   */
  readonly supersedesInApp?: boolean;
  /**
   * For a config that is not JSON: the new text, or null when the edit is not safe. Then nothing is
   * written and `manual` tells the user what to add.
   */
  readonly editText?: (current: string) => string | null;
  readonly manual?: (file: string) => string;
}

const home = (path: string): PlatformPaths => ({ darwin: path, linux: path, win32: path });

/** Append to a nested array, without duplicating and without disturbing what is already in it. */
function addToList(
  current: Record<string, unknown>,
  outer: string | null,
  key: string,
  value: string,
): Record<string, unknown> {
  const scope: Record<string, unknown> =
    null === outer
      ? current
      : 'object' === typeof current[outer] && null !== current[outer]
        ? { ...(current[outer] as Record<string, unknown>) }
        : {};
  const list = Array.isArray(scope[key]) ? (scope[key] as unknown[]) : [];
  if (list.includes(value)) return current;
  const next = { ...scope, [key]: [...list, value] };
  return null === outer ? next : { ...current, [outer]: next };
}

const CODEX_RULE = 'default_tools_approval_mode = "approve"';
const CODEX_TABLE = new RegExp(
  `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${RETICLE_KEY}|"${RETICLE_KEY}"|'${RETICLE_KEY}')\\s*\\]\\s*(?:#.*)?$`,
);
const CODEX_MODE_KEY = /^\s*default_tools_approval_mode\s*=/;
const TOML_HEADER = /^\s*\[/;

/** One line under our `[mcp_servers.reticle]` header. A mode the user set is kept. */
function codexApprove(current: string): string | null {
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.split(/\r?\n/);
  const at = lines.findIndex((line) => CODEX_TABLE.test(line));
  if (at < 0) {
    return null;
  }
  const next = lines.findIndex((line, i) => i > at && TOML_HEADER.test(line));
  const table = lines.slice(at + 1, next < 0 ? undefined : next);
  if (table.some((line) => CODEX_MODE_KEY.test(line))) {
    return current;
  }
  lines.splice(at + 1, 0, CODEX_RULE);
  return lines.join(eol);
}

export const APPROVAL_GRANTS: readonly ApprovalGrant[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    paths: home('.claude/settings.json'),
    markers: [home('.claude')],
    rule: 'permissions.allow += "mcp__reticle"',
    grant: (c) => addToList(c, 'permissions', 'allow', 'mcp__reticle'),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    paths: home('.cursor/permissions.json'),
    markers: [home('.cursor')],
    rule: 'mcpAllowlist += "reticle:*"',
    // Documented: "when a key appears in permissions.json, it fully replaces the in-app allowlist
    // for that type" — and in practice it costs more than that. A non-empty mcpAllowlist also locks
    // the run mode to Allowlist, so a user who had Run Everything ("YOLO") on loses it and cannot
    // turn it back on while the file exists; Cursor has acknowledged that as their bug. Merging into
    // a file the user already made is safe — they are already in Allowlist mode. Creating one is
    // not, so we never do: see the DEFERRED branch below.
    supersedesInApp: true,
    grant: (c) => addToList(c, null, 'mcpAllowlist', `${RETICLE_KEY}:*`),
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    paths: home('.gemini/antigravity-cli/settings.json'),
    markers: [
      {
        darwin: 'Library/Application Support/Antigravity',
        linux: '.config/Antigravity',
        win32: 'AppData/Roaming/Antigravity',
      },
      home('.gemini/antigravity-cli'),
    ],
    rule: 'permissions.allow += "mcp(reticle/*)"',
    grant: (c) => addToList(c, 'permissions', 'allow', `mcp(${RETICLE_KEY}/*)`),
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    paths: home('.gemini/settings.json'),
    markers: [home('.gemini')],
    rule: 'mcpServers.reticle.trust = true',
    // Gemini has no allowlist: trust is a property of the server entry itself, so this reaches into
    // the entry init already wrote rather than adding a rule beside it.
    grant: (c) => {
      const servers =
        'object' === typeof c['mcpServers'] && null !== c['mcpServers']
          ? { ...(c['mcpServers'] as Record<string, unknown>) }
          : {};
      const entry =
        'object' === typeof servers[RETICLE_KEY] && null !== servers[RETICLE_KEY]
          ? (servers[RETICLE_KEY] as Record<string, unknown>)
          : {};
      return { ...c, mcpServers: { ...servers, [RETICLE_KEY]: { ...entry, trust: true } } };
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    paths: home('.codex/config.toml'),
    markers: [home('.codex')],
    rule: `mcp_servers.${RETICLE_KEY}.${CODEX_RULE}`,
    grant: (c) => c,
    editText: codexApprove,
    manual: (file) =>
      `add \`${CODEX_RULE}\` under [mcp_servers.${RETICLE_KEY}] in ${file}. Without it, Codex asks before every reticle tool call, and refuses each one under approval_policy = "never".`,
  },
];

export const ApprovalOutcome = {
  GRANTED: 'granted',
  ALREADY: 'already',
  ABSENT: 'absent',
  /** Deliberately left for an explicit run, because doing it unattended costs the user something. */
  DEFERRED: 'deferred',
  FAILED: 'failed',
} as const;
export type ApprovalOutcome = (typeof ApprovalOutcome)[keyof typeof ApprovalOutcome];

export interface ApprovalResult {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly outcome: ApprovalOutcome;
  readonly rule: string;
  /** Set where the user has to be told something the write alone does not say. */
  readonly warn?: string;
}

interface ApprovalWhere {
  readonly home: string;
  readonly platform: keyof PlatformPaths;
}

/**
 * Pre-approve Reticle's tools everywhere the machine has an agent that would otherwise ask.
 *
 * A client that cannot be written is reported, never thrown: one unwritable settings file is not a
 * reason to leave the other three prompting.
 */
export function grantAutoApproval(
  io: AgentWriterIo,
  where: ApprovalWhere,
  grants: readonly ApprovalGrant[] = APPROVAL_GRANTS,
): ApprovalResult[] {
  const join = joinFor(where.platform);
  return grants.map((grant): ApprovalResult => {
    const file = join(where.home, grant.paths[where.platform]);
    const base = { id: grant.id, name: grant.name, file, rule: grant.rule };
    const installed = grant.markers.some((m) => io.exists(join(where.home, m[where.platform])));
    if (!installed) return { ...base, outcome: ApprovalOutcome.ABSENT };
    try {
      const existed = io.exists(file);
      if (grant.editText !== undefined) {
        const current = existed ? io.readFile(file) : '';
        const next = grant.editText(current);
        if (null === next) {
          const warn = grant.manual?.(file);
          return {
            ...base,
            outcome: ApprovalOutcome.DEFERRED,
            ...(warn === undefined ? {} : { warn }),
          };
        }
        if (next === current) {
          return { ...base, outcome: ApprovalOutcome.ALREADY };
        }
        io.writeFile(file, next);
        return { ...base, outcome: ApprovalOutcome.GRANTED };
      }
      if (true === grant.supersedesInApp && !existed) {
        return {
          ...base,
          outcome: ApprovalOutcome.DEFERRED,
          warn: `left ${grant.name}'s approvals alone — creating ${file} would take over its in-app settings and pin the run mode to Allowlist. If ${grant.name} asks before every reticle tool call, add \`${RETICLE_KEY}:*\` under Settings → Agents → Approvals & Execution (nothing to do if you run everything already).`,
        };
      }
      // A settings file we cannot parse is left exactly as it is. Reformatting somebody's config to
      // add one line is a worse outcome than one dialog they have to click.
      const current = existed
        ? (JSON.parse(io.readFile(file)) as Record<string, unknown>)
        : ({} as Record<string, unknown>);
      const next = grant.grant(current);
      if (next === current) return { ...base, outcome: ApprovalOutcome.ALREADY };
      io.mkdirp(parentOf(file));
      io.writeFile(file, `${JSON.stringify(next, null, INDENT)}\n`);
      return { ...base, outcome: ApprovalOutcome.GRANTED };
    } catch (err) {
      return {
        ...base,
        outcome: ApprovalOutcome.FAILED,
        warn: String((err as Error)?.message ?? err).slice(0, 120),
      };
    }
  });
}
