#!/usr/bin/env node
/**
 * A/B benchmark: same model, same tasks, with vs. without agent-token-sentinel.
 *
 *   node bench/run.mjs --self-check                 # validate fixtures (no model calls, free)
 *   node bench/run.mjs --repeats 3 --model <id>     # real run: costs Claude usage!
 *
 * Each trial copies a task repo into a fresh temp git repo, runs Claude Code
 * headless (`claude -p … --output-format json`), then verifies the result with
 * the ORIGINAL tests restored (editing tests does not count as a fix).
 *
 * Arms
 *   baseline  no sentinel, no MCP servers, project settings only
 *   sentinel  `sentinel install --claude` (hooks + MCP + SKILL.md), same isolation
 *
 * Results: bench/results/<timestamp>/results.jsonl + report.md
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const tasksDir = join(here, 'tasks');
const isWin = process.platform === 'win32';

/* ------------------------------- args -------------------------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const opts = {
  selfCheck: flag('self-check', false) === true,
  repeats: Number(flag('repeats', 3)),
  model: flag('model', undefined),
  arms: String(flag('arms', 'baseline,sentinel')).split(','),
  tasks: flag('tasks', undefined)?.split?.(','),
  budgetUsd: Number(flag('max-budget-usd', 2)),
  timeoutMin: Number(flag('timeout-min', 20)),
  claude: flag('claude', 'claude'),
  keep: flag('keep', false) === true,
  out: flag('out', undefined),
  /** Plumbing test: the stub edits tests instead of code; every trial must be scored FAIL. */
  expectCheat: flag('expect-cheat', false) === true,
};

/** `--claude some-script.mjs` runs a JS stand-in through node (used for free plumbing tests). */
const claudeCmd = /\.[cm]?js$/.test(opts.claude) ? [process.execPath, resolve(opts.claude)] : [opts.claude];
const runClaude = (args, cwd, extra) => sh(claudeCmd[0], [...claudeCmd.slice(1), ...args], cwd, extra);

const taskIds = readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, 'task.json')) && (!opts.tasks || opts.tasks.includes(d)));
if (!taskIds.length) die('No tasks selected.');

/* ------------------------------ helpers ------------------------------ */

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function sh(cmd, args, cwd, extra = {}) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: isWin, maxBuffer: 64 * 1024 * 1024, ...extra });
}

function loadTask(id) {
  return { id, ...JSON.parse(readFileSync(join(tasksDir, id, 'task.json'), 'utf8')) };
}

function freshRepo(task) {
  const dir = mkdtempSync(join(tmpdir(), `sentinel-bench-${task.id}-`));
  cpSync(join(tasksDir, task.id, 'repo'), dir, { recursive: true });
  sh('git', ['init', '-q'], dir);
  sh('git', ['-c', 'user.email=bench@localhost', '-c', 'user.name=bench', 'add', '-A'], dir);
  sh('git', ['-c', 'user.email=bench@localhost', '-c', 'user.name=bench', 'commit', '-qm', 'task'], dir);
  return dir;
}

/** Re-copy the task's protected paths (tests) from the fixture, then run the test command. */
function verify(task, dir) {
  let testsTouched = false;
  for (const p of task.protectedPaths ?? []) {
    const src = join(tasksDir, task.id, 'repo', p);
    const diff = sh('git', ['diff', '--quiet', 'HEAD', '--', p], dir);
    if (diff.status !== 0) testsTouched = true;
    rmSync(join(dir, p), { recursive: true, force: true });
    cpSync(src, join(dir, p), { recursive: true });
  }
  const [cmd, ...args] = task.testCommand.split(' ');
  const r = sh(cmd, args, dir);
  return { passed: r.status === 0, testsTouched };
}

/* ----------------------------- self-check ---------------------------- */

if (opts.selfCheck) {
  let ok = true;
  for (const id of taskIds) {
    const task = loadTask(id);
    const dir = freshRepo(task);
    const before = verify(task, dir);
    cpSync(join(tasksDir, id, 'solution'), dir, { recursive: true });
    const after = verify(task, dir);
    rmSync(dir, { recursive: true, force: true });
    const good = !before.passed && after.passed;
    ok &&= good;
    console.log(`${good ? '✔' : '✖'} ${id}: unfixed ${before.passed ? 'PASSES (bad fixture)' : 'fails'} · with solution ${after.passed ? 'passes' : 'FAILS (bad solution)'}`);
  }
  console.log(ok ? `\nAll ${taskIds.length} benchmark tasks are valid.` : '\nInvalid benchmark fixtures.');
  process.exit(ok ? 0 : 1);
}

/* ------------------------------- trials ------------------------------ */

const cli = join(repoRoot, 'dist', 'cli', 'index.js');
if (opts.arms.includes('sentinel') && !existsSync(cli)) die('Build first: npm run build');
const version = runClaude(['--version'], repoRoot);
if (version.status !== 0) die(`Claude Code CLI not found (${opts.claude}). Install it or pass --claude <path>.`);

const outDir = opts.out ? resolve(opts.out) : join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });
const resultsPath = join(outDir, 'results.jsonl');
rmSync(resultsPath, { force: true });
const total = taskIds.length * opts.arms.length * opts.repeats;
console.log(`Benchmark: ${taskIds.length} tasks × ${opts.arms.join('/')} × ${opts.repeats} = ${total} trials · ${version.stdout.trim()}${opts.model ? ` · model ${opts.model}` : ''}`);
console.log(`Spend cap per trial: $${opts.budgetUsd}. Results → ${outDir}\n`);

let n = 0;
for (let rep = 1; rep <= opts.repeats; rep++) {
  for (const id of taskIds) {
    // Alternate arm order per repetition to cancel ordering effects (caching, rate limits).
    const arms = rep % 2 ? opts.arms : [...opts.arms].reverse();
    for (const arm of arms) {
      n++;
      const task = loadTask(id);
      const dir = freshRepo(task);
      const mcpConfig = join(dir, '.bench-mcp.json');
      if (arm === 'sentinel') {
        const inst = sh(process.execPath, [cli, 'install', '--claude', '--root', dir], repoRoot);
        if (inst.status !== 0) die(`install failed: ${inst.stderr}`);
        writeFileSync(mcpConfig, readFileSync(join(dir, '.mcp.json')));
      } else {
        writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
      }
      const args = [
        '-p',
        task.prompt,
        '--output-format',
        'json',
        '--dangerously-skip-permissions', // isolated temp repo; needed for unattended runs
        '--setting-sources',
        'project,local', // ignore the user's global settings/hooks in both arms
        '--strict-mcp-config',
        '--mcp-config',
        mcpConfig,
        '--max-budget-usd',
        String(opts.budgetUsd),
        ...(opts.model ? ['--model', opts.model] : []),
      ];
      const started = Date.now();
      const run = runClaude(args, dir, { timeout: opts.timeoutMin * 60_000, env: { ...process.env, SENTINEL_ROOT: dir, BENCH_TASK_DIR: join(tasksDir, id), ...(opts.expectCheat ? { BENCH_STUB_CHEAT: '1' } : {}) } });
      let out = {};
      try {
        out = JSON.parse(run.stdout.trim().split('\n').pop() || '{}');
      } catch {
        out = { parse_error: true };
      }
      const v = verify(task, dir);
      let sentinel = {};
      const statePath = join(dir, '.sentinel', 'state.json');
      if (existsSync(statePath)) {
        const st = JSON.parse(readFileSync(statePath, 'utf8'));
        sentinel = { trips: st.circuit?.tripCount ?? 0, runs: st.runs?.length ?? 0, finalStatus: st.circuit?.status };
      }
      const u = out.usage ?? {};
      const row = {
        task: id,
        arm,
        rep,
        success: v.passed && !v.testsTouched,
        testsPassed: v.passed,
        testsTouched: v.testsTouched,
        costUsd: out.total_cost_usd ?? null,
        turns: out.num_turns ?? null,
        inputTokens: u.input_tokens ?? null,
        outputTokens: u.output_tokens ?? null,
        cacheReadTokens: u.cache_read_input_tokens ?? null,
        cacheWriteTokens: u.cache_creation_input_tokens ?? null,
        durationMs: out.duration_ms ?? Date.now() - started,
        agentError: out.is_error ?? run.status !== 0,
        timedOut: run.error?.code === 'ETIMEDOUT',
        ...sentinel,
      };
      writeFileSync(resultsPath, `${JSON.stringify(row)}\n`, { flag: 'a' });
      console.log(
        `[${n}/${total}] ${id.padEnd(16)} ${arm.padEnd(8)} rep ${rep}: ${row.success ? 'PASS' : 'FAIL'}${row.testsTouched ? ' (tests edited)' : ''}` +
          ` · $${row.costUsd?.toFixed?.(3) ?? '?'} · ${row.turns ?? '?'} turns${row.trips ? ` · ${row.trips} trip(s)` : ''}`,
      );
      if (!opts.keep) rmSync(dir, { recursive: true, force: true });
    }
  }
}

/* ------------------------------- report ------------------------------ */

const rows = readFileSync(resultsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const report = buildReport(rows);
writeFileSync(join(outDir, 'report.md'), report);
console.log(`\n${report}`);
if (opts.expectCheat) {
  const caught = rows.every((r) => !r.success && r.testsTouched);
  console.log(caught ? '✔ Anti-cheat: edited tests were detected and scored as failures.' : '✖ Anti-cheat FAILED: a trial that edited the tests was scored as a success.');
  process.exit(caught ? 0 : 1);
}

function buildReport(rows) {
  const byArm = (arm) => rows.filter((r) => r.arm === arm);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  };
  const num = (rs, k) => rs.map((r) => r[k]).filter((x) => typeof x === 'number');
  const wilson = (k, nn) => {
    if (!nn) return [NaN, NaN];
    const z = 1.96;
    const p = k / nn;
    const d = 1 + (z * z) / nn;
    const c = (p + (z * z) / (2 * nn)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / nn + (z * z) / (4 * nn * nn))) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  };
  const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '–');
  const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '–');
  const totalIn = (r) => (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0);

  const stats = {};
  const lines = ['# agent-token-sentinel A/B benchmark', '', `Trials: ${rows.length} · tasks: ${[...new Set(rows.map((r) => r.task))].join(', ')}`, ''];
  lines.push('| Arm | Success | 95% CI | Mean cost | Median input tokens (incl. cache) | Mean turns | Trips |', '|---|---|---|---|---|---|---|');
  for (const arm of [...new Set(rows.map((r) => r.arm))]) {
    const rs = byArm(arm);
    const k = rs.filter((r) => r.success).length;
    const [lo, hi] = wilson(k, rs.length);
    stats[arm] = { k, n: rs.length, cost: mean(num(rs, 'costUsd')), tokens: median(rs.map(totalIn)), turns: mean(num(rs, 'turns')) };
    lines.push(
      `| ${arm} | ${k}/${rs.length} (${pct(k / rs.length)}) | ${pct(lo)}–${pct(hi)} | $${fmt(stats[arm].cost, 3)} | ${fmt(stats[arm].tokens)} | ${fmt(stats[arm].turns, 1)} | ${rs.reduce((a, r) => a + (r.trips ?? 0), 0)} |`,
    );
  }
  lines.push('', '## Per task', '', '| Task | Arm | Success | Mean cost | Mean turns |', '|---|---|---|---|---|');
  for (const task of [...new Set(rows.map((r) => r.task))]) {
    for (const arm of [...new Set(rows.map((r) => r.arm))]) {
      const rs = rows.filter((r) => r.task === task && r.arm === arm);
      lines.push(`| ${task} | ${arm} | ${rs.filter((r) => r.success).length}/${rs.length} | $${fmt(mean(num(rs, 'costUsd')), 3)} | ${fmt(mean(num(rs, 'turns')), 1)} |`);
    }
  }

  const b = stats.baseline;
  const s = stats.sentinel;
  if (b && s) {
    const pb = b.k / b.n;
    const ps = s.k / s.n;
    const pooled = (b.k + s.k) / (b.n + s.n);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / b.n + 1 / s.n));
    const z = se > 0 ? (ps - pb) / se : 0;
    const pValue = 2 * (1 - normalCdf(Math.abs(z)));
    lines.push('', '## Verdict', '');
    lines.push(`- Cost: ${fmt(((s.cost - b.cost) / b.cost) * 100, 1)}% · input tokens: ${fmt(((s.tokens - b.tokens) / b.tokens) * 100, 1)}% · turns: ${fmt(((s.turns - b.turns) / b.turns) * 100, 1)}% (sentinel vs. baseline)`);
    lines.push(`- Success: ${pct(ps)} vs. ${pct(pb)} (Δ ${fmt((ps - pb) * 100, 1)} pts, two-proportion z-test p = ${fmt(pValue, 3)})`);
    if (ps < pb && pValue < 0.05) lines.push('- ⚠️ **Significant success-rate regression.** Do not ship the change; inspect the failing trials.');
    else if (b.n < 30) lines.push(`- No significant difference detected, but n = ${b.n} per arm has little power: treat as a smoke test, not proof. Increase --repeats for a stronger claim.`);
    else lines.push('- No significant success-rate regression detected at α = 0.05.');
  }
  return `${lines.join('\n')}\n`;
}

function normalCdf(x) {
  // Abramowitz–Stegun approximation.
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - p;
}
