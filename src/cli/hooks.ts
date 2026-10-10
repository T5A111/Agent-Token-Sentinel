/**
 * Agent hook adapters for Claude Code, Cursor and Windsurf.
 *
 * All three clients pipe a JSON payload to the hook command on stdin and
 * treat exit code 2 from a *pre* hook as "block this action". Payload
 * shapes differ and evolve, so fields are extracted tolerantly.
 *
 * Hooks fail open: an internal error never blocks the agent.
 */
import type { EventSource } from '../types.js';
import { Sentinel } from '../sentinel.js';

export type HookClient = 'claude' | 'cursor' | 'windsurf';
export type HookPhase = 'pre-edit' | 'post-edit' | 'post-command' | 'ignore';

export interface NormalizedHook {
  client: HookClient;
  event: string;
  phase: HookPhase;
  toolName?: string;
  files: string[];
  fragments: Array<{ oldText: string; newText: string }>;
  command?: string;
  exitCode?: number;
  output?: string;
  failedHint: boolean;
  roots: string[];
}

export interface HookResponse {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const EDIT_TOOL = /^(?:Edit|MultiEdit|Write|NotebookEdit)$|edit|write|replace|patch|create_file|delete_file/i;
const SHELL_TOOL = /^(?:Bash|BashOutput|shell|terminal)$|run_terminal|run_command|shell|terminal/i;
const SENTINEL_WRAPPED = /\b(?:sentinel|agent-token-sentinel)\s+run\b/;

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v);
  return undefined;
}
function firstStr(sources: Array<Json | undefined>, keys: string[]): string | undefined {
  for (const s of sources) for (const k of keys) if (s && str(s[k])) return str(s[k]);
  return undefined;
}
function firstNum(sources: Array<Json | undefined>, keys: string[]): number | undefined {
  for (const s of sources) for (const k of keys) if (s && num(s[k]) !== undefined) return num(s[k]);
  return undefined;
}

export function normalizeHookPayload(client: HookClient, payload: unknown, eventOverride?: string): NormalizedHook {
  const p = obj(payload) ?? {};
  const toolInput = obj(p.tool_input) ?? obj(p.toolInput) ?? obj(p.input) ?? obj(p.arguments);
  const toolInfo = obj(p.tool_info) ?? obj(p.toolInfo);
  const toolResponse = obj(p.tool_response) ?? obj(p.tool_output) ?? obj(p.toolResponse) ?? obj(p.result);
  const event = eventOverride ?? str(p.hook_event_name) ?? str(p.agent_action_name) ?? str(p.event) ?? 'unknown';
  const toolName = str(p.tool_name) ?? str(p.toolName) ?? str(p.tool);
  const sources = [toolInput, toolInfo, p];

  const files = [
    firstStr(sources, ['file_path', 'filePath', 'notebook_path', 'target_file', 'path', 'file']),
  ].filter((f): f is string => !!f);

  const fragments: NormalizedHook['fragments'] = [];
  const pushFragment = (e: Json | undefined) => {
    if (!e) return;
    const oldText = typeof e.old_string === 'string' ? e.old_string : typeof e.oldText === 'string' ? e.oldText : undefined;
    const newText = typeof e.new_string === 'string' ? e.new_string : typeof e.newText === 'string' ? e.newText : undefined;
    if (oldText !== undefined || newText !== undefined) fragments.push({ oldText: oldText ?? '', newText: newText ?? '' });
  };
  pushFragment(toolInput);
  for (const s of sources) if (s && Array.isArray(s.edits)) for (const e of s.edits) pushFragment(obj(e));

  const command = firstStr(sources, ['command', 'command_line', 'commandLine', 'cmd']);
  const exitCode = firstNum([toolResponse, toolInfo, p], ['exit_code', 'exitCode', 'returnCode', 'return_code', 'code', 'status']);
  const outputParts = [
    typeof p.tool_response === 'string' ? p.tool_response : undefined,
    firstStr([toolResponse, toolInfo, p], ['output', 'combined_output']),
    firstStr([toolResponse, toolInfo, p], ['stdout']),
    firstStr([toolResponse, toolInfo, p], ['stderr']),
  ].filter((x): x is string => !!x);
  const output = outputParts.length ? outputParts.join('\n') : undefined;
  const failedHint =
    /failure/i.test(event) || toolResponse?.is_error === true || toolResponse?.interrupted === true || !!str(toolResponse?.error) || p.success === false || toolResponse?.success === false;

  const roots = [
    ...(Array.isArray(p.workspace_roots) ? p.workspace_roots.filter((r): r is string => typeof r === 'string') : []),
    ...[str(p.cwd), str(toolInfo?.cwd)].filter((r): r is string => !!r),
  ];

  return { client, event, phase: classify(event, toolName), toolName, files, fragments, command, exitCode, output, failedHint, roots };
}

function classify(event: string, toolName: string | undefined): HookPhase {
  const e = event.toLowerCase();
  if (e === 'pre_write_code') return 'pre-edit';
  if (e === 'post_write_code' || e === 'afterfileedit') return 'post-edit';
  if (e === 'post_run_command' || e === 'aftershellexecution') return 'post-command';
  const pre = e === 'pretooluse';
  const post = e === 'posttooluse' || e === 'posttoolusefailure';
  if (!pre && !post) return 'ignore';
  if (toolName && EDIT_TOOL.test(toolName)) return pre ? 'pre-edit' : 'post-edit';
  if (toolName && SHELL_TOOL.test(toolName)) return pre ? 'ignore' : 'post-command';
  return 'ignore';
}

/** Failure markers used only when the client does not report an exit code. */
const FAILURE_MARKERS = /(?:^|\s)(?:FAIL\b|FAILED\b|✗|×\s|Error:|error TS\d+|Traceback \(most recent call last\)|npm ERR!|ELIFECYCLE|panicked at|BUILD FAILED|\d+ (?:failed|failing)\b)/m;
const ZERO_FAILURES = /\b0 (?:failed|failing|errors?)\b/;

export function inferExitCode(hook: NormalizedHook): number | undefined {
  if (hook.exitCode !== undefined) return hook.exitCode;
  if (hook.failedHint) return 1;
  if (!hook.output) return undefined;
  if (FAILURE_MARKERS.test(hook.output) && !ZERO_FAILURES.test(hook.output)) return 1;
  return 0;
}

export function resolveHookRoot(hook: NormalizedHook, explicit?: string): string {
  return explicit ?? process.env.SENTINEL_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.env.CURSOR_PROJECT_DIR ?? hook.roots[0] ?? process.cwd();
}

function blockResponse(client: HookClient, reason: string): HookResponse {
  const message = `[agent-token-sentinel] ${reason}`;
  if (client === 'cursor') {
    return {
      exitCode: 2,
      stdout: JSON.stringify({ permission: 'deny', decision: 'deny', agentMessage: message, agent_message: message, userMessage: 'Sentinel blocked this edit: circuit OPEN.', user_message: 'Sentinel blocked this edit: circuit OPEN.' }),
      stderr: message,
    };
  }
  return { exitCode: 2, stderr: message };
}

function allowResponse(client: HookClient, phase: HookPhase, note?: string): HookResponse {
  if (client === 'cursor' && phase === 'pre-edit') {
    return { exitCode: 0, stdout: JSON.stringify(note ? { permission: 'allow', agentMessage: `[agent-token-sentinel] ${note}` } : { permission: 'allow' }) };
  }
  if (client === 'claude' && note) {
    const hookEventName = phase === 'pre-edit' ? 'PreToolUse' : 'PostToolUse';
    return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: `[agent-token-sentinel] ${note}` } }) };
  }
  return { exitCode: 0, stderr: note ? `[agent-token-sentinel] ${note}` : undefined };
}

/** Message to the agent after the tool already ran (a trip on post-edit / post-command). */
function postAlert(client: HookClient, message: string): HookResponse {
  // Claude Code feeds stderr of a PostToolUse exit-2 hook back to the model.
  if (client === 'claude') return { exitCode: 2, stderr: `[agent-token-sentinel] ${message}` };
  return { exitCode: 0, stderr: `[agent-token-sentinel] ${message}` };
}

export function handleHook(client: HookClient, payload: unknown, options: { root?: string; event?: string } = {}): HookResponse {
  let hook: NormalizedHook;
  try {
    hook = normalizeHookPayload(client, payload, options.event);
  } catch {
    return { exitCode: 0 };
  }
  if (hook.phase === 'ignore') return { exitCode: 0 };

  try {
    const sentinel = new Sentinel({ root: resolveHookRoot(hook, options.root) });
    const source = `hook:${client}` as EventSource;

    if (hook.phase === 'pre-edit') {
      // Block any write while OPEN, even when the payload carries no path.
      const files = hook.files.length ? hook.files : [undefined];
      for (const f of files) {
        let file: string | undefined;
        try {
          file = f ? sentinel.toRel(f) : undefined;
        } catch {
          file = undefined; // outside project: still gated by circuit state
        }
        const d = sentinel.guardEdit(file);
        if (!d.allowed) return blockResponse(client, d.reason);
        if (d.decision === 'warn') return allowResponse(client, 'pre-edit', d.reason);
      }
      return allowResponse(client, 'pre-edit');
    }

    if (hook.phase === 'post-edit') {
      const notes: string[] = [];
      for (const f of hook.files) {
        let rel: string;
        try {
          rel = sentinel.toRel(f);
        } catch {
          continue;
        }
        const r = sentinel.recordEdit({ file: rel, fragments: hook.fragments, source });
        if (r.trip) return postAlert(client, `CIRCUIT OPEN — stop editing.\n${r.trip.markdown}`);
        if (r.assessment.level === 'high') notes.push(...r.assessment.reasons);
      }
      return notes.length ? allowResponse(client, 'post-edit', notes.join('; ')) : { exitCode: 0 };
    }

    // post-command
    const command = hook.command ?? hook.toolName ?? 'unknown command';
    if (SENTINEL_WRAPPED.test(command)) return { exitCode: 0 }; // `sentinel run` records itself
    if (!new RegExp(sentinel.config.runCommandPattern, 'i').test(command)) return { exitCode: 0 };
    const exitCode = inferExitCode(hook);
    if (exitCode === undefined) return { exitCode: 0 };
    const r = sentinel.recordRun({ command, exitCode, log: hook.output, source });
    if (r.trip) return postAlert(client, `CIRCUIT OPEN — stop editing.\n${r.trip.markdown}`);
    // The raw output is already in the agent's context; only add loop warnings, not a second copy of the error.
    if (exitCode !== 0 && r.assessment.reasons.length) {
      return allowResponse(client, 'post-command', `Loop signals (risk ${r.assessment.level}): ${r.assessment.reasons.join('; ')}. Run tests via \`sentinel run -- <cmd>\` to get distilled output.`);
    }
    return { exitCode: 0 };
  } catch (err) {
    return { exitCode: 0, stderr: `[agent-token-sentinel] hook error (ignored, failing open): ${(err as Error).message}` };
  }
}

export function handleGitPreCommit(root: string): HookResponse {
  try {
    const status = new Sentinel({ root }).status();
    if (status.status === 'OPEN') {
      return {
        exitCode: 1,
        stderr: `[agent-token-sentinel] Commit rejected: circuit OPEN (${status.reasons.join('; ')}).\nRead .sentinel/dead-ends/LATEST.md, then run \`sentinel reset\` once you have a new plan. Bypass with --no-verify if you really must.`,
      };
    }
    return { exitCode: 0 };
  } catch {
    return { exitCode: 0 };
  }
}
