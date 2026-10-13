---
name: token-sentinel
description: Loop breaker and context guard for debugging sessions. Use whenever you build, compile or run tests, before editing a file during a fix, when reading a large file, when a log is long, and ALWAYS when a tool reports that the sentinel circuit is OPEN.
---

# agent-token-sentinel — Agent Operating Rules

You are paired with **agent-token-sentinel**, a local watchdog that detects
whack-a-mole debugging loops and keeps your context window lean. It exposes
MCP tools (server `token-sentinel`) and a CLI (`sentinel`). Editor hooks may
already enforce some of these rules; follow them anyway.

## 1. When to call what

| Moment | Do this | Why |
|---|---|---|
| Running a build / test / type-check | Just run it. In Claude Code it is routed through `sentinel run` automatically; elsewhere use `sentinel run -- <cmd>` **or** call `sentinel_record_run {command, exitCode, log}` afterwards | Records the exit code, fingerprints the error, returns a distilled failure listing **every** failing test. |
| The distilled failure is not enough | `sentinel_expand_log {run, failure: N}` / `{grep: "…"}` / `{from, to}` | Pulls exactly the raw lines you need from the stored log. Never re-run a slow test suite just to see more output. |
| Before editing a file while fixing a failure | `sentinel_guard_edit {file, intent}` | Snapshots the file; answers ALLOW / WARN / BLOCK. |
| After editing (only if no editor hook is installed) | `sentinel_record_edit {file}` | Feeds the flip-flop detector. |
| A log longer than ~40 lines | `sentinel_distill_log {log}` | Strips ANSI, node_modules and bundler frames; keeps error + first project call site ±3 lines. |
| Reading a file > ~200 lines | `sentinel_prune_file {file, targets:["fn","Class.method"]}` | Returns only the target + referenced types/imports, with original line numbers. |
| Every ~3 debug rounds | `sentinel_compact_history` | Replace your memory of earlier rounds with the `[Compacted]` lines. |
| Unsure whether you are looping | `sentinel_check_circuit` | Shows the failure streak, reciprocity rate, fingerprint pattern and hotspot. |

## 2. Hard rules

1. **Never write while the circuit is OPEN.** A BLOCK is not an error to work
   around: do not switch tools, shell redirection (`cat > file`), or another
   path to write anyway.
2. **Never paste a raw log** into your reasoning or into a reply when a
   distilled version is available. If you need more, expand the specific
   part with `sentinel_expand_log`; use `# sentinel:raw` only as a last resort.
3. **Never rewrite a whole file** to change a few lines. Prune, then edit
   the numbered lines.
4. **Never retry an approach listed under "Rejected approaches"** in a
   Dead-End log, including cosmetic variations (renaming the guard, moving
   the null-check one line up, wrapping the same call in try/catch).
5. **Do not edit tests to make them pass** unless the user confirms that
   the expectation is wrong.

## 3. Thresholds (defaults, `.sentinel/config.json`)

| Key | Default | Trips / warns when |
|---|---|---|
| `maxConsecutiveFailures` | 4 | 4 failing runs in a row → **trip** |
| `sameFingerprintLimit` | 3 | Same error fingerprint 3× in a row (A→A→A) → **trip** |
| — | — | Error cycle A→B→A or ping-pong A→B→A→B → **trip** |
| `reciprocityThreshold` | 0.6 | > 60% of deleted lines re-added within 2 edits **and** last run failed → **trip** |
| `oscillationWindow` | 5 | Edits per file examined for flip-flops |
| `hotspotRounds` | 3 | Same function edited in 3 consecutive failing rounds → **HIGH risk warning** |
| `cooldownMs` | 300000 | After 5 min OPEN, one HALF_OPEN probe attempt is allowed |
| `autoRollback` | true | On trip, agent-touched files are restored to the last clean checkpoint |
| `distillTokenBudget` | 150 | Base tokens of a distilled log; grows with the number of failures and when the same failure repeats (up to `distillMaxBudget` 600) |
| `autoWrapTests` | true | Claude Code routes build/test commands through `sentinel run`; add `# sentinel:raw` to a command to see raw output instead |
| `compactEvery` | 3 | Rounds per `[Compacted]` episode |
| `contextLines` | 3 | Source lines around the call site |

Risk levels: `low` → proceed · `medium` → slow down, re-read the error ·
`high` (WARN) → stop patching symptoms; read callers and types first ·
`critical` → the breaker trips.

## 4. When the circuit trips (standard self-diagnosis procedure)

The sentinel has already: blocked writes, rolled your edits back to the last
clean checkpoint (a backup of your edits is kept under
`refs/sentinel/backups/*`), and written a Dead-End log.

1. **Stop.** Do not edit anything. Do not re-run the same test in hope.
2. **Read** `sentinel://dead-ends` (or `.sentinel/dead-ends/LATEST.md`):
   why it tripped, rejected approaches, the error fingerprints, the attempts.
3. **Answer every question** in "Required architecture-level self-check" in
   writing, briefly:
   - Restate the failing behavior without mentioning the code you changed.
   - Name the root-cause *layer*: data shape · module contract · async
     ordering · configuration/env · the test itself.
   - List ≥ 2 hypotheses that are NOT variations of rejected approaches, each
     with the cheapest experiment that could falsify it.
4. **Gather evidence read-only**: `sentinel_prune_file` on callers and type
   definitions, `git log -p` on the failing area, check config/env. Running
   read-only commands is allowed while OPEN.
5. If the test expectation may be wrong, or you need a decision → **ask the
   user** instead of guessing.
6. **Reset with a hypothesis**: `sentinel_reset_circuit {hypothesis}` (or
   `sentinel reset --hypothesis "..."`). The hypothesis must name the new
   root cause and the single change you will make.
7. Make **one minimal change**, run tests via `sentinel run`, and evaluate.
   If the breaker trips again on the same area, escalate to the user with
   the two Dead-End logs instead of trying a third time.

**HALF_OPEN** (after the cool-down, if you did not reset): you get exactly
one probe attempt. Edits are allowed until the next recorded run: pass →
CLOSED, fail → OPEN again.

## 5. After the conversation is compacted

If you see a block starting with `[agent-token-sentinel memory · after compact]`,
it is the authoritative record of this debugging session: the open problem,
what was already tried (do not retry it) and where the full logs are. Continue
from it rather than re-discovering the same facts.

## 6. Reading sentinel output

- `✖ TypeError: … / at fn (src/x.ts:42:7) / > 42 | code` — the distilled
  error; the `>` line is the first project call site.
- `also failing (3): • test — Error: …` — the other failures in the same run.
  Fix them together when they share a cause; otherwise expect them next.
- `[sentinel: … · full log: sentinel_expand_log run=run-12]` — where the raw
  log is. `escalated ×N` means you have hit this exact failure N+1 times: the
  extra context is there to make you look wider, not to patch the same line.
- `[Compacted]: Rounds 1-3 attempted null-checks at src/auth.ts#login, failed with TypeError ×3. Reverted.`
  — everything you need to remember about those rounds; drop the details.
- `⚠️ Hotspot: …` — you keep patching the same function; widen the view.
- `⛔ BLOCK [circuit OPEN]` — follow section 4.
