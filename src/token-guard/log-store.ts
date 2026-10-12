/**
 * Raw-log expansion: the counterpart of the distiller. Distillation shows the
 * agent a ~150-token briefing; when that is not enough, the agent pulls exactly
 * the part of the raw log it needs instead of re-running the command or
 * reading thousands of lines.
 */
import { failingTestFromLine } from '../circuit-breaker/detector.js';
import { estimateTokens } from '../utils/tokens.js';

export interface ExpandLogOptions {
  /** Run id (`run-12` or `12`); defaults to the latest stored log. */
  run?: string;
  /** 1-based index of the failure block to return (as listed in the distilled output). */
  failure?: number;
  /** Case-insensitive pattern; matching lines are returned with `context` lines around them. */
  grep?: string;
  context?: number;
  /** 1-based inclusive line range. */
  from?: number;
  to?: number;
  /** Cap on the returned slice (default 2000 tokens). */
  maxTokens?: number;
}

export interface ExpandLogResult {
  text: string;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
}

const ERROR_LINE = /(?:^|\s)(?:[A-Z][A-Za-z0-9]*)?(?:Error|Exception)(?:\s*\[[^\]]*\])?:|error\s+TS\d+:|^\s*FAIL\b|^\s*●\s|^\s*[×✗✕]\s/;

export function sliceLog(raw: string, options: ExpandLogOptions & { header?: string } = {}): ExpandLogResult {
  const lines = raw.split('\n');
  const maxTokens = options.maxTokens ?? 2000;
  const width = String(lines.length).length;
  const fmt = (i: number) => `${String(i + 1).padStart(width)}| ${lines[i] ?? ''}`;
  let picked: number[] = [];
  let mode = 'full';

  if (options.failure !== undefined) {
    mode = `failure ${options.failure}`;
    const starts = failureStarts(lines);
    const start = starts[options.failure - 1];
    if (start === undefined) {
      return done([`(no failure #${options.failure}; this log has ${starts.length} failure block(s))`], false);
    }
    const end = Math.min(starts[options.failure] ?? lines.length, start + 150);
    picked = range(start, end);
  } else if (options.grep) {
    mode = `grep /${options.grep}/`;
    let re: RegExp;
    try {
      re = new RegExp(options.grep, 'i');
    } catch {
      re = new RegExp(options.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const ctx = Math.max(0, Math.min(options.context ?? 2, 20));
    const set = new Set<number>();
    lines.forEach((l, i) => {
      if (re.test(l)) for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) set.add(j);
    });
    picked = [...set].sort((a, b) => a - b);
    if (!picked.length) return done([`(no line matches /${options.grep}/)`], false);
  } else if (options.from !== undefined || options.to !== undefined) {
    const from = Math.max(1, options.from ?? 1);
    const to = Math.min(lines.length, options.to ?? lines.length);
    mode = `lines ${from}-${to}`;
    picked = range(from - 1, to);
  } else {
    picked = range(0, lines.length);
  }

  // Render with gap markers, stop at the token cap.
  const out: string[] = [];
  let prev = -2;
  let truncated = false;
  let returned = 0;
  for (const i of picked) {
    const line = (i !== prev + 1 && prev >= 0 ? '   ⋮\n' : '') + fmt(i);
    if (estimateTokens(out.join('\n')) + estimateTokens(line) > maxTokens) {
      truncated = true;
      out.push(`… truncated at ~${maxTokens} tokens (line ${i + 1} of ${lines.length}). Narrow with from/to, grep or failure.`);
      break;
    }
    out.push(line);
    returned++;
    prev = i;
  }
  return done(out, truncated);

  function done(body: string[], truncatedFlag: boolean): ExpandLogResult {
    const head = `${options.header ? `${options.header} · ` : ''}${lines.length} lines · ${mode}`;
    return { text: `${head}\n${body.join('\n')}`, totalLines: lines.length, returnedLines: returned, truncated: truncatedFlag };
  }
}

/** Line indices where a new failure block begins (failing-test marker, or an error headline outside one). */
function failureStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let inBlockSinceTest = false;
  lines.forEach((line, i) => {
    if (/^\s*at\s/.test(line)) return;
    if (failingTestFromLine(line)) {
      starts.push(i);
      inBlockSinceTest = true;
      return;
    }
    if (ERROR_LINE.test(line)) {
      if (!inBlockSinceTest) starts.push(i);
      inBlockSinceTest = false;
    }
  });
  return starts;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
}
