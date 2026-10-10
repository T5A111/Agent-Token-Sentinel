import { normalizeCodeLine } from './normalize.js';

export interface LineDiff {
  /** Raw added lines (not normalized). */
  added: string[];
  removed: string[];
  /** 1-based line numbers in the *new* file that changed (deletions map to the line now at that position). */
  changedLines: number[];
}

export interface FileDiff extends LineDiff {
  file: string;
}

const MAX_LCS_CELLS = 4_000_000;

/**
 * Line diff between two versions of a file. Common prefix/suffix are trimmed,
 * then an LCS table is used on the middle. Very large middles degrade to
 * "everything replaced", which is still correct for reciprocity counting.
 */
export function diffLines(before: string, after: string): LineDiff {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const result: LineDiff = { added: [], removed: [], changedLines: [] };

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    result.removed.push(...midA);
    result.added.push(...midB);
    for (let i = 0; i < Math.max(midB.length, 1); i++) result.changedLines.push(start + i + 1);
    return result;
  }

  const n = midA.length;
  const m = midB.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        midA[i] === midB[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      i++;
      j++;
    } else if (j < m && (i >= n || (table[i * width + j + 1] ?? 0) >= (table[(i + 1) * width + j] ?? 0))) {
      result.added.push(midB[j] ?? '');
      result.changedLines.push(start + j + 1);
      j++;
    } else {
      result.removed.push(midA[i] ?? '');
      result.changedLines.push(start + j + 1);
      i++;
    }
  }
  result.changedLines = [...new Set(result.changedLines)].sort((x, y) => x - y);
  return result;
}

/** Parse `git diff` / unified diff output into per-file line changes. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let newLine = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim().replace(/^b\//, '');
      current = { file: path === '/dev/null' ? '' : path, added: [], removed: [], changedLines: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith('--- ')) {
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) {
      current.added.push(line.slice(1));
      current.changedLines.push(newLine);
      newLine++;
    } else if (line.startsWith('-')) {
      current.removed.push(line.slice(1));
      current.changedLines.push(newLine);
    } else if (line.startsWith(' ')) {
      newLine++;
    }
  }
  for (const f of files) f.changedLines = [...new Set(f.changedLines)];
  return files.filter((f) => f.file !== '');
}

/** Normalize and drop blank lines: the canonical multiset used for reciprocity. */
export function canonicalLines(lines: readonly string[]): string[] {
  return lines.map(normalizeCodeLine).filter((l) => l.length > 0);
}
