# agent-token-sentinel

**English** | [繁體中文](./README.zh-TW.md)

> A local-first watchdog and context optimizer for coding agents (Claude Code, Cursor, Windsurf, any MCP client).
> It **breaks whack-a-mole debug loops** before they burn your token budget and wreck your code, and it **distills bloated context** so the agent stays sharp.

Everything runs on your machine: no external API calls, no telemetry. State lives in `.sentinel/` (git-ignored automatically).

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
- 🧪 **Log Distiller**: ANSI stripped; `node_modules`, `node:internal`, Vite/Rollup/Webpack/esbuild/Vitest/Jest frames dropped; keeps the error, the failing test, expected/received, and the **first project call site ±3 lines**. Typical reduction is 95%+.
- 🌳 **AST Pruner**: uses the TypeScript compiler API to keep target functions, classes or methods plus the same-file types and imports they reference; everything else becomes `// ... [omitted N lines of unrelated logic]`. Original line numbers are preserved. Other languages fall back to a brace/indent heuristic.
- 🗜️ **Episodic History Compactor**: every 3 debug rounds →
  `[Compacted]: Rounds 1-3 attempted null-checks at src/auth.ts#login, failed with TypeError ×3. Reverted.`
- 🔌 **Hard enforcement**: pre-write hooks for Claude Code, Cursor and Windsurf exit with code 2 to block writes while the circuit is OPEN. A git pre-commit hook rejects commits.

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

```bash
git clone https://github.com/t5a111/token-sentinel.git agent-token-sentinel
cd agent-token-sentinel && npm install && npm run build   # Node ≥ 18.17

# In the project you want to guard:
cd ~/my-project
node ~/agent-token-sentinel/dist/cli/index.js install --all   # Claude Code + Cursor + Windsurf + git
```

`sentinel install` merges into existing configs (it never clobbers them) and is idempotent. Pass `--claude`, `--cursor`, `--windsurf` or `--git` to install selectively, `--dry-run` to preview, or `--command "npx agent-token-sentinel"` to write a portable command instead of an absolute path.

Then make the agent run tests through the wrapper:

```bash
sentinel run -- npm test      # exit code passes through; prints a distilled failure instead of the raw log
```

## Integration

### Claude Code

`sentinel install --claude` writes:

**`.mcp.json`**
```json
{ "mcpServers": { "token-sentinel": { "command": "node", "args": ["/abs/path/dist/mcp/server.js"] } } }
```

**`.claude/settings.json`** (hooks: PreToolUse blocks writes with exit 2 while OPEN; PostToolUse records edits and test runs)
```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "Edit|MultiEdit|Write|NotebookEdit",      "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }],
    "PostToolUse": [{ "matcher": "Edit|MultiEdit|Write|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }],
    "PostToolUseFailure": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }]
  }
}
```

**`.claude/skills/token-sentinel/SKILL.md`**: the agent operating rules ([SKILL.md](./SKILL.md)).

### Cursor

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

### Windsurf (Cascade)

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
| Claude Code | ✅ | ✅ PreToolUse exit 2 | ✅ PostToolUse | ✅ (`sentinel run` for exact exit codes) |
| Cursor | ✅ | ✅ preToolUse exit 2 / `deny` | ✅ afterFileEdit | ✅ afterShellExecution |
| Windsurf | ✅ (global config) | ✅ pre_write_code exit 2 | ✅ post_write_code | ✅ post_run_command |
| Other MCP clients | ✅ | advisory (`sentinel_guard_edit`) | `sentinel_record_edit` | `sentinel_record_run` / `sentinel run` |
| git | — | ✅ pre-commit | — | — |

> Hook payload fields differ between clients and versions, so they are parsed tolerantly. When a client does not report a command's exit code, failure is inferred from the output (`FAIL`, `error TS…`, `Traceback`, …). For exact results, run tests through `sentinel run -- <cmd>`; those runs are recorded once and skipped by the post-command hooks.

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
| `sentinel_prune_file {file, targets[], lineNumbers?}` | Read only the needed symbols. |
| `sentinel_compact_history {}` | Fold old rounds into `[Compacted]` lines. |

Resources: `sentinel://state`, `sentinel://dead-ends`, `sentinel://history`.

## CLI

```
sentinel run [--raw] -- <cmd...>      sentinel status [--json]        sentinel reset [--hypothesis "..."]
sentinel checkpoint [label]           sentinel rollback [id]          sentinel distill [file|-] [--budget N]
sentinel prune <file> <symbol...>     sentinel compact | history      sentinel dead-ends
sentinel install [--claude|--cursor|--windsurf|--git|--all] [--global] [--command "..."] [--dry-run]
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
| `distillTokenBudget` | `150` | Max tokens of a distilled log. |
| `compactEvery` | `3` | Debug rounds per compacted episode. |
| `contextLines` | `3` | Source lines shown around the call site. |
| `maxCheckpoints` | `20` | Checkpoint refs kept. |
| `runCommandPattern` | test/build regex | Which shell commands the post-command hooks treat as build/test runs. |

**Trip conditions** (any one): failure streak ≥ `maxConsecutiveFailures` · same fingerprint ≥ `sameFingerprintLimit` · error cycle `A→B→A` or ping-pong `A→B→A→B` · flip-flop > `reciprocityThreshold` with the last run failing · a failed HALF_OPEN probe.

## Self-verification

```bash
npm run typecheck && npm test
```

The suite (`tests/self-test.ts`) covers the four required scenarios plus rollback, pruning, compaction, the MCP protocol and the CLI/installer:

| # | Scenario | Verified |
|---|---|---|
| 1 | add → remove → re-add a line | reciprocity 100% > 60% → loop risk; refinement edits score 0% |
| 2 | two Vitest logs, different time/path/line/address | identical SHA-256; streak counted; A→A→A trips |
| 3 | 105-line Vite/node_modules log | ≤ 10 lines, ≤ 150 tokens, error + call site ±3 lines kept (−96%) |
| 4 | 4 consecutive failures | OPEN, Dead-End JSON+MD, writes blocked (Claude/Cursor/Windsurf hooks exit 2), HALF_OPEN, reset |
| 5 | real git repo | agent files restored, new file removed, human edit untouched, HEAD/index/stash untouched, backup ref |
| 6 | 252-line TS file | target + transitively referenced types + used import kept; the rest folded |
| 7 | 6 debug rounds | auto `[Compacted]` after round 4; ≥ 70% of history tokens freed (82.6%) |
| 8 | MCP client ↔ server | all tools listed and callable; validation and path-traversal errors are tool errors |
| 9 | `sentinel run`, `install --all`, git pre-commit | exit code passthrough, distilled output, idempotent config merge, commit rejected while OPEN |

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
- Rollback needs a git repository. Without one, the sentinel runs in block-only mode.
- Precise AST pruning covers TS/JS (`.ts .tsx .js .jsx .mts .cts .mjs .cjs`). Other languages use a heuristic.
- An agent determined to bypass the guard (e.g. writing files through the shell) can still do so. The hooks gate the editor's write tools, and the git hook gates commits.

## License

MIT
