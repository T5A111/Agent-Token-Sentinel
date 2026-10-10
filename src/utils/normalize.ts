import { isAbsolute, relative, sep } from 'node:path';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;

/** Remove ANSI color/cursor control sequences and carriage-return redraws. */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .split('\n')
    .map((line) => {
      // Progress bars redraw with \r: keep only the final frame of the line.
      const idx = line.lastIndexOf('\r');
      return idx >= 0 && idx < line.length - 1 ? line.slice(idx + 1) : line.replace(/\r$/, '');
    })
    .join('\n');
}

/** Canonical form of a source line for diff comparison (whitespace-insensitive). */
export function normalizeCodeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

export function toPosix(path: string): string {
  return path.split(sep).join('/').replace(/\\/g, '/');
}

/** Make a path project-relative (POSIX). Paths outside the root keep only their tail. */
export function toProjectPath(path: string, root?: string): string {
  let p = path.replace(/^file:\/\//, '');
  if (root && isAbsolute(p)) {
    const rel = relative(root, p);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel);
  }
  p = toPosix(p);
  if (/^(?:[A-Za-z]:)?\//.test(p)) {
    // Absolute path outside the project: drop machine-specific prefix.
    const nm = p.lastIndexOf('/node_modules/');
    if (nm >= 0) return p.slice(nm + 1);
    const parts = p.split('/').filter(Boolean);
    return `<abs>/${parts.slice(-2).join('/')}`;
  }
  return p.replace(/^\.\//, '');
}

/**
 * Strip volatile noise from error text so that the "same" failure produces
 * identical output across runs, machines and timestamps.
 */
export function normalizeVolatile(text: string, root?: string): string {
  let out = stripAnsi(text);
  if (root) {
    const posixRoot = toPosix(root).replace(/\/$/, '');
    out = out.split(posixRoot + '/').join('').split(root + sep).join('');
  }
  return out
    // ISO-8601 / RFC timestamps and clock times
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<ts>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\s?(?:AM|PM)?\b/gi, '<time>')
    // Epoch millis / seconds that look like timestamps
    .replace(/\b1[5-9]\d{8}(?:\d{3})?\b/g, '<epoch>')
    // UUIDs
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    // Memory addresses / long hex ids
    .replace(/\b0x[0-9a-f]{4,}\b/gi, '<addr>')
    .replace(/\b[0-9a-f]{24,}\b/gi, '<hex>')
    // Temp directories
    .replace(/(?:\/tmp|\/var\/folders|\/private\/var|[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp)[^\s:'")]*/g, '<tmp>')
    // Durations and ports
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|µs|us|ns|m)\b/g, '<dur>')
    .replace(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}\b/g, '$1:<port>')
    // Process ids
    .replace(/\bpid[:= ]\s*\d+\b/gi, 'pid=<pid>');
}

/** Remove `:line:col` / `(line,col)` positions — they shift whenever code above moves. */
export function stripPositions(text: string): string {
  return text
    .replace(/:\d+:\d+\b/g, '')
    .replace(/:\d+\b(?=\)|$|\s)/g, '')
    .replace(/\(\d+,\d+\)/g, '');
}
