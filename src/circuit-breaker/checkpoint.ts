import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Checkpoint, RollbackResult } from '../types.js';
import { git, gitOrThrow, isGitRepo } from '../utils/git.js';
import { makeId } from '../utils/hash.js';
import { toPosix } from '../utils/normalize.js';

const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: 'agent-token-sentinel',
  GIT_AUTHOR_EMAIL: 'sentinel@localhost',
  GIT_COMMITTER_NAME: 'agent-token-sentinel',
  GIT_COMMITTER_EMAIL: 'sentinel@localhost',
};

/**
 * Git-backed working-tree snapshots that never touch the user's branch,
 * HEAD, index or stash list.
 *
 * A snapshot is built with a *temporary* index (`GIT_INDEX_FILE`): the
 * working tree — untracked files included, ignored files excluded — is
 * staged into it, written as a tree, wrapped in a dangling commit and
 * pinned under `refs/sentinel/...` so `git gc` keeps it.
 */
export class CheckpointManager {
  private top?: string;
  private prefix = '';

  constructor(private readonly root: string) {}

  isAvailable(): boolean {
    if (this.top) return true;
    if (!isGitRepo(this.root)) return false;
    // Work from the repository top level; project paths are relative to `root`,
    // which may be a sub-directory (monorepo package).
    this.top = gitOrThrow(this.root, ['rev-parse', '--show-toplevel']);
    this.prefix = git(this.root, ['rev-parse', '--show-prefix']).stdout;
    return true;
  }

  private get cwd(): string {
    if (!this.isAvailable() || !this.top) throw new Error('not a git repository');
    return this.top;
  }

  /** Snapshot the whole working tree. */
  snapshot(namespace: 'checkpoints' | 'backups', label: string, now = Date.now()): Checkpoint {
    const id = makeId(namespace === 'checkpoints' ? 'cp' : 'bk', now);
    const tmpDir = mkdtempSync(join(tmpdir(), 'sentinel-index-'));
    const tmpIndex = join(tmpDir, 'index');
    try {
      const realIndex = gitOrThrow(this.cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
      if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex); // speeds up `add -A` via stat cache
      const env = { ...SNAPSHOT_ENV, GIT_INDEX_FILE: tmpIndex };
      gitOrThrow(this.cwd, ['add', '-A', '--', '.'], env);
      const tree = gitOrThrow(this.cwd, ['write-tree'], env);
      const head = git(this.cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
      const parentArgs = head.ok && head.stdout ? ['-p', head.stdout] : [];
      const commit = gitOrThrow(this.cwd, ['commit-tree', tree, ...parentArgs, '-m', `sentinel ${namespace}: ${label}`], env);
      const ref = `refs/sentinel/${namespace}/${id}`;
      gitOrThrow(this.cwd, ['update-ref', ref, commit]);
      return { id, ref, commit, label, createdAt: now, green: false };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** Files that differ between two snapshot commits. */
  changedBetween(fromCommit: string, toCommit: string): string[] {
    const out = gitOrThrow(this.cwd, ['diff', '--name-only', '--no-renames', fromCommit, toCommit]);
    return out ? out.split('\n').filter(Boolean) : [];
  }

  /**
   * Restore files to `checkpoint`. Before touching anything the current state
   * is saved as a backup snapshot so the rollback itself can be undone.
   *
   * @param onlyFiles restrict restoration to these paths (agent-touched files);
   *                  when empty, every file changed since the checkpoint is restored.
   */
  restore(checkpoint: Checkpoint, onlyFiles: readonly string[] = []): RollbackResult {
    if (!this.isAvailable()) return { performed: false, restoredFiles: [], deletedFiles: [], skippedReason: 'not a git repository' };
    if (!git(this.cwd, ['cat-file', '-e', `${checkpoint.commit}^{commit}`]).ok) {
      return { performed: false, restoredFiles: [], deletedFiles: [], skippedReason: `checkpoint ${checkpoint.id} no longer exists` };
    }
    const backup = this.snapshot('backups', `before rollback to ${checkpoint.id}`);
    const changed = this.changedBetween(checkpoint.commit, backup.commit);
    const scope = onlyFiles.length ? new Set(onlyFiles.map((f) => this.prefix + toPosix(f))) : undefined;
    const targets = scope ? changed.filter((f) => scope.has(f)) : changed;

    const restoredFiles: string[] = [];
    const deletedFiles: string[] = [];
    for (const file of targets) {
      const inCheckpoint = git(this.cwd, ['cat-file', '-e', `${checkpoint.commit}:${file}`]).ok;
      const projectPath = file.startsWith(this.prefix) ? file.slice(this.prefix.length) : file;
      if (inCheckpoint) {
        // `restore --worktree` leaves the user's index untouched.
        gitOrThrow(this.cwd, ['restore', `--source=${checkpoint.commit}`, '--worktree', '--', file]);
        restoredFiles.push(projectPath);
      } else {
        const full = join(this.cwd, file);
        if (existsSync(full)) unlinkSync(full);
        deletedFiles.push(projectPath);
      }
    }
    return { performed: true, checkpoint: checkpoint.id, backupRef: backup.ref, restoredFiles, deletedFiles };
  }

  /** Delete checkpoint refs beyond the newest `keep`. */
  prune(checkpoints: readonly Checkpoint[], keep: number): Checkpoint[] {
    const sorted = [...checkpoints].sort((a, b) => a.createdAt - b.createdAt);
    const drop = sorted.slice(0, Math.max(0, sorted.length - keep));
    for (const cp of drop) git(this.cwd, ['update-ref', '-d', cp.ref]);
    return sorted.slice(drop.length);
  }
}
