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
  /** Handler for messages coming from the webview (stats requests). */
  onMessage: ((msg: unknown) => void) | undefined;

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
        "Claude Monitor",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extUri],
        }
      );
      this.panel.webview.html = this.getHtml();
      this.panel.webview.onDidReceiveMessage((msg) => {
        this.onMessage?.(msg);
      });
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
      this.panel.title = `Claude Monitor · ${state.title ?? state.sessionId?.slice(0, 8) ?? ""}`;
      this.panel.webview.postMessage({ type: "live", data: toPayload(state) });
    }
  }

  sendModels(models: string[]): void {
    this.panel?.webview.postMessage({ type: "models", models });
  }

  sendStats(data: unknown): void {
    this.panel?.webview.postMessage({ type: "stats", data });
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

  /* statistics */
  .filters { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin: 6px 0 10px; }
  .filters label { font-size:12px; opacity:.8; display:flex; align-items:center; gap:6px; }
  .filters select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-editorWidget-border, #444));
    border-radius:4px; padding: 3px 6px; font-size:12px; font-family:inherit;
  }
  .sumgrid { display:grid; grid-template-columns: repeat(auto-fit, minmax(90px,1fr)); gap:8px; margin-bottom:10px; }
  .sumgrid .s { background: var(--vscode-editor-inactive-selection-background); border-radius:6px; padding:8px 10px; }
  .sumgrid .s .l { font-size:10px; opacity:.6; text-transform:uppercase; letter-spacing:.04em; }
  .sumgrid .s .v { font-size:15px; font-weight:600; font-variant-numeric: tabular-nums; }
  .chartwrap { display:flex; gap:8px; height:220px; background: var(--vscode-editor-inactive-selection-background); border-radius:6px; padding:10px; box-sizing:border-box; }
  .yaxis { display:flex; flex-direction:column; justify-content:space-between; width:54px; font-size:10px; opacity:.55; text-align:right; font-variant-numeric: tabular-nums; padding-bottom:18px; }
  .plot { flex:1; display:flex; flex-direction:column; }
  .plotgrid { position:relative; flex:1; }
  .gridline { position:absolute; left:0; right:0; border-top:1px dashed rgba(125,125,125,.18); }
  .bars { display:flex; align-items:flex-end; gap:1px; height:100%; }
  .bars .bar { flex:1; min-width:2px; background: var(--vscode-charts-blue, #3794ff); opacity:.85; border-radius:2px 2px 0 0; cursor:pointer; position:relative; }
  .bars .bar:hover { opacity:1; background: var(--vscode-charts-green, #89d185); }
  .bars .bar .tip { display:none; position:absolute; bottom:100%; left:50%; transform:translateX(-50%); background:var(--vscode-editorHoverWidget-background, #000); color:var(--vscode-editorHoverWidget-foreground, #fff); border:1px solid var(--vscode-editorWidget-border,#555); border-radius:4px; padding:3px 6px; font-size:10px; white-space:nowrap; z-index:5; }
  .bars .bar:hover .tip { display:block; }
  .xaxis { height:16px; display:flex; justify-content:space-between; font-size:10px; opacity:.5; margin-top:2px; }
  .empty { margin: auto; opacity:.5; font-size:12px; }
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

  <h1 style="margin-top:18px">统计 · Statistics</h1>
  <div class="filters">
    <label>模型 Model <select id="f-model"><option value="all">全部 All</option></select></label>
    <label>时间 Time <select id="f-time">
      <option value="today">本日 Today</option>
      <option value="week">本周 Week</option>
      <option value="month">本月 Month</option>
      <option value="all" selected>全部 All</option>
    </select></label>
    <label>类型 Metric <select id="f-metric">
      <option value="ttft">初次返回时间 TTFT</option>
      <option value="input">输入token Input</option>
      <option value="output">输出token Output</option>
      <option value="rate" selected>速率 Rate</option>
      <option value="duration">会话时间 Duration</option>
    </select></label>
  </div>
  <div class="sumgrid" id="sumgrid"></div>
  <div class="chartwrap">
    <div class="yaxis" id="yaxis"></div>
    <div class="plot">
      <div class="plotgrid"><div class="bars" id="bars"></div></div>
      <div class="xaxis" id="xaxis"></div>
    </div>
  </div>

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

  // --- value formatters (mirror metrics.ts) ---
  function fmtTok(n){ if(!isFinite(n))return'—'; if(n>=1e6)return(n/1e6).toFixed(2)+'M'; if(n>=1e3)return(n/1e3).toFixed(1)+'k'; return String(Math.round(n)); }
  function fmtMs(ms){ if(!isFinite(ms))return'—'; if(ms<1000)return Math.round(ms)+'ms'; const s=ms/1000; return s<60?s.toFixed(1)+'s':Math.floor(s/60)+'m'+Math.round(s%60)+'s'; }
  function fmtRate(r){ if(!isFinite(r)||r<=0)return'—'; return r>=100?r.toFixed(0)+' t/s':r.toFixed(1)+' t/s'; }
  function fmtVal(v, unit){
    if(unit==='tok') return fmtTok(v);
    if(unit==='ms') return fmtMs(v);
    if(unit==='t/s') return fmtRate(v);
    return String(v);
  }
  const METRIC_LABEL = { ttft:'初次返回时间', input:'输入token', output:'输出token', rate:'速率', duration:'会话时间' };

  function requestStats() {
    vscode.postMessage({ type:'requestStats', model: $('f-model').value, time: $('f-time').value, metric: $('f-metric').value });
  }
  ['f-model','f-time','f-metric'].forEach(id => { $(id).addEventListener('change', requestStats); });

  function renderStats(s) {
    const unit = s.unit;
    const points = s.points || [];
    const sum = s.summary || {};
    // summary cards
    const sg = $('sumgrid');
    sg.innerHTML = '';
    const cards = [
      ['数量 Count', String(sum.count ?? 0)],
      ['平均 Avg', fmtVal(sum.avg ?? 0, unit)],
      ['最小 Min', fmtVal(sum.min ?? 0, unit)],
      ['最大 Max', fmtVal(sum.max ?? 0, unit)],
      ['合计 Total', fmtVal(sum.total ?? 0, unit)],
    ];
    cards.forEach(([l,v]) => {
      const d = document.createElement('div'); d.className='s';
      d.innerHTML = '<div class="l">'+esc(l)+'</div><div class="v">'+esc(v)+'</div>';
      sg.appendChild(d);
    });

    const bars = $('bars'); const yaxis = $('yaxis'); const xaxis = $('xaxis');
    bars.innerHTML = ''; yaxis.innerHTML = ''; xaxis.innerHTML = '';
    if (!points.length) {
      bars.innerHTML = '<div class="empty">无数据 No data for this filter</div>';
      return;
    }
    const max = Math.max(...points.map(p=>p.value), 1);
    // Y axis: 5 steps (top→bottom)
    const STEPS = 5;
    for (let i=STEPS; i>=0; i--) {
      const v = max * i / STEPS;
      const d = document.createElement('div'); d.textContent = fmtVal(v, unit);
      yaxis.appendChild(d);
    }
    // gridlines
    const plot = bars.parentElement;
    [...plot.querySelectorAll('.gridline')].forEach(g=>g.remove());
    for (let i=1;i<STEPS;i++){
      const g=document.createElement('div'); g.className='gridline'; g.style.bottom=(i/STEPS*100)+'%'; plot.appendChild(g);
    }
    // bars
    points.forEach(p => {
      const b = document.createElement('div'); b.className='bar';
      b.style.height = Math.max(1, (p.value/max*100)) + '%';
      const tip = document.createElement('div'); tip.className='tip';
      tip.textContent = fmtVal(p.value, unit) + ' · ' + new Date(p.ts).toLocaleString();
      b.appendChild(tip);
      bars.appendChild(b);
    });
    // X axis range
    const t0 = new Date(points[0].ts).toLocaleDateString();
    const t1 = new Date(points[points.length-1].ts).toLocaleDateString();
    xaxis.innerHTML = '<span>'+esc(t0)+'</span><span>'+esc(t1)+'</span>';
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'models') {
      const sel = $('f-model'); const cur = sel.value || 'all';
      sel.innerHTML = '<option value="all">全部 All</option>';
      (msg.models || []).forEach(m => {
        const o = document.createElement('option'); o.value = m; o.textContent = m;
        sel.appendChild(o);
      });
      sel.value = (msg.models || []).includes(cur) ? cur : 'all';
      return;
    }
    if (msg.type === 'stats') { renderStats(msg.data); return; }
    if (msg.type === 'live') {
      const s = msg.data;
      if (!s) return;
      $('updated').textContent = s.updatedAtMs ? new Date(s.updatedAtMs).toLocaleTimeString() : '';
      const st = $('status'); st.className = 'status ' + s.statusKind; st.textContent = s.statusText;
      $('session').textContent = s.sessionLabel || '';
      $('model').textContent = s.model || '—';
      $('tier').textContent = [s.serviceTier, s.speed].filter(Boolean).join(' · ') || '';
      $('ctx').textContent = s.contextText; setBar($('ctxbar'), s.contextPct); $('ctxsub').textContent = s.contextSub;
      $('dur').textContent = s.durText; $('durSub').textContent = s.durSub || '';
      $('rate').textContent = s.rateText; $('rateSub').textContent = s.rateSub || '';
      $('inflight').textContent = s.inFlightText; $('retry').textContent = s.retryText || '';
      $('total').textContent = s.totalText; $('totalSub').textContent = s.totalSub || '';
      const rows = $('rows'); rows.innerHTML = '';
      (s.history || []).forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>'+r.idx+'</td><td>'+esc(r.model)+'</td><td>'+r.ctx+'</td><td>'+r.out+
          '</td><td>'+r.dur+'</td><td>'+r.rate+'</td><td class="muted">'+esc(r.stop||'')+'</td>';
        rows.appendChild(tr);
      });
    }
  });

  // initial: ask for model list + default stats
  vscode.postMessage({ type:'getModels' });
  requestStats();
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
