# Claude Code Monitor

**🇬🇧 English** ｜ [🇨🇳 中文 (GitHub)](https://github.com/xuehun2/Claude-Code-Monitor/blob/main/README.md)

A VS Code extension that provides a **live status bar + dashboard** for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — model, context usage, output rate, TTFT, and retry status at a glance.

**为 Claude Code 提供实时状态栏监控的 VS Code 扩展——模型、上下文占用、输出速率、首字节延迟、重试状态，一目了然。**

---

[📖 查看中文版说明 (View Chinese README)](https://github.com/xuehun2/Claude-Code-Monitor/blob/main/README.md)

---

## ✨ Features

- **Multi-session support** — Each Claude Code window gets its own status bar item, auto-discovered and tracked independently
- **Session titles** — Status bar shows session name (e.g. `开发Cl…`) for easy identification
- **Current model** — Real-time model name (e.g. `glm-5.2`, `sonnet-4-6`)
- **Context usage** — Current context tokens vs. window limit with percentage (e.g. `142.5k (71%)`)
- **Output details** — Bracketed display of last request's output tokens, TTFT, and rate (e.g. `[3.4k · 3.7s · 130 t/s]`)
- **Live timer** — Elapsed time while a request is in progress (e.g. `⏱8.4s`)
- **Interrupt detection** — Shows `⏹interrupted` (red background) after user presses Esc, persists until next request starts
- **Retry detection** — Real attempt counter and error type parsed from VS Code output log (e.g. `↻2/11 ServerOverloaded`, yellow warning background)
- **Auto-hide** — No status bar items shown when no active Claude Code sessions exist

## 📊 Status Bar Examples

| State | Display |
| --- | --- |
| Idle | `💬 开发Cl… · glm-5.2 · 142.5k (71%) · [3.4k · 3.7s · 130 t/s]` |
| Generating | `⟳ 开发Cl… · glm-5.2 · 142.5k (71%) · [3.4k · 3.7s · 130 t/s] ⏱8.4s` |
| Retrying | `⚠ 开发Cl… · glm-5.2 · 142.5k (71%) · [3.4k · 3.7s · 130 t/s] ↻2/11 ServerOverloaded` |
| Interrupted | `✕ 开发Cl… · glm-5.2 · 142.5k (71%) · [3.4k · 3.7s · 130 t/s] ⏹interrupted` |

## 🖥️ Dashboard

Click the status bar or run `Claude Code: Show Live Dashboard` to open the webview panel with:

- Real-time status cards (model / context progress bar / request duration / output rate / live timer)
- Rate sparkline
- Recent request history table

## 📐 How It Works

The extension reads from two data sources:

### 1. Transcript (session record)
Path: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`

Each assistant entry contains `message.model` and `message.usage` (input/output/cache tokens). The extension polls the transcript to derive model, context size, request duration, and output rate.

### 2. VS Code Output Log (real-time signals)
Path: `<VS Code logs>/exthost/Anthropic.claude-code/Claude VScode.log`

Tailed in real time via `fs.watch` for signals the transcript cannot provide:

| Signal | Log format | Description |
| --- | --- | --- |
| Running/idle | `update_session_state {sessionId, state, title}` | Per-session running state and title |
| Interrupt | `interrupt_claude` | User pressed Esc; persists until next request |
| First-byte latency | `first byte after Xms` | Time to first token (TTFT) |
| Retry counter | `API error (attempt N/M): 429 ...` | Real attempt count, HTTP status, error type |
| Slow first byte | `Slow first byte (attempt N)` | 30s without first chunk, soft timeout warning |

### 3. Session Discovery
Path: `~/.claude/sessions/<pid>.json`

Each live Claude Code process writes a JSON file (with sessionId, pid, cwd). The extension scans these and checks process liveness via `process.kill(pid, 0)`. Status bar items auto-disappear when processes exit.

## ⚙️ Commands

| Command | Description |
| --- | --- |
| `Claude Code: Show Live Dashboard` | Open the webview panel |
| `Claude Code: Select Session to Monitor` | Pick a session to monitor |
| `Claude Code: Open Transcript File` | Open the raw JSONL transcript |
| `Claude Code: Refresh Now` | Force a re-read |

## 🔧 Configuration

| Key | Default | Description |
| --- | --- | --- |
| `claudeCodeMonitor.projectsDir` | `""` (auto-detect) | Override Claude Code projects directory |
| `claudeCodeMonitor.contextLimit` | `200000` | Context window size for percentage calculation |
| `claudeCodeMonitor.refreshIntervalMs` | `1000` | Poll interval (ms) |
| `claudeCodeMonitor.retryThresholdMs` | `30000` | Legacy threshold (deprecated; retry detection now log-driven) |
| `claudeCodeMonitor.statusBarAlignment` | `"right"` | Status bar alignment: `left` or `right` |
| `claudeCodeMonitor.showInStatusBar` | `true` | Show the status bar item |
| `claudeCodeMonitor.maxHistoryRequests` | `40` | Recent requests kept for dashboard |

## 🔨 Build from Source

Requirements: Node.js 18+ and VS Code 1.80+

```bash
npm install
npm run compile
```

Package and install (needs `@vscode/vsce`):

```bash
npm i -g @vscode/vsce
vsce package
code --install-extension claude-code-monitor-0.1.0.vsix
```

For development: open the folder in VS Code and press **F5**.

## ⚠️ Known Limitations

- **Live token rate unavailable** — Claude Code's streaming WebSocket is locked to third-party extensions (auth rejected with `1008 Unauthorized`). The transcript only writes final token counts on request completion, and the log contains no streaming token data. Rate therefore shows the **last completed request**'s value; per-second live rate cannot be computed during streaming.
- **Retry attribution** — Log lines like `[API REQUEST]`, `Stream started`, and `API error` carry no sessionId. They are attributed to the "currently running" session. If two sessions run concurrently and interleave requests, attribution may occasionally be wrong, but primary state (title/running/context) is always accurate.
- **Retry countdown** — The CLI's "retrying in X seconds" countdown is only printed to the terminal and not written to the VS Code log, so it cannot be displayed.

## 📄 License

[MIT](LICENSE)
