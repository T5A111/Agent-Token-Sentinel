import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * User-tunable thresholds. Loaded from `.sentinel/config.json`; any missing
 * field falls back to the default below. Invalid files never crash the
 * sentinel — they fall back to defaults and surface a warning.
 */
export const ConfigSchema = z.object({
  /** Consecutive failing runs (exit code != 0) before the breaker trips. */
  maxConsecutiveFailures: z.number().int().min(1).default(4),
  /** Line reciprocity rate above which a file is considered oscillating. */
  reciprocityThreshold: z.number().gt(0).max(1).default(0.6),
  /** How many recent edits per file the oscillation detector looks at. */
  oscillationWindow: z.number().int().min(3).default(5),
  /** Same error fingerprint occurrences (in a row) before tripping. */
  sameFingerprintLimit: z.number().int().min(2).default(3),
  /** Rounds a single function may be edited-and-failed in a row before HIGH risk. */
  hotspotRounds: z.number().int().min(2).default(3),
  /** Cool-down before an OPEN breaker allows one HALF_OPEN probe write. */
  cooldownMs: z.number().int().min(0).default(5 * 60 * 1000),
  /** Restore agent-touched files to the last green checkpoint when tripping. */
  autoRollback: z.boolean().default(true),
  /** Token budget for distilled logs. */
  distillTokenBudget: z.number().int().min(40).default(150),
  /** Debug rounds per compaction episode. */
  compactEvery: z.number().int().min(2).default(3),
  /** Lines of source context around the first project call site. */
  contextLines: z.number().int().min(0).max(10).default(3),
  /** Hard ceiling for the dynamic distill budget (scales with failures and repeats). */
  distillMaxBudget: z.number().int().min(40).default(600),
  /** Raw logs kept under .sentinel/logs for sentinel_expand_log. */
  maxLogs: z.number().int().min(1).default(30),
  /**
   * Claude Code: transparently route build/test Bash commands through
   * `sentinel run` (distilled output, exact exit codes). The raw log stays
   * retrievable, and `# sentinel:raw` in a command opts out.
   */
  autoWrapTests: z.boolean().default(true),
  /** Max tokens of sentinel memory injected after Claude Code compacts or resumes a session. */
  memoryTokenBudget: z.number().int().min(80).default(400),
  /** Max checkpoints kept under refs/sentinel/checkpoints. */
  maxCheckpoints: z.number().int().min(1).default(20),
  /**
   * Shell commands recognized by post-command hooks as build/test runs.
   * Other commands (ls, cat, git status...) are ignored.
   */
  runCommandPattern: z
    .string()
    .default(
      String.raw`\b(test|tests|vitest|jest|mocha|ava|tsc|build|lint|eslint|pytest|tox|cargo\s+(test|build|check)|go\s+(test|build|vet)|make|gradle|mvn|dotnet\s+(test|build)|bun\s+test|deno\s+test)\b`,
    ),
});

export type SentinelConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: SentinelConfig = ConfigSchema.parse({});

export interface LoadedConfig {
  config: SentinelConfig;
  warnings: string[];
}

export function loadConfig(root: string, overrides: Partial<SentinelConfig> = {}): LoadedConfig {
  const path = join(root, '.sentinel', 'config.json');
  const warnings: string[] = [];
  let fileValues: unknown = {};
  if (existsSync(path)) {
    try {
      fileValues = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      warnings.push(`Ignoring unreadable ${path}: ${(err as Error).message}`);
    }
  }
  const parsed = ConfigSchema.safeParse({ ...(isRecord(fileValues) ? fileValues : {}), ...overrides });
  if (!parsed.success) {
    warnings.push(`Invalid .sentinel/config.json, using defaults: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return { config: ConfigSchema.parse(overrides), warnings };
  }
  return { config: parsed.data, warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
