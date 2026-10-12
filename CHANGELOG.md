# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-12

Theme: save tokens **without** starving the model of information.

### Added
- **Raw logs are kept** (`.sentinel/logs/`, last `maxLogs` = 30) and can be pulled on demand with the new
  `sentinel_expand_log` MCP tool / `sentinel log` CLI: a specific failure block, grep matches with context,
  or a line range. Distilled output ends with the run id to expand.
- **Multi-failure distillation**: every failing test in a run is listed (one line each), not just the first.
- **Dynamic budget**: +30 tokens per extra failure, and +50% budget / +2 source-context lines each time the
  *same* failure repeats (capped by `distillMaxBudget` = 600). A stuck model gets more evidence, not less.
- **Claude Code auto-wrap** (`autoWrapTests`, default on): a PreToolUse hook transparently routes build/test
  Bash commands through `sentinel run` via `updatedInput`. It never sets a permission decision, so the user's
  permission rules still apply. Watch/dev/serve, background, heredoc and `# sentinel:raw` commands are left alone.
- **Memory that survives compaction**: a `SessionStart` hook (startup | resume | clear | compact) re-injects the
  open problem, already-tried approaches, the latest dead end and log pointers (`memoryTokenBudget` = 400).
  Silent when nothing is pending.
- **Structured episodes**: compacted history keeps status (unresolved / reverted / resolved), the exact error
  message and failing test names, not only a one-line summary.
- **A/B benchmark** (`bench/`): 5 debugging tasks × {baseline, sentinel} with Claude Code headless; isolated
  temp repos, per-trial spend cap, tests restored before scoring, report with 95% CIs and a significance test.
  `npm run bench:check` validates fixtures and plumbing for free (runs in CI).

### Changed
- `install --claude` also registers PreToolUse for `Bash` and a `SessionStart` hook (re-run `install` to upgrade).
- `sentinel run --shell <sh>` runs a single command string through the given shell.

## [0.1.1] - 2026-10-10

### Added
- `sentinel uninstall [--claude|--cursor|--windsurf|--git|--all] [--global] [--purge] [--dry-run]`:
  removes only what `install` added. Your own hooks, MCP servers and settings are
  preserved, and a config file is deleted only if nothing but sentinel content was in it.
  Recovery data (`.sentinel/`, `refs/sentinel/*` snapshots and rollback backups)
  is kept unless `--purge` is given. Foreign git hooks and unparseable files are never touched.

## [0.1.0] - 2026-10-10

### Added
- Circuit breaker: line-reciprocity flip-flop detection, SHA-256 error
  fingerprints (A→A→A, A→B→A, A→B→A→B), hotspot warnings, CLOSED/OPEN/HALF_OPEN
  state machine, Dead-End logs.
- Git checkpoints under `refs/sentinel/*` and rollback of agent-touched files
  (branch, HEAD, index and stash are never modified; a backup ref is kept).
- Token guard: log distiller (~150 tokens), TypeScript-AST pruner, episodic
  history compactor.
- MCP server (9 tools, 3 resources) and the `sentinel` CLI (`run`, `status`,
  `reset`, `checkpoint`, `rollback`, `distill`, `prune`, `compact`, `install`, `hook`).
- Hard write blocking through Claude Code hooks; Cursor and Windsurf hooks (beta);
  git pre-commit hook.
