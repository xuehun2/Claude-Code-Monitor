// Types describing the parts of the Claude Code transcript JSONL we care about,
// plus the derived monitor state shown in the status bar / dashboard.

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
 * Reduce a list of transcript entries (already parsed, in file order) to a
 * MonitorState. Each assistant message with usage is treated as one model
 * request; its start time is the timestamp of the most recent preceding
 * user/tool-result entry.
 */
export function computeState(
  entries: TranscriptEntry[],
  opts: ComputeOptions
): MonitorState {
  const state: MonitorState = {
    source: "transcript",
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

  if (entries.length === 0) {
    state.source = "none";
    return state;
  }

  let pendingStartMs: number | undefined; // start time of the request currently in flight
  let lastUserMs: number | undefined; // timestamp of the last user-type entry
  let lastErrorText: string | undefined; // text of the most recent API error
  let lastErrorMs: number | undefined; // timestamp of the most recent API error
  let sawApiError = false; // any isApiErrorMessage entry exists in this session

  const requests: RequestRecord[] = [];

  for (const e of entries) {
    // Carry session metadata from any entry that has it.
    state.sessionId ??= e.sessionId;
    state.cwd ??= e.cwd;
    state.version ??= e.version;
    state.gitBranch ??= e.gitBranch;
    state.entrypoint ??= e.entrypoint;

    const eMs = tsToMs(e.timestamp);

    if (e.type === "user") {
      // An API-error entry is a real, explicit signal that a model request's
      // retries were exhausted and the error was surfaced. Capture its text.
      if (e.isApiErrorMessage) {
        sawApiError = true;
        lastErrorMs = eMs ?? lastErrorMs;
        const text = stringifyContent(e.message?.content);
        lastErrorText = text || "API error";
        // An error entry is NOT a new in-flight model request start.
        continue;
      }
      const ms = eMs;
      if (ms !== undefined) {
        lastUserMs = ms;
        pendingStartMs = ms;
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
        state.model = e.message.model;
      }
      if (usage?.service_tier) {
        state.serviceTier = usage.service_tier;
      }
      if (usage?.speed) {
        state.speed = usage.speed;
      }
      // Always reflect the freshest context size we've seen.
      state.contextTokens = contextTokens;

      // Only emit a request record when a user/tool-result entry preceded
      // this one. Claude Code writes the same assistant message multiple
      // times (streaming snapshots); those re-writes have no new preceding
      // user entry, so pendingStartMs is undefined and we skip them — this
      // is what dedups the duplicates naturally.
      if (pendingStartMs !== undefined) {
        const startMs = pendingStartMs;
        const durationMs = endMs >= startMs ? endMs - startMs : 0;
        const outputRate =
          durationMs > 0 ? (outputTokens / durationMs) * 1000 : 0;
        requests.push({
          model: e.message.model ?? state.model ?? "unknown",
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
        });
        pendingStartMs = undefined; // consumed
      }
      continue;
    }

    // Other entry types (system init, summary, attachment, queue-operation, ...):
    // pull model info from system init if present.
    if (e.type === "system" && e.subtype === "init") {
      // init sometimes carries model under message.model or a top-level field
      const m = (e as Record<string, unknown>).model;
      if (typeof m === "string") {
        state.model ??= m;
      }
    }
  }

  // Trim to most recent N
  const trimmed =
    requests.length > opts.maxHistory
      ? requests.slice(requests.length - opts.maxHistory)
      : requests;
  state.requests = trimmed;
  state.requestCount = requests.length;
  state.totalOutputTokens = requests.reduce((a, r) => a + r.outputTokens, 0);
  state.totalInputTokens = requests.reduce(
    (a, r) => a + r.contextTokens,
    0
  );
  state.lastRequest = requests.length ? requests[requests.length - 1] : undefined;
  state.contextTokens = state.lastRequest
    ? state.lastRequest.contextTokens
    : state.contextTokens;
  state.contextPct =
    opts.contextLimit > 0
      ? Math.min(1, state.contextTokens / opts.contextLimit)
      : 0;

  // In-flight: the last non-error user entry had no following assistant
  // message AND the session didn't end on an API error. If the last entry is
  // an API error, the request is done (interrupted by error), not generating.
  const lastEntry = entries[entries.length - 1];
  const endedOnError = !!lastEntry?.isApiErrorMessage;
  const inFlight =
    !endedOnError &&
    lastUserMs !== undefined &&
    pendingStartMs !== undefined &&
    lastEntry?.type !== "assistant";
  state.inFlight = inFlight;
  if (inFlight && lastUserMs !== undefined) {
    state.inFlightElapsedMs = Math.max(0, opts.nowMs - lastUserMs);
  }

  // Retry / error signal: ONLY the explicit isApiErrorMessage entry.
  // We do not infer retrying from in-flight duration — long tool runs would
  // cause false positives, and the user asked for a real attempt signal only.
  state.lastErrorText = lastErrorText;
  state.lastErrorMs = lastErrorMs;
  if (sawApiError && lastErrorText) {
    state.retrying = true;
    state.retryReason = truncate(lastErrorText, 120);
  }

  return state;
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
