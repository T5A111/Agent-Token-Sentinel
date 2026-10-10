import { spawnSync } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number;
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): GitResult {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) return { ok: false, stdout: '', stderr: res.error.message, status: -1 };
  return { ok: res.status === 0, stdout: res.stdout.trimEnd(), stderr: res.stderr.trimEnd(), status: res.status ?? -1 };
}

export function gitOrThrow(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const res = git(cwd, args, env);
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).stdout === 'true';
}
