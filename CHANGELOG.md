# Changelog

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
