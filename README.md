# agent-token-sentinel

**English** | [繁體中文](./README.zh-TW.md)

[![CI](https://github.com/T5A111/Agent-Token-Sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/T5A111/Agent-Token-Sentinel/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-token-sentinel.svg)](https://www.npmjs.com/package/agent-token-sentinel)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)

> A local-first watchdog and context optimizer for coding agents (Claude Code, Cursor, Windsurf, any MCP client).
> It **breaks whack-a-mole debug loops** before they burn your token budget and wreck your code, and it **distills bloated context** so the agent stays sharp.

Everything runs on your machine: no external API calls, no telemetry. State lives in `.sentinel/` (git-ignored automatically).

> **Status: beta (v0.1).** The core engine, MCP server, CLI and the Claude Code integration are covered by the test suite on Linux, macOS and Windows.
> The **Cursor and Windsurf hook adapters are beta**: they are built against the published hook formats and tested with simulated payloads, but not yet verified end-to-end in those editors. Please [open an issue](https://github.com/T5A111/Agent-Token-Sentinel/issues) with your editor version if something doesn't trigger.

---

## Why

Coding agents fail in two expensive ways:

| Pain | What it looks like | What the sentinel does |
|---|---|---|
| **Whack-a-mole loop** | Fix A breaks B, fix B breaks A; the same null-check is added, removed, re-added; the same error comes back 5 times. | Detects code flip-flops, error-fingerprint cycles and failure streaks → **trips a circuit breaker**, blocks further writes, **rolls back** the dirty edits, and writes a **Dead-End log** that forces an architecture-level re-plan. |
| **Context bloat** | 3,000-token stack traces full of `node_modules`, whole-file rewrites, 20 rounds of stale tool output. | **Distills logs** to ~150 tokens, **prunes files** to the symbols you need (AST), and **compacts history** into one-line episode summaries. |

## Highlights

- 🔁 **Code flip-flop detection**: line-reciprocity rate over the last 5 edits per file (the share of deleted lines that come back within 2 edits). Above 60% plus a failing run → trip.
- 🧬 **Error fingerprints**: SHA-256 of `ErrorName + normalized message + project stack + failing test`, after stripping timestamps, absolute paths, `line:col`, memory addresses, UUIDs, durations, ports and temp dirs. Detects `A→A→A`, `A→B→A` and `A→B→A→B`.
- ⚡ **Circuit breaker**: CLOSED → OPEN → HALF_OPEN, with manual reset (requires a new hypothesis) or a single probe after a cool-down.
- ⏪ **Safe rollback**: git snapshots via a *temporary index* under `refs/sentinel/*`. Your branch, HEAD, index and stash are never touched. Only agent-touched files are restored, and a backup ref is taken first, so the rollback is itself undoable.
- 🧪 **Log Distiller**: ANSI stripped; `node_modules`, `node:internal`, Vite/Rollup/Webpack/esbuild/Vitest/Jest frames dropped; keeps the error, the failing test, expected/received, the **first project call site ±3 lines**, and a one-line entry for **every other failing test**. Typical reduction is 95%+.
- 📈 **Dynamic budget, nothing lost**: the budget grows with the number of failures, and **widens each time the same failure repeats** (a stuck model needs more evidence, not less). Every raw log is stored; `sentinel_expand_log` pulls a specific failure block, a grep or a line range on demand, instead of re-running the command.
- 🔀 **Automatic in Claude Code**: build/test Bash commands are transparently routed through `sentinel run`, so the savings do not depend on the model remembering a rule. Same exit code, your permission rules still apply, `# sentinel:raw` opts out.
- 🌳 **AST Pruner**: uses the TypeScript compiler API to keep target functions, classes or methods plus the same-file types and imports they reference; everything else becomes `// ... [omitted N lines of unrelated logic]`. Original line numbers are preserved. Other languages fall back to a brace/indent heuristic.
- 🗜️ **Episodic History Compactor**: every 3 debug rounds →
  `[Compacted]: Rounds 1-3 attempted null-checks at src/auth.ts#login, failed with TypeError ×3. Reverted.`
  Each episode also keeps its **status (unresolved / reverted / resolved), the exact error and the failing test**, so what was tried survives.
- 🧠 **Memory that survives compaction**: when Claude Code compacts, resumes or clears a session, a `SessionStart` hook re-injects the open problem, what was already tried and the latest dead end (≤ 400 tokens). Silent when nothing is pending.
- 🔌 **Hard enforcement**: pre-write hooks for Claude Code, Cursor and Windsurf exit with code 2 to block writes while the circuit is OPEN. A git pre-commit hook rejects commits.
- 🧹 **Safe one-command uninstall**: `uninstall --all` removes only what `install` added; your own settings stay byte-for-byte unchanged, and recovery data is kept unless you ask for `--purge`. See [Uninstall](#uninstall).

## Architecture

```
 ┌──────────── Coding agent (Claude Code · Cursor · Windsurf · any MCP client) ────────────┐
 │                                                                                         │
 │   MCP tools ─────────────┐        pre/post hooks (stdin JSON) ──┐     sentinel run --   │
 └──────────────────────────┼──────────────────────────────────────┼───────────┬───────────┘
                            ▼                                      ▼           ▼
                   src/mcp/server.ts                       src/cli/hooks.ts  src/cli/index.ts
                            └───────────────┬──────────────────────┴───────────┘
                                            ▼
                                   src/sentinel.ts  (facade · locked read-modify-write)
             ┌──────────────────────────────┼─────────────────────────────────────┐
             ▼                              ▼                                     ▼
   ┌── circuit-breaker/ ──────┐   ┌── token-guard/ ─────────┐          ┌── utils/ ─────────────┐
   │ detector.ts  reciprocity │   │ distiller.ts  log → 150t │          │ state-store (atomic,  │
   │              fingerprints│   │ pruner.ts     AST fold   │          │   locked state.json)  │
   │              hotspot/risk│   │ compactor.ts  episodes   │          │ ast · diff · git      │
   │ breaker.ts   state machine│  └──────────────────────────┘          │ normalize · tokens    │
   │ checkpoint.ts git snapshots│                                        └───────────────────────┘
   └───────────────────────────┘
                                            ▼
                     .sentinel/state.json · dead-ends/*.md · refs/sentinel/*
```

## Quick start

Requires **Node.js ≥ 20** and **git** (git is only needed for rollback).

**Option A: from npm (recommended)**

```bash
cd ~/my-project
npx agent-token-sentinel install --all     # Claude Code + Cursor + Windsurf + git hook
# or install globally to get a faster `sentinel` command:
npm install -g agent-token-sentinel && sentinel install --all
```

**Option B: from source**

```bash
git clone https://github.com/T5A111/Agent-Token-Sentinel.git && cd Agent-Token-Sentinel
npm install && npm run build && npm link   # `npm link` puts `sentinel` on your PATH
cd ~/my-project && sentinel install --all
```

`sentinel install` merges into existing configs (it never clobbers them) and is idempotent. Pass `--claude`, `--cursor`, `--windsurf` or `--git` to install selectively, or `--dry-run` to preview.
When run through `npx`, the generated configs call `npx -y agent-token-sentinel …`, so they never point into the temporary npx cache. With a global or source install they call the installed script directly, which is faster.

Then make the agent run tests through the wrapper (the installed `SKILL.md` and rules already tell it to):

```bash
sentinel run -- npm test      # or: npx agent-token-sentinel run -- npm test
```

The exit code passes through unchanged, and a distilled failure is printed instead of the raw log.

> **Changed your mind?** `npx -y agent-token-sentinel uninstall --all` removes it again in one line and leaves your project as it was. Add `--dry-run` first to preview. See [Uninstall](#uninstall).

## Integration

### Claude Code

`sentinel install --claude` writes:

**`.mcp.json`**
```json
{ "mcpServers": { "token-sentinel": { "command": "node", "args": ["/abs/path/dist/mcp/server.js"] } } }
```

**`.claude/settings.json`**. The hooks:
- **PreToolUse** blocks writes with exit 2 while OPEN, and routes build/test Bash commands through `sentinel run`.
- **PostToolUse** records edits and test runs.
- **SessionStart** re-injects the debugging memory after a compact, resume or clear.
```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "Edit|MultiEdit|Write|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }],
    "PostToolUse": [{ "matcher": "Edit|MultiEdit|Write|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }],
    "PostToolUseFailure": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }],
    "SessionStart": [{ "matcher": "startup|resume|clear|compact", "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }]
  }
}
```

**`.claude/skills/token-sentinel/SKILL.md`**: the agent operating rules ([SKILL.md](./SKILL.md)).

### Cursor *(beta)*

`sentinel install --cursor` writes `.cursor/mcp.json`, `.cursor/hooks.json` and `.cursor/rules/token-sentinel.mdc` (`alwaysApply: true`):

```json
{
  "version": 1,
  "hooks": {
    "preToolUse":          [{ "command": "node \"/abs/path/dist/cli/index.js\" hook cursor --event preToolUse" }],
    "afterFileEdit":       [{ "command": "node \"/abs/path/dist/cli/index.js\" hook cursor --event afterFileEdit" }],
    "afterShellExecution": [{ "command": "node \"/abs/path/dist/cli/index.js\" hook cursor --event afterShellExecution" }]
  }
}
```

When the circuit is OPEN, `preToolUse` answers `{"permission":"deny", ...}` and exits 2.

### Windsurf (Cascade) *(beta)*

`sentinel install --windsurf` writes `.windsurf/hooks.json` and `.windsurf/rules/token-sentinel.md` (`trigger: always_on`):

```json
{
  "hooks": {
    "pre_write_code":   [{ "command": "node \"/abs/path/dist/cli/index.js\" hook windsurf --event pre_write_code",   "show_output": true }],
    "post_write_code":  [{ "command": "node \"/abs/path/dist/cli/index.js\" hook windsurf --event post_write_code",  "show_output": true }],
    "post_run_command": [{ "command": "node \"/abs/path/dist/cli/index.js\" hook windsurf --event post_run_command", "show_output": true }]
  }
}
```

Windsurf reads MCP servers only from the user-global `~/.codeium/windsurf/mcp_config.json`. Add `--global` to have the installer merge it, or add it yourself:

```json
{ "mcpServers": { "token-sentinel": { "command": "node", "args": ["/abs/path/dist/mcp/server.js"], "env": { "SENTINEL_ROOT": "/abs/path/to/project" } } } }
```

### Git

`sentinel install --git` adds a `pre-commit` hook that rejects commits while the circuit is OPEN. An existing foreign hook is never overwritten; the installer prints the line to add instead.

### Enforcement matrix

| Client | MCP tools | Hard write block | Auto-record edits | Auto-record test runs |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ PreToolUse exit 2 | ✅ PostToolUse | ✅ auto-routed through `sentinel run` (exact exit codes, distilled output) |
| Cursor *(beta)* | ✅ | ✅ preToolUse exit 2 / `deny` | ✅ afterFileEdit | ✅ afterShellExecution |
| Windsurf *(beta)* | ✅ (global config) | ✅ pre_write_code exit 2 | ✅ post_write_code | ✅ post_run_command |
| Other MCP clients | ✅ | advisory (`sentinel_guard_edit`) | `sentinel_record_edit` | `sentinel_record_run` / `sentinel run` |
| git | — | ✅ pre-commit | — | — |

> Hook payload fields differ between clients and versions, so they are parsed tolerantly. When a client does not report a command's exit code, failure is inferred from the output (`FAIL`, `error TS…`, `Traceback`, …). For exact results, run tests through `sentinel run -- <cmd>`; those runs are recorded once and skipped by the post-command hooks.

## Uninstall

> Requires v0.1.1 or later. Check with `npx -y agent-token-sentinel version`.

**Step 1: preview** (changes nothing):

```bash
npx -y agent-token-sentinel uninstall --all --dry-run
```

**Step 2: remove**, then **restart** Claude Code / Cursor / Windsurf so they stop loading the hooks and MCP server:

```bash
npx -y agent-token-sentinel uninstall --all
```

Run the command in each project where you ran `install`. If you installed globally or from source, `sentinel uninstall --all` does the same.

### Common cases

| I want to… | Command |
|---|---|
| Preview what would be removed | `npx -y agent-token-sentinel uninstall --all --dry-run` |
| Remove everything from this project (keep recovery data) | `npx -y agent-token-sentinel uninstall --all` |
| Remove from one editor only | `npx -y agent-token-sentinel uninstall --claude` (or `--cursor`, `--windsurf`, `--git`, combinable) |
| Also delete `.sentinel/` and all git snapshots / rollback backups | `npx -y agent-token-sentinel uninstall --all --purge` |
| Also clean Windsurf's user-global MCP config | `npx -y agent-token-sentinel uninstall --windsurf --global` |
| Uninstall a project other than the current directory | `npx -y agent-token-sentinel uninstall --all --root /path/to/project` |
| Remove the package itself (global install) | `npm uninstall -g agent-token-sentinel` |
| Remove the package itself (installed from source with `npm link`) | `npm unlink -g agent-token-sentinel`, then delete the cloned folder |

Run `uninstall` in your projects **before** removing the package itself; otherwise the `sentinel` command is no longer available (`npx -y agent-token-sentinel …` still works).

### What it does, and what it never does

- **Removes only what `install` added**: sentinel hook entries, the `token-sentinel` MCP server, `SKILL.md`, the Cursor/Windsurf rules files and the sentinel `pre-commit` hook.
- **Your own hooks, MCP servers and settings stay byte-for-byte unchanged.** A config file is deleted only if nothing else was in it, and a folder only if it ends up empty.
- **Recovery data is kept by default**: `.sentinel/` (state, Dead-End logs) and the `refs/sentinel/*` git snapshots. These include the rollback backups of any agent edits the breaker reverted. Use `--purge` only once you are sure you don't need them.
- **Foreign git hooks and unparseable config files are never touched.** They are listed as warnings, and the command exits with code 1 so you notice.
- It never commits, never touches your branch, HEAD, index or stash, and never edits your source code. Uninstalling leaves your project exactly as it was.

<details>
<summary>Manual removal (if you cannot run the command)</summary>

| Location | What to remove |
|---|---|
| `.claude/settings.json`, `.cursor/hooks.json`, `.windsurf/hooks.json` | Only the entries whose command contains `hook claude`, `hook cursor` or `hook windsurf` |
| `.mcp.json`, `.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json` | The `token-sentinel` entry under `mcpServers` |
| `.claude/skills/token-sentinel/`, `.cursor/rules/token-sentinel.mdc`, `.windsurf/rules/token-sentinel.md` | Delete |
| `.git/hooks/pre-commit` | Delete only if it contains `# agent-token-sentinel pre-commit` |
| `.sentinel/` | Delete (optional; state and Dead-End logs) |
| `refs/sentinel/*` | `git for-each-ref --format="%(refname)" refs/sentinel/` lists them; delete each with `git update-ref -d <ref>` (optional; includes rollback backups) |

</details>

## MCP interface

| Tool | Purpose |
|---|---|
| `sentinel_guard_edit {file, intent?}` | Call before editing. Returns ALLOW / WARN / BLOCK and snapshots the file. |
| `sentinel_record_edit {file, diff? \| before?/after?}` | Record an edit when no hook is installed. |
| `sentinel_record_run {command, exitCode, log?}` | Record a build/test run; returns the distilled error and may trip the breaker. |
| `sentinel_check_circuit {}` | State, risk, reciprocity, fingerprint pattern, hotspot, checkpoint. |
| `sentinel_reset_circuit {hypothesis}` | Close the circuit; requires a new root-cause hypothesis (≥ 15 chars). |
| `sentinel_checkpoint {label?}` | Snapshot the working tree as a rollback target. |
| `sentinel_distill_log {log, tokenBudget?}` | Compress a log. |
| `sentinel_expand_log {run?, failure?, grep?, from?, to?}` | Pull part of a stored raw log (a failure block, matching lines, a range) instead of re-running. |
| `sentinel_prune_file {file, targets[], lineNumbers?}` | Read only the needed symbols. |
| `sentinel_compact_history {}` | Fold old rounds into `[Compacted]` lines. |

Resources: `sentinel://state`, `sentinel://dead-ends`, `sentinel://history`.

## CLI

```
sentinel run [--raw] -- <cmd...>      sentinel status [--json]        sentinel reset [--hypothesis "..."]
sentinel checkpoint [label]           sentinel rollback [id]          sentinel distill [file|-] [--budget N]
sentinel log [run-id] [--failure N] [--grep RE] [--from N --to M]
sentinel prune <file> <symbol...>     sentinel compact | history      sentinel dead-ends
sentinel install [--claude|--cursor|--windsurf|--git|--all] [--global] [--command "..."] [--dry-run]
sentinel uninstall [--claude|--cursor|--windsurf|--git|--all] [--global] [--purge] [--dry-run]
sentinel hook <claude|cursor|windsurf|git-pre-commit> [--event name]
sentinel mcp
```

`sentinel status` exits with code 3 while the circuit is OPEN, so you can use it in scripts.

## Configuration (`.sentinel/config.json`)

All fields are optional. An invalid file falls back to the defaults and shows a warning.

| Key | Default | Effect |
|---|---|---|
| `maxConsecutiveFailures` | `4` | Failing runs in a row before tripping. |
| `reciprocityThreshold` | `0.6` | Flip-flop threshold (share of deleted lines re-added within 2 edits). |
| `oscillationWindow` | `5` | Recent edits per file inspected. |
| `sameFingerprintLimit` | `3` | Identical error fingerprints in a row before tripping. |
| `hotspotRounds` | `3` | Consecutive failing rounds editing the same function → HIGH-risk warning. |
| `cooldownMs` | `300000` | Time OPEN before one HALF_OPEN probe is allowed. |
| `autoRollback` | `true` | Restore agent-touched files on trip (`false` = block only). |
| `distillTokenBudget` | `150` | Base budget of a distilled log (one failure, first sighting). |
| `distillMaxBudget` | `600` | Ceiling after scaling: +30 tokens per extra failure, +50% per repeat of the same failure. |
| `maxLogs` | `30` | Raw logs kept in `.sentinel/logs/` for `sentinel_expand_log`. |
| `autoWrapTests` | `true` | Claude Code: route build/test Bash commands through `sentinel run`. |
| `memoryTokenBudget` | `400` | Max size of the memory re-injected after compaction / resume. |
| `compactEvery` | `3` | Debug rounds per compacted episode. |
| `contextLines` | `3` | Source lines shown around the call site. |
| `maxCheckpoints` | `20` | Checkpoint refs kept. |
| `runCommandPattern` | test/build regex | Which shell commands the post-command hooks treat as build/test runs. |

**Trip conditions** (any one): failure streak ≥ `maxConsecutiveFailures` · same fingerprint ≥ `sameFingerprintLimit` · error cycle `A→B→A` or ping-pong `A→B→A→B` · flip-flop > `reciprocityThreshold` with the last run failing · a failed HALF_OPEN probe.

## Self-verification

```bash
npm run typecheck && npm test   # unit + integration suite
npm run test:pack               # builds the npm tarball, installs it in a clean project, runs CLI + MCP handshake
```

CI runs both on Linux, macOS and Windows with Node 20, 22 and 24.

The suite (`tests/self-test.ts`) covers the four required scenarios plus rollback, pruning, compaction, the MCP protocol and the CLI/installer:

| # | Scenario | Verified |
|---|---|---|
| 1 | add → remove → re-add a line | reciprocity 100% > 60% → loop risk; refinement edits score 0% |
| 2 | two Vitest logs, different time/path/line/address | identical SHA-256; streak counted; A→A→A trips |
| 3 | 105-line Vite/node_modules log | ≤ 10 lines, ≤ 150 tokens, error + call site ±3 lines kept (−96%) |
| 4 | 4 consecutive failures | OPEN, Dead-End JSON+MD, writes blocked (Claude/Cursor/Windsurf hooks exit 2), HALF_OPEN, reset |
| 5 | real git repo | agent files restored, new file removed, human edit untouched, HEAD/index/stash untouched, backup ref |
| 6 | 252-line TS file | target + transitively referenced types + used import kept; the rest folded |
| 7 | 6 debug rounds | auto `[Compacted]` after round 4 with status + error evidence; ≥ 70% of recorded history tokens saved (82%) |
| 8 | MCP client ↔ server | all tools listed and callable; validation and path-traversal errors are tool errors |
| 9 | `sentinel run`, `install --all`, git pre-commit | exit code passthrough, distilled output, idempotent config merge, commit rejected while OPEN |
| 10 | install over existing user configs → `uninstall` | dry-run changes nothing; user files byte-identical afterwards; `.sentinel/` + refs kept until `--purge`; foreign hooks and broken files untouched |
| 11 | 4 failing tests in one log | all 4 listed; budget scales; raw log stored, failure #3 / grep / ranges expandable; old logs pruned |
| 12 | same failure 3× | budget and source context widen each time (±3 → ±5 → ±7 lines); a new failure resets it |
| 13 | Claude Code Bash `npm test` | rewritten via `updatedInput` without auto-approval; watch/dev/background/heredoc/opt-out untouched; quoting + exit code identical under bash |
| 14 | compact/resume after 4 failures | open problem, tried approaches and log pointer injected within budget; silent on clean projects and once green |

### A/B benchmark (does it actually help?)

The self-tests prove the mechanisms work. They do **not** prove that a model solves more tasks or spends less. For that, `bench/` holds 5 debugging tasks, each built around a typical agent failure mode: off-by-one, a shared root cause that invites whack-a-mole, an async cache bug, 4 independent bugs, and a misleading stack trace. The runner executes the same model on the same tasks **with and without** the sentinel:

```bash
npm run bench:check                              # free: validates fixtures + plumbing with a stub (also in CI)
npm run bench -- --repeats 5 --model <model-id>  # real run with Claude Code headless: costs your Claude usage
```

Each trial runs in an isolated temp git repo. The user's global settings and MCP servers are excluded in both arms, and spend is capped per trial (`--max-budget-usd`, default $2). The original tests are restored before scoring, so editing the tests never counts as a fix. The report lists success rate with 95% CIs, cost, input tokens (cache included), turns, breaker trips and a two-proportion significance test. With few repeats it says plainly that the result is a smoke test, not proof.

## Project layout

```
src/
├── circuit-breaker/  detector.ts · breaker.ts · checkpoint.ts
├── token-guard/      distiller.ts · pruner.ts · compactor.ts
├── mcp/              server.ts
├── cli/              index.ts · hooks.ts · install.ts
├── utils/            ast.ts · diff.ts · git.ts · hash.ts · normalize.ts · state-store.ts · tokens.ts · approach.ts
├── sentinel.ts       facade (locking, persistence, wiring)
├── config.ts · types.ts · index.ts
tests/self-test.ts    self-verification suite
SKILL.md              rules for the agent
```

## Limitations

- Token counts are estimated offline (~4 chars/token, CJK ≈ 1 token/char), with roughly ±15% error.
- The history compactor cannot delete anything from the agent's own transcript; the client manages that. The "tokens saved" figure is accounting over recorded history. It becomes real when the model works from the compacted view: after Claude Code compacts or resumes (the memory is injected automatically), or when the model reads `sentinel://history`.
- Measured savings depend on your model, tasks and prompt caching. Run the A/B benchmark on your own workload before relying on a number.
- Rollback needs a git repository. Without one, the sentinel runs in block-only mode.
- Precise AST pruning covers TS/JS (`.ts .tsx .js .jsx .mts .cts .mjs .cjs`). Other languages use a heuristic.
- An agent determined to bypass the guard (e.g. writing files through the shell) can still do so. The hooks gate the editor's write tools, and the git hook gates commits.

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development and release workflow, and [CHANGELOG.md](./CHANGELOG.md) for release notes.

## License

MIT
