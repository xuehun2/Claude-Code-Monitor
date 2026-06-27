// Tail the Claude Code VS Code extension log to extract real-time signals that
// the transcript JSONL does NOT expose. Now MULTI-SESSION aware: multiple Claude
// Code sessions share one log file (one VS Code window = one exthost log), and
// each session's signals are routed by sessionId where possible.
//
// Routing rules (verified against a real dual-session log):
//   - update_session_state {sessionId, state, title}  -> routed EXACTLY by
//     sessionId. Provides: running/idle, and the session TITLE (display name).
//   - [API REQUEST] / Stream started / first byte / Slow first byte /
//     API error (attempt N/M)  -> these lines carry NO sessionId. They are
//     attributed to the session that is currently "running" (the most recent
//     update_session_state.running). A session is always running while it is
//     mid-request or retrying, so this attribution is correct for the retry/
//     first-byte case. The only ambiguity is two sessions running concurrently
//     and interleaving requests — rare in practice.
//   - interrupt_claude {channelId}  -> no sessionId; attributed to the current
//     running session (you can only interrupt a running one).
//
// The log lives at:
//   <Code logs>/<timestamp>/window<N>/exthost/Anthropic.claude-code/Claude VScode.log

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  httpStatus: number;
  code: string;
  errorType: string;
  message: string;
  atMs: number;
}

export interface PerSessionLogState {
  sessionId: string;
  title?: string;
  running: boolean;
  interrupted: boolean;
  interruptedAtMs?: number;
  requestSentAtMs?: number;
  firstByteAtMs?: number;
  firstByteLatencyMs?: number;
  slowFirstByteAttempt?: number;
  retrying: boolean;
  retry?: RetryInfo;
  lastActivityMs: number;
}

export interface LogSummary {
  available: boolean;
  logPath?: string;
  /** Per-session live states, keyed by sessionId. */
  sessions: Map<string, PerSessionLogState>;
  updatedAtMs: number;
}

export class LogTailer implements vscode.Disposable {
  private logPath: string | undefined;
  private fd: number | undefined;
  private offset = 0;
  private watcher: fs.FSWatcher | undefined;
  private sessions = new Map<string, PerSessionLogState>();
  private lastRunningSessionId: string | undefined;
  private listeners: Array<(s: LogSummary) => void> = [];
  private rescanTimer: NodeJS.Timeout | undefined;
  private readonly pollingTimer: NodeJS.Timeout;
  private readonly codeLogsDir: string;

  constructor(codeLogsDir: string) {
    this.codeLogsDir = codeLogsDir;
    this.pollingTimer = setInterval(() => this.checkFile(), 1000);
    this.rescanTimer = setInterval(() => this.findAndOpen(), 10_000);
    void this.findAndOpen();
  }

  onState(fn: (s: LogSummary) => void): void {
    this.listeners.push(fn);
  }

  getSummary(): LogSummary {
    return {
      available: !!this.logPath && this.fd !== undefined,
      logPath: this.logPath,
      sessions: this.sessions,
      updatedAtMs: Date.now(),
    };
  }

  /** Live state for one session (or undefined if unseen in the log). */
  getSession(sessionId: string): PerSessionLogState | undefined {
    return this.sessions.get(sessionId);
  }

  private getOrCreate(sessionId: string): PerSessionLogState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        running: false,
        interrupted: false,
        retrying: false,
        lastActivityMs: Date.now(),
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private findAndOpen(): void {
    const found = findLatestLog(this.codeLogsDir);
    if (!found) {
      return;
    }
    if (found === this.logPath) {
      return;
    }
    this.close();
    this.logPath = found;
    try {
      this.fd = fs.openSync(found, "r");
      this.offset = fs.statSync(found).size;
      this.watcher = fs.watch(found, () => this.checkFile());
      this.replayTail(96_000);
      this.emit();
    } catch {
      this.fd = undefined;
    }
  }

  private replayTail(bytes: number): void {
    if (!this.fd || !this.logPath) {
      return;
    }
    try {
      const size = fs.statSync(this.logPath).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(this.fd, buf, 0, buf.length, start);
      this.parse(skipPartialFirstLine(buf.toString("utf8")));
    } catch {
      // ignore
    }
  }

  private close(): void {
    try {
      this.watcher?.close();
    } catch {
      // ignore
    }
    this.watcher = undefined;
    try {
      if (this.fd !== undefined) {
        fs.closeSync(this.fd);
      }
    } catch {
      // ignore
    }
    this.fd = undefined;
    this.offset = 0;
  }

  private checkFile(): void {
    if (!this.fd || !this.logPath) {
      this.findAndOpen();
      return;
    }
    let size: number;
    try {
      size = fs.statSync(this.logPath).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      this.offset = 0;
    }
    if (size === this.offset) {
      return;
    }
    try {
      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(this.fd, buf, 0, len, this.offset);
      this.offset = size;
      this.parse(buf.toString("utf8"));
      this.emit();
    } catch {
      // ignore
    }
  }

  private parse(chunk: string): void {
    const lines = chunk.split("\n");
    const now = Date.now();
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line) {
        continue;
      }
      this.parseLine(line, now);
    }
  }

  private parseLine(line: string, now: number): void {
    const ts = extractTime(line, now);

    // 1) update_session_state — routed exactly by sessionId.
    if (line.includes("update_session_state")) {
      const wv = /Received message from webview: (\{.*\})\s*$/.exec(line);
      if (wv) {
        try {
          const obj = JSON.parse(wv[1]);
          const req = obj?.request;
          if (req?.type === "update_session_state" && req.sessionId) {
            const s = this.getOrCreate(req.sessionId);
            s.title = req.title ?? s.title;
            s.lastActivityMs = ts;
            if (req.state === "running") {
              s.running = true;
              s.interrupted = false; // new request started → clear interrupt
              this.lastRunningSessionId = req.sessionId;
            } else if (req.state === "waiting_input" || req.state === "idle") {
              s.running = false;
              // Do NOT clear interrupted here — an interrupt is always
              // followed by waiting_input, but the user wants the interrupt
              // flag to persist until the next request starts.
            }
          }
        } catch {
          // ignore
        }
      }
      return;
    }

    // 2) rename_tab — also carries a title (but no sessionId). Try to apply to
    //    the most recent running/active session if it has no title yet. This is
    //    best-effort; update_session_state is the authoritative title source.
    if (line.includes("rename_tab")) {
      return; // update_session_state already gives us titled sessions reliably
    }

    // 3) interrupt_claude — attribute to the current running session.
    if (line.includes('"interrupt_claude"')) {
      const sid = this.lastRunningSessionId;
      if (sid) {
        const s = this.getOrCreate(sid);
        s.interrupted = true;
        s.interruptedAtMs = ts;
        s.running = false;
      }
      return;
    }

    // 4) Request-level signals (no sessionId): attribute to running session.
    const sid = this.lastRunningSessionId;
    if (!sid) {
      return;
    }
    const s = this.getOrCreate(sid);

    if (line.includes("[API REQUEST]") && line.includes("/messages")) {
      s.requestSentAtMs = ts;
      s.firstByteAtMs = undefined;
      s.firstByteLatencyMs = undefined;
      s.interrupted = false; // new request started → clear interrupt
      s.lastActivityMs = ts;
      return;
    }

    if (line.includes("Stream started") && line.includes("first chunk")) {
      s.firstByteAtMs = ts;
      s.lastActivityMs = ts;
      if (s.retrying) {
        s.retrying = false;
      }
      return;
    }
    const fb = /first byte after (\d+)ms/.exec(line);
    if (fb) {
      s.firstByteLatencyMs = parseInt(fb[1], 10);
      return;
    }

    const slow = /Slow first byte: no stream chunk[\d.]+s after request sent \(attempt (\d+)\)/.exec(
      line
    );
    if (slow) {
      s.slowFirstByteAttempt = parseInt(slow[1], 10);
      s.retrying = true;
      s.retry = {
        attempt: parseInt(slow[1], 10),
        maxAttempts: 0,
        httpStatus: 0,
        code: "SlowFirstByte",
        errorType: "timeout",
        message: `Slow first byte (attempt ${slow[1]})`,
        atMs: ts,
      };
      s.lastActivityMs = ts;
      return;
    }

    const err = /API error \(attempt (\d+)\/(\d+)\): (\d+) \d+ (\{.*\})/.exec(line);
    if (err) {
      const attempt = parseInt(err[1], 10);
      const max = parseInt(err[2], 10);
      const httpStatus = parseInt(err[3], 10);
      let code = "";
      let errorType = "";
      try {
        const body = JSON.parse(err[4]);
        code = body?.error?.code ?? "";
        errorType = body?.error?.type ?? "";
      } catch {
        // ignore
      }
      s.retrying = true;
      s.retry = {
        attempt,
        maxAttempts: max,
        httpStatus,
        code,
        errorType,
        message: [
          httpStatus || "",
          code || errorType || "API error",
          `attempt ${attempt}${max ? "/" + max : ""}`,
        ]
          .filter(Boolean)
          .join(" · "),
        atMs: ts,
      };
      s.lastActivityMs = ts;
      return;
    }
  }

  private emit(): void {
    const summary: LogSummary = {
      available: !!this.logPath && this.fd !== undefined,
      logPath: this.logPath,
      sessions: this.sessions,
      updatedAtMs: Date.now(),
    };
    for (const fn of this.listeners) {
      fn(summary);
    }
  }

  dispose(): void {
    clearInterval(this.pollingTimer);
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
    }
    this.close();
  }
}

function skipPartialFirstLine(s: string): string {
  const i = s.indexOf("\n");
  return i >= 0 ? s.slice(i + 1) : s;
}

function extractTime(line: string, fallback: number): number {
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/.exec(line);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  const prefix = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/.exec(line);
  if (prefix) {
    const t = Date.parse(prefix[1].replace(" ", "T") + "Z");
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  return fallback;
}

export interface TtftRecord {
  ts: number;
  model: string;
  ttftMs: number;
}

/**
 * Scan the ENTIRE log file for historical TTFT (time-to-first-token) entries.
 * Each "first byte after Xms" line is timestamped; the model is taken from the
 * most recent "[API:timing] dispatching to firstParty model=..." line. Returns
 * records at/after sinceMs, sorted ascending.
 */
export function collectTtftRecords(logPath: string, sinceMs = 0): TtftRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const out: TtftRecord[] = [];
  let currentModel = "unknown";
  for (const line of text.split("\n")) {
    const m = /\[API:timing\] dispatching to firstParty model=(\S+)/.exec(line);
    if (m) {
      currentModel = m[1];
      continue;
    }
    const fb = /first byte after (\d+)ms/.exec(line);
    if (fb) {
      const ts = extractTime(line, Date.now());
      if (ts >= sinceMs) {
        out.push({ ts, model: currentModel, ttftMs: parseInt(fb[1], 10) });
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export function findLatestLog(codeLogsDir: string): string | undefined {
  let sessions: string[];
  try {
    sessions = fs
      .readdirSync(codeLogsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  let best: { path: string; mtime: number } | undefined;
  for (const s of sessions) {
    let windows: string[];
    try {
      windows = fs
        .readdirSync(path.join(codeLogsDir, s), { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("window"))
        .map((d) => path.join(codeLogsDir, s, d.name));
    } catch {
      windows = [];
    }
    for (const w of windows) {
      const candidate = path.join(w, "exthost", "Anthropic.claude-code", "Claude VScode.log");
      try {
        const st = fs.statSync(candidate);
        if (!best || st.mtimeMs > best.mtime) {
          best = { path: candidate, mtime: st.mtimeMs };
        }
      } catch {
        // not present in this window
      }
    }
  }
  return best?.path;
}

export function defaultCodeLogsDir(): string {
  const appdata = process.env.APPDATA;
  if (appdata) {
    return path.join(appdata, "Code", "logs");
  }
  return path.join(require("os").homedir(), ".config", "Code", "logs");
}
