import * as vscode from "vscode";
import * as path from "path";
import type { MonitorState, TranscriptEntry, ComputeAccumulator } from "./metrics";
import {
  computeStateIncremental,
  mergeLogState,
  fmtMs,
  fmtRate,
  fmtTokens,
} from "./metrics";
import {
  listSessions,
  pickActiveSession,
  readEntriesIncremental,
  resolveProjectsDir,
  fileMtimeMs,
  listActiveSessions,
  findTranscriptForSession,
  collectAllRequests,
  collectRequestsFromFile,
  type SessionInfo,
  type ActiveSession,
  type StatRequest,
  type IncrementalReadState,
} from "./transcript";
import { LogTailer, defaultCodeLogsDir, type PerSessionLogState } from "./logtail";
import { Dashboard } from "./dashboard";

let service: MonitorService | undefined;

export interface StatsResult {
  points: { ts: number; value: number; req: StatRequest }[];
  summary: { count: number; avg: number; min: number; max: number; total: number };
  unit: string;
  metric: string;
  model: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const dashboard = new Dashboard(context.extensionUri);
  service = new MonitorService(dashboard);
  context.subscriptions.push(service);

  // Webview → extension: statistics requests.
  dashboard.onMessage = (raw) => {
    if (!service) return;
    const msg = raw as { type?: string; model?: string; metric?: string; fromMs?: number; toMs?: number };
    if (msg?.type === "getModels") {
      void service.getModels().then((models) => dashboard.sendModels(models));
    } else if (msg?.type === "requestStats") {
      void service.computeStats(msg.model ?? "all", msg.metric ?? "rate", msg.fromMs ?? 0, msg.toMs ?? 0)
        .then((data) => dashboard.sendStats(data));
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeMonitor.showDashboard", (sessionId?: string) => {
      if (sessionId) {
        dashboard.currentSessionId = sessionId;
      }
      const v = sessionId ? service?.views.get(sessionId) : service?.mostRecentView();
      dashboard.show(v?.state);
      if (sessionId && dashboard.visible) {
        dashboard.refreshStats();
      }
    }),
    vscode.commands.registerCommand("claudeMonitor.selectSession", async () => {
      await service?.pickSession();
    }),
    vscode.commands.registerCommand("claudeMonitor.openTranscript", () => {
      service?.openTranscript();
    }),
    vscode.commands.registerCommand("claudeMonitor.refresh", () => {
      service?.forceRefresh();
    })
  );

  service.start();
}

export function deactivate(): void {
  service?.dispose();
}

interface SessionView {
  sessionId: string;
  active: ActiveSession;
  statusItem: vscode.StatusBarItem;
  /** Incremental read state — tracks file offset and accumulated entries. */
  readState: IncrementalReadState | undefined;
  /** Incremental compute accumulator — avoids re-traversing all entries. */
  computeAcc: ComputeAccumulator | undefined;
  state: MonitorState | undefined;
  lastText: string;
  lastTooltipStr: string;
  lastBgKey: string;
}

class MonitorService implements vscode.Disposable {
  private dashboard: Dashboard;
  private logTailer: LogTailer;

  private claudeDir: string;
  private projectsDir: string;
  private sessions: SessionInfo[] = [];
  views = new Map<string, SessionView>();

  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /** Debounce: suppress tick() re-entry within this many ms. */
  private lastTickMs = 0;
  private readonly tickDebounceMs = 500;
  /** Guard against concurrent tick() runs (async I/O can overlap). */
  private ticking = false;

  /** Cache for listActiveSessions — avoid scanning disk every tick. */
  private cachedActiveSessions: ActiveSession[] = [];
  private cachedActiveSessionsAt = 0;
  private readonly activeSessionsTtlMs = 5000;

  /** Cache for stats data — avoid re-reading transcript on every filter change. */
  private statsCache: {
    transcriptPath: string;
    mtime: number;
    requests: StatRequest[];
    createdAt: number;
  } | undefined;

  /** Cache for getModels — avoid re-reading transcript. */
  private modelsCache: {
    transcriptPath: string;
    mtime: number;
    models: string[];
  } | undefined;

  /** Max age for stats/models cache — after this, re-read to pick up new data. */
  private readonly statsCacheTtlMs = 30_000;

  constructor(dashboard: Dashboard) {
    this.dashboard = dashboard;
    this.projectsDir = resolveProjectsDir(
      getConfig().get<string>("projectsDir")
    );
    this.claudeDir = path.dirname(this.projectsDir);

    this.logTailer = new LogTailer(defaultCodeLogsDir());
    this.disposables.push(this.logTailer);
    this.logTailer.onState(() => this.scheduleTick());

    // When the dashboard panel is closed, release cached stats data to free memory.
    this.dashboard.onPanelClosed = () => {
      this.statsCache = undefined;
      this.modelsCache = undefined;
    };

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudeMonitor")) {
          this.projectsDir = resolveProjectsDir(
            getConfig().get<string>("projectsDir")
          );
          this.claudeDir = path.dirname(this.projectsDir);
          for (const v of this.views.values()) {
            v.readState = undefined; // force re-read
            v.computeAcc = undefined; // force recompute
          }
          this.statsCache = undefined;
          this.modelsCache = undefined;
          this.cachedActiveSessionsAt = 0;
        }
      })
    );
  }

  get state(): MonitorState | undefined {
    return this.mostRecentView()?.state;
  }

  start(): void {
    this.lastTickMs = Date.now();
    void this.tick();
    const interval = Math.max(
      250,
      getConfig().get<number>("refreshIntervalMs") ?? 1000
    );
    this.timer = setInterval(() => this.scheduleTick(), interval);
  }

  /**
   * Schedule a tick with debounce. Coalesces rapid fire from logTailer events
   * and the polling timer into a single tick — prevents re-reading files many
   * times per second during streaming output.
   */
  private scheduleTick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTickMs;
    if (elapsed >= this.tickDebounceMs) {
      this.lastTickMs = now;
      void this.tick();
    }
    // Otherwise: a recent tick already ran. The next setInterval tick will
    // pick up any newer changes.
  }

  async pickSession(): Promise<void> {
    this.sessions = await listSessions(this.projectsDir);
    if (this.sessions.length === 0) {
      vscode.window.showInformationMessage(
        `No Claude Code transcripts found in ${this.projectsDir}`
      );
      return;
    }
    const items = this.sessions.map((s) => ({
      label: s.sessionId.slice(0, 8),
      description: s.lastModel ?? "",
      detail: [
        s.cwd ?? "(unknown cwd)",
        new Date(s.mtimeMs).toLocaleString(),
      ].join(" · "),
      session: s,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: "Select Claude Code session to monitor",
      placeHolder: "Active sessions are shown automatically in the status bar",
    });
    if (picked) {
      vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(picked.session.path)
      );
    }
  }

  openTranscript(): void {
    if (this.views.size === 0) {
      vscode.window.showInformationMessage("No active Claude Code session.");
      return;
    }
    const v = this.mostRecentView();
    if (v?.active.transcriptPath) {
      vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(v.active.transcriptPath)
      );
    }
  }

  forceRefresh(): void {
    for (const v of this.views.values()) {
      v.readState = undefined; // force full re-read
      v.computeAcc = undefined; // force full recompute
    }
    this.statsCache = undefined;
    this.modelsCache = undefined;
    this.cachedActiveSessionsAt = 0; // force re-scan
    void this.tick();
  }

  /** Distinct model names seen in the current session's transcript. */
  async getModels(): Promise<string[]> {
    const sid = this.dashboard.currentSessionId;
    let v = sid ? this.views.get(sid) : undefined;
    if (!v) {
      v = this.mostRecentView();
      if (v?.state?.sessionId) {
        this.dashboard.currentSessionId = v.state.sessionId;
      }
    }
    const tp = v?.active.transcriptPath;
    if (!tp) return [];

    // Use cache if transcript hasn't changed.
    const mtime = (await fileMtimeMs(tp)) ?? 0;
    if (this.modelsCache && this.modelsCache.transcriptPath === tp && this.modelsCache.mtime === mtime) {
      return this.modelsCache.models;
    }

    const set = new Set<string>();
    for (const r of await this.getRequestsForStats(tp)) {
      if (r.model) {
        set.add(r.model);
      }
    }
    const models = [...set].sort();
    this.modelsCache = { transcriptPath: tp, mtime, models };
    return models;
  }

  /**
   * Get all requests for the stats panel from a transcript file, using cache.
   * This avoids re-reading the entire transcript file on every stats request.
   * Cache is invalidated by: file mtime change, TTL expiry, or dashboard close.
   */
  private async getRequestsForStats(transcriptPath: string): Promise<StatRequest[]> {
    const mtime = (await fileMtimeMs(transcriptPath)) ?? 0;
    const now = Date.now();
    if (
      this.statsCache &&
      this.statsCache.transcriptPath === transcriptPath &&
      this.statsCache.mtime === mtime &&
      now - this.statsCache.createdAt < this.statsCacheTtlMs
    ) {
      return this.statsCache.requests;
    }
    const requests = await collectRequestsFromFile(transcriptPath, 0);
    this.statsCache = { transcriptPath, mtime, requests, createdAt: now };
    return requests;
  }

  /**
   * Compute a chartable dataset for the statistics view.
   * Scoped to the current session only.
   */
  async computeStats(
    model: string,
    metric: string,
    fromMs = 0,
    toMs = 0
  ): Promise<StatsResult> {
    const sid = this.dashboard.currentSessionId;
    let v = sid ? this.views.get(sid) : undefined;
    if (!v) {
      v = this.mostRecentView();
      if (v?.state?.sessionId) {
        this.dashboard.currentSessionId = v.state.sessionId;
      }
    }
    const tp = v?.active.transcriptPath;
    const allReqs = tp ? await this.getRequestsForStats(tp) : [];
    let rs = allReqs.filter((r) => r.ts >= fromMs && (toMs <= 0 || r.ts <= toMs));

    const wantModel = model !== "all";
    if (wantModel) {
      rs = rs.filter((r) => r.model === model);
    }
    let unit = "";
    let points: { ts: number; value: number; req: StatRequest }[] = [];

    if (metric === "input") {
      unit = "tok";
      points = rs.map((r) => ({ ts: r.ts, value: r.inputTokens + r.cacheReadTokens, req: r }));
    } else if (metric === "output") {
      unit = "tok";
      points = rs.map((r) => ({ ts: r.ts, value: r.outputTokens, req: r }));
    } else if (metric === "duration") {
      unit = "ms";
      points = rs.map((r) => ({ ts: r.ts, value: r.durationMs, req: r }));
    } else {
      unit = "t/s";
      points = rs.map((r) => ({ ts: r.ts, value: r.outputRate, req: r }));
    }

    points.sort((a, b) => a.ts - b.ts);
    const totalCount = points.length;
    const vals = points.map((p) => p.value);
    const summary = {
      count: totalCount,
      avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
      min: vals.length ? Math.min(...vals) : 0,
      max: vals.length ? Math.max(...vals) : 0,
      total: vals.reduce((a, b) => a + b, 0),
    };

    return { points, summary, unit, metric, model };
  }

  private async tick(): Promise<void> {
    // Guard against concurrent ticks — if a previous tick is still awaiting I/O,
    // skip this one. The next polling timer will try again.
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this._tick();
    } catch {
      // ignore tick errors
    } finally {
      this.ticking = false;
    }
  }

  private async _tick(): Promise<void> {
    const now = Date.now();
    // Use cached active sessions if fresh, to avoid scanning the sessions
    // directory and doing process.kill checks on every tick. When the cache
    // is empty (e.g. Claude Code not started yet), use a shorter TTL so we
    // re-scan sooner and pick up newly-created sessions.
    const emptyCacheTtl = 1000;
    const ttl = this.cachedActiveSessions.length > 0 ? this.activeSessionsTtlMs : emptyCacheTtl;
    const useCache = now - this.cachedActiveSessionsAt < ttl;
    let active: ActiveSession[];
    if (useCache) {
      active = this.cachedActiveSessions;
    } else {
      active = await listActiveSessions(this.claudeDir);
      // Only update cache + timestamp when we actually scanned — otherwise
      // a cached empty result would refresh its own TTL and never expire.
      this.cachedActiveSessions = active;
      this.cachedActiveSessionsAt = now;
    }

    const activeIds = new Set(active.map((a) => a.sessionId));

    // Remove views for sessions no longer active.
    for (const [sid, v] of this.views) {
      if (!activeIds.has(sid)) {
        v.statusItem.dispose();
        this.views.delete(sid);
      }
    }

    // Add/update views for active sessions.
    for (const a of active) {
      let v = this.views.get(a.sessionId);
      if (!v) {
        const statusItem = vscode.window.createStatusBarItem(
          `claudeMonitor.${a.sessionId}`,
          vscode.StatusBarAlignment.Right,
          100
        );
        statusItem.name = `Claude Code: ${a.sessionId.slice(0, 8)}`;
        statusItem.command = {
          command: "claudeMonitor.showDashboard",
          arguments: [a.sessionId],
          title: "Show Dashboard",
        };
        v = {
          sessionId: a.sessionId,
          active: a,
          statusItem,
          readState: undefined,
          computeAcc: undefined,
          state: undefined,
          lastText: "",
          lastTooltipStr: "",
          lastBgKey: "",
        };
        this.views.set(a.sessionId, v);
        this.disposables.push(statusItem);
      } else {
        v.active = a;
      }
    }

    // If no active sessions at all, hide everything.
    if (this.views.size === 0) return;

    const cfg = getConfig();
    const show = cfg.get<boolean>("showInStatusBar") !== false;
    const logSummary = this.logTailer.getSummary();

    // Incrementally read all active session transcripts in parallel.
    const tickEntries = new Map<string, TranscriptEntry[]>();
    const readPromises: Promise<void>[] = [];
    for (const v of this.views.values()) {
      const tp = v.active.transcriptPath;
      if (tp) {
        readPromises.push(
          readEntriesIncremental(tp, v.readState).then((newState) => {
            v.readState = newState;
            tickEntries.set(v.sessionId, newState.entries);
          })
        );
      } else {
        tickEntries.set(v.sessionId, []);
      }
    }
    await Promise.all(readPromises);

    for (const v of this.views.values()) {
      const entries = tickEntries.get(v.sessionId) ?? [];

      // Incremental compute: only process new entries since last tick.
      // When readState was reset (forceRefresh/config change), computeAcc
      // is also undefined, so this falls back to full computation.
      const { state, acc } = computeStateIncremental(entries, v.computeAcc, {
        contextLimit: cfg.get<number>("contextLimit") ?? 200000,
        retryThresholdMs: cfg.get<number>("retryThresholdMs") ?? 30000,
        maxHistory: cfg.get<number>("maxHistoryRequests") ?? 40,
        nowMs: now,
      });
      v.computeAcc = acc;
      state.transcriptPath = v.active.transcriptPath;
      state.sessionId = v.sessionId;
      const logSession = logSummary.sessions.get(v.sessionId);
      state.title = logSession?.title;
      mergeLogState(state, logSession ? { available: logSummary.available, ...logSession } : undefined, now);

      // Always show the status bar for active sessions (the session process
      // is alive per listActiveSessions). The old check (requestCount > 0)
      // caused new sessions to be invisible until their first request completed.
      this.render(v, state, show);
    }

    // Dashboard: update whichever session the dashboard is currently showing.
    if (this.dashboard.visible) {
      const sid = this.dashboard.currentSessionId;
      const v = sid ? this.views.get(sid) : this.mostRecentView();
      if (v?.state) {
        this.dashboard.update(v.state);
      }
    }
  }

  private render(v: SessionView, state: MonitorState, show: boolean): void {
    v.state = state;

    const text = statusText(state);
    if (text !== v.lastText) {
      v.statusItem.text = text;
      v.lastText = text;
    }

    const tooltipStr = statusTooltip(state);
    if (tooltipStr !== v.lastTooltipStr) {
      const md = new vscode.MarkdownString(tooltipStr, true);
      md.isTrusted = false;
      v.statusItem.tooltip = md;
      v.lastTooltipStr = tooltipStr;
    }

    const bgKey = statusBgKey(state);
    if (bgKey !== v.lastBgKey) {
      v.statusItem.backgroundColor =
        bgKey === "warning"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : bgKey === "error"
            ? new vscode.ThemeColor("statusBarItem.errorBackground")
            : undefined;
      v.lastBgKey = bgKey;
    }

    if (show) {
      v.statusItem.show();
    } else {
      v.statusItem.hide();
    }
  }

  mostRecentView(): SessionView | undefined {
    let best: SessionView | undefined;
    for (const v of this.views.values()) {
      const t = v.state?.updatedAtMs ?? 0;
      if (!best || t > (best.state?.updatedAtMs ?? 0)) {
        best = v;
      }
    }
    return best;
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const v of this.views.values()) {
      v.statusItem.dispose();
    }
    this.views.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("claudeMonitor");
}

/** Truncate a session title to 5 chars + "…" (by character count, not bytes). */
function shortTitle(title: string | undefined): string {
  if (!title) return "Claude";
  const chars = Array.from(title.trim());
  if (chars.length <= 5) return chars.join("");
  return chars.slice(0, 5).join("") + "…";
}

function statusText(s: MonitorState): string {
  const icon =
    s.phase === "retrying"
      ? "$(warning)"
      : s.phase === "interrupted"
        ? "$(x)"
        : s.phase === "sending" || s.phase === "streaming"
          ? "$(loading~spin)"
          : "$(comment-discussion)";
  const model = s.model ? shortModel(s.model) : "—";
  const ctx = fmtTokens(s.contextTokens);
  const pct = `${(s.contextPct * 100).toFixed(0)}%`;
  const title = shortTitle(s.title);

  let rateSlot = "—";
  if (s.lastRequest) {
    const out = fmtTokens(s.lastRequest.outputTokens);
    const rate = fmtRate(s.lastRequest.outputRate);
    if (s.firstByteLatencyMs !== undefined) {
      const ttft = fmtMs(s.firstByteLatencyMs);
      rateSlot = `${out} · ${ttft} · ${rate}`;
    } else {
      rateSlot = `${out} · ${rate}`;
    }
  }

  let slot = "";
  if (s.phase === "retrying") {
    const attempt = s.retryAttempt ?? "";
    const max = s.retryMaxAttempts ? `/${s.retryMaxAttempts}` : "";
    const code = s.retryCode || s.retryErrorType || "";
    slot = ` ↻${attempt}${max}${code ? " " + code : ""}`;
  } else if (s.phase === "sending" || s.phase === "streaming") {
    slot = ` ⏱${fmtMs(s.liveElapsedMs)}`;
  } else if (s.phase === "interrupted") {
    slot = ` ⏹interrupted`;
  }
  if (s.contextPct > 0.85) {
    slot += ` ⚠compact!`;
  }

  return `${icon} ${title} · ${model} · ${ctx} (${pct}) · [${rateSlot}]${slot}`;
}

function statusBgKey(s: MonitorState): "warning" | "error" | "none" {
  if (s.phase === "retrying") return "warning";
  if (s.phase === "interrupted") return "error";
  if (s.contextPct > 0.85) return "error";
  return "none";
}

function statusTooltip(s: MonitorState): string {
  const lines: string[] = [];
  lines.push(`**Claude Code Monitor**`);
  lines.push("");
  lines.push(`- **Session:** ${s.title ?? s.sessionId ?? "—"}${s.sessionId ? ` (${s.sessionId.slice(0, 8)})` : ""}`);
  const phaseLabel: Record<MonitorState["phase"], string> = {
    idle: "○ idle",
    sending: "● sending (waiting first byte)",
    streaming: "● streaming",
    retrying: "⚠ retrying",
    interrupted: "⏹ interrupted",
  };
  lines.push(`- **Status:** ${phaseLabel[s.phase]}`);
  if (!s.logAvailable) {
    lines.push(`  - _live log unavailable — phase is inferred from transcript_`);
  }
  if (s.phase === "retrying") {
    const parts: string[] = [];
    if (s.retryAttempt) {
      parts.push(`attempt ${s.retryAttempt}${s.retryMaxAttempts ? "/" + s.retryMaxAttempts : ""}`);
    }
    if (s.retryHttpStatus) {
      parts.push(`HTTP ${s.retryHttpStatus}`);
    }
    if (s.retryCode) {
      parts.push(s.retryCode);
    }
    if (s.retryErrorType && s.retryErrorType !== s.retryCode) {
      parts.push(s.retryErrorType);
    }
    if (parts.length) {
      lines.push(`  - ${parts.join(" · ")}`);
    }
  }
  if (s.firstByteLatencyMs !== undefined) {
    lines.push(`  - first byte: ${fmtMs(s.firstByteLatencyMs)}`);
  }
  lines.push(`- **Model:** ${s.model ?? "—"}${s.serviceTier ? ` (${s.serviceTier}` : ""}${s.speed ? `, ${s.speed}` : ""}${s.serviceTier ? ")" : ""}`);
  lines.push(`- **Context:** ${fmtTokens(s.contextTokens)} / ${fmtTokens(s.contextLimit)} (${(s.contextPct * 100).toFixed(1)}%)`);
  if (s.contextPct > 0.85) {
    lines.push(`  - ⚠ **Context high!** Run \`/compact\` to free space.`);
  }
  if (s.lastRequest) {
    lines.push(`- **Last request:** ${fmtMs(s.lastRequest.durationMs)} · ${fmtRate(s.lastRequest.outputRate)} · ${fmtTokens(s.lastRequest.outputTokens)} out · stop=${s.lastRequest.stopReason ?? "—"}`);
  }
  lines.push(`- **Session:** ${s.requestCount} requests · ${fmtTokens(s.totalOutputTokens)} out · ${fmtTokens(s.totalInputTokens)} ctx`);
  if (s.cwd) {
    lines.push(`- **cwd:** ${s.cwd}`);
  }
  lines.push("");
  lines.push(`_Rate = latest completed request. Click to open dashboard._`);
  return lines.join("\n");
}

function shortModel(m: string): string {
  const parts = m.split("-");
  if (m.startsWith("claude-") && parts.length > 1) {
    return parts.slice(1).join("-");
  }
  return m;
}
