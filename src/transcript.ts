// Discover and parse Claude Code transcript JSONL files.
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

export function listSessions(projectsDir: string): SessionInfo[] {
  const out: SessionInfo[] = [];
  let top: string[];
  try {
    top = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const sub of top) {
    const subDir = path.join(projectsDir, sub);
    let files: string[];
    try {
      files = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(subDir, f);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(p);
      } catch {
        continue;
      }
      const sessionId = f.replace(/\.jsonl$/, "");
      const meta = quickMeta(p);
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

// Read the first and last few lines to extract session metadata cheaply.
function quickMeta(p: string): Partial<SessionInfo> {
  const meta: Partial<SessionInfo> = {};
  try {
    const fd = fs.openSync(p, "r");
    try {
      const headBuf = Buffer.alloc(8192);
      const n = fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      const head = headBuf.toString("utf8", 0, n);
      for (const line of head.split("\n")) {
        if (!line.trim()) {
          continue;
        }
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
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ignore
  }
  return meta;
}

export function safeParse(line: string): TranscriptEntry | null {
  try {
    return JSON.parse(line) as TranscriptEntry;
  } catch {
    return null;
  }
}

/**
 * Read a transcript file and return parsed entries. To bound memory on very
 * large sessions, only the trailing `maxBytes` of the file are read.
 */
export function readEntries(p: string, maxBytes = 2_000_000): TranscriptEntry[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return [];
  }
  let buf: Buffer;
  let skipFirst = false;
  const fd = fs.openSync(p, "r");
  try {
    if (stat.size > maxBytes) {
      buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
      skipFirst = true; // first line likely partial
    } else {
      buf = Buffer.alloc(stat.size);
      fs.readSync(fd, buf, 0, stat.size, 0);
    }
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const start = skipFirst ? 1 : 0;
  const out: TranscriptEntry[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    const o = safeParse(line);
    if (o) {
      out.push(o);
    }
  }
  return out;
}

export function fileMtimeMs(p: string): number | undefined {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
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
  if (sessions.length === 0) {
    return undefined;
  }
  if (workspaceCwd) {
    const norm = (s?: string) =>
      s ? path.resolve(s).toLowerCase().replace(/\\/g, "/") : "";
    const target = norm(workspaceCwd);
    const match = sessions.find(
      (s) => s.cwd && norm(s.cwd) === target
    );
    if (match) {
      return match;
    }
    // Also accept sessions whose encoded dir name matches the encoded cwd.
    const encTarget = encodeCwd(workspaceCwd).toLowerCase();
    const encMatch = sessions.find((s) =>
      s.path.toLowerCase().includes(encTarget)
    );
    if (encMatch) {
      return encMatch;
    }
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
export function listActiveSessions(claudeDir?: string): ActiveSession[] {
  const dir = claudeDir && claudeDir.trim().length > 0
    ? claudeDir
    : path.join(os.homedir(), ".claude");
  const sessionsDir = path.join(dir, "sessions");
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ActiveSession[] = [];
  for (const f of files) {
    const p = path.join(sessionsDir, f);
    let obj: any;
    try {
      obj = JSON.parse(fs.readFileSync(p, "utf8"));
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
    out.push({
      sessionId: obj.sessionId,
      pid: obj.pid,
      cwd: obj.cwd,
      startedAt: obj.startedAt,
      transcriptPath: findTranscriptForSession(dir, obj.sessionId, obj.cwd),
    });
  }
  return out;
}

/** Locate the transcript JSONL for a sessionId under <claudeDir>/projects. */
export function findTranscriptForSession(
  claudeDir: string,
  sessionId: string,
  cwd?: string
): string | undefined {
  const projectsDir = path.join(claudeDir, "projects");
  let subdirs: string[];
  try {
    subdirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  // Prefer the subdir matching the encoded cwd, but fall back to scanning all.
  const ordered: string[] = [];
  if (cwd) {
    const enc = encodeCwd(cwd);
    if (subdirs.includes(enc)) {
      ordered.push(enc);
    }
  }
  for (const s of subdirs) {
    if (!ordered.includes(s)) {
      ordered.push(s);
    }
  }
  for (const sub of ordered) {
    const candidate = path.join(projectsDir, sub, `${sessionId}.jsonl`);
    try {
      fs.statSync(candidate);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}
