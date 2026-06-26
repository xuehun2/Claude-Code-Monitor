# Claude Code Monitor

A VS Code extension that shows a **live status bar + dashboard** for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), refreshing in real time from the Claude Code transcript.

It displays:

- **Current model** (e.g. `sonnet-4-6`, `glm-5.2`)
- **Context size** — current context tokens vs. the window limit, with a usage bar
- **Model request time** — duration of the last model request
- **Real-time output rate** — tokens/second for the last request
- **In-flight / retrying state** — elapsed time while a request is running, and a ⚠ flag when a request exceeds the retry/timeout threshold or an API error is detected
- Session totals, recent-request history, and a rate sparkline in the dashboard

## How it works

Claude Code writes a JSONL transcript per session under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Each assistant entry contains `message.model` and `message.usage` (input / output / cache tokens) plus a timestamp. The extension polls the active transcript (default every 1s) and derives:

| Metric | Source |
| --- | --- |
| Current model | last assistant `message.model` |
| Context size | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |
| Request time | assistant timestamp − preceding user/tool-result timestamp |
| Output rate | `output_tokens / request_duration` |
| In-flight | last user entry has no following assistant entry |
| Retrying / timeout | in-flight longer than `retryThresholdMs`, or an API-error entry is present |

> **Note on “retrying”:** Claude Code does not write an explicit “retrying” event to the transcript. This extension uses a heuristic — an in-flight request that exceeds the configured threshold, or the presence of an API-error message. Treat it as a strong hint, not a guarantee.

## Status bar

The status bar item shows a compact live summary, e.g.:

```
💬 sonnet-4-6 · 24.1k (12%) · 110 t/s · 3.2s
```

- `💬` idle · `🔄` (spinner) while generating · `⚠` while flagged as retrying
- Click it to open the dashboard. Hover for a full tooltip.

## Commands

- **Claude Code: Show Live Dashboard** — open the webview dashboard
- **Claude Code: Select Session to Monitor** — pick a different session
- **Claude Code: Open Transcript File** — open the raw JSONL
- **Claude Code: Refresh Now** — force a re-read

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `claudeCodeMonitor.projectsDir` | `~/.claude/projects` | Override the projects directory |
| `claudeCodeMonitor.contextLimit` | `200000` | Context window size for the % calc |
| `claudeCodeMonitor.refreshIntervalMs` | `1000` | Poll interval |
| `claudeCodeMonitor.retryThresholdMs` | `30000` | In-flight threshold to flag retrying |
| `claudeCodeMonitor.statusBarAlignment` | `right` | `left` or `right` |
| `claudeCodeMonitor.showInStatusBar` | `true` | Show the status bar item |
| `claudeCodeMonitor.maxHistoryRequests` | `40` | Recent requests kept for the dashboard |

## Build & install from source

Requirements: Node.js 18+ and VS Code 1.80+.

```bash
npm install
npm run compile
```

Then package and install (needs `@vscode/vsce`):

```bash
npm i -g @vscode/vsce
vsce package
code --install-extension claude-code-monitor-0.1.0.vsix
```

Or, for development: open the folder in VS Code and press **F5** (uses `.vscode/launch.json`).

## Notes

- The extension auto-selects the most recently modified transcript, preferring one whose `cwd` matches your workspace. Use **Select Session** to override.
- Polling is intentional: it is reliable on Windows and also drives the in-flight elapsed timer between transcript writes.
