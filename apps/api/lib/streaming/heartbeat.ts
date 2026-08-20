/**
 * Origin-side heartbeats for streaming chat responses (issue #59).
 *
 * api.ansari.chat is proxied through Cloudflare, which closes a proxied
 * connection after ~100 seconds without a single byte from the origin (not
 * configurable below Enterprise). The facilitator emits nothing while Gemini
 * is in a thinking phase or a tool round is running, so a stream can sit
 * silent long enough to be dropped at the edge mid-request. These heartbeats
 * keep bytes flowing whenever the real stream is idle.
 */

export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Raw-text route timing (issue #64). The deployed frontend (web + Expo, not
 * quickly redeployable) creates the assistant bubble and hides the thinking
 * indicator on the FIRST received byte — so an early ZWSP destroys the
 * thinking indicator on ordinary turns. First-token latency is p50 ~19s /
 * p90 ~39s: waiting 15s before the first heartbeat balances thinking-
 * indicator UX against mobile network idle timeouts (many carriers drop
 * TCP at 30-60s). p50 ~11s, so ~half of turns never receive one; turns
 * silent past 15s get bytes flowing well inside mobile idle cutoffs.
 * Previous value (60s) left a fatal gap: p90 responses had no heartbeat
 * and mobile users' connections were silently dropped mid-thinking.
 */
export const RAW_TEXT_HEARTBEAT_INITIAL_DELAY_MS = 15_000;
export const RAW_TEXT_HEARTBEAT_INTERVAL_MS = 15_000;

/** SSE comment line — ignored by SSE parsers, never surfaces to clients. */
export const SSE_HEARTBEAT = ': ping\n\n';

/**
 * Zero-width space for the raw-text stream (POST /api/v2/threads/[id]) whose
 * client renders every received byte verbatim. Only ever sent BEFORE the
 * first real content byte: leading ZWSPs are invisible, but one landing
 * mid-stream could break ligature joining inside Arabic/Quran text.
 */
export const RAW_TEXT_HEARTBEAT = '\u200B';

export interface Heartbeat {
  /** Record real stream activity: defers the next heartbeat by a full interval. */
  touch(): void;
  /** Stop the heartbeat for good (idempotent). */
  stop(): void;
}

/**
 * Call `send` every `intervalMs` while the stream is otherwise idle (no
 * `touch` within the last interval). The FIRST heartbeat waits
 * `initialDelayMs` (default: `intervalMs`, i.e. no extra grace) — the raw
 * text route uses a long initial delay so ordinary turns never receive a
 * heartbeat byte at all (#64). If `send` throws (e.g. enqueue on a
 * controller closed by a client disconnect), the heartbeat stops itself.
 */
export function startHeartbeat(
  send: () => void,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  initialDelayMs: number = intervalMs
): Heartbeat {
  let lastActivity = Date.now();
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const stop = () => {
    stopped = true;
    clearTimeout(initialTimer);
    if (interval !== undefined) clearInterval(interval);
  };

  const beat = () => {
    if (Date.now() - lastActivity < intervalMs) return;
    try {
      send();
      // A heartbeat is itself bytes on the wire; the edge idle timer resets.
      lastActivity = Date.now();
    } catch {
      stop();
    }
  };

  const initialTimer = setTimeout(() => {
    beat();
    if (stopped) return;
    interval = setInterval(beat, intervalMs);
    interval.unref?.();
  }, initialDelayMs);
  // Don't let a pending heartbeat hold the process open on shutdown.
  initialTimer.unref?.();

  return {
    touch: () => {
      lastActivity = Date.now();
    },
    stop,
  };
}
