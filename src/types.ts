/**
 * Shared domain types for agent-token-sentinel.
 * Everything persisted to `.sentinel/state.json` is defined here so the
 * schema has one source of truth.
 */

export type CircuitStatus = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Where an observation came from. */
export type EventSource = 'mcp' | 'cli' | 'hook:claude' | 'hook:cursor' | 'hook:windsurf' | 'git' | 'test';

/** One recorded code change to a single file. */
export interface EditRound {
  /** Monotonic sequence number shared by edits and runs (ordering without clocks). */
  seq: number;
  timestamp: number;
  /** Project-relative POSIX path. */
  file: string;
  /** Normalized lines added by this edit (multiset, order preserved). */
  added: string[];
  /** Normalized lines removed by this edit. */
  removed: string[];
  /** Enclosing symbols touched by this edit, e.g. `AuthService.login`. */
  symbols: string[];
  /** First changed line (1-based, post-edit numbering) for human-readable summaries. */
  line?: number;
  source: EventSource;
}

/** One recorded build/test/compile command execution. */
export interface RunRecord {
  seq: number;
  timestamp: number;
  command: string;
  exitCode: number;
  /** SHA-256 error fingerprint; absent for successful runs or unparseable logs. */
  fingerprint?: string;
  errorName?: string;
  /** Short, normalized error message. */
  message?: string;
  /** Token estimate of the raw log, for compaction accounting. */
  rawTokens: number;
  source: EventSource;
}

export interface Checkpoint {
  id: string;
  /** Git ref holding the snapshot commit, e.g. `refs/sentinel/checkpoints/<id>`. */
  ref: string;
  commit: string;
  label: string;
  createdAt: number;
  /** True when created automatically after a passing run. */
  green: boolean;
}

export interface CompactedEpisode {
  fromRound: number;
  toRound: number;
  summary: string;
  freedTokens: number;
  createdAt: number;
}

export interface CircuitState {
  status: CircuitStatus;
  openedAt?: number;
  reasons: string[];
  /** In HALF_OPEN: whether the single probe write was already granted. */
  probeGranted: boolean;
  tripCount: number;
}

export interface SentinelState {
  version: 1;
  seq: number;
  circuit: CircuitState;
  edits: EditRound[];
  runs: RunRecord[];
  consecutiveFailures: number;
  checkpoints: Checkpoint[];
  /** Files touched by the agent since the last green checkpoint. */
  touchedFiles: string[];
  /** IDs of persisted Dead-End logs (bodies live in `.sentinel/dead-ends/`). */
  deadEnds: string[];
  compacted: CompactedEpisode[];
  /** Runs with seq <= this are already folded into `compacted`. */
  compactedThroughSeq: number;
  /** Debug rounds numbered so far (for "Rounds 1-3" labels across compactions). */
  roundCounter: number;
  /** Edits/runs with seq <= this were rolled back by a trip. */
  revertedThroughSeq: number;
}

/* ------------------------------------------------------------------ */
/* Analysis results                                                     */
/* ------------------------------------------------------------------ */

export interface ReciprocityResult {
  /** Highest reciprocity rate found in the window (0..1). */
  rate: number;
  file?: string;
  /** Lines that flipped back and forth. */
  flippedLines: string[];
  /** seq of the edit whose removals/additions were reverted. */
  pivotSeq?: number;
}

export interface OscillationReport extends ReciprocityResult {
  oscillating: boolean;
}

export type FingerprintPattern = 'none' | 'repeat' | 'cycle' | 'ping-pong';

export interface FingerprintPatternResult {
  pattern: FingerprintPattern;
  /** For `repeat`: trailing run length. For cycles: sequence length. */
  length: number;
  hashes: string[];
}

export interface ErrorFingerprint {
  hash: string;
  errorName: string;
  message: string;
  frames: string[];
  failingTest?: string;
  /** The exact canonical string that was hashed (useful for debugging). */
  canonical: string;
}

export interface HotspotReport {
  hot: boolean;
  file?: string;
  symbol?: string;
  rounds: number;
}

export interface RiskAssessment {
  level: RiskLevel;
  /** Human-readable observations (warnings included). */
  reasons: string[];
  /** Subset of reasons severe enough to trip the breaker. */
  tripReasons: string[];
  oscillation: OscillationReport;
  fingerprintPattern: FingerprintPatternResult;
  hotspot: HotspotReport;
  consecutiveFailures: number;
}

export interface RollbackResult {
  performed: boolean;
  checkpoint?: string;
  backupRef?: string;
  restoredFiles: string[];
  deletedFiles: string[];
  skippedReason?: string;
}

export interface DeadEndLog {
  id: string;
  createdAt: string;
  reasons: string[];
  attempts: Array<{ seq: number; file: string; symbols: string[]; summary: string }>;
  fingerprints: Array<{ hash: string; errorName?: string; message?: string; occurrences: number }>;
  rejectedApproaches: string[];
  rollback: RollbackResult;
  requiredSelfCheck: string[];
}

export interface GuardDecision {
  decision: 'allow' | 'warn' | 'block';
  allowed: boolean;
  circuit: CircuitStatus;
  reason: string;
  risk: RiskLevel;
}
