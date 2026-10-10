# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
