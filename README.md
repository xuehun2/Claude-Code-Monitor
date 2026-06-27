# Claude Code Monitor

**🇨🇳 中文** ｜ [🇬🇧 English (GitHub)](https://github.com/xuehun2/Claude-Code-Monitor#readme)

为 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 提供实时状态栏监控的 VS Code 扩展——模型、上下文占用、输出速率、首字节延迟、重试状态，一目了然。

**Real-time status bar monitor for Claude Code in VS Code — model, context usage, output rate, TTFT, and retry status at a glance.**

---

[📖 查看英文版说明 (View English README)](https://github.com/xuehun2/Claude-Code-Monitor#readme)

---

## ✨ 功能特性

- **多会话支持** — 同时打开多个 Claude Code 窗口时，每个窗口独立显示一条状态栏，自动发现和跟踪
- **会话标题** — 状态栏显示会话名称（如"开发Cl…"），一眼区分不同会话
- **当前模型** — 实时显示模型名称（如 `glm-5.2`、`sonnet-4-6`）
- **上下文占用** — 当前上下文 token 数 / 窗口上限，附带百分比（如 `142.5k (71%)`）
- **输出详情** — 中括号包裹，显示上次请求的输出 token 数、初次响应时间(TTFT)、速率（如 `[3.4k · 3.7s · 130 t/s]`）
- **生成计时** — 请求进行中实时显示已用时间（如 `⏱8.4s`）
- **中断检测** — 用户中断(Esc)后持续显示 `⏹interrupted`（红底），直到下一次请求发起才恢复
- **重试检测** — 从 VS Code 输出日志实时解析真实的 attempt 计数和错误类型（如 `↻2/11 ServerOverloaded`，黄底警告）
- **无会话自动隐藏** — 没有活跃的 Claude Code 会话时不占用状态栏空间

## 📊 状态栏示例

| 状态 | 显示 |
| --- | --- |
| 空闲 | `💬 开发Cl… · glm-5.2 · 142.5k (71%) · [3.4k · 3.7s · 130 t/s]` |
| 生成中 | `⟳ 开发Cl… · glm-5.2 · 142.5k (71%) · [3.4k · 3.7s · 130 t/s] ⏱8.4s` |
| 重试中 | `⚠ 开发Cl… · glm-5.2 · 142.5k (71%) · [3.4k · 3.7s · 130 t/s] ↻2/11 ServerOverloaded` |
| 已中断 | `✕ 开发Cl… · glm-5.2 · 142.5k (71%) · [3.4k · 3.7s · 130 t/s] ⏹interrupted` |

## 🖥️ Dashboard 面板

点击状态栏或执行命令 `Claude Monitor: Show Live Dashboard` 打开 Webview 面板，包含：

- 实时状态卡片（模型 / 上下文进度条 / 请求时长 / 输出速率 / 生成计时）
- **统计图表**：可按模型 / 时间 / 类型筛选的全功能图表，带 Y 轴刻度、悬停 tooltip 和汇总卡片
- 最近请求历史表

### 📊 统计图表筛选

| 筛选维度 | 选项 |
| --- | --- |
| 模型 | 全部 + 自动列出所有出现过的模型 |
| 时间 | 本日 / 本周 / 本月 / 全部 |
| 类型 | 初次返回时间(TTFT) / 输入token / 输出token / 速率 / 会话时间 |

图表展示筛选范围内的请求序列，Y 轴标注数值刻度，悬停柱状条显示具体数值与时间；上方汇总卡片显示数量、平均、最小、最大、合计。

## 📐 工作原理

扩展从两个数据源获取信息：

### 1. Transcript（会话记录）
路径: `~/.claude/projects/<编码路径>/<session-id>.jsonl`

每个 assistant 条目包含 `message.model` 和 `message.usage`（input/output/cache tokens），扩展定期轮询解析出模型、上下文大小、请求耗时和输出速率。

### 2. VS Code 输出日志（实时信号）
路径: `<VS Code logs>/exthost/Anthropic.claude-code/Claude VScode.log`

通过 `fs.watch` 实时 tail 日志文件，提取 transcript 无法提供的信号：

| 信号 | 日志格式 | 说明 |
| --- | --- | --- |
| 运行/空闲 | `update_session_state {sessionId, state, title}` | 精确到会话的运行状态和标题 |
| 中断 | `interrupt_claude` | 用户按 Esc 中断，持续显示直到下次请求 |
| 首字节延迟 | `first byte after Xms` | 模型初次响应时间(TTFT) |
| 重试计数 | `API error (attempt N/M): 429 ...` | 真实的 attempt 计数、HTTP 状态码、错误类型 |
| 慢首字节 | `Slow first byte (attempt N)` | 30 秒无首字节，软超时预警 |

### 3. 会话发现
路径: `~/.claude/sessions/<pid>.json`

每个活跃的 Claude Code 进程写一个 JSON 文件（含 sessionId、pid、cwd），扩展定期扫描并通过 `process.kill(pid, 0)` 检测进程存活。进程结束后对应状态栏自动消失。

## ⚙️ 命令

| 命令 | 说明 |
| --- | --- |
| `Claude Monitor: Show Live Dashboard` | 打开 Webview 面板 |
| `Claude Monitor: Select Session to Monitor` | 选择监控的会话 |
| `Claude Monitor: Open Transcript File` | 打开会话 JSONL 原始文件 |
| `Claude Monitor: Refresh Now` | 强制刷新 |

## 🔧 配置项

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `claudeMonitor.projectsDir` | `""` (自动检测) | 覆盖 Claude Code projects 目录 |
| `claudeMonitor.contextLimit` | `200000` | 上下文窗口大小（用于计算百分比） |
| `claudeMonitor.refreshIntervalMs` | `1000` | 轮询间隔（毫秒） |
| `claudeMonitor.retryThresholdMs` | `30000` | 旧版阈值（已弃用，重试检测现由日志驱动） |
| `claudeMonitor.statusBarAlignment` | `"right"` | 状态栏对齐：`left` 或 `right` |
| `claudeMonitor.showInStatusBar` | `true` | 是否显示状态栏 |
| `claudeMonitor.maxHistoryRequests` | `40` | Dashboard 保留的最近请求数 |

## 🔨 从源码构建

要求: Node.js 18+ 和 VS Code 1.80+

```bash
npm install
npm run compile
```

打包安装（需要 `@vscode/vsce`）：

```bash
npm i -g @vscode/vsce
vsce package
code --install-extension claude-code-monitor-0.1.0.vsix
```

开发调试：在 VS Code 中打开项目文件夹，按 **F5** 启动扩展开发宿主。

## ⚠️ 已知局限

- **实时 token 速率不可达** — Claude Code 的流式 WebSocket 对第三方扩展锁死（鉴权被拒 `1008 Unauthorized`），transcript 仅在请求完成时写入最终 token 数，日志也不含流式 token 计数。因此速率仅显示**最近一次完成请求**的值，流式过程中无法计算每秒实时速率。
- **重试归属** — `[API REQUEST]`、`Stream started`、`API error` 等日志行不带 sessionId，归属到"当前 running 的会话"。两个会话同时运行并交错发请求时偶发归属错，但主状态（标题/running/上下文）始终准确。
- **重试倒计时** — CLI 中的"X 秒后重试"倒计时仅打印到终端，不写入 VS Code 日志，因此无法显示。

## 📄 许可证

[MIT](LICENSE)
