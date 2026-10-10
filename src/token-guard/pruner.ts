/**
 * AST Pruner: read only what matters from a large file.
 *
 * Keeps the requested symbols (functions, classes, `Class.method`, consts),
 * plus the imports and same-file type definitions they reference
 * (transitively for types). Everything else is folded into
 * `// ... [omitted N lines of unrelated logic]` markers, and every kept line
 * carries its original line number so edits can be targeted precisely
 * instead of rewriting the whole file.
 */
import ts from 'typescript';
import { isTsLike, listSymbolsHeuristic, nodeLines, parseTs, statementBindings } from '../utils/ast.js';
import { estimateTokens } from '../utils/tokens.js';

export interface PruneOptions {
  /** Symbol names to keep: `fn`, `Class`, `Class.method`, `CONST`. */
  targets: string[];
  /** Prefix kept lines with original line numbers (default true). */
  lineNumbers?: boolean;
  /** Keep same-file types/interfaces/enums referenced by the targets (default true). */
  includeTypes?: boolean;
}

export interface PruneResult {
  text: string;
  keptSymbols: string[];
  missingTargets: string[];
  /** Types/imports kept because a target references them. */
  dependencies: string[];
  omittedLines: number;
  totalLines: number;
  originalTokens: number;
  prunedTokens: number;
  strategy: 'typescript-ast' | 'heuristic';
}

type Range = { start: number; end: number }; // 1-based inclusive

export function pruneSource(source: string, fileName: string, options: PruneOptions): PruneResult {
  const lines = source.split('\n');
  const { ranges, kept, missing, deps, strategy } = isTsLike(fileName)
    ? collectTsRanges(source, fileName, options)
    : collectHeuristicRanges(source, options);
  const text = render(lines, ranges, options.lineNumbers ?? true, commentToken(fileName));
  const keptCount = new Set(ranges.flatMap((r) => Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start + i))).size;
  return {
    text,
    keptSymbols: kept,
    missingTargets: missing,
    dependencies: deps,
    omittedLines: lines.length - keptCount,
    totalLines: lines.length,
    originalTokens: estimateTokens(source),
    prunedTokens: estimateTokens(text),
    strategy,
  };
}

/* ------------------------------------------------------------------ */
/* TypeScript / JavaScript                                              */
/* ------------------------------------------------------------------ */

function collectTsRanges(source: string, fileName: string, options: PruneOptions) {
  const sf = parseTs(source, fileName);
  const ranges: Range[] = [];
  const kept: string[] = [];
  const deps: string[] = [];
  const found = new Set<string>();
  const referenced = new Set<string>();

  const topLevel = sf.statements.map((stmt) => ({ stmt, ...statementBindings(stmt, sf) }));

  for (const target of options.targets) {
    const [head, member] = target.split('.', 2) as [string, string | undefined];
    const entry = topLevel.find((t) => t.names.includes(head));
    if (!entry) continue;

    if (member && ts.isClassDeclaration(entry.stmt)) {
      const cls = entry.stmt;
      const m = cls.members.find((mem) => memberName(mem, sf) === member);
      if (!m) continue;
      const clsLines = nodeLines(sf, cls);
      const memLines = nodeLines(sf, m);
      // Class header (up to the opening brace) + the member + closing brace.
      const openBraceLine = sf.getLineAndCharacterOfPosition(cls.members.pos).line + 1;
      ranges.push(
        { start: clsLines.startLine, end: openBraceLine },
        { start: memLines.startLine, end: memLines.endLine },
        { start: clsLines.endLine, end: clsLines.endLine },
      );
      collectIdentifiers(m, referenced);
      kept.push(target);
      found.add(target);
      continue;
    }

    const { startLine, endLine } = nodeLines(sf, entry.stmt);
    ranges.push({ start: startLine, end: endLine });
    collectIdentifiers(entry.stmt, referenced);
    kept.push(target);
    found.add(target);
  }

  if (options.includeTypes ?? true) {
    // Transitively include same-file type-level declarations.
    const included = new Set<ts.Statement>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of topLevel) {
        if (included.has(t.stmt)) continue;
        const isTypeLike = t.kind === 'interface' || t.kind === 'type' || t.kind === 'enum';
        if (!isTypeLike || !t.names.some((n) => referenced.has(n))) continue;
        if (kept.some((k) => t.names.includes(k))) continue;
        included.add(t.stmt);
        const { startLine, endLine } = nodeLines(sf, t.stmt);
        ranges.push({ start: startLine, end: endLine });
        collectIdentifiers(t.stmt, referenced);
        deps.push(...t.names);
        changed = true;
      }
    }
  }

  // Imports binding any referenced name.
  for (const t of topLevel) {
    if (t.kind !== 'import' || !t.names.some((n) => referenced.has(n))) continue;
    const { startLine, endLine } = nodeLines(sf, t.stmt);
    ranges.push({ start: startLine, end: endLine });
    deps.push(...t.names.filter((n) => referenced.has(n)).map((n) => `import ${n}`));
  }

  return { ranges, kept, missing: options.targets.filter((t) => !found.has(t)), deps, strategy: 'typescript-ast' as const };
}

function memberName(m: ts.ClassElement, sf: ts.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(m)) return 'constructor';
  if (!m.name) return undefined;
  return ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : m.name.getText(sf);
}

function collectIdentifiers(node: ts.Node, out: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/* ------------------------------------------------------------------ */
/* Heuristic (other languages)                                          */
/* ------------------------------------------------------------------ */

const IMPORT_LINE = /^\s*(?:import\b|from\s+\S+\s+import\b|use\s+[\w:]+|#include\b|package\s+\w|require\b|using\s+[\w.]+;)/;

function collectHeuristicRanges(source: string, options: PruneOptions) {
  const symbols = listSymbolsHeuristic(source);
  const ranges: Range[] = [];
  const kept: string[] = [];
  const found = new Set<string>();
  for (const target of options.targets) {
    const name = target.split('.').pop() ?? target;
    const sym = symbols.find((s) => s.name === name);
    if (!sym) continue;
    ranges.push({ start: sym.startLine, end: sym.endLine });
    kept.push(target);
    found.add(target);
  }
  source.split('\n').forEach((line, i) => {
    if (IMPORT_LINE.test(line)) ranges.push({ start: i + 1, end: i + 1 });
  });
  return { ranges, kept, missing: options.targets.filter((t) => !found.has(t)), deps: [] as string[], strategy: 'heuristic' as const };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function commentToken(fileName: string): string {
  return /\.(?:py|rb|sh|bash|zsh|ya?ml|toml|r|pl|ex|exs|nim|cr)$/i.test(fileName) ? '#' : '//';
}

function render(lines: string[], ranges: Range[], lineNumbers: boolean, comment: string): string {
  const keep = new Array<boolean>(lines.length + 1).fill(false);
  for (const r of ranges) for (let i = Math.max(1, r.start); i <= Math.min(lines.length, r.end); i++) keep[i] = true;
  const width = String(lines.length).length;
  const out: string[] = [];
  let i = 1;
  while (i <= lines.length) {
    if (keep[i]) {
      const text = lines[i - 1] ?? '';
      out.push(lineNumbers ? `${String(i).padStart(width)} | ${text}` : text);
      i++;
      continue;
    }
    const start = i;
    while (i <= lines.length && !keep[i]) i++;
    const folded = lines.slice(start - 1, i - 1);
    const nonBlank = folded.filter((l) => l.trim() !== '');
    if (nonBlank.length === 0) {
      if (out.length && i <= lines.length) out.push(lineNumbers ? `${' '.repeat(width)} |` : '');
      continue;
    }
    const indent = /^\s*/.exec(nonBlank[0] ?? '')?.[0] ?? '';
    const marker = `${indent}${comment} ... [omitted ${folded.length} lines of unrelated logic]`;
    out.push(lineNumbers ? `${' '.repeat(width)} | ${marker}` : marker);
  }
  return out.join('\n');
}
