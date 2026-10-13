/**
 * Episodic History Compactor.
 *
 * A *debug round* = the edits made since the previous run + the run itself.
 * Every `compactEvery` completed rounds, older rounds are folded into a
 * single line such as:
 *
 *   [Compacted]: Rounds 1-3 attempted null-checks at src/auth.ts:42, failed with TypeError. Reverted.
 *
 * The agent replaces its verbose tool-call history with this view
 * (resource `sentinel://history`), freeing most of the stale context.
 */
import type { CompactedEpisode, DeadEndLog, EditRound, EpisodeStatus, RunRecord, SentinelState } from '../types.js';
import { classifyApproach, primaryLocation } from '../utils/approach.js';
import { estimateTokens } from '../utils/tokens.js';

export interface DebugRound {
  /** 1-based round number since the last reset. */
  index: number;
  edits: EditRound[];
  run: RunRecord;
  /** Estimated tokens this round occupied in the agent's context (edits + raw log + call overhead). */
  rawTokens: number;
  reverted: boolean;
}

export interface CompactOptions {
  compactEvery: number;
  /** Most recent rounds always kept verbatim (default 1). */
  keepRecent?: number;
  /** Fold every older round now, even before a full block of `compactEvery` exists (explicit compaction). */
  force?: boolean;
}

export interface HistoryStats {
  /** Tokens the full, uncompacted history would occupy. */
  originalTokens: number;
  /** Tokens of the compacted view (summaries + recent raw rounds). */
  currentTokens: number;
  freedTokens: number;
  reduction: number;
}

export interface CompactionResult {
  episodes: CompactedEpisode[];
  remaining: DebugRound[];
  originalTokens: number;
  compactedTokens: number;
  freedTokens: number;
  /** freed / original, 0..1 */
  reduction: number;
}

/** Per tool call, the agent's context also carries the call envelope and its own reasoning. */
const TOOL_CALL_OVERHEAD_TOKENS = 40;

export function roundTokens(edits: readonly EditRound[], run: RunRecord): number {
  const editTokens = edits.reduce((sum, e) => sum + estimateTokens(e.added.join('\n')) + estimateTokens(e.removed.join('\n')) + TOOL_CALL_OVERHEAD_TOKENS, 0);
  return editTokens + run.rawTokens + TOOL_CALL_OVERHEAD_TOKENS;
}

/** Group uncompacted edits and runs into debug rounds. */
export function buildRounds(state: SentinelState): DebugRound[] {
  const rounds: DebugRound[] = [];
  const runs = state.runs.filter((r) => r.seq > state.compactedThroughSeq);
  let prevSeq = state.compactedThroughSeq;
  let index = state.roundCounter;
  for (const run of runs) {
    const edits = state.edits.filter((e) => e.seq > prevSeq && e.seq < run.seq);
    index++;
    rounds.push({ index, edits, run, rawTokens: roundTokens(edits, run), reverted: run.seq <= state.revertedThroughSeq });
    prevSeq = run.seq;
  }
  return rounds;
}

/** Structured facts about a block of rounds: what was tried, where, what failed, how it ended. */
export function describeRounds(rounds: readonly DebugRound[]): Omit<CompactedEpisode, 'summary' | 'freedTokens' | 'createdAt'> {
  const edits = rounds.flatMap((r) => r.edits);
  const errors = new Map<string, { name: string; message?: string; count: number }>();
  for (const r of rounds) {
    if (r.run.exitCode === 0) continue;
    const name = r.run.errorName && r.run.errorName !== 'UnknownError' ? r.run.errorName : `exit ${r.run.exitCode}`;
    const key = `${name}|${r.run.message ?? ''}`;
    const e = errors.get(key) ?? { name, message: r.run.message, count: 0 };
    e.count++;
    errors.set(key, e);
  }
  const lastRun = rounds[rounds.length - 1]?.run;
  const status: EpisodeStatus = rounds.some((r) => r.reverted) ? 'reverted' : lastRun && lastRun.exitCode === 0 ? 'resolved' : 'unresolved';
  return {
    fromRound: rounds[0]?.index ?? 0,
    toRound: rounds[rounds.length - 1]?.index ?? 0,
    status,
    approach: edits.length ? classifyApproach(edits) : 're-running without edits',
    location: primaryLocation(edits),
    errors: [...errors.values()],
    tests: [...new Set(rounds.map((r) => r.run.failingTest).filter((t): t is string => !!t))].slice(0, 3),
    files: [...new Set(edits.map((e) => e.file))].slice(0, 5),
  };
}

export function summarizeRounds(rounds: readonly DebugRound[]): string {
  if (rounds.length === 0) return '[Compacted]: (no rounds)';
  const d = describeRounds(rounds);
  const label = d.fromRound === d.toRound ? `Round ${d.fromRound}` : `Rounds ${d.fromRound}-${d.toRound}`;
  const byName = new Map<string, number>();
  for (const e of d.errors ?? []) byName.set(e.name, (byName.get(e.name) ?? 0) + e.count);
  const errorText = [...byName.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
  const failed = (d.errors ?? []).length > 0;
  const outcome = !failed ? 'all passed' : d.status === 'resolved' ? `failed with ${errorText}, then passed` : `failed with ${errorText}`;
  const reverted = d.status === 'reverted' ? ' Reverted.' : '';
  return `[Compacted]: ${label} attempted ${d.approach}${d.location ? ` at ${d.location}` : ''}, ${outcome}.${reverted}`;
}

/**
 * Multi-line rendering of an episode: the summary plus the evidence a model
 * needs to avoid repeating it (exact error message, failing test, status).
 */
export function renderEpisode(e: CompactedEpisode): string[] {
  const lines = [e.summary];
  if (e.status && e.status !== 'resolved') lines.push(`  status: ${e.status.toUpperCase()}`);
  const top = [...(e.errors ?? [])].sort((a, b) => b.count - a.count)[0];
  if (top?.message) lines.push(`  error: ${top.name}: ${top.message.slice(0, 140)}`);
  if (e.tests?.length) lines.push(`  test: ${e.tests.join(' | ').slice(0, 160)}`);
  return lines;
}

/** Pure compaction over a list of rounds. */
export function compactRounds(rounds: readonly DebugRound[], options: CompactOptions, now = Date.now()): CompactionResult {
  const keepRecent = options.keepRecent ?? 1;
  const originalTokens = rounds.reduce((s, r) => s + r.rawTokens, 0);
  const episodes: CompactedEpisode[] = [];
  const compactable = rounds.slice(0, Math.max(0, rounds.length - keepRecent));
  let consumed = 0;
  // Fold complete blocks of `compactEvery`; a trailing partial block is folded
  // too once at least one full block exists (or when forced), so nothing stale lingers.
  if (compactable.length >= options.compactEvery || (options.force && compactable.length > 0)) {
    for (let i = 0; i < compactable.length; i += options.compactEvery) {
      const block = compactable.slice(i, i + options.compactEvery);
      const summary = summarizeRounds(block);
      const blockTokens = block.reduce((s, r) => s + r.rawTokens, 0);
      const episode: CompactedEpisode = { ...describeRounds(block), summary, freedTokens: 0, createdAt: now };
      episode.freedTokens = Math.max(0, blockTokens - estimateTokens(renderEpisode(episode).join('\n')));
      episodes.push(episode);
      consumed += block.length;
    }
  }
  const remaining = rounds.slice(consumed);
  const compactedTokens = episodes.reduce((s, e) => s + estimateTokens(renderEpisode(e).join('\n')), 0) + remaining.reduce((s, r) => s + r.rawTokens, 0);
  const freedTokens = Math.max(0, originalTokens - compactedTokens);
  return { episodes, remaining, originalTokens, compactedTokens, freedTokens, reduction: originalTokens > 0 ? freedTokens / originalTokens : 0 };
}

/** Compact the state's uncompacted rounds in place. */
export function compactState(state: SentinelState, options: CompactOptions, now = Date.now()): CompactionResult {
  const rounds = buildRounds(state);
  const result = compactRounds(rounds, options, now);
  if (result.episodes.length > 0) {
    state.compacted.push(...result.episodes);
    const lastFolded = rounds[rounds.length - result.remaining.length - 1];
    if (lastFolded) {
      state.compactedThroughSeq = lastFolded.run.seq;
      state.roundCounter = lastFolded.index;
    }
  }
  return result;
}

/** Whole-history accounting: what the agent would carry without vs. with compaction. */
export function historyStats(state: SentinelState): HistoryStats {
  const summaries = state.compacted.reduce((s, e) => s + estimateTokens(renderEpisode(e).join('\n')), 0);
  const freed = state.compacted.reduce((s, e) => s + e.freedTokens, 0);
  const recent = buildRounds(state).reduce((s, r) => s + r.rawTokens, 0);
  const originalTokens = summaries + freed + recent;
  const currentTokens = summaries + recent;
  return { originalTokens, currentTokens, freedTokens: freed, reduction: originalTokens > 0 ? freed / originalTokens : 0 };
}

/** Context-ready history: compacted episodes (with evidence) followed by one line per recent round. */
export function renderHistory(state: SentinelState): string {
  const lines = state.compacted.slice(-20).flatMap(renderEpisode);
  for (const r of buildRounds(state)) lines.push(renderRound(r));
  return lines.length ? lines.join('\n') : '(no debug history recorded)';
}

function renderRound(r: DebugRound): string {
  const files = [...new Set(r.edits.map((e) => `${e.file}${e.symbols.length ? `#${e.symbols.join(',')}` : ''}`))].join(', ') || 'no edits';
  const result = r.run.exitCode === 0 ? 'PASS' : `FAIL ${r.run.errorName ?? ''}${r.run.message ? `: ${r.run.message.slice(0, 100)}` : ''}`;
  return `Round ${r.index}: edited ${files}; \`${r.run.command}\` → ${result}${r.reverted ? ' (reverted)' : ''}${r.run.logId ? ` [log ${r.run.logId}]` : ''}`;
}

export interface MemoryOptions {
  /** SessionStart source: startup | resume | clear | compact | fork. */
  reason?: string;
  tokenBudget: number;
  latestDeadEnd?: DeadEndLog;
}

/**
 * The debugging memory re-injected when Claude Code compacts, resumes or clears
 * a session, so "what was already tried and failed" is never lost with the
 * transcript. Returns undefined when there is nothing worth saying.
 */
export function buildMemory(state: SentinelState, options: MemoryOptions): string | undefined {
  const failing = state.consecutiveFailures > 0;
  const open = state.circuit.status !== 'CLOSED';
  const rounds = buildRounds(state);
  const unresolved = state.compacted.filter((e) => e.status && e.status !== 'resolved');
  const hasHistory = rounds.length > 0 || unresolved.length > 0;
  // On a fresh startup only speak up when something is actually wrong.
  if (!open && !failing && (options.reason === 'startup' || !hasHistory)) return undefined;

  const out: string[] = [`[agent-token-sentinel memory${options.reason ? ` · after ${options.reason}` : ''}]`];
  if (open) {
    out.push(`Circuit ${state.circuit.status}: ${state.circuit.reasons.join('; ').slice(0, 200)}. Do not edit until you read sentinel://dead-ends and reset with a new hypothesis.`);
  }
  const last = state.runs[state.runs.length - 1];
  if (failing && last) {
    const what = `${last.errorName ?? 'failure'}${last.message ? `: ${last.message.slice(0, 140)}` : ''}`;
    out.push(`Open problem: ${what}${last.failingTest ? ` (test: ${last.failingTest.slice(0, 100)})` : ''} — failing ${state.consecutiveFailures} run(s) in a row on \`${last.command}\`${last.logId ? `; full log: sentinel_expand_log run=${last.logId}` : ''}.`);
  }
  const tried = [
    ...(options.latestDeadEnd && open ? options.latestDeadEnd.rejectedApproaches.map((a) => `- (dead end) ${a}`) : []),
    ...unresolved.slice(-6).flatMap((e) => renderEpisode(e).map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`))),
  ];
  if (tried.length) out.push('Already tried, did not fix it:', ...tried);
  if (rounds.length) out.push('Recent rounds:', ...rounds.slice(-3).map((r) => `- ${renderRound(r)}`));
  const green = [...state.checkpoints].reverse().find((c) => c.green);
  if (green) out.push(`Last green checkpoint: ${green.id} (${green.label}).`);

  // Fit the budget by dropping the oldest detail first, never the header or the open problem.
  const fixed = out.slice(0, 1 + (open ? 1 : 0) + (failing && last ? 1 : 0));
  let rest = out.slice(fixed.length);
  while (rest.length && estimateTokens([...fixed, ...rest].join('\n')) > options.tokenBudget) rest = rest.slice(1);
  return [...fixed, ...rest].join('\n');
}
