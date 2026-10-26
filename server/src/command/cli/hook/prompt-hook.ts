/**
 * `reticle hook prompt --agent <id>`: what an agent's prompt-submit hook runs.
 *
 * The user's request is what a verdict is checked against, and an agent relays it only when it
 * remembers to. So the agent's own hook hands it over, before the model reads it. This writes, in
 * the project's `.reticle/`:
 *
 *   request.json    the newest prompt, in the shape `reticle_intent { declare, request }` writes;
 *                   a run written soon after carries it, so it reaches the user's own linked
 *                   workspace with that run when the project shares requests;
 *   requests.jsonl  every prompt, one line each, oldest first.
 *
 * Secrets are redacted before anything is written. It stays offline, finishes fast, writes nothing
 * outside `.reticle/`, and never blocks the prompt: every failure is exit 0 and nothing written.
 * Nothing here reaches telemetry: `cli.ts` runs this before it reports the command.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import { PromptHookAgent } from '@reticlehq/init';
import { PromptContextSchema } from '@reticlehq/core/artifacts';
import { discoverProjectConfigs } from '@/command/cli/config/config-discovery.js';
import {
  MAX_REQUEST,
  agentCaptureOff,
  agentCaptureOffIn,
  promptContextFor,
  redactSecrets,
  sharesRequests,
} from '@/memory/intent/record-request.js';
export { agentCaptureOff, agentCaptureOffIn } from '@/memory/intent/record-request.js';
import { readTextOrUndefined } from '@/memory/project/fs/fs-port.js';
import {
  WORKSPACE_GITIGNORE,
  workspaceGitignore,
} from '@/memory/journal/on-disk/workspace-gitignore.js';

/** A hook fired twice for one prompt (VS Code and Copilot CLI read one file) keeps one copy. */
const DUPLICATE_WINDOW_MS = 10_000;
/** The history moves aside once it passes this size, so `.reticle/` cannot grow without end. */
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
/**
 * The tags an agent harness wraps around a prompt it wrote for itself: a background task that
 * finished, a slash command, a shell escape, a reminder. Only these names. A user prompt that starts
 * with a tag of their own (`<Button> must be disabled`) is a real request, and is kept.
 */
const HARNESS_TAGS: readonly string[] = [
  'system-reminder',
  'task-notification',
  'agent-message',
  'cross-session-message',
  'teammate-message',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'persisted-output',
  'user-prompt-submit-hook',
];
const HARNESS_PROMPT = new RegExp(`^<(?:${HARNESS_TAGS.join('|')})[\\s>]`);
/** Where each agent names its project when the payload does not. */
const PROJECT_DIR_ENV = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'GEMINI_PROJECT_DIR'];
const JSON_INDENT = 2;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  'object' === typeof value && null !== value && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  'string' === typeof value && 0 < value.trim().length ? value : undefined;

/**
 * The prompt and the folder it was sent from, read from one agent's payload.
 *
 * Every agent sends `prompt` except Windsurf (`tool_info.user_prompt`). Every agent sends `cwd`
 * except Cursor (`workspace_roots`) and Windsurf (none: its hook runs in the workspace root).
 */
export function promptFromPayload(
  agent: string,
  payload: unknown,
  fallbackCwd: string,
  env: NodeJS.ProcessEnv,
): { prompt: string | undefined; cwd: string } {
  const body = isObject(payload) ? payload : {};
  const toolInfo = isObject(body['tool_info']) ? body['tool_info'] : {};
  const prompt =
    PromptHookAgent.WINDSURF === agent
      ? (text(toolInfo['user_prompt']) ?? text(body['prompt']))
      : (text(body['prompt']) ?? text(toolInfo['user_prompt']));
  const roots = Array.isArray(body['workspace_roots']) ? body['workspace_roots'] : [];
  const cwd =
    text(body['cwd']) ??
    text(roots[0]) ??
    PROJECT_DIR_ENV.map((name) => text(env[name])).find((dir) => dir !== undefined) ??
    fallbackCwd;
  return { prompt, cwd };
}

/** What the prompt hook prints; one table with the fast path's. */
export { promptHookAck as hookAck } from './hook-fast.js';

/**
 * The `.reticle` folders a prompt sent from `cwd` belongs in.
 *
 * The nearest project above `cwd`, and every app below it that declares the same project id. In a
 * monorepo `init` writes the app's config at the root too, and the app's runs read the request
 * from the APP's `.reticle`, so a prompt kept only at the root is a prompt no run ever carries.
 */
export function captureRoots(cwd: string): string[] {
  if (!existsSync(cwd)) {
    return [];
  }
  const { found } = discoverProjectConfigs(cwd);
  const nearest = found.find((config) => isWithin(config.directory, cwd));
  if (nearest === undefined) {
    return [];
  }
  const apps = found.filter(
    (config) =>
      config.directory !== nearest.directory &&
      config.projectId !== undefined &&
      config.projectId === nearest.projectId &&
      isWithin(nearest.directory, config.directory),
  );
  return [nearest, ...apps].map((config) => join(config.directory, ReticleDir.ROOT));
}

/** Is `inner` the folder `outer` or inside it? */
function isWithin(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return '' === rel || (!rel.startsWith('..') && !isAbsolute(rel));
}

interface CaptureIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
}

/** Keep one prompt. Never throws: the folders it wrote to, or none. */
export function capturePrompt(agent: string, raw: string, io: CaptureIo): { written: string[] } {
  try {
    if (agentCaptureOff(io.env)) {
      return { written: [] };
    }
    const { prompt, cwd } = promptFromPayload(agent, JSON.parse(raw) as unknown, io.cwd, io.env);
    if (prompt === undefined || HARNESS_PROMPT.test(prompt.trim())) {
      return { written: [] };
    }
    const written: string[] = [];
    for (const root of captureRoots(cwd)) {
      if (keepIn(root, agent, prompt.trim(), io.now())) {
        written.push(root);
      }
    }
    return { written };
  } catch {
    return { written: [] };
  }
}

/** Write one prompt into one `.reticle`. False when the project opted out, or it is a repeat. */
function keepIn(root: string, agent: string, prompt: string, at: number): boolean {
  const projectDir = dirname(root);
  if (agentCaptureOffIn(projectDir)) {
    return false;
  }
  const requestPath = join(root, ReticleDir.REQUEST_FILE);
  const request = redactSecrets(prompt, MAX_REQUEST);
  if (repeats(requestPath, request, at)) {
    return false;
  }
  const context = promptContextFor(prompt, [], at, sharesRequests(projectDir, root));
  mkdirSync(root, { recursive: true });
  // The hook can run before any daemon has written `.reticle/.gitignore`: write it, or add the
  // prompt files to an older one, before a prompt lands where `git add -A` would take it.
  const ignorePath = join(root, WORKSPACE_GITIGNORE);
  const ignore = workspaceGitignore(readTextOrUndefined(ignorePath));
  if (ignore !== undefined) {
    writeFileSync(ignorePath, ignore);
  }
  // Writers run detached and can finish out of order: the request is the NEWEST prompt, so an
  // older one that lands late goes to the history only.
  if (!newerHeld(requestPath, at)) {
    const tmp = `${requestPath}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(context, null, JSON_INDENT)}\n`);
    renameSync(tmp, requestPath);
  }
  const historyPath = join(root, ReticleDir.REQUESTS_LOG_FILE);
  // ponytail: one rotated file; older history is dropped once a second one fills.
  // Every step goes through one open file, so the path cannot change between a check and a write.
  // It is not opened to append: Windows cannot truncate a file that is open to append. Two hooks
  // that write in the same instant can lose one line of history.
  const fd = openSync(historyPath, constants.O_RDWR | constants.O_CREAT);
  try {
    let end = fstatSync(fd).size;
    if (MAX_HISTORY_BYTES < end) {
      writeFileSync(join(root, ReticleDir.REQUESTS_LOG_ROTATED_FILE), readFileSync(fd));
      ftruncateSync(fd, 0);
      end = 0;
    }
    writeSync(fd, `${JSON.stringify({ at, agent, request: context.request })}\n`, end);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The request file already holds a prompt that arrived after `at`. */
function newerHeld(requestPath: string, at: number): boolean {
  try {
    const held = PromptContextSchema.safeParse(JSON.parse(readFileSync(requestPath, 'utf8')));
    return held.success && held.data.at !== undefined && held.data.at > at;
  } catch {
    return false;
  }
}

/** The same prompt was kept a moment ago: a second hook for the same submit. */
function repeats(requestPath: string, request: string, at: number): boolean {
  try {
    const held = PromptContextSchema.safeParse(JSON.parse(readFileSync(requestPath, 'utf8')));
    if (!held.success || held.data.at === undefined) {
      return false;
    }
    return held.data.request === request && at - held.data.at < DUPLICATE_WINDOW_MS;
  } catch {
    return false;
  }
}
