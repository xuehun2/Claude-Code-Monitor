import * as vscode from "vscode";
import type { MonitorState } from "./metrics";
import { fmtMs, fmtRate, fmtTokens } from "./metrics";

export class Dashboard {
  public static readonly viewType = "claudeMonitor.dashboard";
  private panel: vscode.WebviewPanel | undefined;
  private readonly extUri: vscode.Uri;
  private lastState: MonitorState | undefined;
  /** Signature of last state update — used to skip redundant postMessage. */
  private lastSig = "";
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
        this.lastSig = "";
        this.onPanelClosed?.();
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

    // Skip redundant updates: if idle and the meaningful fields haven't
    // changed since the last update, don't postMessage — avoids rebuilding
    // the webview DOM every second when nothing is happening.
    const sig = stateSig(state);
    const isIdle = state.phase === "idle";
    if (isIdle && this.lastSig === sig && this.lastState) {
      this.lastState = state;
      return;
    }
    this.lastSig = sig;
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

  /** Ask the webview to re-request stats (e.g. after switching sessions). */
  refreshStats(): void {
    this.panel?.webview.postMessage({ type: "refreshStats" });
  }

  /** Clear cached stats data — called when the dashboard panel is closed. */
  onPanelClosed: (() => void) | undefined;

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
  .ctxbar { height: 8px; background: rgba(125,125,125,.25); border-radius: 4px; overflow:hidden; margin-top:6px; }
  .ctxbar > div { height:100%; background: var(--vscode-charts-blue, #3794ff); transition: width .3s; }
  .ctxbar.high > div { background: var(--vscode-charts-red, #f14c4c); }
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

  /* Scrollable chart with fixed Y-axis */
  .chartouter { position:relative; display:flex; background: var(--vscode-editor-inactive-selection-background); border-radius:6px; padding:10px 10px 0 10px; box-sizing:border-box; }
  .yaxis { flex-shrink:0; display:flex; flex-direction:column; justify-content:space-between; width:58px; font-size:10px; opacity:.55; text-align:right; font-variant-numeric: tabular-nums; padding-right:6px; }
  .chartscroll { flex:1; overflow-x:auto; overflow-y:visible; position:relative; min-width:0; padding-bottom:8px; }
  .chartscroll::-webkit-scrollbar { height:6px; }
  .chartscroll::-webkit-scrollbar-thumb { background:var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4)); border-radius:3px; }
  .plot { min-width:100%; display:flex; flex-direction:column; position:relative; }
  .plotgrid { position:relative; height:190px; }
  .gridline { position:absolute; left:0; right:0; border-top:1px dashed rgba(125,125,125,.18); }
  /* X-axis time tick marks */
  .xtick { position:absolute; bottom:0; width:1px; height:6px; background:rgba(125,125,125,.35); }
  .xlabel { position:absolute; top:2px; transform:translateX(-50%); font-size:9px; opacity:.5; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .bars { display:flex; align-items:flex-end; gap:2px; height:100%; flex-wrap:nowrap; }
  .bars .bar { flex:none; width:27px; min-width:27px; background: var(--vscode-charts-blue, #3794ff); opacity:.85; border-radius:2px 2px 0 0; cursor:pointer; position:relative; }
  .bars .bar:hover { opacity:1; background: var(--vscode-charts-green, #89d185); }
  .bars .bar.capped { background: var(--vscode-charts-orange, #cca700); }
  /* Rich tooltip — fixed position, positioned by JS */
  .tooltip { display:none; position:fixed; background:var(--vscode-editorHoverWidget-background, #000); color:var(--vscode-editorHoverWidget-foreground, #fff); border:1px solid var(--vscode-editorWidget-border,#555); border-radius:6px; padding:6px 10px; font-size:11px; white-space:nowrap; z-index:9999; line-height:1.6; pointer-events:none; max-height:220px; overflow:hidden; }
  .xaxis { height:20px; position:relative; margin-top:2px; }
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
      <div class="ctxbar" id="ctxbar"><div style="width:0%"></div></div>
      <div class="sub" id="ctxsub"></div></div>
    <div class="card"><div class="label">Last request</div><div class="value" id="dur">—</div><div class="sub" id="durSub"></div></div>
    <div class="card"><div class="label">Output rate</div><div class="value" id="rate">—</div><div class="sub" id="rateSub"></div></div>
    <div class="card"><div class="label">Live</div><div class="value" id="inflight">—</div><div class="sub" id="retry"></div></div>
    <div class="card"><div class="label">Session total</div><div class="value" id="total">—</div><div class="sub" id="totalSub"></div></div>
  </div>

  <h1 style="margin-top:18px">统计 · Statistics</h1>
  <div class="filters">
    <label>模型 Model <select id="f-model"><option value="all">全部 All</option></select></label>
    <label>类型 Metric <select id="f-metric">
      <option value="input">输入token Input</option>
      <option value="output">输出token Output</option>
      <option value="rate" selected>速率 Rate</option>
      <option value="duration">会话时间 Duration</option>
    </select></label>
    <label>时间范围 Time Range <select id="f-range">
      <option value="all">全部 All</option>
      <option value="1h">最近1h</option>
      <option value="6h">最近6h</option>
      <option value="24h">最近24h</option>
      <option value="7d">最近7天</option>
      <option value="30d">最近30天</option>
      <option value="custom">自定义 Custom</option>
    </select></label>
    <label id="custom-range-label" style="display:none">从 From <input type="datetime-local" id="f-from" style="background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--vscode-editorWidget-border,#444));border-radius:4px;padding:3px 6px;font-size:12px;font-family:inherit;" /></label>
    <label id="custom-range-to" style="display:none">至 To <input type="datetime-local" id="f-to" style="background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--vscode-editorWidget-border,#444));border-radius:4px;padding:3px 6px;font-size:12px;font-family:inherit;" /></label>
  </div>
  <div class="sumgrid" id="sumgrid"></div>
  <div class="chartouter">
    <div class="yaxis" id="yaxis"></div>
    <div class="chartscroll" id="chartscroll">
      <div class="plot" id="plot">
        <div class="plotgrid" id="plotgrid"><div class="bars" id="bars"></div></div>
        <div class="xaxis" id="xaxis"></div>
      </div>
    </div>
  </div>
  <div class="tooltip" id="tooltip"></div>

  <h1 style="margin-top:18px">Recent requests</h1>
  <table>
    <thead><tr><th>#</th><th>Time</th><th>Model</th><th>Context</th><th>Out</th><th>Dur</th><th>Rate</th><th>Stop</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  function setBar(barEl, pct) {
    barEl.className = "ctxbar" + (pct >= 0.85 ? " high" : "");
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

  function requestStats() {
    const range = $('f-range').value;
    let fromMs = 0;
    let toMs = 0;
    const now = Date.now();
    if (range === '1h') { fromMs = now - 3600000; }
    else if (range === '6h') { fromMs = now - 6 * 3600000; }
    else if (range === '24h') { fromMs = now - 86400000; }
    else if (range === '7d') { fromMs = now - 7 * 86400000; }
    else if (range === '30d') { fromMs = now - 30 * 86400000; }
    else if (range === 'custom') {
      const fromVal = $('f-from').value;
      const toVal = $('f-to').value;
      fromMs = fromVal ? new Date(fromVal).getTime() : 0;
      toMs = toVal ? new Date(toVal).getTime() : 0;
    }
    // 'all' → fromMs=0, toMs=0 (no filter)
    vscode.postMessage({ type:'requestStats', model: $('f-model').value, metric: $('f-metric').value, fromMs, toMs });
  }

  function toggleCustomRange() {
    const show = $('f-range').value === 'custom';
    $('custom-range-label').style.display = show ? '' : 'none';
    $('custom-range-to').style.display = show ? '' : 'none';
  }

  ['f-model','f-metric','f-range'].forEach(id => { $(id).addEventListener('change', () => { toggleCustomRange(); requestStats(); }); });
  $('f-from').addEventListener('change', requestStats);
  $('f-to').addEventListener('change', requestStats);
  // Hide tooltip when scrolling the chart
  $('chartscroll').addEventListener('scroll', hideTooltip);

  function fmtTime(ts) {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const mo = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    // Show date if it's not today, or just time
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    return isToday ? h+':'+m+':'+s : mo+'/'+day+' '+h+':'+m;
  }

  /**
   * Format a time label for X-axis, showing date when it changes.
   * Returns { text, priority } where priority indicates visual importance.
   *   priority 3 = date change (always shown, even if crowded)
   *   priority 2 = hour boundary (shown if enough space)
   *   priority 1 = 10-min boundary (shown if enough space)
   *   priority 0 = skip
   */
  function fmtAxisLabel(ts, prevTs) {
    const d = new Date(ts);
    const h = d.getHours();
    const m = d.getMinutes();
    const mo = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    const hh = String(h).padStart(2,'0');
    const mm = String(m).padStart(2,'0');

    let text = '';
    let priority = 0;

    if (!prevTs) {
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      text = isToday ? hh+':'+mm : mo+'/'+day+' '+hh+':'+mm;
      priority = 3; // first point: always show
      return { text, priority };
    }

    const prev = new Date(prevTs);
    const dayChanged = d.toDateString() !== prev.toDateString();
    const hourChanged = h !== prev.getHours();
    const minuteChanged = Math.floor(m / 10) !== Math.floor(prev.getMinutes() / 10);

    if (dayChanged) {
      text = mo+'/'+day+' '+hh+':'+mm;
      priority = 3; // date change: always show
    } else if (hourChanged) {
      text = hh+':'+mm;
      priority = 2; // hour boundary
    } else if (minuteChanged) {
      text = hh+':'+mm;
      priority = 1; // 10-min boundary
    }

    return { text, priority };
  }

  function fmtTimeFull(ts) {
    return new Date(ts).toLocaleString();
  }

  // Global tooltip element
  const tooltip = $('tooltip');

  // Show tooltip near the hovered bar, using fixed positioning to avoid clipping
  function showTooltip(barEl, html) {
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    const rect = barEl.getBoundingClientRect();
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    let top = rect.top - th - 6;
    // Clamp to viewport
    if (left < 4) left = 4;
    if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
    if (top < 4) top = rect.bottom + 6; // flip below if no room above
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  function hideTooltip() {
    tooltip.style.display = 'none';
  }

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
    ];
    // "合计 Total" is meaningless for rate (average of rates ≠ total rate).
    if (s.metric !== 'rate') {
      cards.push(['合计 Total', fmtVal(sum.total ?? 0, unit)]);
    }
    cards.forEach(([l,v]) => {
      const d = document.createElement('div'); d.className='s';
      d.innerHTML = '<div class="l">'+esc(l)+'</div><div class="v">'+esc(v)+'</div>';
      sg.appendChild(d);
    });

    const bars = $('bars'); const yaxis = $('yaxis'); const xaxis = $('xaxis');
    const plot = $('plot'); const plotgrid = $('plotgrid');
    bars.innerHTML = ''; yaxis.innerHTML = ''; xaxis.innerHTML = '';
    // Remove old gridlines and ticks
    [...plotgrid.querySelectorAll('.gridline')].forEach(g=>g.remove());
    [...xaxis.querySelectorAll('.xtick,.xlabel')].forEach(g=>g.remove());

    if (!points.length) {
      bars.innerHTML = '<div class="empty">无数据 No data for this filter</div>';
      return;
    }

    // P95 outlier capping: Y-axis max = P95 of values, bars above are capped
    const allVals = points.map(p => p.value).sort((a, b) => a - b);
    const p95Idx = Math.min(Math.floor(allVals.length * 0.95), allVals.length - 1);
    const yMax = Math.max(allVals[p95Idx], 1); // Y-axis ceiling
    const hasCapped = allVals.some(v => v > yMax);

    // Y axis: STEPS+1 labels from top (yMax) to bottom (0)
    const STEPS = 5;
    for (let i=STEPS; i>=0; i--) {
      const v = yMax * i / STEPS;
      const d = document.createElement('div'); d.textContent = fmtVal(v, unit);
      yaxis.appendChild(d);
    }
    // gridlines
    for (let i=1;i<STEPS;i++){
      const g=document.createElement('div'); g.className='gridline'; g.style.bottom=(i/STEPS*100)+'%'; plotgrid.appendChild(g);
    }

    // Fixed bar width: 27px bar + 2px gap = 29px per bar
    const barSlot = 29;
    const neededWidth = points.length * barSlot;
    const scrollContainer = $('chartscroll');
    const availableWidth = scrollContainer.clientWidth - 4;
    const chartWidth = Math.max(neededWidth, availableWidth);
    plot.style.minWidth = chartWidth + 'px';

    // bars — capped values get a special class and ▲ indicator
    points.forEach((p, idx) => {
      const b = document.createElement('div');
      const capped = p.value > yMax;
      b.className = 'bar' + (capped ? ' capped' : '');
      b.style.height = Math.max(1, (Math.min(p.value, yMax) / yMax * 100)) + '%';
      b.dataset.idx = idx;
      const r = p.req || {};
      let lines = [];
      lines.push('<b>' + esc(fmtVal(p.value, unit)) + (capped ? ' ▲' : '') + '</b>');
      lines.push('时间: ' + esc(fmtTimeFull(p.ts)));
      lines.push('模型: ' + esc(r.model || '—'));
      lines.push('耗时: ' + esc(fmtMs(r.durationMs || 0)));
      lines.push('输出: ' + esc(fmtTok(r.outputTokens || 0)) + ' @ ' + esc(fmtRate(r.outputRate || 0)));
      lines.push('输入: ' + esc(fmtTok((r.inputTokens||0) + (r.cacheReadTokens||0))));
      if (r.cacheReadTokens) lines.push('缓存读: ' + esc(fmtTok(r.cacheReadTokens)));
      const tipHtml = lines.join('<br>');
      b.addEventListener('mouseenter', () => showTooltip(b, tipHtml));
      b.addEventListener('mouseleave', hideTooltip);
      bars.appendChild(b);
    });

    // X-axis: smart time labels at date changes, hour boundaries, etc.
    // Walk through all bars and place labels only at significant time transitions.
    // All labels must respect minimum pixel spacing. Date changes (priority 3)
    // are the most important — if a date change is too close to the previous
    // label, it REPLACES the previous label (date info is more important).
    const minLabelPx = 56; // minimum pixels between label centers
    const minLabelEvery = Math.max(1, Math.ceil(minLabelPx / barSlot));
    // Track placed labels as { idx, element refs } so we can remove/replace.
    const placedLabels = [];
    let prevTs = 0;

    for (let idx = 0; idx < points.length; idx++) {
      const p = points[idx];
      const label = fmtAxisLabel(p.ts, prevTs);
      prevTs = p.ts;

      // Skip if not significant
      if (label.priority === 0) continue;

      const barCenter = idx * barSlot + barSlot / 2;
      const tooClose = placedLabels.length > 0 && idx - placedLabels[placedLabels.length - 1].idx < minLabelEvery;

      if (tooClose) {
        // Only date change (priority 3) can replace the previous label.
        if (label.priority < 3) continue;
        // Date change: remove the previous label and replace with this one.
        const prev = placedLabels.pop();
        prev.tick.remove();
        prev.lbl.remove();
      }

      // Place the label.
      const tick = document.createElement('div');
      tick.className = 'xtick';
      tick.style.left = barCenter + 'px';
      xaxis.appendChild(tick);
      const lbl = document.createElement('div');
      lbl.className = 'xlabel';
      lbl.style.left = barCenter + 'px';
      lbl.textContent = label.text;
      if (label.priority >= 2) {
        lbl.style.fontWeight = '600';
        lbl.style.opacity = '.7';
      }
      xaxis.appendChild(lbl);
      placedLabels.push({ idx, tick, lbl });
    }

    // Always label the last bar if it's not already labeled, but only if
    // there's enough space from the previous label.
    if (points.length > 0) {
      const lastIdx = points.length - 1;
      const alreadyLabeled = placedLabels.length > 0 && placedLabels[placedLabels.length - 1].idx === lastIdx;
      const tooClose = placedLabels.length > 0 && lastIdx - placedLabels[placedLabels.length - 1].idx < minLabelEvery;
      if (!alreadyLabeled && !tooClose) {
        const barCenter = lastIdx * barSlot + barSlot / 2;
        const d = new Date(points[lastIdx].ts);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const text = isToday
          ? String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')
          : String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
        const tick = document.createElement('div');
        tick.className = 'xtick';
        tick.style.left = barCenter + 'px';
        xaxis.appendChild(tick);
        const lbl = document.createElement('div');
        lbl.className = 'xlabel';
        lbl.style.left = barCenter + 'px';
        lbl.textContent = text;
        xaxis.appendChild(lbl);
      }
    }
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
    if (msg.type === 'refreshStats') { requestStats(); return; }
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
        tr.innerHTML = '<td>'+r.idx+'</td><td class="muted">'+esc(r.time)+'</td><td>'+esc(r.model)+'</td><td>'+r.ctx+'</td><td>'+r.out+
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

/**
 * Compute a lightweight signature of a MonitorState for change detection.
 * Only includes fields that would produce visible changes in the dashboard
 * when the monitor is idle — avoids the expensive history/requests array.
 */
function stateSig(s: MonitorState): string {
  return [
    s.phase,
    s.model,
    s.contextTokens,
    s.contextPct,
    s.lastRequest?.endMs ?? "",
    s.lastRequest?.outputRate ?? "",
    s.requestCount,
    s.totalOutputTokens,
    s.totalInputTokens,
    s.retrying ? "1" : "0",
    s.retryAttempt ?? "",
    s.retryCode ?? "",
    s.liveElapsedMs < 1000 ? 0 : Math.floor(s.liveElapsedMs / 1000), // 1s granularity
    s.title ?? "",
  ].join("|");
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
    idx: number; time: string; model: string; ctx: string; out: string;
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
        time: r.endMs ? new Date(r.endMs).toLocaleString() : "",
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
