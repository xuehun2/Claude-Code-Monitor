// Discover and parse Claude Code transcript JSONL files.
// All I/O is async to avoid blocking the VS Code extension host thread.
// For real-time monitoring, readEntriesIncremental() supports incremental
// reading — only new bytes appended since the last read are fetched and parsed.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { TranscriptEntry } from "./metrics";

export interface SessionInfo {
  sessionId: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  entrypoint?: string;
  lastModel?: string;
}

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function resolveProjectsDir(override?: string): string {
  const dir = override && override.trim().length > 0 ? override : defaultProjectsDir();
  return dir;
}

export async function listSessions(projectsDir: string): Promise<SessionInfo[]> {
  const out: SessionInfo[] = [];
  let top: fs.Dirent[];
  try {
    top = (await fs.promises.readdir(projectsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const sub of top) {
    const subDir = path.join(projectsDir, sub.name);
    let files: string[];
    try {
      files = (await fs.promises.readdir(subDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(subDir, f);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(p);
      } catch {
        continue;
      }
      const sessionId = f.replace(/\.jsonl$/, "");
      const meta = await quickMeta(p);
      out.push({
        sessionId,
        path: p,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        ...meta,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Read the first few lines to extract session metadata cheaply.
async function quickMeta(p: string): Promise<Partial<SessionInfo>> {
  const meta: Partial<SessionInfo> = {};
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(p, "r");
    const headBuf = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString("utf8", 0, bytesRead);
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      const o = safeParse(line);
      if (o) {
        meta.cwd ??= o.cwd;
        meta.version ??= o.version;
        meta.gitBranch ??= o.gitBranch;
        meta.entrypoint ??= o.entrypoint;
        if (o.message?.model) {
          meta.lastModel ??= o.message.model;
        }
        break;
      }
    }
  } catch {
    // ignore
  } finally {
    await fd?.close();
  }
  return meta;
}

/**
 * Incremental read state — tracks how far we've read into a transcript file.
 * On each call, only the bytes appended since lastOffset are read and parsed,
 * then appended to the existing entries array. This avoids re-reading the
 * entire 2MB tail on every tick.
 */
export interface IncrementalReadState {
  /** Byte offset we've read up to (file position for next read). */
  lastOffset: number;
  /** File size at last read — used to detect truncation (file replaced). */
  lastSize: number;
  /** Parsed entries accumulated so far (only the trailing maxEntries are kept). */
  entries: TranscriptEntry[];
  /**
   * How many entries have been dropped from the front of `entries` (sliding
   * window). Tracked so the compute accumulator can stay in sync with the
   * trimmed array - see `entryBaseOffset` in ComputeOptions.
   */
  droppedCount: number;
}

/**
 * Incrementally read NEW bytes from a transcript file and append parsed entries.
 * If the file was truncated (size < lastOffset), re-reads from the tail.
 * Keeps at most `maxEntries` entries in the returned state (oldest dropped).
 *
 * @param p           Path to the JSONL transcript file.
 * @param prevState   Previous incremental state (or undefined for first read).
 * @param maxEntries  Max entries to keep in memory (sliding window from the tail).
 * @param maxBytes    On first read (no prevState), only read the trailing maxBytes.
 *                    Subsequent reads are always incremental (only new bytes).
 */
export async function readEntriesIncremental(
  p: string,
  prevState: IncrementalReadState | undefined,
  maxEntries = 500,
  maxBytes = 2_000_000,
): Promise<IncrementalReadState> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(p);
  } catch {
    return prevState ?? { lastOffset: 0, lastSize: 0, entries: [], droppedCount: 0 };
  }

  const fileSize = stat.size;

  // First read — no previous state: read the tail.
  if (!prevState) {
    const entries = await readTailEntries(p, maxBytes);
    return {
      lastOffset: fileSize,
      lastSize: fileSize,
      entries: trimToMax(entries, maxEntries),
      droppedCount: 0,
    };
  }

  // File truncated or replaced (size < lastOffset) — re-read from tail.
  if (fileSize < prevState.lastOffset) {
    const entries = await readTailEntries(p, maxBytes);
    return {
      lastOffset: fileSize,
      lastSize: fileSize,
      entries: trimToMax(entries, maxEntries),
      droppedCount: 0,
    };
  }

  // No new data — return previous state as-is.
  if (fileSize === prevState.lastOffset) {
    return prevState;
  }

  // Incremental read: only the new bytes appended since lastOffset.
  const newBytes = fileSize - prevState.lastOffset;
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(p, "r");
    const buf = Buffer.alloc(newBytes);
    const { bytesRead } = await fd.read(buf, 0, newBytes, prevState.lastOffset);
    const text = buf.toString("utf8", 0, bytesRead);
    const newEntries = parseLines(text, true); // skipFirst=true: first line may be partial
    // Append in place (avoids copying the full entries array on every append)
    // and trim the sliding window from the front, tracking how many were
    // dropped so the compute accumulator stays in sync (entryBaseOffset).
    const entries = prevState.entries;
    for (const ne of newEntries) entries.push(ne);
    let droppedCount = prevState.droppedCount ?? 0;
    if (entries.length > maxEntries) {
      const excess = entries.length - maxEntries;
      entries.splice(0, excess);
      droppedCount += excess;
    }
    return {
      lastOffset: fileSize,
      lastSize: fileSize,
      entries,
      droppedCount,
    };
  } catch {
    return prevState;
  } finally {
    await fd?.close();
  }
}

/**
 * Read the tail of a transcript file and return parsed entries.
 * Used for initial reads and after truncation.
 */
async function readTailEntries(p: string, maxBytes: number): Promise<TranscriptEntry[]> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(p);
  } catch {
    return [];
  }
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(p, "r");
    let buf: Buffer;
    let skipFirst = false;
    if (stat.size > maxBytes) {
      buf = Buffer.alloc(maxBytes);
      await fd.read(buf, 0, maxBytes, stat.size - maxBytes);
      skipFirst = true;
    } else {
      buf = Buffer.alloc(stat.size);
      await fd.read(buf, 0, stat.size, 0);
    }
    const text = buf.toString("utf8");
    return parseLines(text, skipFirst);
  } catch {
    return [];
  } finally {
    await fd?.close();
  }
}

/**
 * Parse newline-delimited JSON lines from a text chunk.
 * If skipFirst is true, the first line is assumed to be partial and skipped.
 */
function parseLines(text: string, skipFirst: boolean): TranscriptEntry[] {
  const lines = text.split("\n");
  const start = skipFirst ? 1 : 0;
  const out: TranscriptEntry[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const o = safeParse(line);
    if (o) {
      trimHeavyFields(o);
      out.push(o);
    }
  }
  return out;
}

/** Keep only the last N entries (sliding window from the tail). */
function trimToMax(entries: TranscriptEntry[], max: number): TranscriptEntry[] {
  return entries.length > max ? entries.slice(entries.length - max) : entries;
}

/**
 * Strip memory-heavy fields we don't need for monitoring. Both assistant and
 * user entries carry message.content which can be hundreds of KB each:
 *   - assistant: text blocks + tool_use input (e.g. full file-write content)
 *   - user: tool_result output (e.g. entire file reads, bash output)
 * For a long session, 500 retained entries with untrimmed content can hold
 * 10-50MB+ in memory, creating GC pressure that stalls the shared extension
 * host thread (and thus Claude Code's own streaming UI). We keep only a
 * truncated error text for API-error user messages; everything else is dropped.
 * Also drops top-level toolUseResult which can carry full tool output.
 */
function trimHeavyFields(e: TranscriptEntry): void {
  if (e.message) {
    if (e.isApiErrorMessage) {
      const text = contentToText(e.message.content);
      e.message.content = text ? text.slice(0, 200) : undefined;
    } else {
      e.message.content = undefined;
    }
  }
  delete (e as Record<string, unknown>).toolUseResult;
}

/** Best-effort flatten of message.content into a short string (for error text). */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const o = c as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
          if (typeof o.content === "string") return o.content;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

export function safeParse(line: string): TranscriptEntry | null {
  try {
    return JSON.parse(line) as TranscriptEntry;
  } catch {
    return null;
  }
}

export async function fileMtimeMs(p: string): Promise<number | undefined> {
  try {
    const stat = await fs.promises.stat(p);
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Read the ENTIRE transcript file (no tail cap). Used for historical stats.
 * @param maxBytes  Safety cap — files larger than this are read from the tail
 *                  only, to bound memory. Defaults to 20 MB.
 */
export async function readAllEntries(p: string, maxBytes = 20_000_000): Promise<TranscriptEntry[]> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(p);
  } catch {
    return [];
  }
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(p, "r");
    let buf: Buffer;
    let skipFirst = false;
    if (stat.size > maxBytes) {
      buf = Buffer.alloc(maxBytes);
      await fd.read(buf, 0, maxBytes, stat.size - maxBytes);
      skipFirst = true;
    } else {
      buf = Buffer.alloc(stat.size);
      await fd.read(buf, 0, stat.size, 0);
    }
    const text = buf.toString("utf8");
    return parseLines(text, skipFirst);
  } catch {
    return [];
  } finally {
    await fd?.close();
  }
}

export interface StatRequest {
  ts: number; // request end (assistant) timestamp
  model: string;
  inputTokens: number; // input_tokens
  outputTokens: number; // output_tokens
  cacheReadTokens: number; // cache_read_input_tokens
  durationMs: number; // request duration
  outputRate: number; // tokens / second
  startTs: number; // request start (user) timestamp
}

function tsToMs2(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}
function num2(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Scan all transcript files under projectsDir and collect every model request
 * record (with full timestamp), filtered to those ending at/after sinceMs.
 * Files are read most-recent-first and collection stops once `cap` is reached.
 */
export async function collectAllRequests(
  projectsDir: string,
  sinceMs = 0,
  cap = 5000
): Promise<StatRequest[]> {
  const files: { path: string; mtime: number }[] = [];
  let subs: fs.Dirent[];
  try {
    subs = (await fs.promises.readdir(projectsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const sub of subs) {
    const subDir = path.join(projectsDir, sub.name);
    let names: string[];
    try {
      names = (await fs.promises.readdir(subDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of names) {
      const p = path.join(subDir, f);
      try {
        const st = await fs.promises.stat(p);
        files.push({ path: p, mtime: st.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out: StatRequest[] = [];
  for (const file of files) {
    if (out.length >= cap) break;
    if (sinceMs > 0 && file.mtime < sinceMs - 86_400_000) continue;
    const entries = await readAllEntries(file.path);
    let pendingStart: number | undefined;
    for (const e of entries) {
      if (e.type === "user") {
        if (e.isApiErrorMessage) continue;
        const ms = tsToMs2(e.timestamp);
        if (ms !== undefined) pendingStart = ms;
        continue;
      }
      if (e.type === "assistant" && e.message && e.message.usage) {
        const endMs = tsToMs2(e.timestamp);
        if (pendingStart !== undefined && endMs !== undefined) {
          const u = e.message.usage;
          const o = num2(u.output_tokens);
          const i = num2(u.input_tokens);
          const cr = num2(u.cache_read_input_tokens);
          const dur = endMs >= pendingStart ? endMs - pendingStart : 0;
          if (endMs >= sinceMs) {
            out.push({
              ts: endMs,
              model: e.message.model ?? "unknown",
              inputTokens: i,
              outputTokens: o,
              cacheReadTokens: cr,
              durationMs: dur,
              outputRate: dur > 0 ? (o / dur) * 1000 : 0,
              startTs: pendingStart,
            });
          }
          pendingStart = undefined;
        }
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Collect requests from a single transcript file (for the stats panel
 * scoped to the current session).
 */
export async function collectRequestsFromFile(
  transcriptPath: string | undefined,
  sinceMs = 0
): Promise<StatRequest[]> {
  if (!transcriptPath) return [];
  const entries = await readAllEntries(transcriptPath);
  const out: StatRequest[] = [];
  let pendingStart: number | undefined;
  for (const e of entries) {
    if (e.type === "user") {
      if (e.isApiErrorMessage) continue;
      const ms = tsToMs2(e.timestamp);
      if (ms !== undefined) pendingStart = ms;
      continue;
    }
    if (e.type === "assistant" && e.message && e.message.usage) {
      const endMs = tsToMs2(e.timestamp);
      if (pendingStart !== undefined && endMs !== undefined) {
        const u = e.message.usage;
        const o = num2(u.output_tokens);
        const i = num2(u.input_tokens);
        const cr = num2(u.cache_read_input_tokens);
        const dur = endMs >= pendingStart ? endMs - pendingStart : 0;
        if (endMs >= sinceMs && o > 0) {
          out.push({
            ts: endMs,
            model: e.message.model ?? "unknown",
            inputTokens: i,
            outputTokens: o,
            cacheReadTokens: cr,
            durationMs: dur,
            outputRate: dur > 0 ? (o / dur) * 1000 : 0,
            startTs: pendingStart,
          });
        }
        pendingStart = undefined;
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Pick the best session to monitor. Prefers the most recently modified session
 * whose cwd matches the given workspace folder; falls back to the global
 * most-recently-modified session.
 */
export function pickActiveSession(
  sessions: SessionInfo[],
  workspaceCwd?: string
): SessionInfo | undefined {
  if (sessions.length === 0) return undefined;
  if (workspaceCwd) {
    const norm = (s?: string) =>
      s ? path.resolve(s).toLowerCase().replace(/\\/g, "/") : "";
    const target = norm(workspaceCwd);
    const match = sessions.find(
      (s) => s.cwd && norm(s.cwd) === target
    );
    if (match) return match;
    const encTarget = encodeCwd(workspaceCwd).toLowerCase();
    const encMatch = sessions.find((s) =>
      s.path.toLowerCase().includes(encTarget)
    );
    if (encMatch) return encMatch;
  }
  return sessions[0]; // already sorted by mtime desc
}

// Mimic Claude Code's cwd -> directory-name encoding (replace non-alnum with '-').
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface ActiveSession {
  sessionId: string;
  pid: number;
  cwd?: string;
  startedAt?: number;
  /** Path to the transcript JSONL for this session, if it exists. */
  transcriptPath?: string;
}

/**
 * Read ~/.claude/sessions/<pid>.json — each file is one live Claude Code
 * process. Returns sessions whose owning process is still alive. This is the
 * authoritative source of "which sessions are currently open".
 */
export async function listActiveSessions(claudeDir?: string): Promise<ActiveSession[]> {
  const dir = claudeDir && claudeDir.trim().length > 0
    ? claudeDir
    : path.join(os.homedir(), ".claude");
  const sessionsDir = path.join(dir, "sessions");
  let files: string[];
  try {
    files = (await fs.promises.readdir(sessionsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ActiveSession[] = [];
  for (const f of files) {
    const p = path.join(sessionsDir, f);
    let obj: any;
    try {
      const text = await fs.promises.readFile(p, "utf8");
      obj = JSON.parse(text);
    } catch {
      continue;
    }
    if (!obj || !obj.sessionId) {
      continue;
    }
    // Liveness check: signal 0 throws if the process is gone.
    if (typeof obj.pid === "number") {
      try {
        process.kill(obj.pid, 0);
      } catch {
        continue; // process dead — skip
      }
    }
    const transcriptPath = await findTranscriptForSession(dir, obj.sessionId, obj.cwd);
    out.push({
      sessionId: obj.sessionId,
      pid: obj.pid,
      cwd: obj.cwd,
      startedAt: obj.startedAt,
      transcriptPath,
    });
  }
  return out;
}

/** Locate the transcript JSONL for a sessionId under <claudeDir>/projects. */
export async function findTranscriptForSession(
  claudeDir: string,
  sessionId: string,
  cwd?: string
): Promise<string | undefined> {
  const projectsDir = path.join(claudeDir, "projects");
  let subdirs: fs.Dirent[];
  try {
    subdirs = (await fs.promises.readdir(projectsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory());
  } catch {
    return undefined;
  }
  // Prefer the subdir matching the encoded cwd, but fall back to scanning all.
  const ordered: string[] = [];
  if (cwd) {
    const enc = encodeCwd(cwd);
    if (subdirs.some((d) => d.name === enc)) {
      ordered.push(enc);
    }
  }
  for (const s of subdirs) {
    if (!ordered.includes(s.name)) {
      ordered.push(s.name);
    }
  }
  for (const sub of ordered) {
    const candidate = path.join(projectsDir, sub, `${sessionId}.jsonl`);
    try {
      await fs.promises.stat(candidate);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}
