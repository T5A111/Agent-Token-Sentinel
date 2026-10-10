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
import type { CompactedEpisode, EditRound, RunRecord, SentinelState } from '../types.js';
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

export function summarizeRounds(rounds: readonly DebugRound[]): string {
  if (rounds.length === 0) return '[Compacted]: (no rounds)';
  const first = rounds[0]?.index ?? 0;
  const last = rounds[rounds.length - 1]?.index ?? first;
  const label = first === last ? `Round ${first}` : `Rounds ${first}-${last}`;
  const edits = rounds.flatMap((r) => r.edits);
  const where = primaryLocation(edits);
  const approach = edits.length ? classifyApproach(edits) : 're-running without edits';

  const failures = rounds.filter((r) => r.run.exitCode !== 0);
  const names = new Map<string, number>();
  for (const r of failures) {
    const n = r.run.errorName && r.run.errorName !== 'UnknownError' ? r.run.errorName : `exit ${r.run.exitCode}`;
    names.set(n, (names.get(n) ?? 0) + 1);
  }
  const errorText = [...names.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
  const lastRun = rounds[rounds.length - 1]?.run;
  const outcome =
    failures.length === 0 ? 'all passed' : lastRun && lastRun.exitCode === 0 ? `failed with ${errorText}, then passed` : `failed with ${errorText}`;
  const reverted = rounds.some((r) => r.reverted) ? ' Reverted.' : '';
  return `[Compacted]: ${label} attempted ${approach}${where ? ` at ${where}` : ''}, ${outcome}.${reverted}`;
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
      episodes.push({
        fromRound: block[0]?.index ?? 0,
        toRound: block[block.length - 1]?.index ?? 0,
        summary,
        freedTokens: Math.max(0, blockTokens - estimateTokens(summary)),
        createdAt: now,
      });
      consumed += block.length;
    }
  }
  const remaining = rounds.slice(consumed);
  const compactedTokens = episodes.reduce((s, e) => s + estimateTokens(e.summary), 0) + remaining.reduce((s, r) => s + r.rawTokens, 0);
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
  const summaries = state.compacted.reduce((s, e) => s + estimateTokens(e.summary), 0);
  const freed = state.compacted.reduce((s, e) => s + e.freedTokens, 0);
  const recent = buildRounds(state).reduce((s, r) => s + r.rawTokens, 0);
  const originalTokens = summaries + freed + recent;
  const currentTokens = summaries + recent;
  return { originalTokens, currentTokens, freedTokens: freed, reduction: originalTokens > 0 ? freed / originalTokens : 0 };
}

/** Context-ready history: compacted episodes followed by one line per recent round. */
export function renderHistory(state: SentinelState): string {
  const lines = state.compacted.slice(-20).map((e) => e.summary);
  for (const r of buildRounds(state)) {
    const files = [...new Set(r.edits.map((e) => `${e.file}${e.symbols.length ? `#${e.symbols.join(',')}` : ''}`))].join(', ') || 'no edits';
    const result = r.run.exitCode === 0 ? 'PASS' : `FAIL ${r.run.errorName ?? ''}${r.run.message ? `: ${r.run.message.slice(0, 100)}` : ''}`;
    lines.push(`Round ${r.index}: edited ${files}; \`${r.run.command}\` → ${result}${r.reverted ? ' (reverted)' : ''}`);
  }
  return lines.length ? lines.join('\n') : '(no debug history recorded)';
}
