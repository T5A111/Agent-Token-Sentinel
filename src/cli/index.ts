#!/usr/bin/env node
/**
 * `sentinel` CLI — run wrapper, hook entry point, installer and inspector.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startStdioServer } from '../mcp/server.js';
import { Sentinel } from '../sentinel.js';
import { estimateTokens } from '../utils/tokens.js';
import { VERSION } from '../version.js';
import { handleGitPreCommit, handleHook, type HookClient, type HookResponse } from './hooks.js';
import { install, type InstallTarget } from './install.js';
import { uninstall } from './uninstall.js';

const VALUE_FLAGS = new Set(['root', 'event', 'budget', 'command', 'hypothesis']);

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Everything after a bare `--`. */
  rest: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (inline !== undefined) out.flags[key] = inline;
      else if (VALUE_FLAGS.has(key)) out.flags[key] = argv[++i] ?? '';
      else out.flags[key] = true;
    } else {
      out.positionals.push(a);
    }
  }
  return out;
}

const HELP = `agent-token-sentinel v${VERSION}

Usage: sentinel <command> [options]

  run [--raw] -- <cmd...>     Run a build/test command, record its exit code, print a distilled
                              failure (≈150 tokens) instead of the raw log. --raw streams output.
  status [--json]             Circuit state, loop signals, last checkpoint.
  reset [--hypothesis "..."]  Close the circuit after re-planning.
  checkpoint [label]          Snapshot the working tree (git refs only, branch untouched).
  rollback [checkpoint-id]    Restore agent-touched files to a checkpoint (backup taken first).
  distill [file|-] [--budget N]   Distill a log file or stdin.
  prune <file> <symbol...> [--no-line-numbers]   Print a file pruned to the given symbols.
  compact                     Fold old debug rounds into [Compacted] summaries.
  history                     Show the compacted debug history.
  dead-ends                   Show the latest Dead-End log.
  install [--claude] [--cursor] [--windsurf] [--git] [--all] [--global] [--command "<cli>"] [--dry-run]
  uninstall [--claude] [--cursor] [--windsurf] [--git] [--all] [--global] [--purge] [--dry-run]
                              Remove only what install added; your other settings are kept.
                              --purge also deletes .sentinel/ and refs/sentinel/* (snapshots, rollback backups).
  hook <claude|cursor|windsurf|git-pre-commit> [--event <name>]   (called by agent/git hooks)
  mcp                         Start the MCP server on stdio.

Global: --root <dir> (default: $SENTINEL_ROOT, $CLAUDE_PROJECT_DIR or cwd)
`;

function rootFrom(args: ParsedArgs): string {
  const flag = args.flags.root;
  return resolve(typeof flag === 'string' && flag ? flag : (process.env.SENTINEL_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()));
}

function readStdin(): string {
  try {
    return process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emit(res: HookResponse): number {
  if (res.stdout) process.stdout.write(`${res.stdout}\n`);
  if (res.stderr) process.stderr.write(`${res.stderr}\n`);
  return res.exitCode;
}

async function runCommand(args: ParsedArgs): Promise<number> {
  const cmd = args.rest.length ? args.rest : args.positionals.slice(1);
  if (cmd.length === 0) {
    process.stderr.write('Usage: sentinel run -- <command...>\n');
    return 64;
  }
  const raw = args.flags.raw === true;
  const display = cmd.join(' ');
  const shown = display.length > 80 ? `${display.slice(0, 77)}...` : display;
  const child =
    cmd.length === 1
      ? spawn(cmd[0] ?? '', { shell: true, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } })
      : spawn(cmd[0] ?? '', cmd.slice(1), { shell: process.platform === 'win32', stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
  const chunks: string[] = [];
  child.stdout?.on('data', (d: Buffer) => {
    chunks.push(d.toString());
    if (raw) process.stdout.write(d);
  });
  child.stderr?.on('data', (d: Buffer) => {
    chunks.push(d.toString());
    if (raw) process.stderr.write(d);
  });
  const exitCode = await new Promise<number>((res) => {
    child.on('error', (err) => {
      chunks.push(`Error: ${err.message}`);
      res(127);
    });
    child.on('close', (code, signal) => res(code ?? (signal ? 128 : 1)));
  });
  const log = chunks.join('');
  const sentinel = new Sentinel({ root: rootFrom(args) });
  const r = sentinel.recordRun({ command: display, exitCode, log, source: 'cli' });

  if (exitCode === 0) {
    const tail = log.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3);
    if (!raw) process.stdout.write(`${tail.join('\n')}\n`);
    process.stdout.write(`✅ sentinel: \`${shown}\` passed${r.checkpoint ? ` · checkpoint ${r.checkpoint.id}` : ''}\n`);
  } else {
    if (!raw && r.distilled) process.stdout.write(`${r.distilled.text}\n`);
    process.stdout.write(
      `❌ sentinel: \`${shown}\` failed (exit ${exitCode}) · ${r.assessment.consecutiveFailures} in a row · risk ${r.assessment.level}` +
        (r.fingerprint ? ` · fp ${r.fingerprint.hash.slice(0, 10)}` : '') +
        (raw ? '' : ` · raw log ${estimateTokens(log)} tokens hidden (use --raw)`) +
        '\n',
    );
    for (const reason of r.assessment.reasons) process.stdout.write(`⚠️  ${reason}\n`);
  }
  if (r.compaction) process.stdout.write(`${r.compaction.episodes.map((e) => e.summary).join('\n')}\n`);
  if (r.trip) process.stdout.write(`\n${r.trip.markdown}\n`);
  return exitCode;
}

const ALL_TARGETS: InstallTarget[] = ['claude', 'cursor', 'windsurf', 'git'];

function hasTargetFlag(args: ParsedArgs): boolean {
  return args.flags.all === true || ALL_TARGETS.some((t) => args.flags[t] === true);
}

/** Targets named by flags; none (or --all) means all of them. */
function selectedTargets(args: ParsedArgs): InstallTarget[] {
  if (!hasTargetFlag(args) || args.flags.all === true) return ALL_TARGETS;
  return ALL_TARGETS.filter((t) => args.flags[t] === true);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const [command, ...pos] = args.positionals;

  switch (command) {
    case undefined:
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'mcp':
      await startStdioServer(rootFrom(args));
      return -1; // keep process alive
    case 'run':
      return runCommand(args);
    case 'status': {
      const s = new Sentinel({ root: rootFrom(args) }).status();
      if (args.flags.json) {
        process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
      } else {
        process.stdout.write(
          [
            `Circuit: ${s.status}${s.reasons.length ? ` — ${s.reasons.join('; ')}` : ''}`,
            `Risk: ${s.assessment.level} · consecutive failures: ${s.consecutiveFailures} · trips: ${s.tripCount}`,
            ...s.assessment.reasons.map((r) => `  ⚠️ ${r}`),
            `Touched files: ${s.touchedFiles.join(', ') || '(none)'}`,
            `Last checkpoint: ${s.lastCheckpoint ? `${s.lastCheckpoint.id} (${s.lastCheckpoint.label})` : '(none)'}${s.gitAvailable ? '' : ' · git unavailable'}`,
            ...s.configWarnings.map((w) => `config: ${w}`),
          ].join('\n') + '\n',
        );
      }
      return s.status === 'OPEN' ? 3 : 0;
    }
    case 'reset': {
      const r = new Sentinel({ root: rootFrom(args) }).reset();
      process.stdout.write(`Circuit reset (${r.previous} → CLOSED).${typeof args.flags.hypothesis === 'string' ? ` Hypothesis: ${args.flags.hypothesis}` : ''}\n`);
      return 0;
    }
    case 'checkpoint': {
      const cp = new Sentinel({ root: rootFrom(args) }).checkpoint(pos.join(' ') || undefined);
      if (!cp) {
        process.stderr.write('Checkpoints need a git repository.\n');
        return 1;
      }
      process.stdout.write(`Checkpoint ${cp.id} → ${cp.ref}\n`);
      return 0;
    }
    case 'rollback': {
      const r = new Sentinel({ root: rootFrom(args) }).rollback(pos[0]);
      process.stdout.write(
        r.performed
          ? `Restored: ${r.restoredFiles.join(', ') || '(none)'}\nDeleted: ${r.deletedFiles.join(', ') || '(none)'}\nBackup: ${r.backupRef}\n`
          : `Rollback skipped: ${r.skippedReason}\n`,
      );
      return r.performed ? 0 : 1;
    }
    case 'distill': {
      const src = pos[0] && pos[0] !== '-' ? readFileSync(pos[0], 'utf8') : readStdin();
      const budget = typeof args.flags.budget === 'string' ? Number(args.flags.budget) : undefined;
      const r = new Sentinel({ root: rootFrom(args) }).distill(src, budget);
      process.stdout.write(`${r.text}\n`);
      return 0;
    }
    case 'prune': {
      const [file, ...targets] = pos;
      if (!file || targets.length === 0) {
        process.stderr.write('Usage: sentinel prune <file> <symbol...>\n');
        return 64;
      }
      const r = new Sentinel({ root: rootFrom(args) }).prune(file, { targets, lineNumbers: args.flags['no-line-numbers'] !== true });
      process.stdout.write(`${r.text}\n`);
      if (r.missingTargets.length) process.stderr.write(`Not found: ${r.missingTargets.join(', ')}\n`);
      return 0;
    }
    case 'compact': {
      const r = new Sentinel({ root: rootFrom(args) }).compact();
      process.stdout.write(`${r.history}\n[history ${r.stats.originalTokens}→${r.stats.currentTokens} tokens, freed ${(r.stats.reduction * 100).toFixed(0)}%]\n`);
      return 0;
    }
    case 'history':
      process.stdout.write(`${new Sentinel({ root: rootFrom(args) }).history()}\n`);
      return 0;
    case 'dead-ends': {
      const logs = new Sentinel({ root: rootFrom(args) }).deadEnds(1);
      process.stdout.write(logs[0]?.markdown ?? 'No dead ends recorded.\n');
      return 0;
    }
    case 'uninstall': {
      const report = uninstall({
        root: rootFrom(args),
        targets: selectedTargets(args),
        global: args.flags.global === true,
        purge: args.flags.purge === true,
        dryRun: args.flags['dry-run'] === true,
      });
      const nothing = !report.edited.length && !report.deleted.length && !report.refsDeleted.length;
      for (const e of report.edited) process.stdout.write(`✎ removed sentinel entries from ${e}\n`);
      for (const d of report.deleted) process.stdout.write(`✖ deleted ${d}\n`);
      for (const r of report.refsDeleted) process.stdout.write(`✖ deleted ref ${r}\n`);
      for (const k of report.kept) process.stdout.write(`ℹ kept ${k}\n`);
      for (const w of report.warnings) process.stdout.write(`⚠ ${w}\n`);
      process.stdout.write(
        nothing
          ? 'Nothing to remove: agent-token-sentinel is not installed here.\n'
          : args.flags['dry-run'] === true
            ? 'Dry run: nothing was changed.\n'
            : 'Uninstalled. Restart your editor / Claude Code so it stops loading the hooks and MCP server.\n',
      );
      return report.warnings.length ? 1 : 0;
    }
    case 'install': {
      const report = install({
        root: rootFrom(args),
        targets: selectedTargets(args),
        command: typeof args.flags.command === 'string' ? args.flags.command : undefined,
        global: args.flags.global === true,
        dryRun: args.flags['dry-run'] === true,
      });
      for (const w of report.written) process.stdout.write(`✔ ${w}\n`);
      for (const s of report.skipped) process.stdout.write(`– skipped: ${s}\n`);
      for (const n of report.notes) process.stdout.write(`ℹ ${n}\n`);
      return 0;
    }
    case 'hook': {
      const kind = pos[0];
      if (kind === 'git-pre-commit') return emit(handleGitPreCommit(rootFrom(args)));
      if (kind !== 'claude' && kind !== 'cursor' && kind !== 'windsurf') {
        process.stderr.write('Usage: sentinel hook <claude|cursor|windsurf|git-pre-commit>\n');
        return 0; // never break the agent on misconfiguration
      }
      const input = readStdin();
      let payload: unknown = {};
      try {
        payload = input.trim() ? JSON.parse(input) : {};
      } catch {
        return 0;
      }
      return emit(
        handleHook(kind as HookClient, payload, {
          root: typeof args.flags.root === 'string' ? args.flags.root : undefined,
          event: typeof args.flags.event === 'string' ? args.flags.event : undefined,
        }),
      );
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 64;
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`sentinel: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
