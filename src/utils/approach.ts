import type { EditRound } from '../types.js';
import { normalizeCodeLine } from './normalize.js';

const APPROACHES: Array<{ label: string; test: RegExp }> = [
  { label: 'null-checks', test: /\?\.|\?\?|!==?\s*(?:null|undefined)|===?\s*(?:null|undefined)|if\s*\(\s*!\s*[\w.$]+\s*\)|typeof\s+[\w.$]+\s*[!=]==?\s*['"]undefined['"]/ },
  { label: 'try/catch wrapping', test: /\btry\s*\{|\bcatch\s*\(|\.catch\(/ },
  { label: 'type assertions/casts', test: /\bas\s+(?:any|unknown|[A-Z]\w*)\b|<any>|!\.|@ts-(?:ignore|expect-error)|eslint-disable/ },
  { label: 'async/await changes', test: /\bawait\b|\basync\b|\.then\(|Promise\./ },
  { label: 'import/dependency changes', test: /^\s*(?:import|export\s+\*|const\s+\w+\s*=\s*require\()/ },
  { label: 'default values', test: /\|\|\s*(?:\[\]|\{\}|''|""|0|false)|=\s*(?:\[\]|\{\})\s*[;,)]/ },
  { label: 'early returns/guards', test: /^\s*if\s*\(.+\)\s*return\b|^\s*return\s*;/ },
  { label: 'test expectation edits', test: /\bexpect\(|\bassert\.|toBe\(|toEqual\(/ },
  { label: 'logging/debug output', test: /console\.(?:log|debug|error)|\bprint\(|debugger/ },
];

/** Best-effort label for "what kind of fix was attempted" in a set of edits. */
export function classifyApproach(edits: readonly EditRound[]): string {
  const counts = new Map<string, number>();
  for (const e of edits) {
    for (const line of [...e.added, ...e.removed]) {
      const norm = normalizeCodeLine(line);
      for (const a of APPROACHES) if (a.test.test(norm)) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  return ranked.slice(0, 2).join(' + ') || 'code edits';
}

/** `file:line` or `file#symbol` of the most-edited location. */
export function primaryLocation(edits: readonly EditRound[]): string | undefined {
  const counts = new Map<string, { n: number; label: string }>();
  for (const e of edits) {
    const sym = e.symbols.find((s) => s !== '<module>');
    const key = `${e.file}#${sym ?? ''}`;
    const label = sym ? `${e.file}#${sym}` : `${e.file}${e.line ? `:${e.line}` : ''}`;
    const prev = counts.get(key);
    counts.set(key, { n: (prev?.n ?? 0) + 1, label: prev?.label ?? label });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.label;
}
