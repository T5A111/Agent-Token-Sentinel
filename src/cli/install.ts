/**
 * `sentinel install` — wire the sentinel into Claude Code, Cursor, Windsurf
 * and git. Existing JSON configs are merged, never clobbered.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, isGitRepo } from '../utils/git.js';

export type InstallTarget = 'claude' | 'cursor' | 'windsurf' | 'git';

export interface InstallOptions {
  root: string;
  targets: InstallTarget[];
  /** Command prefix used to invoke the sentinel CLI (default: node <this cli>). */
  command?: string;
  /** Also write the user-global Windsurf MCP config (~/.codeium/windsurf/mcp_config.json). */
  global?: boolean;
  dryRun?: boolean;
}

export interface InstallReport {
  written: string[];
  skipped: string[];
  notes: string[];
}

const GIT_HOOK_MARKER = '# agent-token-sentinel pre-commit';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PACKAGE_NAME = 'agent-token-sentinel';

/** Package-runner caches (npx, pnpm dlx, bunx) are wiped at will: never write their paths into configs. */
const EPHEMERAL_INSTALL = /[\\/]_npx[\\/]|[\\/]dlx-[^\\/]*[\\/]|[\\/]bunx-[^\\/]*[\\/]/;

/** How hooks/MCP configs should invoke this installation of the CLI. */
export function defaultCommands(here: string = fileURLToPath(import.meta.url)): { cli: string; mcp: { command: string; args: string[] } } {
  if (EPHEMERAL_INSTALL.test(here)) {
    return { cli: `npx -y ${PACKAGE_NAME}`, mcp: { command: 'npx', args: ['-y', PACKAGE_NAME, 'mcp'] } };
  }
  const isTs = here.endsWith('.ts');
  const cliPath = join(dirname(here), isTs ? 'index.ts' : 'index.js');
  const mcpPath = join(dirname(here), '..', 'mcp', isTs ? 'server.ts' : 'server.js');
  return isTs
    ? { cli: `npx tsx "${cliPath}"`, mcp: { command: 'npx', args: ['tsx', mcpPath] } }
    : { cli: `node "${cliPath}"`, mcp: { command: 'node', args: [mcpPath] } };
}

export function install(options: InstallOptions): InstallReport {
  const report: InstallReport = { written: [], skipped: [], notes: [] };
  const defaults = defaultCommands();
  const cli = options.command ?? defaults.cli;
  const mcp = options.command
    ? { command: options.command.split(' ')[0] ?? 'npx', args: [...options.command.split(' ').slice(1), 'mcp'] }
    : defaults.mcp;
  const root = resolve(options.root);
  const write = (path: string, content: string, mode?: number) => {
    if (options.dryRun) {
      report.written.push(`${path} (dry-run)`);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode) chmodSync(path, mode);
    report.written.push(path);
  };
  const mcpServerEntry = { command: mcp.command, args: mcp.args, env: { SENTINEL_ROOT: root } };
  const rules = agentRules();

  if (options.targets.includes('claude')) {
    // Project MCP server (.mcp.json is shared with the team; the root is resolved from CLAUDE_PROJECT_DIR).
    mergeJson(join(root, '.mcp.json'), (cfg) => {
      const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
      servers['token-sentinel'] = { command: mcp.command, args: mcp.args };
    }, write);
    mergeJson(join(root, '.claude', 'settings.json'), (cfg) => {
      const hooks = (cfg.hooks ??= {}) as Record<string, unknown[]>;
      const entry = (matcher: string) => ({ matcher, hooks: [{ type: 'command', command: `${cli} hook claude`, timeout: 30 }] });
      upsertHook(hooks, 'PreToolUse', entry('Edit|MultiEdit|Write|NotebookEdit'));
      upsertHook(hooks, 'PostToolUse', entry('Edit|MultiEdit|Write|NotebookEdit|Bash'));
      upsertHook(hooks, 'PostToolUseFailure', entry('Bash'));
    }, write);
    const skill = readPackageFile('SKILL.md');
    if (skill) write(join(root, '.claude', 'skills', 'token-sentinel', 'SKILL.md'), skill);
    else report.skipped.push('SKILL.md not found in package');
  }

  if (options.targets.includes('cursor')) {
    mergeJson(join(root, '.cursor', 'mcp.json'), (cfg) => {
      const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
      servers['token-sentinel'] = mcpServerEntry;
    }, write);
    mergeJson(join(root, '.cursor', 'hooks.json'), (cfg) => {
      cfg.version ??= 1;
      const hooks = (cfg.hooks ??= {}) as Record<string, unknown[]>;
      for (const event of ['preToolUse', 'afterFileEdit', 'afterShellExecution']) {
        upsertHook(hooks, event, { command: `${cli} hook cursor --event ${event}` });
      }
    }, write);
    write(join(root, '.cursor', 'rules', 'token-sentinel.mdc'), `---\ndescription: agent-token-sentinel loop breaker and context guard\nalwaysApply: true\n---\n\n${rules}`);
  }

  if (options.targets.includes('windsurf')) {
    mergeJson(join(root, '.windsurf', 'hooks.json'), (cfg) => {
      const hooks = (cfg.hooks ??= {}) as Record<string, unknown[]>;
      for (const event of ['pre_write_code', 'post_write_code', 'post_run_command']) {
        upsertHook(hooks, event, { command: `${cli} hook windsurf --event ${event}`, show_output: true });
      }
    }, write);
    write(join(root, '.windsurf', 'rules', 'token-sentinel.md'), `---\ntrigger: always_on\n---\n\n${rules}`);
    const globalMcp = join(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
    if (options.global) {
      mergeJson(globalMcp, (cfg) => {
        const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
        servers['token-sentinel'] = mcpServerEntry;
      }, write);
    } else {
      report.notes.push(
        `Windsurf reads MCP servers only from the user-global ${globalMcp}. Re-run with --global, or add:\n` +
          JSON.stringify({ mcpServers: { 'token-sentinel': mcpServerEntry } }, null, 2),
      );
    }
  }

  if (options.targets.includes('git')) {
    if (!isGitRepo(root)) {
      report.skipped.push('git: not a git repository');
    } else {
      const hooksDir = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).stdout || join(root, '.git', 'hooks');
      const hookPath = join(hooksDir, 'pre-commit');
      const script = `#!/bin/sh\n${GIT_HOOK_MARKER}\n${cli} hook git-pre-commit --root "$(git rev-parse --show-toplevel)" || exit 1\n`;
      if (existsSync(hookPath) && !readFileSync(hookPath, 'utf8').includes(GIT_HOOK_MARKER)) {
        report.skipped.push(`${hookPath} exists and is not ours — add this line to it:\n  ${cli} hook git-pre-commit || exit 1`);
      } else {
        write(hookPath, script, 0o755);
      }
    }
  }
  return report;
}

function mergeJson(path: string, mutate: (cfg: Record<string, unknown>) => void, write: (p: string, c: string) => void): void {
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`Refusing to overwrite unparseable ${path}; fix or remove it first.`);
    }
  }
  mutate(cfg);
  write(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Replace any existing sentinel hook entry for `event` with `entry`; other hooks are kept. */
function upsertHook(hooks: Record<string, unknown[]>, event: string, entry: Record<string, unknown>): void {
  const list = Array.isArray(hooks[event]) ? hooks[event] : [];
  const isOurs = (e: unknown) => / hook (?:claude|cursor|windsurf)\b/.test(JSON.stringify(e));
  hooks[event] = [...list.filter((e) => !isOurs(e)), entry];
}

function readPackageFile(name: string): string | undefined {
  const path = join(packageRoot, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** Compact always-on rules for Cursor / Windsurf (full guide: SKILL.md). */
export function agentRules(): string {
  return `# agent-token-sentinel rules

You are guarded by agent-token-sentinel (MCP server \`token-sentinel\`). Follow these rules:

1. Run builds/tests through \`sentinel run -- <command>\` (or call \`sentinel_record_run\` with the exit code and output after every build/test command).
2. Before editing a file, call \`sentinel_guard_edit\`. If it returns BLOCK, do not edit anything.
3. Never paste full logs into your reasoning: use the distilled output (\`sentinel_distill_log\`).
4. To read a large file, call \`sentinel_prune_file\` with the function/class names you need; edit the numbered lines it shows instead of rewriting the file.
5. When the circuit is OPEN: stop editing, read \`sentinel://dead-ends\` (or .sentinel/dead-ends/LATEST.md), answer its self-check questions, choose an approach that is NOT on the rejected list, then call \`sentinel_reset_circuit\` with your new hypothesis.
6. Every ~3 debug rounds, call \`sentinel_compact_history\` and rely on its [Compacted] summary instead of earlier tool output.
`;
}
