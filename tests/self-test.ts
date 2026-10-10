/**
 * agent-token-sentinel — Self-Verification Suite
 *
 * Zero-dependency runner (node:assert). Every test works in its own temp
 * directory; test 5 drives a real git repository.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { assessRisk, computeReciprocity, detectFingerprintPattern, detectOscillation, fingerprintError } from '../src/circuit-breaker/detector.js';
import { handleHook } from '../src/cli/hooks.js';
import { defaultCommands, install } from '../src/cli/install.js';
import { uninstall } from '../src/cli/uninstall.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createServer } from '../src/mcp/server.js';
import { Sentinel } from '../src/sentinel.js';
import { distillLog } from '../src/token-guard/distiller.js';
import { pruneSource } from '../src/token-guard/pruner.js';
import type { EditRound } from '../src/types.js';
import { createInitialState } from '../src/utils/state-store.js';
import { estimateTokens } from '../src/utils/tokens.js';

/* ------------------------------------------------------------------ */
/* Tiny test runner                                                     */
/* ------------------------------------------------------------------ */

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const metrics: string[] = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });
const metric = (line: string) => metrics.push(line);

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `sentinel-${prefix}-`));
  tempDirs.push(d);
  return d;
}
function writeFile(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function edit(seq: number, file: string, added: string[], removed: string[]): EditRound {
  return { seq, timestamp: seq, file, added, removed, symbols: [], source: 'test' };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

function vitestLog(opts: { home: string; time: string; line: number; col: number; addr: string; duration: string }): string {
  const { home, time, line, col, addr, duration } = opts;
  return [
    '\u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv1.6.0 \u001b[39m\u001b[90m' + home + '\u001b[39m',
    '',
    ` \u001b[31m❯\u001b[39m tests/auth.test.ts (5 tests | 1 failed) ${duration}`,
    '',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  tests/auth.test.ts > auth > rejects expired token',
    `TypeError: Cannot read properties of undefined (reading 'sub') at ${addr}`,
    ` ❯ validateToken src/auth.ts:${line}:${col}`,
    `    at validateToken (${home}/src/auth.ts:${line}:${col})`,
    `    at ${home}/tests/auth.test.ts:${line - 27}:12`,
    `    at runTest (${home}/node_modules/@vitest/runner/dist/index.js:781:11)`,
    `    at processTicksAndRejections (node:internal/process/task_queues:95:5)`,
    '',
    ' Test Files  1 failed (1)',
    '      Tests  1 failed | 4 passed (5)',
    `   Start at  ${time}`,
    `   Duration  ${duration} (transform 21ms, setup 0ms, collect 30ms, tests 4ms)`,
  ].join('\n');
}

/* ================================================================== */
/* Test 1 — Diff reciprocity                                            */
/* ================================================================== */

test('1. Diff reciprocity: add → remove → re-add is flagged as a loop (> 60%)', () => {
  const guard = 'if (!token) throw new Error("missing token");';
  const rounds = [
    edit(1, 'src/auth.ts', [`  ${guard}`], []), // round 1: add a validation line
    edit(3, 'src/auth.ts', [], [`    ${guard}`]), // round 2: delete it (indentation differs — normalized)
    edit(5, 'src/auth.ts', [guard], []), // round 3: add it back
  ];
  const rec = computeReciprocity(rounds);
  assert.ok(rec.rate > 0.6, `reciprocity ${rec.rate} should exceed 0.6`);
  assert.equal(rec.rate, 1);
  assert.deepEqual(rec.flippedLines, [guard]);

  const osc = detectOscillation(rounds, DEFAULT_CONFIG);
  assert.equal(osc.oscillating, true);
  assert.equal(osc.file, 'src/auth.ts');

  // With a failing run, the oscillation becomes a trip reason (dead-loop risk).
  const state = createInitialState();
  state.edits = rounds;
  state.runs = [{ seq: 6, timestamp: 6, command: 'npm test', exitCode: 1, fingerprint: 'abc', rawTokens: 10, source: 'test' }];
  state.consecutiveFailures = 1;
  const risk = assessRisk(state, DEFAULT_CONFIG);
  assert.equal(risk.level, 'critical');
  assert.ok(risk.tripReasons.some((r) => r.includes('flip-flop')), risk.tripReasons.join('|'));

  // Control: genuinely different edits are not a loop.
  const progress = [edit(1, 'a.ts', ['const a = 1;'], ['const a = 0;']), edit(2, 'a.ts', ['const b = 2;'], []), edit(3, 'a.ts', ['return a + b;'], ['return a;'])];
  assert.ok(computeReciprocity(progress).rate < 0.6);

  // End-to-end through the facade with real before/after content + symbol mapping.
  const root = tempDir('t1');
  const s = new Sentinel({ root, disableGit: true });
  const v0 = 'export function validate(token?: string) {\n  return token!.length > 0;\n}\n';
  const v1 = `export function validate(token?: string) {\n  ${guard}\n  return token!.length > 0;\n}\n`;
  s.recordEdit({ file: 'src/auth.ts', before: v0, after: v1, source: 'test' });
  s.recordEdit({ file: 'src/auth.ts', before: v1, after: v0, source: 'test' });
  const r3 = s.recordEdit({ file: 'src/auth.ts', before: v0, after: v1, source: 'test' });
  assert.equal(r3.assessment.oscillation.oscillating, true);
  assert.deepEqual(r3.recorded[0]?.symbols, ['validate']);
  metric(`T1 reciprocity rate = ${(rec.rate * 100).toFixed(0)}% (threshold 60%), control = ${(computeReciprocity(progress).rate * 100).toFixed(0)}%`);
});

/* ================================================================== */
/* Test 2 — Error fingerprint                                            */
/* ================================================================== */

test('2. Error fingerprint: same stack, different timestamps/paths/positions → identical SHA-256', () => {
  const a = vitestLog({ home: '/home/alice/proj', time: '10:15:32', line: 42, col: 18, addr: '0x7ffd5e8c1a20', duration: '1.23s' });
  const b = vitestLog({ home: '/Users/bob/work/proj', time: '23:01:07', line: 45, col: 7, addr: '0x55d4c2e0b9f8', duration: '987ms' });
  assert.notEqual(a, b);
  const fa = fingerprintError(a, '/home/alice/proj');
  const fb = fingerprintError(b, '/Users/bob/work/proj');
  assert.match(fa.hash, /^[0-9a-f]{64}$/);
  assert.equal(fa.hash, fb.hash, `canonical A:\n${fa.canonical}\ncanonical B:\n${fb.canonical}`);
  assert.equal(fa.errorName, 'TypeError');
  assert.equal(fa.failingTest, 'auth > rejects expired token');
  assert.ok(fa.frames.some((f) => f.includes('validateToken src/auth.ts')));
  assert.ok(!fa.canonical.includes('node_modules') && !fa.canonical.includes('node:internal'), 'framework frames must be dropped');

  // A genuinely different error must produce a different fingerprint.
  const other = fingerprintError(a.replace("reading 'sub'", "reading 'exp'"), '/home/alice/proj');
  assert.notEqual(other.hash, fa.hash);

  // Consecutive-failure counter + repeat detection through the breaker.
  const root = tempDir('t2');
  const s = new Sentinel({ root, disableGit: true });
  const r1 = s.recordRun({ command: 'npx vitest run', exitCode: 1, log: a, source: 'test' });
  const r2 = s.recordRun({ command: 'npx vitest run', exitCode: 1, log: b, source: 'test' });
  assert.equal(r1.fingerprint?.hash, r2.fingerprint?.hash);
  assert.equal(r2.assessment.consecutiveFailures, 2);
  assert.equal(r2.assessment.fingerprintPattern.length, 2, 'two identical fingerprints in a row');
  assert.equal(r2.status, 'CLOSED');
  const r3 = s.recordRun({ command: 'npx vitest run', exitCode: 1, log: a, source: 'test' });
  assert.equal(r3.assessment.fingerprintPattern.pattern, 'repeat');
  assert.equal(r3.status, 'OPEN', 'A → A → A trips the breaker');

  // Pattern detector covers cycles and ping-pong as well.
  assert.equal(detectFingerprintPattern(['A', 'B', 'A'], 3).pattern, 'cycle');
  assert.equal(detectFingerprintPattern(['A', 'B', 'A', 'B'], 3).pattern, 'ping-pong');
  assert.equal(detectFingerprintPattern(['A', 'B', 'C'], 3).pattern, 'none');
  metric(`T2 fingerprint ${fa.hash.slice(0, 16)}… identical across runs; A→A→A tripped at run 3`);
});

/* ================================================================== */
/* Test 3 — Log distillation                                             */
/* ================================================================== */

test('3. Log distiller: 100+ lines of node_modules/Vite noise → ≤ 10 lines, call site kept', () => {
  const root = tempDir('t3');
  const src = Array.from({ length: 40 }, (_, i) => `  const v${i + 1} = ${i + 1};`);
  src[25] = 'export function getUserId(session: Session) {';
  src[26] = '  return session.user.id;';
  src[27] = '}';
  writeFile(root, 'src/services/user.ts', src.join('\n'));

  const noise: string[] = [
    '\u001b[36m[vite]\u001b[39m connected.',
    '\u001b[2m 10:22:31 AM\u001b[22m \u001b[36m\u001b[1m[vite]\u001b[22m\u001b[39m hmr update /src/App.tsx',
  ];
  for (let i = 0; i < 40; i++) noise.push(`    at ${['transformRequest', 'pluginContainer.transform', 'loadAndTransform', 'viteTransformMiddleware'][i % 4]} (${root}/node_modules/vite/dist/node/chunks/dep-B0fRCRkQ.js:${50000 + i}:${i + 3})`);
  noise.push(`TypeError: Cannot read properties of undefined (reading 'id')`);
  for (let i = 0; i < 3; i++) noise.push(`    at Object.handler (${root}/node_modules/rollup/dist/es/shared/node-entry.js:${2000 + i}:12)`);
  noise.push(`    at getUserId (${root}/src/services/user.ts:27:23)`);
  noise.push(`    at ${root}/src/routes/profile.ts:14:9`);
  for (let i = 0; i < 45; i++) noise.push(`    at ${i % 2 ? 'Module._compile' : 'processTicksAndRejections'} (${i % 2 ? `${root}/node_modules/webpack/lib/NormalModule.js:${900 + i}:7` : 'node:internal/process/task_queues:95:5'})`);
  for (let i = 0; i < 12; i++) noise.push(`npm ERR! code ELIFECYCLE`);
  const raw = noise.join('\n');
  assert.ok(raw.split('\n').length >= 100, `fixture has ${raw.split('\n').length} lines`);

  const r = distillLog(raw, { root, tokenBudget: 150, contextLines: 3 });
  const lines = r.text.split('\n');
  assert.ok(lines.length <= 10, `distilled to ${lines.length} lines:\n${r.text}`);
  assert.ok(r.distilledTokens <= 150, `distilled tokens ${r.distilledTokens}`);
  assert.match(r.text, /TypeError: Cannot read properties of undefined \(reading 'id'\)/);
  assert.match(r.text, /getUserId \(src\/services\/user\.ts:27:23\)/);
  assert.match(r.text, />\s+27 \|\s+return session\.user\.id;/, 'call-site line marked with ">"');
  assert.match(r.text, /24 \|/, '3 lines of context before');
  assert.match(r.text, /30 \|/, '3 lines of context after');
  assert.ok(!/node_modules|node:internal|\u001b\[/.test(r.text), 'no framework frames or ANSI codes');
  assert.ok(r.reduction > 0.9, `reduction ${r.reduction}`);
  metric(`T3 ${r.originalLines} lines / ${r.originalTokens} tokens → ${lines.length} lines / ${r.distilledTokens} tokens (−${(r.reduction * 100).toFixed(1)}%)`);
  metric(`T3 distilled output:\n${r.text.split('\n').map((l) => `      │ ${l}`).join('\n')}`);

  // tsc output is grouped and capped too.
  const tsc = Array.from({ length: 30 }, (_, i) => `src/services/user.ts(${i + 1},5): error TS2322: Type 'string' is not assignable to type 'number'.`).join('\n');
  const t = distillLog(tsc, { root });
  assert.ok(t.text.split('\n').length <= 10 && t.text.includes('TS2322') && t.text.includes('more TypeScript errors'), t.text);
});

/* ================================================================== */
/* Test 4 — Breaker trip, Dead-End log, write blocking, reset            */
/* ================================================================== */

test('4. Circuit breaker: 4th consecutive failure trips, writes Dead-End log, blocks writes, resets', () => {
  const root = tempDir('t4');
  let now = Date.now(); // real-time anchor: hook processes use the real clock
  const s = new Sentinel({ root, disableGit: true, now: () => now, config: { cooldownMs: 60_000 } });
  const errors = ['TypeError: a is undefined', 'RangeError: index out of range', 'SyntaxError: Unexpected token', 'ReferenceError: foo is not defined'];

  for (let i = 0; i < 3; i++) {
    const d = s.guardEdit('src/app.ts');
    assert.equal(d.allowed, true, `edit ${i + 1} allowed`);
    s.recordEdit({ file: 'src/app.ts', before: `v${i}`, after: `v${i + 1}`, source: 'test' });
    const r = s.recordRun({ command: 'npm test', exitCode: 1, log: `${errors[i]}\n    at main (src/app.ts:${i + 1}:1)`, source: 'test' });
    assert.equal(r.status, 'CLOSED', `still CLOSED after failure ${i + 1}`);
    assert.equal(r.trip, undefined);
  }
  // Same function edited in 3 failing rounds → HIGH-risk warning, but writes are still allowed.
  const hot = s.guardEdit('src/app.ts');
  assert.equal(hot.decision, 'warn');
  assert.equal(hot.risk, 'high');
  assert.match(hot.reason, /Hotspot: src\/app\.ts/);
  const fourth = s.recordRun({ command: 'npm test', exitCode: 1, log: `${errors[3]}\n    at main (src/app.ts:9:1)`, source: 'test' });
  assert.equal(fourth.status, 'OPEN', '4th consecutive failure trips');
  assert.ok(fourth.trip, 'trip result present');
  const dead = fourth.trip!.deadEnd;
  assert.ok(dead.reasons.some((r) => r.includes('4 consecutive failing runs')), dead.reasons.join('|'));
  assert.equal(dead.fingerprints.length, 4);
  assert.ok(dead.attempts.length >= 3);
  assert.ok(dead.rejectedApproaches.length >= 1);
  assert.ok(dead.requiredSelfCheck.length >= 4);
  assert.equal(dead.rollback.performed, false, 'block-only mode without git');

  // Persisted as JSON + Markdown.
  const files = readdirSync(join(root, '.sentinel', 'dead-ends'));
  assert.ok(files.some((f) => f.endsWith('.json')) && files.includes('LATEST.md'), files.join(','));
  const md = readFileSync(join(root, '.sentinel', 'dead-ends', 'LATEST.md'), 'utf8');
  assert.match(md, /Dead-End Log/);
  assert.match(md, /Rejected approaches/);
  assert.match(md, /Required architecture-level self-check/);

  // Writes are now blocked — via the API and via a real Claude Code PreToolUse hook payload.
  const blocked = s.guardEdit('src/app.ts');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.decision, 'block');
  const hook = handleHook('claude', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, 'src/app.ts') }, cwd: root }, { root });
  assert.equal(hook.exitCode, 2, 'Claude Code hook blocks with exit 2');
  assert.match(hook.stderr ?? '', /Circuit OPEN/);
  const cursorHook = handleHook('cursor', { hook_event_name: 'preToolUse', tool_name: 'edit_file', tool_input: { target_file: 'src/app.ts' } }, { root });
  assert.equal(cursorHook.exitCode, 2);
  assert.equal(JSON.parse(cursorHook.stdout ?? '{}').permission, 'deny');
  const windsurfHook = handleHook('windsurf', { agent_action_name: 'pre_write_code', tool_info: { file_path: join(root, 'src/app.ts') } }, { root });
  assert.equal(windsurfHook.exitCode, 2);
  // Non-write tools are never blocked.
  assert.equal(handleHook('claude', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/app.ts' } }, { root }).exitCode, 0);

  // HALF_OPEN: after cool-down one probe is allowed; a failing probe re-opens.
  now += 60_001;
  const probe = s.guardEdit('src/app.ts');
  assert.equal(probe.allowed, true);
  assert.equal(probe.circuit, 'HALF_OPEN');
  const probeFail = s.recordRun({ command: 'npm test', exitCode: 1, log: 'Error: still broken', source: 'test' });
  assert.equal(probeFail.status, 'OPEN', 'failed probe re-opens');
  assert.equal(s.guardEdit('src/app.ts').allowed, false);

  // Manual reset closes the circuit and clears the loop memory.
  s.reset();
  assert.equal(s.status().status, 'CLOSED');
  assert.equal(s.guardEdit('src/app.ts').allowed, true);
  assert.equal(s.status().consecutiveFailures, 0);
  metric(`T4 tripped on failure #4 → OPEN, Dead-End ${dead.id} written, writes blocked (Claude/Cursor/Windsurf hooks exit 2), HALF_OPEN probe + reset OK`);
});

/* ================================================================== */
/* Test 5 — Real git rollback                                            */
/* ================================================================== */

test('5. Git rollback: trip restores agent-touched files, keeps a backup ref, never touches branch/index/user files', () => {
  const root = tempDir('t5');
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'dev@example.com');
  sh(root, 'config', 'user.name', 'Dev');
  sh(root, 'config', 'core.autocrlf', 'false'); // Windows runners default to CRLF conversion
  const original = 'export function total(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n';
  writeFile(root, 'src/math.ts', original);
  writeFile(root, 'notes.md', 'user notes\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'init');
  const head = sh(root, 'rev-parse', 'HEAD');

  const s = new Sentinel({ root });
  const green = s.recordRun({ command: 'npm test', exitCode: 0, log: 'all passed', source: 'test' });
  assert.ok(green.checkpoint, 'green run creates a checkpoint');

  // The user edits a file by hand (not through the agent) — must survive rollback.
  writeFile(root, 'notes.md', 'user notes\nedited by the human\n');

  // The agent edits math.ts and creates a new file.
  assert.equal(s.guardEdit('src/math.ts').allowed, true);
  const dirty = 'export function total(xs: number[]) {\n  if (!xs) return 0; // agent patch\n  return xs.reduce((a, b) => a + b, 0);\n}\n';
  writeFile(root, 'src/math.ts', dirty);
  s.recordEdit({ file: 'src/math.ts', source: 'test' });
  assert.equal(s.guardEdit('src/helpers.ts').allowed, true);
  writeFile(root, 'src/helpers.ts', 'export const noop = () => {};\n');
  s.recordEdit({ file: 'src/helpers.ts', source: 'test' });

  let last;
  for (let i = 0; i < 4; i++) last = s.recordRun({ command: 'npm test', exitCode: 1, log: `Error${i}Error: failure ${i}\n    at total (src/math.ts:2:3)`, source: 'test' });
  assert.equal(last?.status, 'OPEN');
  const rb = last!.trip!.deadEnd.rollback;
  assert.equal(rb.performed, true, rb.skippedReason);
  assert.deepEqual(rb.restoredFiles, ['src/math.ts']);
  assert.deepEqual(rb.deletedFiles, ['src/helpers.ts']);

  assert.equal(readFileSync(join(root, 'src/math.ts'), 'utf8'), original, 'agent edit rolled back');
  assert.equal(existsSync(join(root, 'src/helpers.ts')), false, 'agent-created file removed');
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'user notes\nedited by the human\n', 'human edit untouched');

  assert.equal(sh(root, 'rev-parse', 'HEAD'), head, 'HEAD unchanged');
  assert.equal(sh(root, 'rev-list', '--count', 'HEAD'), '1', 'no commits added to the branch');
  assert.equal(sh(root, 'diff', '--cached', '--name-only'), '', 'index untouched');
  assert.equal(sh(root, 'stash', 'list'), '', 'stash untouched');
  assert.ok(rb.backupRef && sh(root, 'show', `${rb.backupRef}:src/math.ts`).includes('agent patch'), 'backup ref holds the pre-rollback state');
  assert.ok(!sh(root, 'status', '--porcelain').includes('.sentinel'), '.sentinel/ is git-ignored');
  metric(`T5 restored ${rb.restoredFiles.join(',')}, deleted ${rb.deletedFiles.join(',')}, backup ${rb.backupRef}`);
});

/* ================================================================== */
/* Test 6 — AST pruning                                                  */
/* ================================================================== */

test('6. AST pruner: keeps target + referenced types/imports, folds the rest', () => {
  const parts: string[] = [
    "import { createHash } from 'node:crypto';",
    "import { readFileSync } from 'node:fs';",
    '',
    'export interface Claims {',
    '  sub: string;',
    '  exp: number;',
    '}',
    '',
    'export type Token = { raw: string; claims: Claims };',
    '',
    'interface Unrelated { x: number }',
    '',
  ];
  for (let i = 0; i < 25; i++) {
    parts.push(`export function helper${i}(input: string): string {`, `  const a${i} = input.trim();`, `  const b${i} = a${i}.toUpperCase();`, `  if (b${i}.length > ${i}) {`, `    return b${i}.slice(0, ${i});`, '  }', `  return readFileSync(b${i}, 'utf8');`, '}', '');
  }
  parts.push(
    '/** Validates a token. */',
    'export function validateToken(token: Token, now: number): boolean {',
    "  const digest = createHash('sha256').update(token.raw).digest('hex');",
    '  return token.claims.exp > now && digest.length === 64;',
    '}',
    '',
    'export class AuthService {',
    '  private cache = new Map<string, Token>();',
    '  login(user: string): Token {',
    "    return { raw: user, claims: { sub: user, exp: 0 } };",
    '  }',
    '  logout(user: string): void {',
    '    this.cache.delete(user);',
    '  }',
    '}',
  );
  const source = parts.join('\n');
  const r = pruneSource(source, 'auth.ts', { targets: ['validateToken'] });
  assert.equal(r.strategy, 'typescript-ast');
  assert.deepEqual(r.keptSymbols, ['validateToken']);
  assert.match(r.text, /export function validateToken\(token: Token, now: number\): boolean \{/);
  assert.match(r.text, /\/\*\* Validates a token\. \*\//, 'JSDoc kept');
  assert.match(r.text, /export type Token = /, 'referenced type kept');
  assert.match(r.text, /export interface Claims \{/, 'transitively referenced type kept');
  assert.match(r.text, /import \{ createHash \} from 'node:crypto';/, 'used import kept');
  assert.ok(!r.text.includes("import { readFileSync }"), 'unused import folded');
  assert.ok(!r.text.includes('helper3') && !r.text.includes('Unrelated'), 'unrelated code folded');
  assert.match(r.text, /\/\/ \.\.\. \[omitted \d+ lines of unrelated logic\]/);
  assert.match(r.text, /^\s*\d+ \| export function validateToken/m, 'original line numbers kept');
  assert.ok(r.prunedTokens < r.originalTokens * 0.25, `${r.prunedTokens} vs ${r.originalTokens}`);

  const m = pruneSource(source, 'auth.ts', { targets: ['AuthService.login'], lineNumbers: false });
  assert.match(m.text, /export class AuthService \{/);
  assert.match(m.text, /login\(user: string\): Token \{/);
  assert.ok(!m.text.includes('logout'), 'sibling method folded');
  assert.ok(!m.text.includes('validateToken'));

  const py = pruneSource('import os\n\ndef a():\n    return 1\n\ndef target(x):\n    y = x + 1\n    return y\n\ndef b():\n    return 2\n', 'm.py', { targets: ['target'], lineNumbers: false });
  assert.equal(py.strategy, 'heuristic');
  assert.match(py.text, /def target\(x\):\n    y = x \+ 1\n    return y/);
  assert.match(py.text, /# \.\.\. \[omitted/);
  assert.ok(!py.text.includes('def a') && !py.text.includes('def b'));
  metric(`T6 ${r.totalLines} lines / ${r.originalTokens} tokens → kept ${r.totalLines - r.omittedLines} lines / ${r.prunedTokens} tokens (deps: ${r.dependencies.join(', ')})`);
});

/* ================================================================== */
/* Test 7 — Episodic history compaction                                  */
/* ================================================================== */

test('7. History compactor: auto-compacts every 3 rounds; 6 rounds free ≥ 70% of history tokens', () => {
  const root = tempDir('t7');
  const s = new Sentinel({ root, disableGit: true, config: { maxConsecutiveFailures: 99, sameFingerprintLimit: 99 } });
  const bigLog = (i: number) =>
    [
      `TypeError: Cannot read properties of null (reading 'session${i}')`,
      `    at login (${root}/src/auth.ts:42:${i + 5})`,
      ...Array.from({ length: 60 }, (_, k) => `    at step${k} (${root}/node_modules/vitest/dist/chunk-${k}.js:${k * 13}:7)`),
    ].join('\n');
  let content = 'export function login(user) {\n  return user.session.id;\n}\n';
  const autoSummaries: string[] = [];
  for (let i = 0; i < 6; i++) {
    const next = content.replace('  return', `  if (user?.session${i} == null) return null;\n  return`);
    s.recordEdit({ file: 'src/auth.ts', before: content, after: next, source: 'test' });
    content = next;
    // Unique errors per round so the breaker does not interfere.
    const r = s.recordRun({ command: 'npx vitest run', exitCode: 1, log: bigLog(i), source: 'test' });
    if (r.compaction) autoSummaries.push(...r.compaction.episodes.map((e) => e.summary));
  }
  assert.equal(autoSummaries.length, 1, `auto compaction after round 4 folds rounds 1-3: ${autoSummaries.join(' | ')}`);
  assert.match(autoSummaries[0] ?? '', /^\[Compacted\]: Rounds 1-3 attempted null-checks.* at src\/auth\.ts#login, failed with TypeError ×3\.$/);

  const c = s.compact();
  assert.ok(c.stats.reduction >= 0.7, `freed ${(c.stats.reduction * 100).toFixed(1)}%`);
  assert.match(c.history, /\[Compacted\]: Rounds 4-5 attempted null-checks/);
  assert.match(c.history, /Round 6: edited src\/auth\.ts#login/);
  assert.ok(c.history.split('\n').length <= 3, c.history);
  metric(`T7 history ${c.stats.originalTokens} → ${c.stats.currentTokens} tokens (freed ${(c.stats.reduction * 100).toFixed(1)}%)`);
  metric(`T7 compacted view:\n${c.history.split('\n').map((l) => `      │ ${l}`).join('\n')}`);
});

/* ================================================================== */
/* Test 8 — MCP server end-to-end                                        */
/* ================================================================== */

test('8. MCP server: lists tools/resources and serves them over a real MCP client', async () => {
  const root = tempDir('t8');
  const server = createServer(new Sentinel({ root, disableGit: true }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'self-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const required of ['sentinel_guard_edit', 'sentinel_distill_log', 'sentinel_check_circuit', 'sentinel_record_run', 'sentinel_reset_circuit', 'sentinel_prune_file', 'sentinel_compact_history', 'sentinel_checkpoint', 'sentinel_record_edit']) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  const text = (res: unknown) => ((res as { content: Array<{ text: string }> }).content[0]?.text ?? '');

  const distilled = await client.callTool({ name: 'sentinel_distill_log', arguments: { log: 'Error: boom\n    at x (node_modules/a.js:1:1)\n    at run (src/run.ts:3:4)' } });
  assert.match(text(distilled), /Error: boom/);
  assert.match(text(distilled), /src\/run\.ts:3:4/);

  for (let i = 0; i < 4; i++) await client.callTool({ name: 'sentinel_record_run', arguments: { command: 'npm test', exitCode: 1, log: `E${i}Error: x${i}` } });
  const guard = await client.callTool({ name: 'sentinel_guard_edit', arguments: { file: 'src/a.ts' } });
  assert.equal(guard.isError, true);
  assert.match(text(guard), /BLOCK/);
  const status = await client.callTool({ name: 'sentinel_check_circuit', arguments: {} });
  assert.match(text(status), /Circuit OPEN/);
  const dead = await client.readResource({ uri: 'sentinel://dead-ends' });
  assert.match((dead.contents[0] as { text: string }).text, /Dead-End Log/);
  const badReset = await client.callTool({ name: 'sentinel_reset_circuit', arguments: { hypothesis: 'short' } });
  assert.equal(badReset.isError, true, 'hypothesis is validated');
  const reset = await client.callTool({ name: 'sentinel_reset_circuit', arguments: { hypothesis: 'The config loader returns undefined in test env; inject it instead.' } });
  assert.match(text(reset), /CLOSED/);
  const err = await client.callTool({ name: 'sentinel_prune_file', arguments: { file: '../../etc/passwd', targets: ['x'] } });
  assert.equal(err.isError, true, 'path traversal rejected as a tool error, server keeps running');
  await client.close();
  metric(`T8 MCP tools: ${names.join(', ')}`);
});

/* ================================================================== */
/* Test 9 — CLI wrapper + installer                                      */
/* ================================================================== */

test('9. CLI: `sentinel run` distills a failing command; `sentinel install --all` writes all client configs', () => {
  const root = tempDir('t9');
  sh(root, 'init', '-q');
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.ts');
  // `node --import <tsx>` instead of node_modules/.bin/tsx: .bin shims are .cmd files on Windows.
  const tsxLoader = import.meta.resolve('tsx');
  const sentinelCli = (args: string[], opts: Parameters<typeof spawnSync>[2] = {}) =>
    spawnSync(process.execPath, ['--import', tsxLoader, cli, ...args], { encoding: 'utf8', ...opts }) as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
  writeFile(root, 'fail.js', "console.log('x'.repeat(50)); for (let i = 0; i < 80; i++) console.error('    at f (/x/node_modules/lib/i.js:' + i + ':1)'); console.error('Error: exploded'); process.exit(3);\n");
  const run = sentinelCli(['run', '--root', root, '--', 'node', 'fail.js'], { cwd: root });
  assert.equal(run.status, 3, `exit code passed through: ${run.stderr}`);
  assert.match(run.stdout, /Error: exploded/);
  assert.match(run.stdout, /failed \(exit 3\)/);
  assert.ok(run.stdout.split('\n').length < 12, run.stdout);
  assert.ok(!run.stdout.includes('node_modules'));

  const inst = sentinelCli(['install', '--all', '--root', root], { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root } });
  assert.equal(inst.status, 0, inst.stderr);
  for (const f of ['.mcp.json', '.claude/settings.json', '.claude/skills/token-sentinel/SKILL.md', '.cursor/mcp.json', '.cursor/hooks.json', '.cursor/rules/token-sentinel.mdc', '.windsurf/hooks.json', '.windsurf/rules/token-sentinel.md', '.git/hooks/pre-commit']) {
    assert.ok(existsSync(join(root, f)), `missing ${f}`);
  }
  const claude = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(claude.hooks.PreToolUse[0].matcher, 'Edit|MultiEdit|Write|NotebookEdit');
  const cursor = JSON.parse(readFileSync(join(root, '.cursor/hooks.json'), 'utf8'));
  assert.equal(cursor.version, 1);
  assert.ok(cursor.hooks.preToolUse && cursor.hooks.afterFileEdit && cursor.hooks.afterShellExecution);
  const windsurf = JSON.parse(readFileSync(join(root, '.windsurf/hooks.json'), 'utf8'));
  assert.ok(windsurf.hooks.pre_write_code && windsurf.hooks.post_run_command);
  // Idempotent: re-install does not duplicate hook entries.
  sentinelCli(['install', '--claude', '--root', root], { cwd: root });
  assert.equal(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 1);

  // Configs never point into a package-runner cache (npx/pnpm dlx/bunx).
  assert.deepEqual(defaultCommands('/home/u/.npm/_npx/9f1c2/node_modules/agent-token-sentinel/dist/cli/install.js').mcp, { command: 'npx', args: ['-y', 'agent-token-sentinel', 'mcp'] });
  assert.equal(defaultCommands('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\ab12\\node_modules\\agent-token-sentinel\\dist\\cli\\install.js').cli, 'npx -y agent-token-sentinel');
  assert.match(defaultCommands('/usr/lib/node_modules/agent-token-sentinel/dist/cli/install.js').cli, /^node ".*index\.js"$/);

  // The git pre-commit hook rejects commits while OPEN.
  const s = new Sentinel({ root, disableGit: true });
  for (let i = 0; i < 4; i++) s.recordRun({ command: 'npm test', exitCode: 1, log: `E${i}Error: ${i}`, source: 'test' });
  const pre = sentinelCli(['hook', 'git-pre-commit', '--root', root]);
  assert.equal(pre.status, 1);
  assert.match(pre.stderr, /Commit rejected/);
  metric(`T9 \`sentinel run\` output ${run.stdout.split('\n').length} lines; installed configs for Claude Code, Cursor, Windsurf, git`);
});

/* ================================================================== */
/* Test 10 — Uninstall                                                   */
/* ================================================================== */

function snapshotTree(root: string, dir = root, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    const rel = full.slice(root.length + 1).split('\\').join('/');
    if (entry.isDirectory()) {
      out[`${rel}/`] = '<dir>';
      snapshotTree(root, full, out);
    } else out[rel] = readFileSync(full, 'utf8');
  }
  return out;
}

test('10. Uninstall: removes only what install added, keeps user settings and recovery data unless --purge', () => {
  const root = tempDir('t10');
  sh(root, 'init', '-q');
  sh(root, 'config', 'user.email', 'dev@example.com');
  sh(root, 'config', 'user.name', 'Dev');
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  // The user's own pre-existing configuration.
  writeFile(root, '.claude/settings.json', json({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  writeFile(root, '.mcp.json', json({ mcpServers: { github: { command: 'gh-mcp' } } }));
  writeFile(root, '.cursor/hooks.json', json({ version: 1, hooks: { afterFileEdit: [{ command: 'prettier --write' }] } }));
  writeFile(root, 'src/app.ts', 'export const x = 1;\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'init');
  const before = snapshotTree(root);

  install({ root, targets: ['claude', 'cursor', 'windsurf', 'git'] });
  const s = new Sentinel({ root });
  s.recordRun({ command: 'npm test', exitCode: 0, log: 'ok', source: 'test' }); // creates .sentinel/ + a checkpoint ref
  assert.ok(sh(root, 'for-each-ref', 'refs/sentinel/').length > 0);
  const installed = snapshotTree(root);
  assert.notDeepEqual(installed, before);

  // Dry run changes nothing.
  const dry = uninstall({ root, targets: ['claude', 'cursor', 'windsurf', 'git'], dryRun: true });
  assert.ok(dry.edited.length + dry.deleted.length > 0);
  assert.deepEqual(snapshotTree(root), installed, 'dry-run must not touch the disk');

  // Real uninstall through the CLI: project back to its pre-install state, except recovery data.
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.ts');
  const res = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'uninstall', '--all', '--root', root], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /Uninstalled/);
  assert.match(res.stdout, /kept .*\.sentinel/);
  assert.match(res.stdout, /snapshot ref\(s\)/);
  const after = snapshotTree(root);
  const withoutState = Object.fromEntries(Object.entries(after).filter(([k]) => !k.startsWith('.sentinel/')));
  assert.deepEqual(withoutState, before, 'every file the user had is byte-identical; everything sentinel added is gone');
  assert.ok(existsSync(join(root, '.sentinel')), '.sentinel kept without --purge');
  assert.ok(!existsSync(join(root, '.git', 'hooks', 'pre-commit')), 'sentinel pre-commit hook removed');
  assert.ok(sh(root, 'for-each-ref', 'refs/sentinel/').length > 0, 'snapshot refs kept without --purge');

  // --purge removes recovery data too; a second run is a no-op.
  const purge = uninstall({ root, targets: ['claude', 'cursor', 'windsurf', 'git'], purge: true });
  assert.ok(purge.refsDeleted.length > 0);
  assert.ok(!existsSync(join(root, '.sentinel')));
  assert.equal(sh(root, 'for-each-ref', 'refs/sentinel/'), '');
  assert.deepEqual(snapshotTree(root), before);
  const again = uninstall({ root, targets: ['claude', 'cursor', 'windsurf', 'git'] });
  assert.equal(again.edited.length + again.deleted.length + again.refsDeleted.length, 0);

  // A foreign git hook and an unparseable config are never touched.
  writeFile(root, '.git/hooks/pre-commit', '#!/bin/sh\necho my own hook\n');
  writeFile(root, '.mcp.json', '{ not json');
  const safe = uninstall({ root, targets: ['claude', 'git'] });
  assert.equal(readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8'), '#!/bin/sh\necho my own hook\n');
  assert.equal(readFileSync(join(root, '.mcp.json'), 'utf8'), '{ not json');
  assert.ok(safe.warnings.some((w) => w.includes('could not parse')));
  metric(`T10 install → uninstall restored ${Object.keys(before).length} user paths byte-for-byte; --purge removed ${purge.refsDeleted.length} ref(s) + .sentinel/`);
});

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log('\nagent-token-sentinel · Self-Verification Suite\n');
  let failed = 0;
  const started = Date.now();
  for (const t of tests) {
    const t0 = Date.now();
    try {
      await t.fn();
      console.log(`  ✔ ${t.name} (${Date.now() - t0}ms)`);
    } catch (err) {
      failed++;
      console.log(`  ✖ ${t.name}\n      ${(err instanceof Error ? (err.stack ?? err.message) : String(err)).split('\n').join('\n      ')}`);
    }
  }
  if (metrics.length) console.log(`\nMetrics:\n${metrics.map((m) => `  • ${m}`).join('\n')}`);
  console.log(`\n${tests.length - failed}/${tests.length} passed in ${Date.now() - started}ms`);
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  void estimateTokens;
  process.exitCode = failed ? 1 : 0;
}

void main();
