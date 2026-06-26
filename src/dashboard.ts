import * as vscode from "vscode";
import type { MonitorState } from "./metrics";
import { fmtMs, fmtRate, fmtTokens } from "./metrics";

export class Dashboard {
  public static readonly viewType = "claudeMonitor.dashboard";
  private panel: vscode.WebviewPanel | undefined;
  private readonly extUri: vscode.Uri;
  private lastState: MonitorState | undefined;
  /** SessionId the dashboard is currently pinned to (undefined = follow most recent). */
  currentSessionId: string | undefined;

  constructor(extUri: vscode.Uri) {
    this.extUri = extUri;
  }

  show(state?: MonitorState): void {
    if (state?.sessionId) {
      this.currentSessionId = state.sessionId;
    }
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        Dashboard.viewType,
        "Claude Code Monitor",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extUri],
        }
      );
      this.panel.webview.html = this.getHtml();
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.currentSessionId = undefined;
      });
    }
    if (state) {
      this.update(state);
    }
  }

  get visible(): boolean {
    return !!this.panel && this.panel.visible;
  }

  update(state: MonitorState): void {
    // If the dashboard is pinned to a session, only accept updates for it.
    if (this.currentSessionId && state.sessionId && state.sessionId !== this.currentSessionId) {
      return;
    }
    this.lastState = state;
    if (this.panel) {
      this.panel.title = `Claude Code · ${state.title ?? state.sessionId?.slice(0, 8) ?? "Monitor"}`;
      this.panel.webview.postMessage(toPayload(state));
    }
  }

  private getHtml(): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}'`,
      `style-src 'unsafe-inline'`,
    ].join("; ");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Claude Code Monitor</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    margin: 0; padding: 16px;
  }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 12px; opacity: .85; text-transform: uppercase; letter-spacing: .06em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
  .card {
    background: var(--vscode-editor-inactive-selection-background);
    border: 1px solid var(--vscode-editorWidget-border, transparent);
    border-radius: 6px; padding: 10px 12px;
  }
  .card .label { font-size: 11px; opacity: .7; margin-bottom: 4px; }
  .card .value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .card .sub { font-size: 11px; opacity: .65; margin-top: 2px; }
  .status { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:10px; font-size:12px; font-weight:600; }
  .status.idle { background: rgba(120,120,120,.25); }
  .status.running { background: rgba(60,170,80,.25); color: #5fcf80; }
  .status.retrying { background: rgba(220,160,40,.25); color: #e0a93b; }
  .bar { height: 8px; background: rgba(125,125,125,.25); border-radius: 4px; overflow:hidden; margin-top:6px; }
  .bar > div { height:100%; background: var(--vscode-charts-blue, #3794ff); transition: width .3s; }
  .bar.high > div { background: var(--vscode-charts-red, #f14c4c); }
  table { width:100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; font-variant-numeric: tabular-nums; }
  th, td { text-align:left; padding: 4px 6px; border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(125,125,125,.15)); }
  th { opacity:.6; font-weight:600; }
  .spark { display:flex; align-items:flex-end; gap:2px; height:42px; margin-top:6px; }
  .spark .b { flex:1; min-width:2px; background: var(--vscode-charts-blue, #3794ff); opacity:.85; border-radius:2px 2px 0 0; }
  .muted { opacity:.5; }
  .row { display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px; }
  #updated { font-size:11px; opacity:.5; }
</style>
</head>
<body>
  <div class="row">
    <h1>Claude Code · Live Monitor</h1>
    <span id="updated">—</span>
  </div>

  <div class="row">
    <span id="status" class="status idle">idle</span>
    <span id="session" class="muted" style="font-size:12px"></span>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Model</div><div class="value" id="model">—</div><div class="sub" id="tier"></div></div>
    <div class="card"><div class="label">Context</div><div class="value" id="ctx">—</div>
      <div class="bar" id="ctxbar"><div style="width:0%"></div></div>
      <div class="sub" id="ctxsub"></div></div>
    <div class="card"><div class="label">Last request</div><div class="value" id="dur">—</div><div class="sub" id="durSub"></div></div>
    <div class="card"><div class="label">Output rate</div><div class="value" id="rate">—</div><div class="sub" id="rateSub"></div></div>
    <div class="card"><div class="label">Live</div><div class="value" id="inflight">—</div><div class="sub" id="retry"></div></div>
    <div class="card"><div class="label">Session total</div><div class="value" id="total">—</div><div class="sub" id="totalSub"></div></div>
  </div>

  <h1 style="margin-top:18px">Output rate (tok/s)</h1>
  <div class="spark" id="spark"></div>

  <h1 style="margin-top:18px">Recent requests</h1>
  <table>
    <thead><tr><th>#</th><th>Model</th><th>Context</th><th>Out</th><th>Dur</th><th>Rate</th><th>Stop</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  function setBar(barEl, pct) {
    barEl.className = "bar" + (pct >= 0.8 ? " high" : "");
    barEl.firstElementChild.style.width = Math.min(100, Math.round(pct*100)) + "%";
  }

  function esc(s){ return String(s==null?'':s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

  window.addEventListener('message', e => {
    const s = e.data;
    if (!s) return;

    $('updated').textContent = s.updatedAtMs ? new Date(s.updatedAtMs).toLocaleTimeString() : '';

    const st = $('status');
    st.className = 'status ' + s.statusKind;
    st.textContent = s.statusText;

    $('session').textContent = s.sessionLabel || '';
    $('model').textContent = s.model || '—';
    $('tier').textContent = [s.serviceTier, s.speed].filter(Boolean).join(' · ') || '';
    $('ctx').textContent = s.contextText;
    setBar($('ctxbar'), s.contextPct);
    $('ctxsub').textContent = s.contextSub;

    $('dur').textContent = s.durText;
    $('durSub').textContent = s.durSub || '';
    $('rate').textContent = s.rateText;
    $('rateSub').textContent = s.rateSub || '';

    $('inflight').textContent = s.inFlightText;
    $('retry').textContent = s.retryText || '';

    $('total').textContent = s.totalText;
    $('totalSub').textContent = s.totalSub || '';

    // sparkline of output rate
    const spark = $('spark');
    spark.innerHTML = '';
    const rates = s.rates || [];
    const max = Math.max(1, ...rates);
    rates.forEach(r => {
      const b = document.createElement('div');
      b.className = 'b';
      b.style.height = Math.max(2, Math.round((r/max)*42)) + 'px';
      spark.appendChild(b);
    });

    // history table
    const rows = $('rows');
    rows.innerHTML = '';
    (s.history || []).forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>'+r.idx+'</td><td>'+esc(r.model)+'</td><td>'+r.ctx+'</td><td>'+r.out+
        '</td><td>'+r.dur+'</td><td>'+r.rate+'</td><td class="muted">'+esc(r.stop||'')+'</td>';
      rows.appendChild(tr);
    });
  });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

interface DashboardPayload {
  updatedAtMs: number;
  statusKind: "idle" | "running" | "retrying";
  statusText: string;
  sessionLabel: string;
  model?: string;
  serviceTier?: string;
  speed?: string;
  contextText: string;
  contextPct: number;
  contextSub: string;
  durText: string;
  durSub: string;
  rateText: string;
  rateSub: string;
  inFlightText: string;
  retryText: string;
  totalText: string;
  totalSub: string;
  rates: number[];
  history: {
    idx: number; model: string; ctx: string; out: string;
    dur: string; rate: string; stop?: string;
  }[];
}

function toPayload(s: MonitorState): DashboardPayload {
  let statusKind: DashboardPayload["statusKind"] = "idle";
  let statusText = "○ idle";
  switch (s.phase) {
    case "retrying":
      statusKind = "retrying";
      statusText = "⚠ retrying";
      break;
    case "sending":
      statusKind = "running";
      statusText = "● sending · waiting first byte";
      break;
    case "streaming":
      statusKind = "running";
      statusText = "● streaming";
      break;
    case "interrupted":
      statusKind = "retrying";
      statusText = "⏹ interrupted";
      break;
    default:
      statusKind = "idle";
      statusText = s.lastRequest ? "○ idle" : "○ idle (no requests yet)";
  }

  const dur = s.lastRequest ? fmtMs(s.lastRequest.durationMs) : "—";
  const rate = s.lastRequest ? fmtRate(s.lastRequest.outputRate) : "—";

  const retryBits: string[] = [];
  if (s.phase === "retrying") {
    if (s.retryAttempt) {
      retryBits.push(`attempt ${s.retryAttempt}${s.retryMaxAttempts ? "/" + s.retryMaxAttempts : ""}`);
    }
    if (s.retryHttpStatus) {
      retryBits.push(`HTTP ${s.retryHttpStatus}`);
    }
    if (s.retryCode) {
      retryBits.push(s.retryCode);
    }
    if (s.retryErrorType && s.retryErrorType !== s.retryCode) {
      retryBits.push(s.retryErrorType);
    }
  }

  return {
    updatedAtMs: s.updatedAtMs,
    statusKind,
    statusText,
    sessionLabel: s.sessionId ? `session ${s.sessionId.slice(0, 8)}…` : "",
    model: s.model,
    serviceTier: s.serviceTier,
    speed: s.speed,
    contextText: `${fmtTokens(s.contextTokens)} / ${fmtTokens(s.contextLimit)}`,
    contextPct: s.contextPct,
    contextSub: `${(s.contextPct * 100).toFixed(1)}% of context window`,
    durText: dur,
    durSub: s.lastRequest
      ? `ended ${new Date(s.lastRequest.endMs).toLocaleTimeString()}`
      : "",
    rateText: rate,
    rateSub: s.lastRequest
      ? `${fmtTokens(s.lastRequest.outputTokens)} out tokens · latest request rate`
      : "",
    inFlightText:
      s.phase === "sending" || s.phase === "streaming"
        ? fmtMs(s.liveElapsedMs)
        : s.phase === "interrupted"
          ? "interrupted"
          : "—",
    retryText: retryBits.join(" · "),
    totalText: `${s.requestCount} req`,
    totalSub: `${fmtTokens(s.totalOutputTokens)} out · ${fmtTokens(
      s.totalInputTokens
    )} ctx`,
    rates: s.requests.map((r) => r.outputRate),
    history: s.requests
      .map((r, i) => ({
        idx: i + 1,
        model: r.model,
        ctx: fmtTokens(r.contextTokens),
        out: fmtTokens(r.outputTokens),
        dur: fmtMs(r.durationMs),
        rate: fmtRate(r.outputRate),
        stop: r.stopReason,
      }))
      .reverse()
      .slice(0, 40),
  };
}
