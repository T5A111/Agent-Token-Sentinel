/**
 * Circuit breaker state machine.
 *
 *   CLOSED ──(trip condition)──▶ OPEN ──(cool-down elapsed)──▶ HALF_OPEN
 *     ▲                            ▲                               │
 *     │                            └──────(probe run fails)────────┤
 *     └──────────────(probe run passes / manual reset)─────────────┘
 *
 * The breaker mutates a `SentinelState` in place; persistence and locking
 * are the caller's job (see `Sentinel` in ../sentinel.ts). Side effects
 * (git, filesystem) are injected so the logic is testable in isolation.
 */
import type { SentinelConfig } from '../config.js';
import type {
  Checkpoint,
  DeadEndLog,
  ErrorFingerprint,
  EventSource,
  GuardDecision,
  RiskAssessment,
  RollbackResult,
  RunRecord,
  SentinelState,
} from '../types.js';
import { classifyApproach, primaryLocation } from '../utils/approach.js';
import { makeId } from '../utils/hash.js';
import { estimateTokens } from '../utils/tokens.js';
import type { CheckpointManager } from './checkpoint.js';
import { assessRisk, fingerprintError } from './detector.js';

const MAX_EDITS = 200;
const MAX_RUNS = 100;

export interface BreakerDeps {
  config: SentinelConfig;
  /** Absent or unavailable → no checkpoints / rollback (block-only mode). */
  checkpoints?: CheckpointManager | null;
  /** Persist a Dead-End log (JSON + Markdown). */
  writeDeadEnd?: (log: DeadEndLog, markdown: string) => void;
  now?: () => number;
  root?: string;
}

export interface RecordEditInput {
  file: string;
  added: string[];
  removed: string[];
  symbols?: string[];
  line?: number;
  source: EventSource;
}

export interface RecordRunInput {
  command: string;
  exitCode: number;
  log?: string;
  source: EventSource;
}

export interface TripResult {
  deadEnd: DeadEndLog;
  markdown: string;
}

export interface RunOutcome {
  run: RunRecord;
  fingerprint?: ErrorFingerprint;
  assessment: RiskAssessment;
  status: SentinelState['circuit']['status'];
  trip?: TripResult;
  checkpoint?: Checkpoint;
}

export class CircuitBreaker {
  private readonly now: () => number;

  constructor(private readonly deps: BreakerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get config(): SentinelConfig {
    return this.deps.config;
  }

  private gitAvailable(): boolean {
    try {
      return !!this.deps.checkpoints?.isAvailable();
    } catch {
      return false;
    }
  }

  assess(state: SentinelState): RiskAssessment {
    return assessRisk(state, this.config);
  }

  /* ---------------------------------------------------------------- */
  /* Write gate                                                         */
  /* ---------------------------------------------------------------- */

  /** Decide whether a write may proceed. Call *before* editing. */
  guardEdit(state: SentinelState, file?: string): GuardDecision {
    const { circuit } = state;
    if (circuit.status === 'OPEN') {
      const elapsed = this.now() - (circuit.openedAt ?? 0);
      if (elapsed >= this.config.cooldownMs) {
        circuit.status = 'HALF_OPEN';
        circuit.probeGranted = true;
      } else {
        const waitS = Math.ceil((this.config.cooldownMs - elapsed) / 1000);
        return {
          decision: 'block',
          allowed: false,
          circuit: 'OPEN',
          risk: 'critical',
          reason:
            `Circuit OPEN: ${circuit.reasons.join('; ') || 'loop detected'}. ` +
            `Writes are blocked. Read the Dead-End log (sentinel://dead-ends), re-plan at the architecture level, ` +
            `then call sentinel_reset_circuit with your new hypothesis` +
            (waitS > 0 ? ` (or wait ${waitS}s for a single HALF_OPEN probe).` : '.'),
        };
      }
    }

    this.ensureBaseline(state);
    if (file && !state.touchedFiles.includes(file)) state.touchedFiles.push(file);

    if (state.circuit.status === 'HALF_OPEN') {
      return {
        decision: 'warn',
        allowed: true,
        circuit: 'HALF_OPEN',
        risk: 'high',
        reason: 'HALF_OPEN probe: writes allowed for ONE attempt. The next recorded run decides — pass → CLOSED, fail → OPEN again.',
      };
    }

    const assessment = this.assess(state);
    if (assessment.level === 'high' || assessment.level === 'critical') {
      return { decision: 'warn', allowed: true, circuit: 'CLOSED', risk: assessment.level, reason: assessment.reasons.join('; ') };
    }
    return {
      decision: 'allow',
      allowed: true,
      circuit: 'CLOSED',
      risk: assessment.level,
      reason: assessment.reasons.length ? assessment.reasons.join('; ') : 'ok',
    };
  }

  /**
   * Before the first write after a green run, snapshot the working tree so a
   * later trip can roll back to the pre-loop state.
   */
  private ensureBaseline(state: SentinelState): void {
    if (state.touchedFiles.length > 0 || !this.gitAvailable()) return;
    const lastRun = state.runs[state.runs.length - 1];
    const latest = state.checkpoints[state.checkpoints.length - 1];
    if (latest && (!lastRun || latest.createdAt >= lastRun.timestamp) && latest.green) return;
    this.createCheckpoint(state, 'baseline before agent edits', false);
  }

  /* ---------------------------------------------------------------- */
  /* Observations                                                       */
  /* ---------------------------------------------------------------- */

  recordEdit(state: SentinelState, input: RecordEditInput): { assessment: RiskAssessment; trip?: TripResult } {
    state.seq++;
    state.edits.push({
      seq: state.seq,
      timestamp: this.now(),
      file: input.file,
      added: input.added,
      removed: input.removed,
      symbols: input.symbols ?? [],
      line: input.line,
      source: input.source,
    });
    if (state.edits.length > MAX_EDITS) state.edits.splice(0, state.edits.length - MAX_EDITS);
    if (!state.touchedFiles.includes(input.file)) state.touchedFiles.push(input.file);
    return this.evaluate(state);
  }

  recordRun(state: SentinelState, input: RecordRunInput): RunOutcome {
    state.seq++;
    const log = input.log ?? '';
    const failed = input.exitCode !== 0;
    const fingerprint = failed ? fingerprintError(log, this.deps.root) : undefined;
    const run: RunRecord = {
      seq: state.seq,
      timestamp: this.now(),
      command: input.command,
      exitCode: input.exitCode,
      fingerprint: fingerprint?.hash,
      errorName: fingerprint?.errorName,
      message: fingerprint?.message.slice(0, 160),
      rawTokens: estimateTokens(log),
      source: input.source,
    };
    state.runs.push(run);
    if (state.runs.length > MAX_RUNS) state.runs.splice(0, state.runs.length - MAX_RUNS);

    if (!failed) {
      state.consecutiveFailures = 0;
      if (state.circuit.status !== 'CLOSED') this.close(state);
      const checkpoint = this.gitAvailable() ? this.createCheckpoint(state, `green: ${input.command}`, true) : undefined;
      state.touchedFiles = [];
      return { run, assessment: this.assess(state), status: state.circuit.status, checkpoint };
    }

    state.consecutiveFailures++;
    if (state.circuit.status === 'HALF_OPEN') {
      const assessment = this.assess(state);
      const trip = this.trip(state, assessment, ['HALF_OPEN probe failed — the new approach did not fix the error', ...assessment.tripReasons]);
      return { run, fingerprint, assessment, status: state.circuit.status, trip };
    }
    const { assessment, trip } = this.evaluate(state);
    return { run, fingerprint, assessment, status: state.circuit.status, trip };
  }

  /** Re-assess and trip when warranted (CLOSED only). */
  evaluate(state: SentinelState): { assessment: RiskAssessment; trip?: TripResult } {
    const assessment = this.assess(state);
    if (state.circuit.status === 'CLOSED' && assessment.tripReasons.length > 0) {
      return { assessment, trip: this.trip(state, assessment, assessment.tripReasons) };
    }
    return { assessment };
  }

  /* ---------------------------------------------------------------- */
  /* Transitions                                                        */
  /* ---------------------------------------------------------------- */

  trip(state: SentinelState, assessment: RiskAssessment, reasons: string[]): TripResult {
    const uniqueReasons = [...new Set(reasons)];
    state.circuit = {
      status: 'OPEN',
      openedAt: this.now(),
      reasons: uniqueReasons,
      probeGranted: false,
      tripCount: state.circuit.tripCount + 1,
    };

    const rollback = this.config.autoRollback
      ? this.rollback(state)
      : { performed: false, restoredFiles: [], deletedFiles: [], skippedReason: 'autoRollback disabled in config' };

    const deadEnd = this.buildDeadEnd(state, assessment, uniqueReasons, rollback);
    const markdown = renderDeadEnd(deadEnd);
    state.deadEnds.push(deadEnd.id);
    try {
      this.deps.writeDeadEnd?.(deadEnd, markdown);
    } catch {
      /* reporting must never break the breaker */
    }
    return { deadEnd, markdown };
  }

  /** Restore agent-touched files to the latest checkpoint. Never throws. */
  rollback(state: SentinelState, checkpointId?: string): RollbackResult {
    if (!this.gitAvailable() || !this.deps.checkpoints) {
      return { performed: false, restoredFiles: [], deletedFiles: [], skippedReason: 'git unavailable — writes blocked, files left as-is' };
    }
    const target = checkpointId
      ? state.checkpoints.find((c) => c.id === checkpointId)
      : state.checkpoints[state.checkpoints.length - 1];
    if (!target) {
      return { performed: false, restoredFiles: [], deletedFiles: [], skippedReason: checkpointId ? `unknown checkpoint ${checkpointId}` : 'no checkpoint recorded yet' };
    }
    try {
      const result = this.deps.checkpoints.restore(target, state.touchedFiles);
      if (result.performed) {
        state.touchedFiles = [];
        state.revertedThroughSeq = state.seq;
      }
      return result;
    } catch (err) {
      return { performed: false, restoredFiles: [], deletedFiles: [], skippedReason: `rollback failed: ${(err as Error).message}` };
    }
  }

  /** Manual reset: close the circuit and clear the loop memory (Dead-End logs are kept). */
  reset(state: SentinelState): void {
    this.close(state);
    state.edits = [];
    state.runs = [];
    state.touchedFiles = [];
    state.compactedThroughSeq = state.seq;
  }

  private close(state: SentinelState): void {
    state.circuit = { status: 'CLOSED', reasons: [], probeGranted: false, tripCount: state.circuit.tripCount };
    state.consecutiveFailures = 0;
  }

  createCheckpoint(state: SentinelState, label: string, green: boolean): Checkpoint | undefined {
    if (!this.deps.checkpoints || !this.gitAvailable()) return undefined;
    try {
      const cp = { ...this.deps.checkpoints.snapshot('checkpoints', label, this.now()), green };
      state.checkpoints.push(cp);
      state.checkpoints = this.deps.checkpoints.prune(state.checkpoints, this.config.maxCheckpoints);
      return cp;
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Dead-End log                                                       */
  /* ---------------------------------------------------------------- */

  private buildDeadEnd(state: SentinelState, assessment: RiskAssessment, reasons: string[], rollback: RollbackResult): DeadEndLog {
    const lastGreenSeq = [...state.runs].reverse().find((r) => r.exitCode === 0)?.seq ?? -Infinity;
    const loopEdits = state.edits.filter((e) => e.seq > lastGreenSeq);
    const loopRuns = state.runs.filter((r) => r.seq > lastGreenSeq && r.exitCode !== 0);

    const fpMap = new Map<string, { hash: string; errorName?: string; message?: string; occurrences: number }>();
    for (const r of loopRuns) {
      const key = r.fingerprint ?? `exit:${r.exitCode}`;
      const entry = fpMap.get(key) ?? { hash: key, errorName: r.errorName, message: r.message, occurrences: 0 };
      entry.occurrences++;
      fpMap.set(key, entry);
    }

    const rejected: string[] = [];
    const location = primaryLocation(loopEdits);
    if (loopEdits.length) rejected.push(`${classifyApproach(loopEdits)}${location ? ` around ${location}` : ''} (${loopEdits.length} edits, ${loopRuns.length} failing runs)`);
    if (assessment.oscillation.oscillating) {
      const sample = assessment.oscillation.flippedLines.slice(0, 3).map((l) => `\`${l.slice(0, 80)}\``).join(', ');
      rejected.push(`Toggling the same lines in ${assessment.oscillation.file}: ${sample}`);
    }
    if (assessment.hotspot.hot) rejected.push(`Further local patches to ${assessment.hotspot.file}#${assessment.hotspot.symbol}`);

    const topError = [...fpMap.values()].sort((a, b) => b.occurrences - a.occurrences)[0];
    return {
      id: makeId('deadend', this.now()),
      createdAt: new Date(this.now()).toISOString(),
      reasons,
      attempts: loopEdits.slice(-12).map((e) => ({
        seq: e.seq,
        file: e.file,
        symbols: e.symbols,
        summary: summarizeEdit(e.added, e.removed),
      })),
      fingerprints: [...fpMap.values()],
      rejectedApproaches: rejected,
      rollback,
      requiredSelfCheck: [
        `Restate the failing behavior in one sentence without mentioning the code you changed${topError?.errorName ? ` (top error: ${topError.errorName})` : ''}.`,
        'Identify the root-cause layer: data shape, contract between modules, async ordering, configuration/env, or the test itself.',
        'List at least two hypotheses that are NOT variations of the rejected approaches above, and the cheapest experiment to falsify each.',
        'Read the callers and the type definitions involved (use sentinel_prune_file) before editing the failing function again.',
        'If the test expectation itself may be wrong, say so explicitly and ask the user instead of editing the test.',
        'Call sentinel_reset_circuit with the chosen hypothesis, then make ONE minimal change and run the tests via `sentinel run`.',
      ],
    };
  }
}

function summarizeEdit(added: string[], removed: string[]): string {
  const first = (lines: string[]) => lines.map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 80);
  const parts = [`+${added.length}/-${removed.length}`];
  const a = first(added);
  const r = first(removed);
  if (a) parts.push(`added \`${a}\``);
  if (r) parts.push(`removed \`${r}\``);
  return parts.join(' ');
}

export function renderDeadEnd(log: DeadEndLog): string {
  const lines: string[] = [
    `# ⛔ Dead-End Log — ${log.id}`,
    '',
    `_Created ${log.createdAt}. The circuit breaker is OPEN; writes are blocked until reset._`,
    '',
    '## Why the breaker tripped',
    ...log.reasons.map((r) => `- ${r}`),
    '',
    '## Rejected approaches (do NOT retry these)',
    ...(log.rejectedApproaches.length ? log.rejectedApproaches.map((r) => `- ${r}`) : ['- (none recorded)']),
    '',
    '## Error fingerprints in this loop',
    ...(log.fingerprints.length
      ? log.fingerprints.map((f) => `- \`${f.hash.slice(0, 12)}\` ×${f.occurrences} ${f.errorName ?? ''}${f.message ? `: ${f.message}` : ''}`)
      : ['- (none)']),
    '',
    '## Attempts',
    ...(log.attempts.length ? log.attempts.map((a) => `- #${a.seq} ${a.file}${a.symbols.length ? `#${a.symbols.join(',')}` : ''} — ${a.summary}`) : ['- (no edits recorded)']),
    '',
    '## Rollback',
    log.rollback.performed
      ? `- Restored ${log.rollback.restoredFiles.length} file(s), deleted ${log.rollback.deletedFiles.length} new file(s) to checkpoint \`${log.rollback.checkpoint}\`.\n- Pre-rollback state saved at \`${log.rollback.backupRef}\` (restore with \`git restore --source=${log.rollback.backupRef} --worktree -- <file>\`).`
      : `- Not performed: ${log.rollback.skippedReason ?? 'unknown'}`,
    '',
    '## Required architecture-level self-check',
    ...log.requiredSelfCheck.map((q, i) => `${i + 1}. ${q}`),
    '',
  ];
  return lines.join('\n');
}
