/**
 * `sentinel uninstall` — remove exactly what `sentinel install` added.
 *
 * - Config files are edited surgically: only sentinel hook entries and the
 *   `token-sentinel` MCP server are removed; everything else is preserved.
 *   A file is deleted only when nothing but sentinel content was in it.
 * - Recovery data (`.sentinel/`, `refs/sentinel/*` snapshots and rollback
 *   backups) is kept unless `--purge` is given.
 * - Never throws on a malformed file: it is reported and left untouched.
 */
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, isGitRepo } from '../utils/git.js';
import { GIT_HOOK_MARKER, gitHooksDir, isSentinelHookEntry, MCP_SERVER_KEY, type InstallTarget } from './install.js';

export interface UninstallOptions {
  root: string;
  targets: InstallTarget[];
  /** Also clean the user-global Windsurf MCP config. */
  global?: boolean;
  /** Also delete `.sentinel/` (state, Dead-End logs) and all `refs/sentinel/*` snapshots/backups. */
  purge?: boolean;
  dryRun?: boolean;
}

export interface UninstallReport {
  /** Files edited (sentinel entries removed, other content kept). */
  edited: string[];
  /** Files or directories deleted. */
  deleted: string[];
  /** Git refs deleted (only with purge). */
  refsDeleted: string[];
  /** Data deliberately left in place, and why. */
  kept: string[];
  /** Problems that need a human (unparseable files, foreign hooks...). */
  warnings: string[];
}

type Json = Record<string, unknown>;

export function uninstall(options: UninstallOptions): UninstallReport {
  const root = resolve(options.root);
  const report: UninstallReport = { edited: [], deleted: [], refsDeleted: [], kept: [], warnings: [] };
  const dry = !!options.dryRun;
  const tag = (p: string) => (dry ? `${p} (dry-run)` : p);

  const deleteFile = (path: string) => {
    if (!existsSync(path)) return;
    if (!dry) unlinkSync(path);
    report.deleted.push(tag(path));
  };
  const deleteDir = (path: string) => {
    if (!existsSync(path)) return;
    if (!dry) rmSync(path, { recursive: true, force: true });
    report.deleted.push(tag(path));
  };
  /** Remove directories the installer created, but only when they are now empty. */
  const pruneEmptyDirs = (...dirs: string[]) => {
    if (dry) return;
    for (const d of dirs) {
      try {
        if (existsSync(d) && readdirSync(d).length === 0) {
          rmdirSync(d);
          report.deleted.push(d);
        }
      } catch {
        /* not empty or not ours */
      }
    }
  };

  /** Load JSON, apply `strip` (returns true when it removed something), then save or delete. */
  const editJson = (path: string, strip: (cfg: Json) => boolean) => {
    if (!existsSync(path)) return;
    let cfg: Json;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object');
      cfg = parsed as Json;
    } catch (err) {
      report.warnings.push(`${path}: left untouched, could not parse (${(err as Error).message})`);
      return;
    }
    if (!strip(cfg)) return;
    if (Object.keys(cfg).length === 0) {
      deleteFile(path);
      return;
    }
    if (!dry) writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
    report.edited.push(tag(path));
  };

  const stripMcp = (cfg: Json): boolean => {
    const servers = cfg.mcpServers;
    if (!isObject(servers) || !(MCP_SERVER_KEY in servers)) return false;
    delete servers[MCP_SERVER_KEY];
    if (Object.keys(servers).length === 0) delete cfg.mcpServers;
    return true;
  };

  /** Remove sentinel hook entries; drop emptied events/`hooks`; drop a lone `version` (Cursor). */
  const stripHooks = (cfg: Json, dropLoneVersion: boolean): boolean => {
    const hooks = cfg.hooks;
    if (!isObject(hooks)) return false;
    let changed = false;
    for (const [event, list] of Object.entries(hooks)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter((e) => !isSentinelHookEntry(e));
      if (kept.length === list.length) continue;
      changed = true;
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    if (!changed) return false;
    if (Object.keys(hooks).length === 0) delete cfg.hooks;
    if (dropLoneVersion && Object.keys(cfg).length === 1 && 'version' in cfg) delete cfg.version;
    return true;
  };

  if (options.targets.includes('claude')) {
    editJson(join(root, '.mcp.json'), stripMcp);
    editJson(join(root, '.claude', 'settings.json'), (cfg) => stripHooks(cfg, false));
    deleteDir(join(root, '.claude', 'skills', 'token-sentinel'));
    pruneEmptyDirs(join(root, '.claude', 'skills'), join(root, '.claude'));
  }

  if (options.targets.includes('cursor')) {
    editJson(join(root, '.cursor', 'mcp.json'), stripMcp);
    editJson(join(root, '.cursor', 'hooks.json'), (cfg) => stripHooks(cfg, true));
    deleteFile(join(root, '.cursor', 'rules', 'token-sentinel.mdc'));
    pruneEmptyDirs(join(root, '.cursor', 'rules'), join(root, '.cursor'));
  }

  if (options.targets.includes('windsurf')) {
    editJson(join(root, '.windsurf', 'hooks.json'), (cfg) => stripHooks(cfg, false));
    deleteFile(join(root, '.windsurf', 'rules', 'token-sentinel.md'));
    pruneEmptyDirs(join(root, '.windsurf', 'rules'), join(root, '.windsurf'));
    const globalMcp = join(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
    if (options.global) editJson(globalMcp, stripMcp);
    else if (existsSync(globalMcp) && readFileSync(globalMcp, 'utf8').includes(`"${MCP_SERVER_KEY}"`)) {
      report.kept.push(`${globalMcp} still lists "${MCP_SERVER_KEY}" (user-global). Re-run with --global to remove it.`);
    }
  }

  const gitRepo = isGitRepo(root);
  if (options.targets.includes('git') && gitRepo) {
    const hookPath = join(gitHooksDir(root), 'pre-commit');
    if (existsSync(hookPath)) {
      const body = readFileSync(hookPath, 'utf8');
      if (body.includes(GIT_HOOK_MARKER)) deleteFile(hookPath);
      else if (/\b(?:sentinel|agent-token-sentinel)\b.*hook git-pre-commit/.test(body)) {
        report.warnings.push(`${hookPath} is your own hook but calls the sentinel — remove the "hook git-pre-commit" line by hand.`);
      }
    }
  }

  // Recovery data.
  const stateDir = join(root, '.sentinel');
  const refs = gitRepo ? listSentinelRefs(root) : [];
  if (options.purge) {
    deleteDir(stateDir);
    for (const ref of refs) {
      if (!dry) git(root, ['update-ref', '-d', ref]);
      report.refsDeleted.push(tag(ref));
    }
  } else {
    if (existsSync(stateDir)) report.kept.push(`${stateDir} (state + Dead-End logs). Add --purge to delete.`);
    const backups = refs.filter((r) => r.startsWith('refs/sentinel/backups/')).length;
    if (refs.length) {
      report.kept.push(
        `${refs.length} git snapshot ref(s) under refs/sentinel/` +
          (backups ? `, including ${backups} rollback backup(s) that may hold reverted agent edits` : '') +
          '. Add --purge to delete.',
      );
    }
  }
  return report;
}

function listSentinelRefs(root: string): string[] {
  const out = git(root, ['for-each-ref', '--format=%(refname)', 'refs/sentinel/']).stdout;
  return out ? out.split('\n').filter(Boolean) : [];
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
