# agent-token-sentinel

[English](./README.md) | **繁體中文**

[![CI](https://github.com/T5A111/Token-Sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/T5A111/Token-Sentinel/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-token-sentinel.svg)](https://www.npmjs.com/package/agent-token-sentinel)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)

> 給 Coding Agent（Claude Code、Cursor、Windsurf 及任何 MCP 客戶端）用的本機優先看門狗與上下文優化引擎。
> 它會在 **打地鼠式除錯死循環** 燒光 Token、改壞程式碼之前**熔斷**，並**蒸餾膨脹的上下文**，讓 Agent 維持判斷精度。

所有分析都在本機完成：不呼叫任何外部 API，也沒有遙測。狀態存放在 `.sentinel/`，並自動排除在 git 之外。

> **狀態：Beta（v0.1）。** 核心引擎、MCP Server、CLI 與 Claude Code 整合都有測試覆蓋，並在 Linux、macOS、Windows 上執行。
> **Cursor 與 Windsurf 的 Hook 整合為 Beta**：依照官方公布的 Hook 格式實作，並用模擬資料測試過，但還沒在這兩個編輯器中做過完整的實機驗證。如果 Hook 沒有觸發，歡迎[開 Issue](https://github.com/T5A111/Token-Sentinel/issues) 並附上編輯器版本。

---

## 為什麼需要它

Coding Agent 最常在兩件事上浪費最多：

| 痛點 | 症狀 | Sentinel 的作法 |
|---|---|---|
| **打地鼠死循環** | 修好 A 壞了 B，修 B 又壞了 A；同一行 null-check 加了又刪、刪了又加；同一個錯誤反覆出現 5 次。 | 偵測代碼振盪、報錯指紋循環與連續失敗 → **觸發熔斷**、阻擋寫入、**自動回滾**髒代碼，並產出 **Dead-End Log**，強制 Agent 回到架構層級重新規劃。 |
| **上下文膨脹** | 3,000 Token 的 stack trace 裡塞滿 `node_modules`、整檔覆寫、累積 20 輪過時的工具輸出。 | **蒸餾日誌**到約 150 Token、用 AST **只讀需要的函式**、把歷史**濃縮成單行摘要**。 |

## 亮點

- 🔁 **代碼振盪偵測**：計算每個檔案最近 5 次修改的「行互逆率」，也就是被刪掉的行在之後 2 次修改內被加回來的比例。超過 60% 且最近一次執行失敗，就熔斷。
- 🧬 **報錯指紋**：先剝離時間戳、絕對路徑、`行:列`、記憶體位址、UUID、耗時、port、暫存目錄，再對 `ErrorName + 正規化訊息 + 專案內 stack + 失敗測試名` 計算 SHA-256。可偵測 `A→A→A`、`A→B→A`、`A→B→A→B` 三種模式。
- ⚡ **熔斷器**：CLOSED → OPEN → HALF_OPEN 三態。可手動重置（必須提出新的假設），或在冷卻後給一次試探機會。
- ⏪ **安全回滾**：用「暫存 index」建立 git 快照，存在 `refs/sentinel/*`。**絕不動**你的分支、HEAD、index 和 stash。只還原 Agent 動過的檔案，回滾前會先建立備份 ref，所以回滾本身也能復原。
- 🧪 **日誌蒸餾**：去除 ANSI 碼；剔除 `node_modules`、`node:internal`、Vite/Rollup/Webpack/esbuild/Vitest/Jest 內部 frame；保留錯誤訊息、失敗的測試、expected/received，以及**第一個專案呼叫點前後 3 行**。壓縮率通常在 95% 以上。
- 🌳 **AST 局部裁剪**：用 TypeScript Compiler API 只保留目標函式、類別或方法，加上它們引用到的同檔型別與 import。其餘程式碼摺疊為 `// ... [omitted N lines of unrelated logic]`，並保留原始行號。其他語言改用大括號或縮排的啟發式方法。
- 🗜️ **歷史斷代壓縮**：每 3 輪除錯自動產生一行摘要，例如：
  `[Compacted]: Rounds 1-3 attempted null-checks at src/auth.ts#login, failed with TypeError ×3. Reverted.`
- 🔌 **硬性攔截**：Claude Code、Cursor、Windsurf 的寫入前 Hook 在熔斷 OPEN 時以 exit code 2 阻擋寫入；git pre-commit hook 會拒絕提交。

## 架構

```
 ┌──────────── Coding Agent（Claude Code · Cursor · Windsurf · 任何 MCP 客戶端）────────────┐
 │                                                                                          │
 │   MCP tools ─────────────┐        pre/post hooks（stdin JSON）──┐     sentinel run --    │
 └──────────────────────────┼──────────────────────────────────────┼───────────┬────────────┘
                            ▼                                      ▼           ▼
                   src/mcp/server.ts                       src/cli/hooks.ts  src/cli/index.ts
                            └───────────────┬──────────────────────┴───────────┘
                                            ▼
                                   src/sentinel.ts（Facade · 加鎖讀改寫）
             ┌──────────────────────────────┼─────────────────────────────────────┐
             ▼                              ▼                                     ▼
   ┌── circuit-breaker/ ──────┐   ┌── token-guard/ ─────────┐          ┌── utils/ ─────────────┐
   │ detector.ts  行互逆率     │   │ distiller.ts 日誌→150t   │          │ state-store（原子寫入 │
   │              報錯指紋     │   │ pruner.ts    AST 摺疊    │          │   + 檔案鎖）          │
   │              熱區/風險    │   │ compactor.ts 斷代壓縮    │          │ ast · diff · git      │
   │ breaker.ts   狀態機       │   └──────────────────────────┘          │ normalize · tokens    │
   │ checkpoint.ts git 快照    │                                         └───────────────────────┘
   └───────────────────────────┘
                                            ▼
                     .sentinel/state.json · dead-ends/*.md · refs/sentinel/*
```

## 快速開始

需要 **Node.js ≥ 20** 與 **git**（git 只有回滾功能會用到）。

**方式 A：從 npm 安裝（推薦）**

```bash
cd ~/my-project
npx agent-token-sentinel install --all     # 一次設定 Claude Code + Cursor + Windsurf + git hook
# 或全域安裝，取得速度較快的 `sentinel` 指令：
npm install -g agent-token-sentinel && sentinel install --all
```

**方式 B：從原始碼安裝**

```bash
git clone https://github.com/T5A111/Token-Sentinel.git && cd Token-Sentinel
npm install && npm run build && npm link   # `npm link` 會把 `sentinel` 指令加入 PATH
cd ~/my-project && sentinel install --all
```

`sentinel install` 會**合併**進既有設定，不會覆蓋，重複執行也不會產生重複項目。可以用 `--claude`、`--cursor`、`--windsurf`、`--git` 個別安裝，或用 `--dry-run` 只預覽不寫入。
透過 `npx` 執行時，產生的設定會呼叫 `npx -y agent-token-sentinel …`，不會指向 npx 的暫存快取目錄。全域安裝或從原始碼安裝時，會直接呼叫已安裝的腳本，速度較快。

接著讓 Agent 透過包裝器執行測試（安裝時寫入的 `SKILL.md` 與規則檔已經會要求 Agent 這樣做）：

```bash
sentinel run -- npm test      # 或：npx agent-token-sentinel run -- npm test
```

exit code 會原樣傳回；失敗時印出蒸餾後的錯誤，而不是原始日誌。

## 整合設定

### Claude Code

`sentinel install --claude` 會寫入以下檔案：

**`.mcp.json`**
```json
{ "mcpServers": { "token-sentinel": { "command": "node", "args": ["/abs/path/dist/mcp/server.js"] } } }
```

**`.claude/settings.json`**：PreToolUse 在 OPEN 時以 exit 2 阻擋寫入；PostToolUse 記錄每次修改與測試結果。
```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "Edit|MultiEdit|Write|NotebookEdit",      "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }],
    "PostToolUse": [{ "matcher": "Edit|MultiEdit|Write|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }],
    "PostToolUseFailure": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node \"/abs/path/dist/cli/index.js\" hook claude", "timeout": 30 }] }]
  }
}
```

**`.claude/skills/token-sentinel/SKILL.md`**：給 Agent 的操作規則（見 [SKILL.md](./SKILL.md)）。

### Cursor *（Beta）*

`sentinel install --cursor` 會寫入 `.cursor/mcp.json`、`.cursor/hooks.json`，以及 `.cursor/rules/token-sentinel.mdc`（設定為 `alwaysApply: true`）：

```json
{
  "version": 1,
  "hooks": {
    "preToolUse":          [{ "command": "node \"/abs/path/dist/cli/index.js\" hook cursor --event preToolUse" }],
    "afterFileEdit":       [{ "command": "node \"/abs/path/dist/cli/index.js\" hook cursor --event afterFileEdit" }],
    "afterShellExecution": [{ "command": "node \"/abs/path/dist/cli/index.js\" hook cursor --event afterShellExecution" }]
  }
}
```

熔斷 OPEN 時，`preToolUse` 會回傳 `{"permission":"deny", ...}`，並以 exit 2 結束。

### Windsurf（Cascade）*（Beta）*

`sentinel install --windsurf` 會寫入 `.windsurf/hooks.json` 和 `.windsurf/rules/token-sentinel.md`（設定為 `trigger: always_on`）：

```json
{
  "hooks": {
    "pre_write_code":   [{ "command": "node \"/abs/path/dist/cli/index.js\" hook windsurf --event pre_write_code",   "show_output": true }],
    "post_write_code":  [{ "command": "node \"/abs/path/dist/cli/index.js\" hook windsurf --event post_write_code",  "show_output": true }],
    "post_run_command": [{ "command": "node \"/abs/path/dist/cli/index.js\" hook windsurf --event post_run_command", "show_output": true }]
  }
}
```

Windsurf 的 MCP 設定**只有全域檔** `~/.codeium/windsurf/mcp_config.json`。加上 `--global` 參數，安裝器就會自動合併；也可以手動加入：

```json
{ "mcpServers": { "token-sentinel": { "command": "node", "args": ["/abs/path/dist/mcp/server.js"], "env": { "SENTINEL_ROOT": "/abs/path/to/project" } } } }
```

### Git

`sentinel install --git` 會加入 `pre-commit` hook，在熔斷 OPEN 時拒絕提交。如果已經有其他人的 hook，安裝器不會覆蓋，而是印出需要手動加入的那一行。

### 各客戶端支援程度

| 客戶端 | MCP 工具 | 硬性阻擋寫入 | 自動記錄修改 | 自動記錄測試 |
|---|---|---|---|---|
| Claude Code | ✅ | ✅ PreToolUse exit 2 | ✅ PostToolUse | ✅（要精確的 exit code，請用 `sentinel run`） |
| Cursor *（Beta）* | ✅ | ✅ preToolUse exit 2 / `deny` | ✅ afterFileEdit | ✅ afterShellExecution |
| Windsurf *（Beta）* | ✅（全域設定） | ✅ pre_write_code exit 2 | ✅ post_write_code | ✅ post_run_command |
| 其他 MCP 客戶端 | ✅ | 僅勸導（`sentinel_guard_edit`） | `sentinel_record_edit` | `sentinel_record_run` / `sentinel run` |
| git | — | ✅ pre-commit | — | — |

> 各客戶端、各版本送給 Hook 的 payload 欄位都不同，因此採用寬鬆解析。若客戶端沒有提供指令的 exit code，會從輸出內容（`FAIL`、`error TS…`、`Traceback` 等）推斷是否失敗。需要精確結果時，請用 `sentinel run -- <cmd>` 執行測試；這類執行只會記錄一次，post-command hook 會自動略過。

## MCP 介面

| Tool | 用途 |
|---|---|
| `sentinel_guard_edit {file, intent?}` | 修改前呼叫，回傳 ALLOW / WARN / BLOCK，並為該檔建立快照。 |
| `sentinel_record_edit {file, diff? \| before?/after?}` | 沒有安裝 Hook 時，用來手動記錄修改。 |
| `sentinel_record_run {command, exitCode, log?}` | 記錄建置或測試結果，回傳蒸餾後的錯誤，必要時觸發熔斷。 |
| `sentinel_check_circuit {}` | 查看熔斷狀態、風險等級、互逆率、指紋模式、熱區與 checkpoint。 |
| `sentinel_reset_circuit {hypothesis}` | 關閉熔斷；必須提出新的根因假設（至少 15 字元）。 |
| `sentinel_checkpoint {label?}` | 建立工作區快照，作為回滾目標。 |
| `sentinel_distill_log {log, tokenBudget?}` | 壓縮日誌。 |
| `sentinel_prune_file {file, targets[], lineNumbers?}` | 只讀取需要的符號。 |
| `sentinel_compact_history {}` | 把舊回合濃縮成 `[Compacted]` 摘要。 |

Resources：`sentinel://state`、`sentinel://dead-ends`、`sentinel://history`。

## CLI

```
sentinel run [--raw] -- <cmd...>      sentinel status [--json]        sentinel reset [--hypothesis "..."]
sentinel checkpoint [label]           sentinel rollback [id]          sentinel distill [file|-] [--budget N]
sentinel prune <file> <symbol...>     sentinel compact | history      sentinel dead-ends
sentinel install [--claude|--cursor|--windsurf|--git|--all] [--global] [--command "..."] [--dry-run]
sentinel hook <claude|cursor|windsurf|git-pre-commit> [--event name]
sentinel mcp
```

熔斷 OPEN 時，`sentinel status` 會以 exit code 3 結束，方便在腳本中判斷。

## 設定（`.sentinel/config.json`）

所有欄位都是選填。設定檔格式錯誤時會改用預設值並顯示警告，不會讓工具崩潰。

| 欄位 | 預設值 | 作用 |
|---|---|---|
| `maxConsecutiveFailures` | `4` | 連續失敗幾次就熔斷。 |
| `reciprocityThreshold` | `0.6` | 振盪門檻：被刪掉的行在之後 2 次修改內被加回的比例。 |
| `oscillationWindow` | `5` | 每個檔案回看最近幾次修改。 |
| `sameFingerprintLimit` | `3` | 同一個報錯指紋連續出現幾次就熔斷。 |
| `hotspotRounds` | `3` | 同一函式連續幾輪被修改且失敗，就發出 HIGH 風險警告。 |
| `cooldownMs` | `300000` | OPEN 多久之後允許一次 HALF_OPEN 試探。 |
| `autoRollback` | `true` | 熔斷時是否還原 Agent 動過的檔案（設為 `false` 則只阻擋寫入）。 |
| `distillTokenBudget` | `150` | 蒸餾後日誌的 Token 上限。 |
| `compactEvery` | `3` | 每幾輪除錯壓縮成一段摘要。 |
| `contextLines` | `3` | 呼叫點前後顯示幾行原始碼。 |
| `maxCheckpoints` | `20` | 最多保留幾個 checkpoint ref。 |
| `runCommandPattern` | 測試／建置指令的正則 | post-command hook 用來判斷哪些 shell 指令算是建置或測試。 |

**熔斷條件**（任一成立即觸發）：
- 連續失敗次數 ≥ `maxConsecutiveFailures`
- 同一指紋連續出現次數 ≥ `sameFingerprintLimit`
- 報錯循環 `A→B→A` 或乒乓 `A→B→A→B`
- 振盪率 > `reciprocityThreshold`，且最近一次執行失敗
- HALF_OPEN 試探失敗

## 自我驗證

```bash
npm run typecheck && npm test   # 單元與整合測試
npm run test:pack               # 打包 npm tarball，安裝到乾淨專案後執行 CLI 與 MCP 握手
```

CI 會在 Linux、macOS、Windows 上，以 Node 20、22、24 執行以上兩組測試。

測試套件 `tests/self-test.ts` 涵蓋規格要求的 4 個情境，另外加測回滾、AST 裁剪、歷史壓縮、MCP 協定和 CLI／安裝器：

| # | 情境 | 驗證內容 |
|---|---|---|
| 1 | 新增 → 刪除 → 加回同一行 | 互逆率 100% > 60%，標記為死循環風險；正常的漸進修改為 0% |
| 2 | 兩份時間、路徑、行號、位址都不同的 Vitest 日誌 | SHA-256 完全一致；連續失敗計數正確；A→A→A 觸發熔斷 |
| 3 | 105 行 Vite／node_modules 日誌 | 壓到 ≤ 10 行、≤ 150 Token，保留錯誤訊息與呼叫點前後 3 行（−96%） |
| 4 | 連續失敗 4 次 | 進入 OPEN、產出 Dead-End JSON+MD、寫入被阻擋（三家 Hook 皆 exit 2）、HALF_OPEN 試探、重置成功 |
| 5 | 真實 git repo | Agent 改的檔案被還原、新建檔案被移除、人工修改不受影響、HEAD／index／stash 未被動到、備份 ref 存在 |
| 6 | 252 行 TS 檔 | 保留目標函式、遞移引用的型別與用到的 import，其餘摺疊 |
| 7 | 6 輪除錯 | 第 4 輪後自動產生 `[Compacted]` 摘要；釋放 ≥ 70% 歷史 Token（實測 82.6%） |
| 8 | MCP client ↔ server | 所有工具都能列出並呼叫；參數驗證失敗與路徑穿越都以 tool error 回傳 |
| 9 | `sentinel run`、`install --all`、git pre-commit | exit code 原樣傳回、輸出已蒸餾、設定合併可重複執行、OPEN 時拒絕提交 |

## 目錄結構

```
src/
├── circuit-breaker/  detector.ts · breaker.ts · checkpoint.ts
├── token-guard/      distiller.ts · pruner.ts · compactor.ts
├── mcp/              server.ts
├── cli/              index.ts · hooks.ts · install.ts
├── utils/            ast.ts · diff.ts · git.ts · hash.ts · normalize.ts · state-store.ts · tokens.ts · approach.ts
├── sentinel.ts       Facade（加鎖、持久化、模組串接）
├── config.ts · types.ts · index.ts
tests/self-test.ts    自我驗證套件
SKILL.md              給 Agent 的規則
```

## 已知限制

- Token 數是離線估算（約 4 字元算 1 Token，中日韓文字約 1 字算 1 Token），誤差約 ±15%。
- 回滾需要 git repo；沒有 git 時只會阻擋寫入，不會回滾。
- 精確的 AST 裁剪只支援 TS/JS（`.ts .tsx .js .jsx .mts .cts .mjs .cjs`），其他語言改用啟發式方法。
- 刻意繞過的 Agent（例如直接用 shell 寫檔）仍然擋不住。Hook 只能管住編輯器的寫入工具，git hook 只能管住 commit。

## 參與貢獻

歡迎提交 Issue 和 PR。開發與發版流程請見 [CONTRIBUTING.md](./CONTRIBUTING.md)，版本紀錄請見 [CHANGELOG.md](./CHANGELOG.md)。

## 授權

MIT
