/**
 * Log Distiller: turns thousands of tokens of compiler/test-runner output
 * into a ~150-token briefing an agent can act on.
 *
 * Keeps: the first error headline (+ a continuation line), the failing test
 * name, assertion expected/received, the first *project* call site with
 * ±N lines of source, a one-line entry for every *other* failing test, and a
 * de-duplicated list of further tsc errors.
 * Drops: ANSI codes, progress redraws, node_modules / node:internal /
 * bundler & test-runner internals, repeated lines and summary chatter.
 *
 * The budget is dynamic: it grows with the number of distinct failures and
 * with `escalation` (how many times the same failure has already been seen),
 * because a model that keeps hitting the same error needs more context, not
 * less. Nothing is lost: the raw log stays retrievable via `logRef`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { collectFailures, extractError, isNoiseFrame, parseFrame, type FailureSummary, type ParsedFrame } from '../circuit-breaker/detector.js';
import { stripAnsi, toProjectPath } from '../utils/normalize.js';
import { estimateTokens } from '../utils/tokens.js';

export interface DistillOptions {
  /** Project root: used to relativize paths and read call-site source. */
  root?: string;
  tokenBudget?: number;
  contextLines?: number;
  /** Read the call-site file from disk for context (default true). */
  readSource?: boolean;
  /** Extra tokens granted per additional distinct failure (default 30). */
  perFailureTokens?: number;
  /** Hard ceiling for the dynamic budget (default 4 × tokenBudget). */
  maxTokenBudget?: number;
  /**
   * 0 = first time this failure is seen. Each repeat widens the budget by 50%
   * and the source context by 2 lines: being stuck calls for more evidence.
   */
  escalation?: number;
  /** How the agent can fetch the full log, e.g. `run-12`; printed in the footer. */
  logRef?: string;
}

export interface CallSite {
  file: string;
  line: number;
  column?: number;
  fn?: string;
  snippet: string[];
}

export interface DistillResult {
  text: string;
  errorName?: string;
  message?: string;
  failingTest?: string;
  callSite?: CallSite;
  originalTokens: number;
  distilledTokens: number;
  /** 1 - distilled/original. */
  reduction: number;
  originalLines: number;
  droppedNoiseFrames: number;
  /** Every distinct failure found (the first one is shown in detail). */
  failures: FailureSummary[];
  /** Budget actually applied after scaling for failures and escalation. */
  effectiveBudget: number;
}

const TSC_LINE = /^(.+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*[:-]\s*error\s+(TS\d+):\s*(.*)$/;
const CODE_FRAME = /^\s*[>❯]?\s*(\d+)\s*\|\s?(.*)$/;
const NOISE_LINE = [
  /^\s*$/,
  /^\s*[-=─━_]{3,}\s*$/,
  /^\s*(?:RUN|DEV)\s+v?\d/,
  /^\s*(?:Test Files|Tests|Snapshots|Start at|Duration|Time|Ran all test suites)\b/,
  /^\s*⎯+/,
  /^\s*(?:npm|pnpm|yarn)\s+(?:ERR!|error|WARN)\s+(?:code|errno|path|syscall|A complete log|Lifecycle|command|signal|Failed at)/i,
  /^\s*ELIFECYCLE|^\s*error Command failed with exit code/,
  /^\s*\[vite\]\s+(?:hmr|page reload|connected)/i,
];

export function distillLog(raw: string, options: DistillOptions = {}): DistillResult {
  const baseBudget = options.tokenBudget ?? 150;
  const escalation = Math.max(0, Math.min(options.escalation ?? 0, 4));
  const root = options.root;
  const clean = stripAnsi(raw);
  const lines = dedupeConsecutive(clean.split('\n'));
  const originalTokens = estimateTokens(raw);
  const failures = collectFailures(clean);
  const contextLines = Math.min((options.contextLines ?? 3) + 2 * escalation, 10);
  const budget = Math.min(
    Math.round((baseBudget + (options.perFailureTokens ?? 30) * Math.min(Math.max(failures.length - 1, 0), 10)) * (1 + 0.5 * escalation)),
    options.maxTokenBudget ?? baseBudget * 4,
  );

  const extracted = extractError(clean);
  const hasHeadline = extracted.errorName !== 'UnknownError';

  // Frames: split project vs noise.
  const allFrames: ParsedFrame[] = [];
  for (const line of lines) {
    const f = parseFrame(line);
    if (f) allFrames.push(f);
  }
  const projectFrames = allFrames.filter((f) => !isNoiseFrame(f.raw) && !isNoiseFrame(f.file));
  const droppedNoiseFrames = allFrames.length - projectFrames.length;

  // tsc diagnostics (often many) — group, dedupe.
  const tscErrors: Array<{ file: string; line: number; column: number; code: string; message: string }> = [];
  for (const line of lines) {
    const m = TSC_LINE.exec(line.trim());
    if (m) {
      tscErrors.push({
        file: toProjectPath(m[1] ?? '', root),
        line: Number(m[2] ?? m[4]),
        column: Number(m[3] ?? m[5]),
        code: m[6] ?? 'TS',
        message: (m[7] ?? '').trim(),
      });
    }
  }

  const out: string[] = [];
  let callSite: CallSite | undefined;
  const isTsc = tscErrors.length > 0 && (!hasHeadline || extracted.errorName.startsWith('TS'));

  const first = isTsc
    ? { file: tscErrors[0]?.file ?? '', line: tscErrors[0]?.line, column: tscErrors[0]?.column, fn: undefined }
    : projectFrames[0];
  if (first?.line) {
    // tsc output usually lists many errors: keep its snippet tight (±1) to leave room for the others.
    const ctx = isTsc ? Math.min(contextLines, 1) : contextLines;
    const snippet = readSnippet(first.file, first.line, ctx, root, options.readSource ?? true) ?? codeFrameFromLog(lines, first.line);
    callSite = { file: toProjectPath(first.file, root), line: first.line, column: first.column, fn: first.fn, snippet };
  }
  const callSiteLines = callSite
    ? [`  at ${callSite.fn ? `${callSite.fn} ` : ''}(${callSite.file}:${callSite.line}${callSite.column ? `:${callSite.column}` : ''})`, ...callSite.snippet.map((s) => `    ${s}`)]
    : [];

  if (isTsc) {
    const unique = uniqueBy(tscErrors, (e) => `${e.file}:${e.line}:${e.code}`);
    const [head, ...rest] = unique;
    out.push(`✖ ${head?.code}: ${truncate(head?.message ?? '', 160)}`, ...callSiteLines);
    const shown = rest.slice(0, 2);
    for (const e of shown) out.push(`✖ ${e.file}:${e.line}:${e.column} ${e.code}: ${truncate(e.message, 120)}`);
    if (rest.length > shown.length) out.push(`  … ${rest.length - shown.length} more TypeScript errors`);
  } else {
    if (hasHeadline) {
      const continuation = headlineContinuation(lines, extracted.message);
      out.push(`✖ ${extracted.errorName}: ${truncate(extracted.message, 200)}${continuation ? ` ${truncate(continuation, 100)}` : ''}`);
    }
    if (extracted.failingTest) out.push(`  test: ${truncate(extracted.failingTest, 120)}`);
    out.push(...assertionDetails(lines), ...callSiteLines);
    const others = failures.filter(
      (f) => !(f.test && f.test === extracted.failingTest) && !(f.errorName === extracted.errorName && f.message === extracted.message),
    );
    if (others.length) {
      out.push(`  also failing (${others.length}):`);
      for (const f of others) {
        const err = f.errorName ? `${f.errorName}${f.message ? `: ${truncate(f.message, 90)}` : ''}` : '';
        out.push(`  • ${[f.test ? truncate(f.test, 80) : '', err].filter(Boolean).join(' — ')}`);
      }
    }
  }

  if (out.length === 0) out.push(...genericFallback(lines));

  const footerFor = (body: string) =>
    `[sentinel: ${originalTokens}→${estimateTokens(body)} tokens, ${droppedNoiseFrames} framework frames hidden` +
    (failures.length > 1 ? `, ${failures.length} failures` : '') +
    (escalation ? `, escalated ×${escalation}` : '') +
    (options.logRef ? ` · full log: sentinel_expand_log run=${options.logRef}` : '') +
    ']';
  // Reserve room for the footer: it is what lets the agent get the full log back.
  let text = fitBudget(out.join('\n'), Math.max(budget - estimateTokens(footerFor('')) - 4, 30));
  text = `${text}\n${footerFor(text)}`;

  const distilledTokens = estimateTokens(text);
  return {
    text,
    errorName: hasHeadline ? extracted.errorName : tscErrors[0]?.code,
    message: hasHeadline ? extracted.message : tscErrors[0]?.message,
    failingTest: extracted.failingTest,
    callSite,
    originalTokens,
    distilledTokens,
    reduction: originalTokens > 0 ? 1 - distilledTokens / originalTokens : 0,
    originalLines: raw.split('\n').length,
    droppedNoiseFrames,
    failures,
    effectiveBudget: budget,
  };
}

function dedupeConsecutive(lines: string[]): string[] {
  const out: string[] = [];
  let repeat = 0;
  for (const line of lines) {
    if (out.length && out[out.length - 1] === line) {
      repeat++;
      continue;
    }
    if (repeat > 0) out.push(`  (previous line repeated ${repeat}x)`);
    repeat = 0;
    out.push(line);
  }
  return out;
}

/** A second line of the error message (e.g. Vitest's diff header), if it is not a frame or noise. */
function headlineContinuation(lines: string[], message: string): string | undefined {
  const idx = lines.findIndex((l) => message && l.includes(message));
  const next = idx >= 0 ? lines[idx + 1] : undefined;
  if (!next || parseFrame(next) || NOISE_LINE.some((re) => re.test(next)) || /^\s*(?:[-+]\s|Expected|Received|❯)/.test(next) || CODE_FRAME.test(next)) return undefined;
  return next.trim();
}

function assertionDetails(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(?:Expected|Received)(?:\s*\(.*?\))?:\s*\S/.test(t) || /^[-+]\s(?:Expected|Received)\b/.test(t) || /^expected .+ to (?:be|equal|deeply equal|strictly equal)/.test(t)) {
      out.push(`  ${truncate(t, 100)}`);
      if (out.length >= 2) break;
    }
  }
  return out;
}

function readSnippet(file: string, line: number, context: number, root: string | undefined, enabled: boolean): string[] | undefined {
  if (!enabled) return undefined;
  const path = file.replace(/^file:\/\//, '');
  const full = isAbsolute(path) ? path : root ? join(root, path) : path;
  try {
    if (!existsSync(full) || statSync(full).size > 2_000_000) return undefined;
    const src = readFileSync(full, 'utf8').split('\n');
    if (line < 1 || line > src.length) return undefined;
    return renderSnippet(
      src.slice(Math.max(0, line - 1 - context), Math.min(src.length, line + context)).map((text, i) => ({ n: Math.max(1, line - context) + i, text })),
      line,
    );
  } catch {
    return undefined;
  }
}

/** Vitest/Babel code frames embedded in the log (`  42|  code`) as a fallback when the file is unreadable. */
function codeFrameFromLog(lines: string[], target: number): string[] {
  const rows: Array<{ n: number; text: string }> = [];
  for (const line of lines) {
    const m = CODE_FRAME.exec(line);
    if (m && !/^\s*\|/.test(line)) rows.push({ n: Number(m[1]), text: m[2] ?? '' });
  }
  const near = rows.filter((r) => Math.abs(r.n - target) <= 3);
  return near.length ? renderSnippet(uniqueBy(near, (r) => String(r.n)), target) : [];
}

function renderSnippet(rows: Array<{ n: number; text: string }>, target: number): string[] {
  const width = String(Math.max(...rows.map((r) => r.n))).length;
  return rows.map((r) => `${r.n === target ? '>' : ' '} ${String(r.n).padStart(width)} | ${r.text.replace(/\s+$/, '').slice(0, 120)}`);
}

function genericFallback(lines: string[]): string[] {
  const interesting = lines.filter(
    (l) => /\b(error|failed|failure|fatal|exception|panic|cannot|undefined|not found|denied)\b/i.test(l) && !NOISE_LINE.some((re) => re.test(l)) && !isNoiseFrame(l),
  );
  const picked = uniqueBy(interesting.map((l) => truncate(l.trim(), 140)), (l) => l).slice(0, 5);
  if (picked.length) return picked;
  const tail = lines.filter((l) => !NOISE_LINE.some((re) => re.test(l))).slice(-5);
  return tail.map((l) => truncate(l.trim(), 140));
}

/** Shrink to the budget by dropping lowest-priority lines from the end, then truncating. */
function fitBudget(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  const lines = text.split('\n');
  // Collapse the tail of the "also failing" list (keep the first 3 entries).
  const bullets = () => lines.map((l, i) => (l.startsWith('  • ') ? i : -1)).filter((i) => i >= 0);
  let hidden = 0;
  while (estimateTokens(lines.join('\n')) > budget && bullets().length > 3) {
    lines.splice(bullets().pop() ?? lines.length - 1, 1);
    hidden++;
  }
  if (hidden) lines.splice((bullets().pop() ?? lines.length - 1) + 1, 0, `  • … ${hidden} more (see full log)`);
  // Drop snippet context lines farthest from the target first (keep the '>' line).
  while (estimateTokens(lines.join('\n')) > budget) {
    const idx = findLastIndex(lines, (l) => /^\s{4}\s\s*\d+ \|/.test(l));
    if (idx < 0) break;
    lines.splice(idx, 1);
  }
  while (estimateTokens(lines.join('\n')) > budget && lines.length > 2) lines.splice(lines.length - 1, 1);
  let result = lines.join('\n');
  while (estimateTokens(result) > budget) result = `${result.slice(0, Math.floor(result.length * 0.85))}…`;
  return result;
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i] as T)) return i;
  return -1;
}

function uniqueBy<T>(items: T[], key: (v: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
