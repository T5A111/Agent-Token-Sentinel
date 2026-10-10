import ts from 'typescript';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'import'
  | 'export'
  | 'other';

export interface SymbolInfo {
  /** Qualified name, e.g. `validateToken` or `AuthService.login`. */
  name: string;
  kind: SymbolKind;
  /** 1-based inclusive line range, including leading JSDoc. */
  startLine: number;
  endLine: number;
  /** Nesting depth: 0 = top-level statement. */
  depth: number;
  /** Names bound by this declaration (imports can bind several). */
  bindings: string[];
}

const TS_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;

export function isTsLike(fileName: string): boolean {
  return TS_EXTENSIONS.test(fileName);
}

export function parseTs(source: string, fileName: string): ts.SourceFile {
  const kind = /\.tsx$/i.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(fileName)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/i.test(fileName)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

export function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Range of a node in 1-based lines, including its JSDoc comment. */
export function nodeLines(sf: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  return { startLine: lineOf(sf, node.getStart(sf, true)), endLine: lineOf(sf, node.getEnd()) };
}

function nameText(name: ts.Node | undefined, sf: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
}

/** Names bound by a top-level statement. */
export function statementBindings(stmt: ts.Statement, sf: ts.SourceFile): { kind: SymbolKind; names: string[] } {
  if (ts.isFunctionDeclaration(stmt)) return { kind: 'function', names: stmt.name ? [stmt.name.text] : ['default'] };
  if (ts.isClassDeclaration(stmt)) return { kind: 'class', names: stmt.name ? [stmt.name.text] : ['default'] };
  if (ts.isInterfaceDeclaration(stmt)) return { kind: 'interface', names: [stmt.name.text] };
  if (ts.isTypeAliasDeclaration(stmt)) return { kind: 'type', names: [stmt.name.text] };
  if (ts.isEnumDeclaration(stmt)) return { kind: 'enum', names: [stmt.name.text] };
  if (ts.isModuleDeclaration(stmt)) return { kind: 'other', names: [stmt.name.getText(sf)] };
  if (ts.isVariableStatement(stmt)) {
    const names: string[] = [];
    for (const decl of stmt.declarationList.declarations) collectBindingNames(decl.name, names);
    return { kind: 'variable', names };
  }
  if (ts.isImportDeclaration(stmt)) {
    const names: string[] = [];
    const clause = stmt.importClause;
    if (clause?.name) names.push(clause.name.text);
    const nb = clause?.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) names.push(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.push(el.name.text);
    return { kind: 'import', names };
  }
  if (ts.isImportEqualsDeclaration(stmt)) return { kind: 'import', names: [stmt.name.text] };
  if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) return { kind: 'export', names: [] };
  return { kind: 'other', names: [] };
}

function collectBindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) collectBindingNames(el.name, out);
}

function isFunctionLikeInitializer(node: ts.Node | undefined): boolean {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/**
 * Enumerate addressable symbols: top-level declarations, class members and
 * nested named functions / function-valued consts.
 */
export function listSymbols(source: string, fileName: string): SymbolInfo[] {
  if (!isTsLike(fileName)) return listSymbolsHeuristic(source);
  const sf = parseTs(source, fileName);
  const out: SymbolInfo[] = [];

  const visit = (node: ts.Node, container: string | undefined, depth: number): void => {
    let name: string | undefined;
    let kind: SymbolKind | undefined;
    if (ts.isFunctionDeclaration(node)) {
      name = node.name?.text ?? 'default';
      kind = 'function';
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      name = node.name?.text ?? 'default';
      kind = 'class';
    } else if (
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      (ts.isPropertyDeclaration(node) && isFunctionLikeInitializer(node.initializer))
    ) {
      name = ts.isConstructorDeclaration(node) ? 'constructor' : nameText(node.name, sf);
      kind = 'method';
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionLikeInitializer(node.initializer)) {
      name = node.name.text;
      kind = 'function';
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name.text;
      kind = 'interface';
    } else if (ts.isTypeAliasDeclaration(node)) {
      name = node.name.text;
      kind = 'type';
    } else if (ts.isEnumDeclaration(node)) {
      name = node.name.text;
      kind = 'enum';
    }

    if (name && kind) {
      // Report variable-declared functions with their whole statement range.
      const rangeNode = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node;
      const qualified = container ? `${container}.${name}` : name;
      out.push({ name: qualified, kind, ...nodeLines(sf, rangeNode), depth, bindings: [name] });
      const nextContainer = kind === 'class' || kind === 'method' || kind === 'function' ? qualified : container;
      ts.forEachChild(node, (child) => visit(child, nextContainer, depth + 1));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, container, depth));
  };
  for (const stmt of sf.statements) visit(stmt, undefined, 0);
  return out;
}

/**
 * For each changed line, the innermost function-like symbol containing it.
 * Falls back to the innermost symbol of any kind, then `<module>`.
 */
export function findEnclosingSymbols(source: string, fileName: string, lines: readonly number[]): string[] {
  if (lines.length === 0) return [];
  let symbols: SymbolInfo[];
  try {
    symbols = listSymbols(source, fileName);
  } catch {
    return ['<module>'];
  }
  const found = new Set<string>();
  for (const line of lines) {
    const containing = symbols.filter((s) => s.startLine <= line && line <= s.endLine);
    const fnLike = containing.filter((s) => s.kind === 'function' || s.kind === 'method');
    const pick = (fnLike.length ? fnLike : containing).sort((a, b) => b.depth - a.depth || a.endLine - a.startLine - (b.endLine - b.startLine))[0];
    found.add(pick?.name ?? '<module>');
  }
  return [...found];
}

/* ------------------------------------------------------------------ */
/* Heuristic fallback for non-TS languages (Python, Go, Rust, Java...) */
/* ------------------------------------------------------------------ */

const DEF_PATTERN =
  /^(\s*)(?:export\s+|pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+|final\s+)*(?:def|function|fn|func|class|struct|impl|interface|trait|enum)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/;

export function listSymbolsHeuristic(source: string): SymbolInfo[] {
  const lines = source.split('\n');
  const out: SymbolInfo[] = [];
  lines.forEach((line, idx) => {
    const m = DEF_PATTERN.exec(line);
    if (!m) return;
    const indent = m[1]?.length ?? 0;
    const name = m[2] ?? 'anonymous';
    const endLine = findBlockEnd(lines, idx, indent);
    const kind: SymbolKind = /\b(class|struct|impl|interface|trait|enum)\b/.test(line) ? 'class' : 'function';
    out.push({ name, kind, startLine: idx + 1, endLine, depth: Math.floor(indent / 2), bindings: [name] });
  });
  return out;
}

/** Block end via brace balance, or via indentation for brace-less languages. */
function findBlockEnd(lines: string[], start: number, indent: number): number {
  let depth = 0;
  let sawBrace = false;
  for (let i = start; i < lines.length; i++) {
    const text = stripStringsAndComments(lines[i] ?? '');
    for (const ch of text) {
      if (ch === '{') {
        depth++;
        sawBrace = true;
      } else if (ch === '}') depth--;
    }
    if (sawBrace && depth <= 0) return i + 1;
    if (!sawBrace && i > start && /:\s*$/.test(lines[start] ?? '')) {
      // Python-style: block ends before the next non-blank line at <= indent.
      const next = lines[i] ?? '';
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent) return i;
    }
  }
  return lines.length;
}

function stripStringsAndComments(line: string): string {
  return line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')
    .replace(/\/\/.*$/, '')
    .replace(/#.*$/, '');
}
