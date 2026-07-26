// Types describing the parts of the Claude Code transcript JSONL we care about,
// plus the derived monitor state shown in the status bar / dashboard.
//
// computeState() supports incremental computation: when only a few new entries
// have been appended since the last call, pass the previous ComputeAccumulator
// to avoid re-traversing the entire entries array.

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
  speed?: string;
}

export interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  entrypoint?: string;
  permissionMode?: string;
  // queue-operation
  operation?: string;
  // system init
  subtype?: string;
  // user messages that are API errors carry this
  isApiErrorMessage?: boolean;
  message?: {
    role?: string;
    model?: string;
    usage?: Usage;
    stop_reason?: string;
    content?: unknown;
  };
  [k: string]: unknown;
}

export interface RequestRecord {
  model: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextTokens: number; // input + cache_read + cache_creation
  outputRate: number; // tokens / second (0 if unknown)
  stopReason?: string;
  isError?: boolean;
}

export interface MonitorState {
  source: "none" | "transcript";
  transcriptPath?: string;
  sessionId?: string;
  /** Display name of the session (from the log's update_session_state title). */
  title?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  entrypoint?: string;
  model?: string;
  serviceTier?: string;
  speed?: string;

  contextTokens: number;
  contextLimit: number;
  contextPct: number;

  lastRequest?: RequestRecord;

  requests: RequestRecord[];
  requestCount: number;
  totalOutputTokens: number;
  totalInputTokens: number; // input + cache_read + cache_creation summed

  inFlight: boolean;
  inFlightElapsedMs: number;

  /**
   * True only when there is a real retry/error signal. Sourced primarily from
   * the Claude Code log ("API error (attempt N/M)" / "Slow first byte
   * (attempt N)"); falls back to the transcript's `isApiErrorMessage` entry
   * if the log is unavailable.
   *
   * We deliberately do NOT infer "retrying" from in-flight duration, because
   * long tool executions would cause false positives.
   */
  retrying: boolean;
  retryReason?: string;
  /** Human-readable text of the most recent API error, if any. */
  lastErrorText?: string;
  /** Timestamp (ms) of the most recent API error entry, if any. */
  lastErrorMs?: number;

  // --- Live signals from the Claude Code log (overlay) ---
  /** True when the log confirms the Claude turn is actively running. */
  running: boolean;
  /** True momentarily after the user interrupted (pressed Esc). */
  interrupted: boolean;
  phase: "idle" | "sending" | "streaming" | "retrying" | "interrupted";
  /** Live elapsed of the current model request, from log [API REQUEST]. */
  liveElapsedMs: number;
  /** First-byte latency from the log ("first byte after Xms"). */
  firstByteLatencyMs?: number;
  /** Real retry attempt counter from the log. */
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryHttpStatus?: number;
  retryCode?: string;
  retryErrorType?: string;
  /** True if the live log is being tailed (signals are fresh). */
  logAvailable: boolean;

  updatedAtMs: number;
  error?: string;
}

export interface ComputeOptions {
  contextLimit: number;
  retryThresholdMs: number;
  maxHistory: number;
  nowMs: number;
  /**
   * Number of entries dropped from the front of the entries array (sliding
   * window in readEntriesIncremental). Used to keep this accumulator in sync
   * with the trimmed array so incremental processing stays correct.
   */
  entryBaseOffset?: number;
}

/**
 * Accumulator for incremental computeState. Stores the intermediate state
 * between calls so that only newly appended entries need to be processed.
 * When the entries array is replaced (truncation/re-read), pass no accumulator
 * to do a full recomputation.
 */
export interface ComputeAccumulator {
  /** How many entries (absolute, from the original start) have been processed. */
  processedCount: number;
  /** Total request count. allRequests is bounded, so this tracks the true total. */
  requestCount: number;

  // --- intermediate state carried across calls ---
  pendingStartMs: number | undefined;
  lastUserMs: number | undefined;
  lastErrorText: string | undefined;
  lastErrorMs: number | undefined;
  sawApiError: boolean;

  // --- accumulated results (updated incrementally) ---
  model: string | undefined;
  serviceTier: string | undefined;
  speed: string | undefined;
  contextTokens: number;
  sessionId: string | undefined;
  cwd: string | undefined;
  version: string | undefined;
  gitBranch: string | undefined;
  entrypoint: string | undefined;

  /** All request records (untrimmed). Only the last maxHistory are kept in state. */
  allRequests: RequestRecord[];
  totalOutputTokens: number;
  totalInputTokens: number;
}

function tsToMs(s: string | undefined): number | undefined {
  if (!s) {
    return undefined;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

function num(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Cap on how many RequestRecords the accumulator retains. Only the most recent
 * `maxHistory` (default 40) are shown in the dashboard; we keep a little extra
 * margin. The true total is tracked by `requestCount` so trimming this array
 * does not lose the count. Bounds memory in very long sessions.
 */
const MAX_ACC_REQUESTS = 100;

/**
 * Create a fresh (empty) accumulator.
 */
function freshAccumulator(): ComputeAccumulator {
  return {
    processedCount: 0,
    requestCount: 0,
    pendingStartMs: undefined,
    lastUserMs: undefined,
    lastErrorText: undefined,
    lastErrorMs: undefined,
    sawApiError: false,
    model: undefined,
    serviceTier: undefined,
    speed: undefined,
    contextTokens: 0,
    sessionId: undefined,
    cwd: undefined,
    version: undefined,
    gitBranch: undefined,
    entrypoint: undefined,
    allRequests: [],
    totalOutputTokens: 0,
    totalInputTokens: 0,
  };
}

/**
 * Process a batch of entries and update the accumulator in place.
 * Returns the updated accumulator (same reference, mutated).
 */
function processEntries(
  acc: ComputeAccumulator,
  entries: TranscriptEntry[],
  startIdx: number,
  endIdx: number,
): ComputeAccumulator {
  for (let i = startIdx; i < endIdx; i++) {
    const e = entries[i];

    // Carry session metadata from any entry that has it.
    acc.sessionId ??= e.sessionId;
    acc.cwd ??= e.cwd;
    acc.version ??= e.version;
    acc.gitBranch ??= e.gitBranch;
    acc.entrypoint ??= e.entrypoint;

    const eMs = tsToMs(e.timestamp);

    if (e.type === "user") {
      if (e.isApiErrorMessage) {
        acc.sawApiError = true;
        acc.lastErrorMs = eMs ?? acc.lastErrorMs;
        const text = stringifyContent(e.message?.content);
        acc.lastErrorText = text || "API error";
        continue;
      }
      const ms = eMs;
      if (ms !== undefined) {
        acc.lastUserMs = ms;
        acc.pendingStartMs = ms;
      }
      continue;
    }

    if (e.type === "assistant" && e.message) {
      const usage = e.message.usage;
      const endMs = eMs ?? 0;

      const inputTokens = num(usage?.input_tokens);
      const outputTokens = num(usage?.output_tokens);
      const cacheRead = num(usage?.cache_read_input_tokens);
      const cacheCreation = num(usage?.cache_creation_input_tokens);
      const contextTokens = inputTokens + cacheRead + cacheCreation;

      if (e.message.model) {
        acc.model = e.message.model;
      }
      if (usage?.service_tier) {
        acc.serviceTier = usage.service_tier;
      }
      if (usage?.speed) {
        acc.speed = usage.speed;
      }
      if (contextTokens > 0) {
        acc.contextTokens = contextTokens;
      }

      if (acc.pendingStartMs !== undefined && outputTokens > 0) {
        const startMs = acc.pendingStartMs;
        const durationMs = endMs >= startMs ? endMs - startMs : 0;
        const outputRate =
          durationMs > 0 ? (outputTokens / durationMs) * 1000 : 0;
        const req: RequestRecord = {
          model: e.message.model ?? acc.model ?? "unknown",
          startMs,
          endMs,
          durationMs,
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
          contextTokens,
          outputRate,
          stopReason: e.message.stop_reason,
        };
        acc.allRequests.push(req);
        acc.requestCount++;
        acc.totalOutputTokens += outputTokens;
        acc.totalInputTokens += contextTokens;
        acc.pendingStartMs = undefined; // consumed
        // Bound the retained request history so allRequests cannot grow
        // unboundedly in very long sessions. requestCount keeps the true total.
        if (acc.allRequests.length > MAX_ACC_REQUESTS) {
          acc.allRequests.splice(0, acc.allRequests.length - MAX_ACC_REQUESTS);
        }
      }
      continue;
    }

    if (e.type === "system" && e.subtype === "init") {
      const m = (e as Record<string, unknown>).model;
      if (typeof m === "string") {
        acc.model ??= m;
      }
    }
  }

  // Note: processedCount (absolute) is set by the caller, which knows the
  // entryBaseOffset (sliding-window drop count). processEntries only ever
  // processes to the end of the array it's given.
  return acc;
}

/**
 * Build a MonitorState from an accumulator and the full entries array.
 * This is the "finalize" step — it reads the accumulated values and
 * computes the derived fields (contextPct, inFlight, trimmed requests, etc.).
 */
function buildState(acc: ComputeAccumulator, entries: TranscriptEntry[], opts: ComputeOptions): MonitorState {
  const state: MonitorState = {
    source: entries.length === 0 ? "none" : "transcript",
    contextTokens: acc.contextTokens,
    contextLimit: opts.contextLimit,
    contextPct: 0,
    requests: [],
    requestCount: acc.requestCount,
    totalOutputTokens: acc.totalOutputTokens,
    totalInputTokens: acc.totalInputTokens,
    inFlight: false,
    inFlightElapsedMs: 0,
    retrying: false,
    running: false,
    interrupted: false,
    phase: "idle",
    liveElapsedMs: 0,
    logAvailable: false,
    updatedAtMs: opts.nowMs,

    // Carry metadata from accumulator
    sessionId: acc.sessionId,
    cwd: acc.cwd,
    version: acc.version,
    gitBranch: acc.gitBranch,
    entrypoint: acc.entrypoint,
    model: acc.model,
    serviceTier: acc.serviceTier,
    speed: acc.speed,
  };

  // Trim to most recent N
  const all = acc.allRequests;
  const trimmed =
    all.length > opts.maxHistory
      ? all.slice(all.length - opts.maxHistory)
      : all;
  state.requests = trimmed;
  state.lastRequest = all.length ? all[all.length - 1] : undefined;
  state.contextTokens = state.lastRequest
    ? state.lastRequest.contextTokens
    : state.contextTokens;
  state.contextPct =
    opts.contextLimit > 0
      ? Math.min(1, state.contextTokens / opts.contextLimit)
      : 0;

  // In-flight: the last non-error user entry had no following assistant
  // message AND the session didn't end on an API error.
  const lastEntry = entries[entries.length - 1];
  const endedOnError = !!lastEntry?.isApiErrorMessage;
  const inFlight =
    !endedOnError &&
    acc.lastUserMs !== undefined &&
    acc.pendingStartMs !== undefined &&
    lastEntry?.type !== "assistant";
  state.inFlight = inFlight;
  if (inFlight && acc.lastUserMs !== undefined) {
    state.inFlightElapsedMs = Math.max(0, opts.nowMs - acc.lastUserMs);
  }

  // Retry / error signal
  state.lastErrorText = acc.lastErrorText;
  state.lastErrorMs = acc.lastErrorMs;
  if (acc.sawApiError && acc.lastErrorText) {
    state.retrying = true;
    state.retryReason = truncate(acc.lastErrorText, 120);
  }

  return state;
}

/**
 * Incrementally compute MonitorState from transcript entries.
 * If prevAcc is provided and its processedCount matches the start of the
 * entries array, only the newly appended entries are processed.
 * If prevAcc is undefined or stale (processedCount > entries.length, meaning
 * the entries array was replaced), a full recomputation is performed.
 *
 * Returns { state, acc } where acc should be passed to the next call.
 */
export function computeStateIncremental(
  entries: TranscriptEntry[],
  prevAcc: ComputeAccumulator | undefined,
  opts: ComputeOptions
): { state: MonitorState; acc: ComputeAccumulator } {
  // No entries at all — return empty state.
  if (entries.length === 0) {
    const acc = freshAccumulator();
    const state: MonitorState = {
      source: "none",
      contextTokens: 0,
      contextLimit: opts.contextLimit,
      contextPct: 0,
      requests: [],
      requestCount: 0,
      totalOutputTokens: 0,
      totalInputTokens: 0,
      inFlight: false,
      inFlightElapsedMs: 0,
      retrying: false,
      running: false,
      interrupted: false,
      phase: "idle",
      liveElapsedMs: 0,
      logAvailable: false,
      updatedAtMs: opts.nowMs,
    };
    return { state, acc };
  }

  // Determine if we can do an incremental update. The entries array is a
  // sliding window: readEntriesIncremental drops old entries from the front
  // once maxEntries is exceeded, tracking how many were dropped in
  // `droppedCount` (passed here as opts.entryBaseOffset). So the entry at
  // index i in the current array is absolute index (base + i); the
  // accumulator's processedCount is absolute, so the first unprocessed entry
  // in the current array is at relative index (processedCount - base). If that
  // is within [0, entries.length] we process just the new tail; otherwise the
  // array was replaced or the accumulator is stale, so recompute from index 0.
  const base = opts.entryBaseOffset ?? 0;
  let acc: ComputeAccumulator;
  let startIdx: number;

  if (prevAcc) {
    const rel = prevAcc.processedCount - base;
    if (rel >= 0 && rel <= entries.length) {
      // Incremental: reuse previous accumulator, process only new entries.
      acc = prevAcc;
      startIdx = rel;
    } else {
      // Full recomputation: start fresh.
      acc = freshAccumulator();
      startIdx = 0;
    }
  } else {
    acc = freshAccumulator();
    startIdx = 0;
  }

  // Process new entries (if any).
  if (startIdx < entries.length) {
    processEntries(acc, entries, startIdx, entries.length);
  }
  // Absolute processed count: the current array covers absolute indices
  // [base, base + entries.length).
  acc.processedCount = base + entries.length;

  const state = buildState(acc, entries, opts);
  return { state, acc };
}

/**
 * Full (non-incremental) computation — processes all entries from scratch.
 * Kept for backward compatibility and for cases where incremental state
 * is not available (e.g. collectRequestsFromFile).
 */
export function computeState(
  entries: TranscriptEntry[],
  opts: ComputeOptions
): MonitorState {
  return computeStateIncremental(entries, undefined, opts).state;
}

/** Shape of a per-session log state from logtail.ts (kept local to avoid a cycle). */
export interface LogStateLike {
  /** Whether live log data is available for this session. Defaults to true if omitted. */
  available?: boolean;
  running: boolean;
  interrupted: boolean;
  interruptedAtMs?: number;
  requestSentAtMs?: number;
  firstByteAtMs?: number;
  firstByteLatencyMs?: number;
  retrying: boolean;
  retry?: {
    attempt: number;
    maxAttempts: number;
    httpStatus: number;
    code: string;
    errorType: string;
    message: string;
    atMs: number;
  };
}

/**
 * Overlay live signals from the Claude Code log onto transcript-derived state.
 * The log is authoritative for: running/idle, interrupt, retry attempts, and
 * the current request phase / first-byte latency. When the log is unavailable
 * for this session, we fall back to the transcript in-flight heuristic.
 */
export function mergeLogState(
  state: MonitorState,
  log: LogStateLike | undefined,
  nowMs: number
): MonitorState {
  if (!log || !log.available) {
    state.logAvailable = false;
    // Fallback: transcript in-flight drives phase.
    if (state.retrying) {
      state.phase = "retrying";
    } else if (state.inFlight) {
      state.phase = "streaming";
      state.liveElapsedMs = state.inFlightElapsedMs;
      state.running = true;
    } else {
      state.phase = "idle";
    }
    return state;
  }

  state.logAvailable = true;
  state.running = log.running;
  state.interrupted = log.interrupted;
  if (log.firstByteLatencyMs !== undefined) {
    state.firstByteLatencyMs = log.firstByteLatencyMs;
  }

  // Retry info from the log is the real signal.
  if (log.retrying && log.retry) {
    state.retrying = true;
    state.retryReason = log.retry.message;
    state.retryAttempt = log.retry.attempt;
    state.retryMaxAttempts = log.retry.maxAttempts || undefined;
    state.retryHttpStatus = log.retry.httpStatus || undefined;
    state.retryCode = log.retry.code || undefined;
    state.retryErrorType = log.retry.errorType || undefined;
  } else if (log.retrying) {
    state.retrying = true;
  }

  // Live elapsed of the current model request.
  if (log.requestSentAtMs) {
    state.liveElapsedMs = Math.max(0, nowMs - log.requestSentAtMs);
  }

  // Derive phase.
  if (log.interrupted) {
    state.phase = "interrupted";
  } else if (log.retrying) {
    state.phase = "retrying";
  } else if (log.running) {
    state.phase = log.firstByteAtMs ? "streaming" : "sending";
  } else {
    state.phase = "idle";
  }

  return state;
}


function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c && typeof c === "object" && "text" in (c as Record<string, unknown>)
            ? String((c as Record<string, unknown>).text)
            : ""
      )
      .join(" ");
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ---- formatting helpers used by status bar + dashboard ----

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

export function fmtMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const s = ms / 1000;
  if (s < 60) {
    return `${s.toFixed(1)}s`;
  }
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

export function fmtRate(tokPerSec: number): string {
  if (!Number.isFinite(tokPerSec) || tokPerSec <= 0) {
    return "—";
  }
  if (tokPerSec >= 100) {
    return `${tokPerSec.toFixed(0)} t/s`;
  }
  return `${tokPerSec.toFixed(1)} t/s`;
}
