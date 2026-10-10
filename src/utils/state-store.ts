import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SentinelState } from '../types.js';

export function createInitialState(): SentinelState {
  return {
    version: 1,
    seq: 0,
    circuit: { status: 'CLOSED', reasons: [], probeGranted: false, tripCount: 0 },
    edits: [],
    runs: [],
    consecutiveFailures: 0,
    checkpoints: [],
    touchedFiles: [],
    deadEnds: [],
    compacted: [],
    compactedThroughSeq: 0,
    roundCounter: 0,
    revertedThroughSeq: 0,
  };
}

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Persists sentinel state under `<root>/.sentinel/`.
 *
 * - Writes are atomic (write temp file, then rename).
 * - A directory lock serializes read-modify-write cycles between the MCP
 *   server and short-lived hook processes running concurrently.
 * - A corrupt state file is quarantined and replaced with a fresh state.
 */
export class StateStore {
  readonly dir: string;
  readonly statePath: string;
  private readonly lockPath: string;

  constructor(readonly root: string) {
    this.dir = join(root, '.sentinel');
    this.statePath = join(this.dir, 'state.json');
    this.lockPath = join(this.dir, 'state.lock');
  }

  ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.ensureGitignored();
  }

  load(): SentinelState {
    if (!existsSync(this.statePath)) return createInitialState();
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<SentinelState>;
      if (parsed.version !== 1) throw new Error(`unsupported state version ${String(parsed.version)}`);
      return { ...createInitialState(), ...parsed, circuit: { ...createInitialState().circuit, ...parsed.circuit } };
    } catch {
      // Quarantine instead of crashing; the agent keeps working with a fresh state.
      try {
        renameSync(this.statePath, `${this.statePath}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return createInitialState();
    }
  }

  save(state: SentinelState): void {
    this.ensureDir();
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.statePath);
  }

  /** Locked read-modify-write. The mutator's return value is passed through. */
  update<T>(mutator: (state: SentinelState) => T): T {
    this.ensureDir();
    this.acquireLock();
    try {
      const state = this.load();
      const result = mutator(state);
      this.save(state);
      return result;
    } finally {
      this.releaseLock();
    }
  }

  writeArtifact(relativePath: string, content: string): string {
    this.ensureDir();
    const full = join(this.dir, relativePath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    return full;
  }

  readArtifact(relativePath: string): string | undefined {
    const full = join(this.dir, relativePath);
    return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
  }

  private acquireLock(): void {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        mkdirSync(this.lockPath);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue; // lock vanished between calls
        }
        if (Date.now() > deadline) {
          // Never deadlock the agent: break the lock and proceed.
          rmSync(this.lockPath, { recursive: true, force: true });
          continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  private releaseLock(): void {
    rmSync(this.lockPath, { recursive: true, force: true });
  }

  /**
   * Keep sentinel state out of version control without touching the user's
   * tracked .gitignore: a nested `.gitignore` containing `*` ignores the whole
   * directory (itself included).
   */
  private ensureGitignored(): void {
    const nested = join(this.dir, '.gitignore');
    if (!existsSync(nested)) writeFileSync(nested, '# agent-token-sentinel local state\n*\n');
  }
}
