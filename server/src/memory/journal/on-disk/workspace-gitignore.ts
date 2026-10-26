import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import { LOCAL_DIRS, LOCAL_FILES } from './workspace-tiers.js';

/**
 * The `.reticle/` entries that are LOCAL state, and must never be committed by accident.
 *
 * Read from the tier table rather than restated here: which half a name belongs to is one decision,
 * and a second copy of it is the list that silently disagrees. This file asks the table exactly one
 * of its two questions — `sharing` — and has no opinion at all about what retention may delete.
 *
 * The reason this matters beyond tidiness: a session journal carries URLs, request and response
 * bodies, and DOM text from the app under test. `.reticle/` is created by the daemon rather than by
 * the user, so it arrives untracked and unexplained, and one `git add -A` puts an app's traffic into
 * a shared repository. Reticle created the directory; the ignore for it is Reticle's to write.
 */
/** The ignore file inside `.reticle/`. */
export const WORKSPACE_GITIGNORE = '.gitignore';

const TRANSIENT: readonly string[] = [
  ...LOCAL_DIRS.map((dir) => `${dir}/`),
  ...LOCAL_FILES,
  '*.log',
  '*.tmp',
];

const HEADER = [
  '# Written by Reticle, and only about the directory Reticle owns.',
  '#',
  '# The entries below are per-machine state — session journals, run artifacts, learned envelopes.',
  '# Journals contain URLs, request and response bodies and page text from the app under test, so',
  '# they are worth keeping out of a shared repository on their own account.',
  '#',
  `# Deliberately NOT ignored: ${ReticleDir.CONTRACT_FILE}, ${ReticleDir.FLOWS_SUBDIR}/, ${ReticleDir.INTENT_FILE} and`,
  `# ${ReticleDir.CAPSULES_SUBDIR}/. Those are meant to be committed — a saved flow only earns its keep`,
  '# when a teammate or CI can replay it.',
  '#',
  '# Edit freely. Reticle only adds the prompt files below when they are missing: they hold every',
  '# prompt you typed, and a `git add -A` must never publish them.',
];

/**
 * The entries Reticle adds to an ignore file that already exists. They are the user's prompts, and
 * a `.gitignore` written before prompt capture existed has none of them.
 */
const PROMPT_FILES: readonly string[] = [
  ReticleDir.REQUEST_FILE,
  ReticleDir.REQUESTS_LOG_FILE,
  ReticleDir.REQUESTS_LOG_ROTATED_FILE,
];
const MERGED_NOTE = '# Added by Reticle: the prompts you typed, kept on this machine.';

/**
 * The ignore file `.reticle/` should hold, given the one it holds now (`undefined`: none). Returns
 * `undefined` when nothing needs to change. A new file gets every local entry. An existing file
 * keeps every line it has, and gets only the prompt files it lacks, appended at the end.
 */
export function workspaceGitignore(existing: string | undefined): string | undefined {
  if (existing === undefined) return `${[...HEADER, '', ...TRANSIENT].join('\n')}\n`;
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = PROMPT_FILES.filter((name) => !lines.has(name) && !lines.has(`/${name}`));
  if (0 === missing.length) return undefined;
  const base = existing.endsWith('\n') || '' === existing ? existing : `${existing}\n`;
  return `${base}${[MERGED_NOTE, ...missing].join('\n')}\n`;
}

/**
 * Write `.reticle/.gitignore`, or add the prompt files to the one that is there.
 *
 * Never overwrites. Once the file exists it belongs to whoever edited it last, and silently
 * reverting somebody's change to a file we placed in their repository is worse than not having
 * written it. The one exception is additive: the prompt files are appended when missing, because
 * a file written before prompt capture existed would otherwise let them be committed. Best-effort throughout: this runs on the daemon's start path, and a workspace that
 * cannot be written must not stop a daemon coming up. Nothing about verification depends on it.
 */
export async function ensureWorkspaceGitignore(fs: FileSystemPort, root: string): Promise<void> {
  const path = join(root, WORKSPACE_GITIGNORE);
  try {
    const existing = (await fs.exists(path)) ? await fs.readFile(path) : undefined;
    const next = workspaceGitignore(existing);
    if (next === undefined) return;
    await fs.mkdir(root);
    await fs.writeFile(path, next);
  } catch {
    /* a workspace we cannot write is not a reason to fail a session */
  }
}
