/**
 * Facade used by the MCP server, the CLI and agent hooks. Each public
 * operation is a locked read-modify-write of `.sentinel/state.json`, so a
 * long-lived MCP server and short-lived hook processes can coexist.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { CheckpointManager } from './circuit-breaker/checkpoint.js';
import { CircuitBreaker, type RunOutcome, type TripResult } from './circuit-breaker/breaker.js';
import { loadConfig, type SentinelConfig } from './config.js';
import { compactState, historyStats, renderHistory, type CompactionResult, type HistoryStats } from './token-guard/compactor.js';
import { distillLog, type DistillResult } from './token-guard/distiller.js';
import { pruneSource, type PruneOptions, type PruneResult } from './token-guard/pruner.js';
import type { Checkpoint, DeadEndLog, EventSource, GuardDecision, RiskAssessment, RollbackResult, SentinelState } from './types.js';
import { findEnclosingSymbols } from './utils/ast.js';
import { diffLines, parseUnifiedDiff, type LineDiff } from './utils/diff.js';
import { git } from './utils/git.js';
import { sha256 } from './utils/hash.js';
import { toPosix } from './utils/normalize.js';
import { StateStore } from './utils/state-store.js';

export interface SentinelOptions {
  root: string;
  config?: Partial<SentinelConfig>;
  now?: () => number;
  /** Disable git checkpoints/rollback entirely (block-only mode). */
  disableGit?: boolean;
}

export interface RecordEditParams {
  file: string;
  /** Content before the edit. Falls back to the pre-edit snapshot, then git HEAD. */
  before?: string;
  /** Content after the edit. Falls back to reading the file from disk. */
  after?: string;
  /** Alternatively, a unified diff (may span several files). */
  diff?: string;
  /** Alternatively, explicit replaced fragments (e.g. old_string/new_string of an Edit tool). */
  fragments?: Array<{ oldText: string; newText: string }>;
  source: EventSource;
}

export interface EditOutcome {
  recorded: Array<{ file: string; added: number; removed: number; symbols: string[] }>;
  assessment: RiskAssessment;
  status: SentinelState['circuit']['status'];
  trip?: TripResult;
}

export interface RecordRunResult extends RunOutcome {
  distilled?: DistillResult;
  compaction?: CompactionResult;
}

export interface StatusReport {
  status: SentinelState['circuit']['status'];
  reasons: string[];
  tripCount: number;
  consecutiveFailures: number;
  assessment: RiskAssessment;
  touchedFiles: string[];
  lastCheckpoint?: Checkpoint;
  latestDeadEnd?: string;
  gitAvailable: boolean;
  configWarnings: string[];
}

export class Sentinel {
  readonly root: string;
  readonly store: StateStore;
  readonly config: SentinelConfig;
  readonly configWarnings: string[];
  private readonly checkpoints: CheckpointManager | null;
  private readonly breaker: CircuitBreaker;
  private readonly now: () => number;

  constructor(options: SentinelOptions) {
    this.root = resolve(options.root);
    this.store = new StateStore(this.root);
    const loaded = loadConfig(this.root, options.config);
    this.config = loaded.config;
    this.configWarnings = loaded.warnings;
    this.now = options.now ?? Date.now;
    this.checkpoints = options.disableGit ? null : new CheckpointManager(this.root);
    this.breaker = new CircuitBreaker({
      config: this.config,
      checkpoints: this.checkpoints,
      now: this.now,
      root: this.root,
      writeDeadEnd: (log, md) => {
        this.store.writeArtifact(`dead-ends/${log.id}.json`, JSON.stringify(log, null, 2));
        this.store.writeArtifact(`dead-ends/${log.id}.md`, md);
        this.store.writeArtifact('dead-ends/LATEST.md', md);
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Circuit                                                            */
  /* ---------------------------------------------------------------- */

  status(): StatusReport {
    const state = this.store.load();
    return {
      status: state.circuit.status,
      reasons: state.circuit.reasons,
      tripCount: state.circuit.tripCount,
      consecutiveFailures: state.consecutiveFailures,
      assessment: this.breaker.assess(state),
      touchedFiles: state.touchedFiles,
      lastCheckpoint: state.checkpoints[state.checkpoints.length - 1],
      latestDeadEnd: state.deadEnds[state.deadEnds.length - 1],
      gitAvailable: this.gitAvailable(),
      configWarnings: this.configWarnings,
    };
  }

  guardEdit(file?: string): GuardDecision {
    const rel = file ? this.toRel(file) : undefined;
    return this.store.update((state) => {
      const decision = this.breaker.guardEdit(state, rel);
      if (decision.allowed && rel) this.saveSnapshot(rel);
      return decision;
    });
  }

  recordEdit(params: RecordEditParams): EditOutcome {
    const changes = this.computeChanges(params);
    return this.store.update((state) => {
      const recorded: EditOutcome['recorded'] = [];
      let trip: TripResult | undefined;
      let assessment = this.breaker.assess(state);
      for (const c of changes) {
        if (c.diff.added.length === 0 && c.diff.removed.length === 0) continue;
        const symbols = c.after !== undefined ? findEnclosingSymbols(c.after, c.file, c.diff.changedLines) : [];
        const res = this.breaker.recordEdit(state, {
          file: c.file,
          added: c.diff.added,
          removed: c.diff.removed,
          symbols,
          line: c.diff.changedLines[0],
          source: params.source,
        });
        assessment = res.assessment;
        trip = trip ?? res.trip;
        recorded.push({ file: c.file, added: c.diff.added.length, removed: c.diff.removed.length, symbols });
      }
      for (const c of changes) if (c.after !== undefined) this.saveSnapshot(c.file, c.after);
      if (trip) this.refreshSnapshots(trip.deadEnd.rollback);
      return { recorded, assessment, status: state.circuit.status, trip };
    });
  }

  recordRun(params: { command: string; exitCode: number; log?: string; source: EventSource }): RecordRunResult {
    const log = params.log ?? '';
    return this.store.update((state) => {
      const outcome = this.breaker.recordRun(state, params);
      if (outcome.trip) this.refreshSnapshots(outcome.trip.deadEnd.rollback);
      const compaction = compactState(state, { compactEvery: this.config.compactEvery }, this.now());
      const distilled = params.exitCode !== 0 && log ? this.distill(log) : undefined;
      return { ...outcome, distilled, compaction: compaction.episodes.length ? compaction : undefined };
    });
  }

  /** Close the circuit. Remaining rounds are compacted first so the lesson survives the reset. */
  reset(): { previous: SentinelState['circuit']['status']; compaction: CompactionResult } {
    return this.store.update((state) => {
      const previous = state.circuit.status;
      const compaction = compactState(state, { compactEvery: 1, keepRecent: 0 }, this.now());
      this.breaker.reset(state);
      return { previous, compaction };
    });
  }

  checkpoint(label = 'manual checkpoint'): Checkpoint | undefined {
    return this.store.update((state) => this.breaker.createCheckpoint(state, label, true));
  }

  rollback(checkpointId?: string): RollbackResult {
    return this.store.update((state) => {
      const result = this.breaker.rollback(state, checkpointId);
      this.refreshSnapshots(result);
      return result;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Token guard                                                        */
  /* ---------------------------------------------------------------- */

  distill(log: string, tokenBudget?: number): DistillResult {
    return distillLog(log, { root: this.root, tokenBudget: tokenBudget ?? this.config.distillTokenBudget, contextLines: this.config.contextLines });
  }

  prune(file: string, options: PruneOptions): PruneResult {
    const full = this.resolveInRoot(file);
    if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`File not found: ${file}`);
    return pruneSource(readFileSync(full, 'utf8'), full, options);
  }

  /** Explicit compaction: fold every round except the most recent one. */
  compact(): CompactionResult & { history: string; stats: HistoryStats } {
    return this.store.update((state) => {
      const result = compactState(state, { compactEvery: this.config.compactEvery, force: true }, this.now());
      return { ...result, history: renderHistory(state), stats: historyStats(state) };
    });
  }

  historyStats(): HistoryStats {
    return historyStats(this.store.load());
  }

  history(): string {
    return renderHistory(this.store.load());
  }

  deadEnds(limit = 3): Array<{ log: DeadEndLog; markdown: string }> {
    const state = this.store.load();
    return state.deadEnds
      .slice(-limit)
      .reverse()
      .flatMap((id) => {
        const json = this.store.readArtifact(`dead-ends/${id}.json`);
        const md = this.store.readArtifact(`dead-ends/${id}.md`);
        return json && md ? [{ log: JSON.parse(json) as DeadEndLog, markdown: md }] : [];
      });
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                            */
  /* ---------------------------------------------------------------- */

  gitAvailable(): boolean {
    try {
      return !!this.checkpoints?.isAvailable();
    } catch {
      return false;
    }
  }

  /** Project-relative POSIX path. Rejects paths escaping the project root. */
  toRel(file: string): string {
    return toPosix(relative(this.root, this.resolveInRoot(file)));
  }

  resolveInRoot(file: string): string {
    const full = isAbsolute(file) ? resolve(file) : resolve(this.root, file);
    const rel = relative(this.root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes project root: ${file}`);
    return full;
  }

  private snapshotKey(rel: string): string {
    return `snapshots/${sha256(rel).slice(0, 32)}`;
  }

  private saveSnapshot(rel: string, content?: string): void {
    try {
      const full = this.resolveInRoot(rel);
      const body = content ?? (existsSync(full) && statSync(full).isFile() && statSync(full).size < 5_000_000 ? readFileSync(full, 'utf8') : '');
      this.store.writeArtifact(this.snapshotKey(rel), body);
    } catch {
      /* snapshots are best-effort */
    }
  }

  /** After a rollback, pre-edit snapshots must reflect the restored files. */
  private refreshSnapshots(result: RollbackResult): void {
    if (!result.performed) return;
    for (const f of [...result.restoredFiles, ...result.deletedFiles]) this.saveSnapshot(f);
  }

  private readBefore(rel: string): string {
    const snap = this.store.readArtifact(this.snapshotKey(rel));
    if (snap !== undefined) return snap;
    if (this.gitAvailable()) {
      const res = git(this.root, ['show', `HEAD:./${rel}`]);
      if (res.ok) return res.stdout;
    }
    return '';
  }

  private computeChanges(params: RecordEditParams): Array<{ file: string; diff: LineDiff; after?: string }> {
    if (params.diff) {
      return parseUnifiedDiff(params.diff).map((d) => {
        const rel = this.toRel(d.file);
        const full = this.resolveInRoot(rel);
        return { file: rel, diff: d, after: existsSync(full) ? readFileSync(full, 'utf8') : undefined };
      });
    }
    const rel = this.toRel(params.file);
    const full = this.resolveInRoot(rel);
    const after = params.after ?? (existsSync(full) ? readFileSync(full, 'utf8') : '');
    if (params.before === undefined && params.fragments?.length && this.store.readArtifact(this.snapshotKey(rel)) === undefined) {
      // No pre-edit snapshot: reconstruct the change from the edit fragments.
      const diff: LineDiff = { added: [], removed: [], changedLines: [] };
      for (const f of params.fragments) {
        const d = diffLines(f.oldText, f.newText);
        diff.added.push(...d.added);
        diff.removed.push(...d.removed);
        const offset = Math.max(0, after.indexOf(f.newText));
        const baseLine = after.slice(0, offset).split('\n').length;
        diff.changedLines.push(...d.changedLines.map((l) => baseLine + l - 1));
      }
      return [{ file: rel, diff, after }];
    }
    const before = params.before ?? this.readBefore(rel);
    return [{ file: rel, diff: diffLines(before, after), after }];
  }
}

/** List Dead-End markdown files without instantiating a Sentinel (used by the CLI). */
export function listDeadEndFiles(root: string): string[] {
  const dir = resolve(root, '.sentinel', 'dead-ends');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'LATEST.md').sort();
}
