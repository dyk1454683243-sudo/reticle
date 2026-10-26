---
title: Prompt capture
description: How Reticle keeps each prompt you send and the agent's own tool calls, where they go, and every way to turn them off.
---

A verdict is checked against what the user asked for. An agent tells Reticle the request only when it remembers to, so `reticle init` installs a hook that hands over each prompt before the agent reads it.

## What `init` installs

`reticle init` adds a prompt-submit hook to the project-level config of each agent it finds that has one:

| Agent | Config file |
| --- | --- |
| Claude Code | `.claude/settings.json` |
| Cursor | `.cursor/hooks.json` |
| Codex CLI | `.codex/hooks.json` |
| Gemini CLI | `.gemini/settings.json` |
| Windsurf | `.windsurf/hooks.json`, or `.devin/hooks.json` when it is there |
| VS Code Copilot and Copilot CLI | `.github/hooks/reticle-prompt-capture.json` |
| Factory Droid | `.factory/hooks.json` |

Each hook runs `node "<bin>" hook prompt --agent <id> || npx -y @reticlehq/server@<version> hook prompt --agent <id>`. `<bin>` is the CLI that ran `init`, written as `$HOME/…` when it is under your home folder. When that file is not there, `node` stops before it reads the prompt and `npx` runs instead. On Windows, and in Copilot's `powershell` field, the hook runs the `npx` command alone. The version is pinned to the one that ran `init`. Run `init` or `reticle hook install` again after an upgrade to move the pin. These files are in your repository, so a teammate who commits them shares the hook. Codex runs these hooks only after you trust them: open `codex` in the project, type `/hooks` and trust the Reticle entries.

Agents with no prompt hook, such as Claude Desktop, get an instruction in the MCP server's instructions: declare the request with `reticle_intent` once for each user request.

## What it writes

The hook writes two files in the project's `.reticle/` folder:

| File | What is in it |
| --- | --- |
| `request.json` | the newest prompt, split into statements and classified |
| `requests.jsonl` | every prompt, one JSON line each, oldest first. At 2 MB it moves to `requests.1.jsonl` |

Secrets are removed before anything is written: credential assignments (`password: …`, `STRIPE_SECRET_KEY=…`), vendor keys (`sk_live_…`, `ghp_…`, `AKIA…`, `AIza…`, `glpat-…`, `xoxb-…`), JWTs, emails, card numbers, phone numbers, home paths and hostnames. This is a pattern match, not a proof: a secret that looks like an ordinary word stays. A prompt is capped at 20,000 characters.

`request.json`, `requests.jsonl` and `requests.1.jsonl` are in `.reticle/.gitignore`. Reticle adds them to an older ignore file that does not have them, and keeps every line you wrote.

The hook makes no network call of its own and never blocks a prompt: a failure is exit 0 and nothing written. It answers the agent at once and writes the prompt in a separate background process. `npx` downloads the pinned version once when its cache does not have it. Nothing about a prompt reaches telemetry.

## The agent's own tool calls

The same config files also get hooks for the agent's own work: the shell commands, file edits and web calls that do not go through Reticle's tools, the model the agent runs, and the message that ends each turn. Each of these hooks runs `reticle hook tool --agent <id>` in the same two forms as the prompt hook.

| Agent | Hooks | What they keep |
| --- | --- | --- |
| Claude Code | `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `PostModelSwitch`, `Stop` | `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch` and `WebSearch` calls; the model; the closing message |
| Cursor | `postToolUse`, `postToolUseFailure`, `afterAgentResponse` | `Shell`, `Write` and `Delete` calls; the closing message |
| Codex CLI | `PostToolUse`, `Stop` | `Bash` and `apply_patch` calls; the closing message; web searches, read from Codex's own session transcript |
| Gemini CLI | `AfterTool`, `AfterAgent` | `run_shell_command` calls; the closing message |
| Windsurf | `post_run_command`, `post_write_code`, `post_cascade_response` | commands and edits, with no result; the closing message |
| Copilot CLI | `postToolUse` | `bash` and `edit` calls |
| Factory Droid | `PostToolUse` | `Execute`, `Edit`, `ApplyPatch`, `Create`, `FetchUrl` and `WebSearch` calls |

Cursor and Codex send the model with each call, and Windsurf sends it unless it is "Unknown". VS Code Copilot gets no tool hook.

Each record goes to `.reticle/episodes/agent-<session>.jsonl`. A tool record holds the tool, its arguments, the first 4,000 characters of its result and the result's full size, whether it failed, its exit code, and its timing. A closing-message record holds the first 4,000 characters of the message and its full size. Secrets are removed from every string with the same patterns as a prompt, and paths inside the project are made relative. Reticle's own tools are skipped, because the episode log below already keeps them. The prompt-capture switch stops these records too: `"promptCapture": false` or `RETICLE_PROMPT_CAPTURE=0` stops the prompts, the tool calls, the model and the closing messages together.

The daemon also keeps every call to Reticle's own tools in `.reticle/episodes/<connection>.jsonl`, one file for each agent connection. The first line holds the git HEAD, the uncommitted change for each file, and the request. Each line after it holds one call: the tool, its arguments with typed values removed, its whole result or error, its timing, the tab, the agent, and the page events it caused. A field longer than 200,000 characters keeps its start and is named in `truncated`.

The `episodes/` folder is in `.reticle/.gitignore`, and retention removes old files with the other evidence. No file in it leaves the machine. `"sync": { "episodes": true }` in `.reticle/cloud.json` is kept for a later upload, which also needs a workspace that agreed to share its data. Nothing uploads the files today.

## What leaves the machine

**Requests are shared by default for a linked project.** A project is linked by `reticle connect` (`.reticle/cloud.json`) or by `RETICLE_API_KEY` in the environment. A run written soon after a prompt carries that prompt, and the run goes to your own workspace when it syncs. The Harness also sends the newest request to the platform planner as a goal. An unlinked project sends the request nowhere.

A synced run also carries two values from the agent's hook records. `agent.model` is the model the agent ran. `context.closingClaim` is the first closing message the agent wrote at or after the run's last Reticle call, with secrets removed. The closing message follows the same rule as the request: it leaves only when the project shares requests.

To keep requests on the machine, set `"shareRequests": false` in `.reticle.json`. Capture goes on, and nothing about a request or a closing message leaves: not with a run, and not to the Harness.

A run syncs through `reticle sync`, through the daemon's background sync, or when `reticle verify` closes in CI. Background sync runs only for a project linked by its own `cloud.json`, and only while somebody is signed in to that address or `RETICLE_API_KEY` is the key for that link.

## Turn it off

Agent capture is the prompts, the tool calls, the model and the closing messages that the agent hooks keep. One switch stops all of it. The episode log is the daemon's record of calls to Reticle's own tools. The journal switch stops it, and the agent's tool calls, model and closing messages, but not the prompts.

| What                                     | How                                          |
| ---------------------------------------- | -------------------------------------------- |
| Do not install the hooks                 | `reticle init --no-prompt-capture`           |
| Stop all agent capture in one project    | `"promptCapture": false` in `.reticle.json`  |
| Stop all agent capture on this machine   | `RETICLE_PROMPT_CAPTURE=0`                   |
| Stop the episode log in one project      | `"journal": false` in `.reticle.json`        |
| Stop the episode log on this machine     | `RETICLE_JOURNAL=0`                          |
| Keep requests and closing messages local | `"shareRequests": false` in `.reticle.json`  |
| Stop background sync in one project      | `"backgroundSync": false` in `.reticle.json` |
| Stop background sync on this machine     | `RETICLE_BACKGROUND_SYNC=0`                  |
| Remove every hook                        | `reticle hook uninstall`                     |

## `reticle hook`

```bash
npx @reticlehq/server hook status      # per agent: is each prompt captured here
npx @reticlehq/server hook install     # add the hook for the agents this project uses
npx @reticlehq/server hook uninstall   # remove exactly what was added
```

`hook install` writes a config only for an agent this project already uses (its folder is in the project, or the Claude Code CLI is on this machine). It also rewrites an older entry that runs only `npx` to the `node … || npx …` form. `hook prompt --agent <id>` and `hook tool --agent <id>` are what the agent's hooks run; you do not run them yourself. `reticle doctor` prints the same rows as `hook status`, and whether background sync is on. `hook status` names an entry that still runs only `npx`.

`npx @reticlehq/server hook export --structure` writes the page structure of each snapshot step in `.reticle/episodes/` to stdout, one JSON line for each step. A line holds the roles, refs, layout and states of the nodes. It holds no page text: a node says only whether it had a name, a value or text.
