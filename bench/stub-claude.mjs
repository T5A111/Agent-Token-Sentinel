#!/usr/bin/env node
/**
 * Stand-in for the `claude` CLI so the benchmark plumbing can be tested for free:
 * applies the task's reference solution and prints a result in Claude Code's
 * `--output-format json` shape. Used by `npm run bench:check` (and CI).
 */
import { cpSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  console.log('0.0.0 (stub claude)');
  process.exit(0);
}
const taskDir = process.env.BENCH_TASK_DIR;
if (process.env.BENCH_STUB_CHEAT) {
  // Simulate an agent that "fixes" the task by gutting the tests: must be scored as a failure.
  for (const f of readdirSync('tests')) writeFileSync(join('tests', f), "import { test } from 'node:test';\ntest('ok', () => {});\n");
} else if (taskDir && existsSync(join(taskDir, 'solution'))) {
  cpSync(join(taskDir, 'solution'), process.cwd(), { recursive: true });
}
console.log(
  JSON.stringify({
    type: 'result',
    is_error: false,
    num_turns: 3,
    duration_ms: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 500 },
  }),
);
