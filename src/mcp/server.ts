#!/usr/bin/env node
/**
 * MCP server (stdio) exposing agent-token-sentinel to Claude Code, Cursor,
 * Windsurf and any other MCP client.
 *
 * Root resolution: --root <dir>  >  $SENTINEL_ROOT  >  $CLAUDE_PROJECT_DIR  >  cwd.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Sentinel } from '../sentinel.js';
import { VERSION } from '../version.js';

type ToolResult = CallToolResult;

function ok(summary: string, data?: unknown): ToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: 'text', text }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `sentinel error: ${message}` }], isError: true };
}

/** Run a handler; any exception becomes a structured tool error instead of crashing the server. */
function safe<A>(fn: (args: A) => ToolResult): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

export function createServer(sentinel: Sentinel): McpServer {
  const server = new McpServer(
    { name: 'agent-token-sentinel', version: VERSION },
    {
      instructions:
        'Watchdog for coding loops and context bloat. Call sentinel_guard_edit before editing a file, ' +
        'sentinel_record_run after every build/test command (or run tests through `sentinel run -- <cmd>`), ' +
        'and use sentinel_distill_log / sentinel_prune_file instead of pasting full logs or whole files. ' +
        'When a distilled failure is not enough, pull the missing detail with sentinel_expand_log instead of re-running. ' +
        'If a tool reports the circuit is OPEN: stop editing, read sentinel://dead-ends, re-plan, then sentinel_reset_circuit.',
    },
  );

  /* ------------------------------- Tools ------------------------------- */

  server.registerTool(
    'sentinel_guard_edit',
    {
      title: 'Guard an upcoming edit',
      description:
        'Call BEFORE writing to a file. Returns allow / warn / block. When blocked, the circuit breaker is OPEN: do not write; follow the Dead-End log instead. ' +
        'Also snapshots the file so the edit can be diffed afterwards.',
      inputSchema: {
        file: z.string().min(1).describe('Path of the file about to be edited (absolute or project-relative).'),
        intent: z.string().max(500).optional().describe('One sentence: what the edit is meant to fix.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    safe(({ file }: { file: string; intent?: string }) => {
      const d = sentinel.guardEdit(file);
      const icon = d.decision === 'block' ? '⛔ BLOCK' : d.decision === 'warn' ? '⚠️ WARN' : '✅ ALLOW';
      return { ...ok(`${icon} [circuit ${d.circuit}, risk ${d.risk}] ${d.reason}`, d), isError: d.decision === 'block' };
    }),
  );

  server.registerTool(
    'sentinel_record_edit',
    {
      title: 'Record an edit',
      description:
        'Call AFTER editing when no editor hook is installed. Provide a unified diff, or before/after content; with neither, the file on disk is diffed against the snapshot taken by sentinel_guard_edit.',
      inputSchema: {
        file: z.string().min(1),
        diff: z.string().optional().describe('Unified diff (git diff format).'),
        before: z.string().optional(),
        after: z.string().optional(),
      },
    },
    safe((args: { file: string; diff?: string; before?: string; after?: string }) => {
      const r = sentinel.recordEdit({ ...args, source: 'mcp' });
      const head = r.trip
        ? `⛔ Circuit TRIPPED by this edit.\n\n${r.trip.markdown}`
        : `Recorded ${r.recorded.map((e) => `${e.file} (+${e.added}/-${e.removed}${e.symbols.length ? ` in ${e.symbols.join(', ')}` : ''})`).join('; ') || 'no line changes'}. Risk: ${r.assessment.level}.`;
      return ok(head, { status: r.status, reasons: r.assessment.reasons });
    }),
  );

  server.registerTool(
    'sentinel_record_run',
    {
      title: 'Record a build/test run',
      description:
        'Call after EVERY build, compile or test command with its exit code and output. Returns a distilled error (≈150 tokens) to use instead of the raw log, ' +
        'and trips the circuit breaker when a loop is detected (writes get blocked, dirty edits are rolled back).',
      inputSchema: {
        command: z.string().min(1).describe('The command that was run, e.g. "npm test".'),
        exitCode: z.number().int().describe('Process exit code. 0 = success.'),
        log: z.string().optional().describe('Raw stdout+stderr. It is distilled and fingerprinted locally.'),
      },
    },
    safe((args: { command: string; exitCode: number; log?: string }) => {
      const r = sentinel.recordRun({ ...args, source: 'mcp' });
      if (r.trip) return { ...ok(`⛔ CIRCUIT OPEN — stop editing.\n\n${r.trip.markdown}`), isError: true };
      if (args.exitCode === 0) {
        return ok(`✅ Run passed. Failure streak reset${r.checkpoint ? `; checkpoint ${r.checkpoint.id} saved` : ''}.${r.compaction ? `\n${r.compaction.episodes.map((e) => e.summary).join('\n')}` : ''}`);
      }
      const lines = [
        `❌ Run failed (${r.assessment.consecutiveFailures} in a row, risk ${r.assessment.level}). Fingerprint ${r.fingerprint?.hash.slice(0, 12) ?? 'n/a'}.`,
        ...r.assessment.reasons.map((x) => `⚠️ ${x}`),
        '',
        r.distilled?.text ?? '(no log provided)',
      ];
      if (r.compaction) lines.push('', 'History compacted:', ...r.compaction.episodes.map((e) => e.summary));
      return ok(lines.join('\n'));
    }),
  );

  server.registerTool(
    'sentinel_check_circuit',
    {
      title: 'Check circuit status',
      description: 'Current breaker state, failure streak, loop signals (oscillation, fingerprint pattern, hotspot) and last checkpoint.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(() => {
      const s = sentinel.status();
      return ok(`Circuit ${s.status} · risk ${s.assessment.level} · ${s.consecutiveFailures} consecutive failures${s.reasons.length ? `\nTripped because: ${s.reasons.join('; ')}` : ''}`, {
        status: s.status,
        risk: s.assessment.level,
        signals: s.assessment.reasons,
        oscillation: { rate: Number(s.assessment.oscillation.rate.toFixed(2)), file: s.assessment.oscillation.file },
        fingerprintPattern: s.assessment.fingerprintPattern.pattern,
        hotspot: s.assessment.hotspot,
        touchedFiles: s.touchedFiles,
        lastCheckpoint: s.lastCheckpoint?.id,
        latestDeadEnd: s.latestDeadEnd,
        gitAvailable: s.gitAvailable,
        tripCount: s.tripCount,
        configWarnings: s.configWarnings,
      });
    }),
  );

  server.registerTool(
    'sentinel_reset_circuit',
    {
      title: 'Reset the circuit breaker',
      description:
        'Close an OPEN circuit after completing the Dead-End self-check. You must state the NEW hypothesis — it must not repeat a rejected approach. Loop history is compacted, Dead-End logs are kept.',
      inputSchema: {
        hypothesis: z.string().min(15).describe('The new root-cause hypothesis and the single change you will try next.'),
      },
    },
    safe(({ hypothesis }: { hypothesis: string }) => {
      const r = sentinel.reset();
      return ok(`Circuit reset (${r.previous} → CLOSED). New hypothesis recorded: ${hypothesis}\nMake ONE minimal change, then record the run.`);
    }),
  );

  server.registerTool(
    'sentinel_checkpoint',
    {
      title: 'Create a checkpoint',
      description: 'Snapshot the working tree (git, without touching your branch/index/stash) as a known-good rollback target.',
      inputSchema: { label: z.string().max(200).optional() },
    },
    safe(({ label }: { label?: string }) => {
      const cp = sentinel.checkpoint(label);
      return cp ? ok(`Checkpoint ${cp.id} saved at ${cp.ref}.`, cp) : fail('Checkpoints need a git repository.');
    }),
  );

  server.registerTool(
    'sentinel_distill_log',
    {
      title: 'Distill a log',
      description: 'Compress a compiler / test-runner log to the error, failing test and first project call site (±3 lines). Strips ANSI and node_modules / bundler frames.',
      inputSchema: {
        log: z.string().min(1),
        tokenBudget: z.number().int().min(40).max(2000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(({ log, tokenBudget }: { log: string; tokenBudget?: number }) => {
      const r = sentinel.distill(log, { tokenBudget });
      return ok(r.text, { originalTokens: r.originalTokens, distilledTokens: r.distilledTokens, reduction: `${(r.reduction * 100).toFixed(1)}%` });
    }),
  );

  server.registerTool(
    'sentinel_expand_log',
    {
      title: 'Expand a stored raw log',
      description:
        'Fetch exactly the part of a recorded run\'s raw log you need when the distilled briefing is not enough: a failure block (`failure: 2`), lines matching a pattern (`grep`), or a line range. ' +
        'Cheaper than re-running the command. Defaults to the latest run.',
      inputSchema: {
        run: z.string().optional().describe('Run id from the distilled footer, e.g. "run-12". Default: latest.'),
        failure: z.number().int().min(1).optional().describe('1-based failure block, in the order the distilled output lists them.'),
        grep: z.string().min(1).max(200).optional().describe('Case-insensitive regex; matching lines are returned with context.'),
        context: z.number().int().min(0).max(20).optional(),
        from: z.number().int().min(1).optional(),
        to: z.number().int().min(1).optional(),
        maxTokens: z.number().int().min(100).max(8000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe((args: { run?: string; failure?: number; grep?: string; context?: number; from?: number; to?: number; maxTokens?: number }) => ok(sentinel.expandLog(args).text)),
  );

  server.registerTool(
    'sentinel_prune_file',
    {
      title: 'Read a file, pruned to the relevant symbols',
      description:
        'Read only the target functions/classes (e.g. "validateToken", "AuthService.login") plus the imports and types they use; everything else is folded. Lines keep original numbers — edit those lines, never rewrite the whole file.',
      inputSchema: {
        file: z.string().min(1),
        targets: z.array(z.string().min(1)).min(1),
        lineNumbers: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(({ file, targets, lineNumbers }: { file: string; targets: string[]; lineNumbers?: boolean }) => {
      const r = sentinel.prune(file, { targets, lineNumbers });
      const meta = `[${r.strategy}] kept ${r.keptSymbols.join(', ') || 'nothing'}${r.dependencies.length ? ` + ${r.dependencies.join(', ')}` : ''}; omitted ${r.omittedLines}/${r.totalLines} lines (${r.originalTokens}→${r.prunedTokens} tokens)${r.missingTargets.length ? `; NOT FOUND: ${r.missingTargets.join(', ')}` : ''}`;
      return ok(`${meta}\n\n${r.text}`);
    }),
  );

  server.registerTool(
    'sentinel_compact_history',
    {
      title: 'Compact debug history',
      description:
        'Fold older debug rounds into one-line [Compacted] summaries. Use the returned history in place of your earlier verbose tool calls and logs.',
      inputSchema: {},
    },
    safe(() => {
      const r = sentinel.compact();
      return ok(
        `${r.history}\n\n[sentinel: ${r.episodes.length} new episode(s); history ${r.stats.originalTokens}→${r.stats.currentTokens} tokens, freed ${(r.stats.reduction * 100).toFixed(0)}%]`,
      );
    }),
  );

  /* ----------------------------- Resources ----------------------------- */

  server.registerResource(
    'state',
    'sentinel://state',
    { title: 'Sentinel state', description: 'Circuit status and loop signals.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(sentinel.status(), null, 2) }] }),
  );

  server.registerResource(
    'dead-ends',
    'sentinel://dead-ends',
    { title: 'Dead-End logs', description: 'Most recent failure-path blacklists (Markdown).', mimeType: 'text/markdown' },
    async (uri) => {
      const logs = sentinel.deadEnds(3);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: logs.length ? logs.map((l) => l.markdown).join('\n---\n') : 'No dead ends recorded.' }] };
    },
  );

  server.registerResource(
    'history',
    'sentinel://history',
    { title: 'Compacted debug history', description: 'Episodic summary of debug rounds.', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: sentinel.history() }] }),
  );

  return server;
}

export function resolveRoot(argv: readonly string[] = process.argv.slice(2)): string {
  const idx = argv.indexOf('--root');
  return (idx >= 0 ? argv[idx + 1] : undefined) ?? process.env.SENTINEL_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function startStdioServer(root = resolveRoot()): Promise<void> {
  const server = createServer(new Sentinel({ root }));
  await server.connect(new StdioServerTransport());
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  startStdioServer().catch((err: unknown) => {
    process.stderr.write(`agent-token-sentinel MCP server failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
