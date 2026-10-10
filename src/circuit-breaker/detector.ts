/**
 * Loop detection primitives. Everything here is pure: given recorded edits,
 * runs and logs, compute signals. Decisions live in `breaker.ts`.
 */
import type { SentinelConfig } from '../config.js';
import type {
  EditRound,
  ErrorFingerprint,
  FingerprintPatternResult,
  HotspotReport,
  OscillationReport,
  ReciprocityResult,
  RiskAssessment,
  RiskLevel,
  RunRecord,
  SentinelState,
} from '../types.js';
import { canonicalLines } from '../utils/diff.js';
import { sha256 } from '../utils/hash.js';
import { normalizeVolatile, stripAnsi, stripPositions, toProjectPath } from '../utils/normalize.js';

/* ================================================================== */
/* 1. Code flip-flop detection (line reciprocity)                       */
/* ================================================================== */

function multiset(lines: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

/** |A ∩ B| for multisets, returning the shared elements. */
function intersect(a: Map<string, number>, b: Map<string, number>): string[] {
  const shared: string[] = [];
  for (const [line, count] of a) {
    const n = Math.min(count, b.get(line) ?? 0);
    for (let i = 0; i < n; i++) shared.push(line);
  }
  return shared;
}

/**
 * Line reciprocity over a sequence of edits *to one file*.
 *
 * For each pivot edit N with deletions D_N (normalized, multiset):
 *   rate(N) = |D_N ∩ (A_{N+1} ∪ A_{N+2})| / |D_N|
 * i.e. the share of deleted lines that come back within the next two edits.
 * The file's reciprocity is the max over pivots.
 *
 * Covers both "add → remove → re-add" (pivot = the removal) and
 * "X → Y → X" (pivot = the edit that replaced X). Iterative refinement
 * (v0 → v1 → v2) is *not* flagged because removed lines never return.
 */
export function computeReciprocity(edits: readonly EditRound[], lookahead = 2): ReciprocityResult {
  let best: ReciprocityResult = { rate: 0, flippedLines: [] };
  for (let n = 0; n < edits.length; n++) {
    const pivot = edits[n];
    if (!pivot) continue;
    const later = edits.slice(n + 1, n + 1 + lookahead);
    const removed = canonicalLines(pivot.removed);
    if (later.length === 0 || removed.length === 0) continue;
    const readded = multiset(later.flatMap((e) => canonicalLines(e.added)));
    const shared = intersect(multiset(removed), readded);
    const rate = shared.length / removed.length;
    if (rate > best.rate) best = { rate, flippedLines: shared, file: pivot.file, pivotSeq: pivot.seq };
  }
  return best;
}

/** Evaluate reciprocity per file over the last `window` edits of each file. */
export function detectOscillation(edits: readonly EditRound[], config: Pick<SentinelConfig, 'oscillationWindow' | 'reciprocityThreshold'>): OscillationReport {
  const byFile = new Map<string, EditRound[]>();
  for (const e of edits) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }
  let best: ReciprocityResult = { rate: 0, flippedLines: [] };
  for (const list of byFile.values()) {
    const res = computeReciprocity(list.slice(-config.oscillationWindow));
    if (res.rate > best.rate) best = res;
  }
  return { ...best, oscillating: best.rate > config.reciprocityThreshold };
}

/* ================================================================== */
/* 2. Error fingerprinting                                              */
/* ================================================================== */

const NOISE_FRAME = [
  /node_modules[\\/]/,
  /\bnode:internal\b/,
  /\binternal\/(?:modules|process|timers|main)/,
  /\(native\)|<anonymous>/,
  /[\\/](?:vite|vitest|rollup|webpack|esbuild|jest-[\w-]+|@vitest|@jest|tsx|ts-node|mocha|chai)[\\/](?:dist|lib|build)[\\/]/,
];

export function isNoiseFrame(frame: string): boolean {
  return NOISE_FRAME.some((re) => re.test(frame));
}

export interface ParsedFrame {
  fn?: string;
  file: string;
  line?: number;
  column?: number;
  raw: string;
}

/** Parse a single stack-frame line in V8, Vitest (❯) or Python format. */
export function parseFrame(line: string): ParsedFrame | undefined {
  const trimmed = line.trim();
  // V8: "at fn (file:line:col)" or "at file:line:col"
  let m = /^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(trimmed);
  if (m) return { fn: m[1], file: m[2] ?? '', line: Number(m[3]), column: Number(m[4]), raw: trimmed };
  // Vitest/Jest code-frame pointer: "❯ src/file.ts:12:5" / "› file:12:5"
  m = /^[❯›>]\s+(?:(\S+)\s+)?(\S+?):(\d+):(\d+)$/.exec(trimmed);
  if (m) return { fn: m[1], file: m[2] ?? '', line: Number(m[3]), column: Number(m[4]), raw: trimmed };
  // Python: File "x.py", line 3, in fn
  m = /^File "(.+?)", line (\d+)(?:, in (.+))?$/.exec(trimmed);
  if (m) return { fn: m[3], file: m[1] ?? '', line: Number(m[2]), raw: trimmed };
  return undefined;
}

const ERROR_HEADLINE =
  /(?:^|\s)((?:[A-Z][A-Za-z0-9]*)?(?:Error|Exception)|AssertionError|Panic|panic)(?:\s*\[[^\]]*\])?:\s*(.*)$/;
const TSC_ERROR = /error\s+(TS\d+):\s*(.*)$/;

export interface ExtractedError {
  errorName: string;
  message: string;
  frames: ParsedFrame[];
  failingTest?: string;
}

/** Pull the first error headline, its frames and the failing test name out of a log. */
export function extractError(log: string): ExtractedError {
  const lines = stripAnsi(log).split('\n');
  let errorName = '';
  let message = '';
  let headlineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*at\s/.test(line)) continue;
    const tsc = TSC_ERROR.exec(line);
    if (tsc) {
      errorName = tsc[1] ?? 'TSError';
      message = tsc[2] ?? '';
      headlineIdx = i;
      break;
    }
    const m = ERROR_HEADLINE.exec(line);
    if (m) {
      errorName = m[1] ?? 'Error';
      message = (m[2] ?? '').trim();
      headlineIdx = i;
      break;
    }
  }
  const frames: ParsedFrame[] = [];
  for (let i = Math.max(headlineIdx, 0); i < lines.length; i++) {
    const f = parseFrame(lines[i] ?? '');
    if (f) frames.push(f);
  }
  return { errorName: errorName || 'UnknownError', message, frames, failingTest: findFailingTest(lines) };
}

function findFailingTest(lines: string[]): string | undefined {
  for (const line of lines) {
    // Vitest: " FAIL  tests/a.test.ts > suite > case"
    let m = /^\s*FAIL\s+\S+\s+>\s+(.+?)\s*$/.exec(line);
    if (m) return m[1]?.replace(/\s+\d+ms$/, '');
    // Jest: "● suite › case"
    m = /^\s*●\s+(.+›.+?)\s*$/.exec(line);
    if (m) return m[1];
    // Vitest list reporter: " × suite > case 12ms" / "✗"
    m = /^\s*[×✗✕]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s?ms)?\s*$/.exec(line);
    if (m) return m[1];
    // pytest: "FAILED tests/test_x.py::test_name - ..."
    m = /^FAILED\s+(\S+)/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * SHA-256 fingerprint of a failure that is stable across reruns:
 * `ErrorName + normalized message + normalized project stack + failing test`.
 *
 * Volatile parts — timestamps, absolute paths, line:col positions, memory
 * addresses, UUIDs, durations, ports, temp dirs — are stripped first, and
 * framework/node_modules frames are dropped so tooling upgrades do not
 * change the identity of an error.
 */
export function fingerprintError(log: string, root?: string): ErrorFingerprint {
  const extracted = extractError(log);
  const message = stripPositions(normalizeVolatile(extracted.message, root)).replace(/\s+/g, ' ').trim().slice(0, 300);
  const frames = extracted.frames
    .filter((f) => !isNoiseFrame(f.raw))
    .slice(0, 8)
    .map((f) => `${f.fn ? `${normalizeVolatile(f.fn, root)} ` : ''}${toProjectPath(f.file, root)}`)
    .map((f) => stripPositions(normalizeVolatile(f, root)));
  const failingTest = extracted.failingTest ? normalizeVolatile(extracted.failingTest, root).replace(/\s*<dur>\s*$/, '').trim() : undefined;
  const canonical = [`name=${extracted.errorName}`, `msg=${message}`, `test=${failingTest ?? ''}`, ...frames.map((f) => `frame=${f}`)].join('\n');
  return { hash: sha256(canonical), errorName: extracted.errorName, message, frames, failingTest, canonical };
}

/**
 * Detect unproductive patterns in the most recent fingerprints (oldest first):
 * - `repeat`    A → A → A        (same failure N times in a row)
 * - `ping-pong` A → B → A → B    (alternating between two failures)
 * - `cycle`     A → B → A        (returned to a failure already seen)
 */
export function detectFingerprintPattern(hashes: readonly string[], repeatLimit: number): FingerprintPatternResult {
  const none: FingerprintPatternResult = { pattern: 'none', length: 0, hashes: [] };
  if (hashes.length === 0) return none;
  const last = hashes[hashes.length - 1];
  let run = 0;
  for (let i = hashes.length - 1; i >= 0 && hashes[i] === last; i--) run++;
  if (run >= repeatLimit) return { pattern: 'repeat', length: run, hashes: hashes.slice(-run) };

  const n = hashes.length;
  if (n >= 4) {
    const [a, b, c, d] = hashes.slice(-4);
    if (a === c && b === d && a !== b) return { pattern: 'ping-pong', length: 4, hashes: [a ?? '', b ?? '', c ?? '', d ?? ''] };
  }
  if (n >= 3) {
    const [a, b, c] = hashes.slice(-3);
    if (a === c && a !== b) return { pattern: 'cycle', length: 3, hashes: [a ?? '', b ?? '', c ?? ''] };
  }
  return { pattern: 'none', length: run, hashes: hashes.slice(-run) };
}

/* ================================================================== */
/* 3. Hotspot: same function edited + failing N rounds in a row         */
/* ================================================================== */

export function detectHotspot(edits: readonly EditRound[], runs: readonly RunRecord[], rounds: number): HotspotReport {
  const recent = runs.slice(-rounds);
  if (recent.length < rounds || recent.some((r) => r.exitCode === 0)) return { hot: false, rounds: 0 };

  let common: Set<string> | undefined;
  for (let i = 0; i < recent.length; i++) {
    const run = recent[i];
    if (!run) continue;
    const prevSeq = i === 0 ? (runs[runs.length - rounds - 1]?.seq ?? -Infinity) : (recent[i - 1]?.seq ?? -Infinity);
    const keys = new Set(
      edits.filter((e) => e.seq > prevSeq && e.seq < run.seq).flatMap((e) => (e.symbols.length ? e.symbols : ['<module>']).map((s) => `${e.file}#${s}`)),
    );
    common = common ? new Set([...common].filter((k) => keys.has(k))) : keys;
    if (common.size === 0) return { hot: false, rounds: 0 };
  }
  const key = [...(common ?? [])][0];
  if (!key) return { hot: false, rounds: 0 };
  const [file, symbol] = key.split('#');
  return { hot: true, file, symbol, rounds };
}

/* ================================================================== */
/* 4. Combined risk assessment                                          */
/* ================================================================== */

export function assessRisk(state: SentinelState, config: SentinelConfig): RiskAssessment {
  const reasons: string[] = [];
  const tripReasons: string[] = [];
  const lastRun = state.runs[state.runs.length - 1];
  const lastFailed = !!lastRun && lastRun.exitCode !== 0;

  const oscillation = detectOscillation(state.edits, config);
  if (oscillation.oscillating) {
    const msg = `Code flip-flop in ${oscillation.file}: ${(oscillation.rate * 100).toFixed(0)}% of changed lines were reverted and re-applied (threshold ${(config.reciprocityThreshold * 100).toFixed(0)}%)`;
    reasons.push(msg);
    if (lastFailed) tripReasons.push(msg);
  }

  // Only fingerprints since the last success count toward a loop.
  const sinceGreen: string[] = [];
  for (let i = state.runs.length - 1; i >= 0; i--) {
    const r = state.runs[i];
    if (!r || r.exitCode === 0) break;
    sinceGreen.unshift(r.fingerprint ?? `exit:${r.exitCode}`);
  }
  const fingerprintPattern = detectFingerprintPattern(sinceGreen, config.sameFingerprintLimit);
  if (fingerprintPattern.pattern === 'repeat') {
    const msg = `Same error fingerprint ${fingerprintPattern.length}x in a row (${short(fingerprintPattern.hashes[0])}) — the fix attempts are not changing the failure`;
    reasons.push(msg);
    tripReasons.push(msg);
  } else if (fingerprintPattern.pattern === 'ping-pong') {
    const msg = `Errors alternate A→B→A→B (${fingerprintPattern.hashes.slice(0, 2).map(short).join(' ↔ ')}) — fixing one breaks the other`;
    reasons.push(msg);
    tripReasons.push(msg);
  } else if (fingerprintPattern.pattern === 'cycle') {
    const msg = `Error cycle A→B→A detected (${short(fingerprintPattern.hashes[0])}) — back to a failure already seen`;
    reasons.push(msg);
    tripReasons.push(msg);
  } else if (fingerprintPattern.length >= 2) {
    reasons.push(`Same error fingerprint ${fingerprintPattern.length}x in a row`);
  }

  const hotspot = detectHotspot(state.edits, state.runs, config.hotspotRounds);
  if (hotspot.hot) {
    // High risk (warn on every guarded edit) rather than a trip: the failure-streak
    // limit decides when to stop, the hotspot tells the agent to zoom out first.
    reasons.push(`Hotspot: ${hotspot.file}#${hotspot.symbol} edited in ${hotspot.rounds} consecutive failing rounds — step back and check callers/contracts before patching it again`);
  }

  if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
    tripReasons.push(`${state.consecutiveFailures} consecutive failing runs (limit ${config.maxConsecutiveFailures})`);
    reasons.push(tripReasons[tripReasons.length - 1] ?? '');
  } else if (state.consecutiveFailures >= Math.max(2, config.maxConsecutiveFailures - 1)) {
    reasons.push(`${state.consecutiveFailures} consecutive failing runs — one more trips the breaker`);
  }

  let level: RiskLevel = 'low';
  if (tripReasons.length > 0) level = 'critical';
  else if (hotspot.hot || oscillation.oscillating) level = 'high';
  else if (reasons.length > 0 || state.consecutiveFailures >= 2) level = 'medium';

  return { level, reasons, tripReasons, oscillation, fingerprintPattern, hotspot, consecutiveFailures: state.consecutiveFailures };
}

function short(hash: string | undefined): string {
  return (hash ?? '').replace(/^exit:/, 'exit ').slice(0, 10);
}
