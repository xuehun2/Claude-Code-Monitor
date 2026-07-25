# Changelog

## 0.5.2 (2026-07-26)

### 🐛 Bug 修复

- **统计图表无法显示数据** — 修复 webview `<script>` 中两处 TypeScript 语法泄漏到浏览器导致的运行时崩溃：
  - `const placedLabels: { idx: number; tick: HTMLDivElement; lbl: HTMLDivElement }[] = []` — TS 类型注解被原样输出到浏览器，触发 SyntaxError。改为 `const placedLabels = []`
  - `placedLabels.pop()!` — TS 非空断言 `!` 在浏览器 JS 中被解析为逻辑 NOT 运算符，导致 `prev` 变为 `false`，`prev.tick.remove()` 崩溃。改为 `placedLabels.pop()`
- **状态栏刷新/切换会话后不显示** — 修复 `cachedActiveSessionsAt` 在缓存命中时也被更新，导致空缓存永不过期的问题。现在仅在实际扫描时更新时间戳，空缓存使用 1s TTL 快速重试
- **移除调试日志** — 清理所有 `logMsg`/`logDebug`/`setDebugLog` 调用及 OutputChannel

## 0.5.1 (2026-07-26)

### ⚡ 增量计算优化

- **`computeState()` 增量化** — 新增 `computeStateIncremental()`，每个会话维护 `ComputeAccumulator` 缓存中间状态（`pendingStartMs`、`lastUserMs`、`totalOutputTokens` 等），每次 tick 只处理新增的 2-3 条 entries，而非从头遍历全部 500 条。CPU 开销从 O(500) 降至 O(2-3)，同步阻塞从 2-5ms 降至 <0.1ms
- **文件未变时零 CPU** — 当 `readEntriesIncremental()` 检测到文件未变化（`fileSize === lastOffset`），返回相同的 entries 引用，`computeStateIncremental()` 检测到 `processedCount === entries.length` 直接跳过处理
- **截断自动重算** — 当 transcript 文件被替换（size < lastOffset），增量读取重读 tail，`computeAcc.processedCount > entries.length` 触发全量重算，保证数据正确性

## 0.5.0 (2026-07-26)

### ⚡ 异步 I/O + 增量读取

- **全量异步 I/O** — 所有 `fs.*Sync` 同步调用替换为 `fs.promises.*` 异步等价物，文件读取、目录扫描、stat 检查不再阻塞 VS Code 扩展宿主线程
- **增量读取 transcript** — 新增 `readEntriesIncremental()`，每个会话维护上次读取的字节偏移量（`lastOffset`），每次 tick 只读取自上次偏移以来**新追加的字节**并解析，而非文件变化时重新读取整个 2MB tail。这是实时监控场景下最大的性能提升
- **并行读取多会话** — 多个活跃会话的 transcript 通过 `Promise.all` 并发读取，减少总 tick 延迟
- **tick 并发保护** — `ticking` 标志防止异步 tick 重叠执行，避免 I/O 慢时请求堆积
- **LogTailer 异步化** — `checkFile()`、`replayTail()`、`findAndOpen()` 全部改为 async，增加 `checking` 防护避免 `fs.watch` + 轮询定时器并发触发
- **统计/模型接口异步化** — `getModels()`、`computeStats()`、`getRequestsForStats()`、`collectRequestsFromFile()`、`collectAllRequests()` 均返回 Promise，Dashboard 消息处理使用 `void ...then()` 避免阻塞

## 0.4.2 (2026-07-26)

### 🧠 内存与性能优化

- `readAllEntries` 新增 20MB 安全上限，防止大型 transcript 导致 OOM
- 解析后剥离 `message.content`，内存占用降低约 10 倍
- `statsCache` 新增 30 秒 TTL，避免长期持有过期数据
- Dashboard 关闭时释放 `statsCache` 和 `modelsCache`

## 0.4.1 (2026-07-24)

### ⚡ 性能优化

- **tick() 防抖** — LogTailer 的 `fs.watch` 事件和 setInterval 轮询都会触发 `tick()`，流式输出时可能每秒触发多次。现在加入 500ms 防抖，合并为单次执行
- **listActiveSessions 缓存** — 每次 `tick()` 都会扫描 `~/.claude/sessions/` 目录并对每个 session 文件做 `process.kill(pid, 0)` 存活检查 + `findTranscriptForSession()` 全目录扫描。现在 5 秒 TTL 内复用缓存结果
- **统计图表数据缓存** — `computeStats()` 和 `getModels()` 每次调用都完整读取 transcript 文件（`readAllEntries` 无大小限制）。现在以 `mtime` 为键缓存 `collectRequestsFromFile` 结果，transcript 文件未修改时直接复用，切换筛选条件不再重新读文件
- **Dashboard 空闲时跳过更新** — 之前每秒都 `postMessage` 发送完整状态（含 40 条历史记录），webview 每次重建 DOM。现在 idle 状态下通过 `stateSig` 签名比对，无变化时跳过发送

## 0.4.0 (2026-07-18)

### ✨ 新功能

- **时间范围筛选** — 统计图表新增时间范围下拉框，支持：全部 / 最近1h / 6h / 24h / 7天 / 30天 / 自定义（起止时间输入框），筛选后图表和汇总卡片仅显示对应范围内的请求数据
- **智能X轴时间标注** — X轴不再每个柱子都标时间，改为在日期切换、整点切换、10分钟边界等关键时间节点显示标签，日期切换时自动加日期前缀，避免标签拥挤
- **最近请求表增加时间列** — Recent requests 表新增 Time 列，显示每次请求的结束时间

### 🐛 Bug 修复

- **X轴时间标签与柱子不对齐** — 之前柱子等间距排列，但X轴时间刻度按时间范围均匀分布百分比位置，导致时间标签和柱子错位。现在时间标签直接跟随每个柱子的位置显示，标签与柱子精确对齐
- **统计图表显示错误会话数据** — 当 dashboard 绑定的会话进程已退出时，`computeStats` 和 `getModels` 会回退到最近活跃会话但未同步 `currentSessionId`，导致图表显示非当前会话的数据。现在回退时会自动更新 dashboard 的会话绑定

## 0.3.3 (2026-07-01)

### 🐛 Bug 修复

- **切换窗口误标 interrupted** — `interrupt_claude` 日志事件的 channelId 与 `launch_claude` 不匹配，导致切换 Claude Code 标签页时错误地将正在运行的会话标记为 interrupted。现在 `interrupt_claude` 只在会话确实有活跃 API 请求（`requestSentAtMs` 存在且在 5 分钟内）时才标记 interrupted，切窗口不再误触发
- **新窗口初始化时显示空状态栏** — 新开 Claude Code 窗口时，会话尚未发出任何请求就显示一个无意义的状态栏。现在只有会话实际产生请求（phase 非 idle 或 requestCount > 0）后才显示状态栏

### ⚠️ 已知限制（未实现）

- **单标签页内切换会话无法自动切换状态栏** — Claude Code 在同一标签页内切换会话时，`launch_claude` 和 `interrupt_claude` 的 channelId 机制无法可靠追踪哪个会话在前台，多次尝试均未成功实现自动切换，暂时放弃此功能
- **手动关闭/隐藏单个状态栏** — 原计划为每个状态栏添加关闭按钮，但因 VS Code 状态栏 API 限制（多个 close 按钮排列丑陋、关闭后切回不恢复），实现效果不佳，已回退

## 0.3.2 (2026-06-30)

### ✨ 新功能

- **多状态栏 + 焦点会话高亮** — 每个 Claude Code 会话对应一个独立状态栏，当前聚焦的会话（通过 `get_session_request` 日志事件检测）以 `prominentBackground` 高亮显示，一眼区分活跃会话
- **compact 警告阈值调整为 85%** — 上下文使用超过 85% 即显示红色警告和 `⚠compact!` 提示（原 95%）

### 🐛 Bug 修复

- **修复 extension.ts 中间状态** — 修复上一版本中 `SessionView` 接口与 `tick()` 逻辑不一致的问题，恢复每个会话独立状态栏的正确行为

## 0.3.1 (2026-06-30)

### 🐛 Bug 修复

- **长时间空闲会话误显示 interrupted** — 修复 interrupt 标志一旦设置就永久保留的问题。interrupt 现在是瞬时信号，60 秒后自动清除，长空闲会话恢复为 idle 状态
- **默认会话状态栏无法移除** — 新增手动隐藏状态栏功能

### ✨ 新功能

- **Hide Status Bar for a Session** — 命令面板选择要隐藏的会话状态栏（`Claude Monitor: Hide Status Bar for a Session`）
- **Restore All Hidden Status Bars** — 一键恢复所有已隐藏的状态栏（`Claude Monitor: Restore All Hidden Status Bars`）

## 0.3.0 (2026-06-29)

### 🎨 统计图表重构

- **移除 TTFT 指标和时间筛选** — TTFT 数据源（VS Code 日志）不可靠且模型切换时会出错，时间筛选对当前会话统计无意义，已移除
- **移除 VS Code 日志扫描** — 统计页不再依赖日志文件，所有数据从 transcript JSONL 获取，更稳定
- **P95 截断式 Y 轴** — Y 轴最大值取 P95 分位数，避免单个极端值压缩所有柱子；超限柱子截顶显示为橙色，悬浮提示标 ▲ 显示真实值
- **可滚动图表** — 柱子固定宽度 27px，一屏约显示 15 根，超出部分水平滚动查看
- **智能 X 轴时间标注** — 根据数据时间跨度自动选择刻度间隔（1分钟~1天），跨天自动加日期前缀
- **丰富悬浮提示** — 鼠标悬停柱子显示：指标值、时间、模型、耗时、输出token@速率、输入token、缓存读token
- **速率统计不显示"合计"** — 合计速率无意义，已隐藏

### 🐛 Bug 修复

- **上下文/速率偶发为空** — 修复工具调用、子代理等零 usage 条目覆盖有效上下文的问题，只在有真实数据时更新
- **统计面板显示所有会话数据** — 改为仅显示当前 dashboard 绑定会话的请求数据
- **点击状态栏打开错误会话** — 修复点击不同会话的状态栏始终显示第一个会话数据的问题，切换后自动刷新统计
- **图表柱子不显示** — 修复 CSS 类名冲突（上下文进度条与图表柱子都用了 `.bar`）和高度链断裂导致柱子高度为 0 的问题

### ✨ 新功能

- **上下文 >95% 红色警告** — 状态栏变红并显示 `⚠compact!`，tooltip 提示运行 `/compact`
- **悬浮提示不被裁剪** — tooltip 改为 `position:fixed` 全局定位，超出图表区域也能完整显示

## 0.2.0 (2026-06-27)

- 新增 Dashboard 统计图表：按模型/时间/类型筛选，Y 轴刻度，悬停 tooltip
- 新增 `collectAllRequests` 全历史扫描
- 新增 `readAllEntries` 完整读取 transcript

## 0.1.0 (2026-06-26)

- 初始发布
- 实时状态栏监控：模型、上下文、输出速率、首字节延迟、重试检测
- 多会话支持
- Dashboard 实时面板
