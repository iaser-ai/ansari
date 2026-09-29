import { AccessibilityInfo, Platform } from 'react-native';
import { DURATION } from '@/constants/motion';
import { doneHaptic, failedHaptic } from '@/lib/haptics';

/**
 * Transient notices — the store behind the toast stack.
 *
 * A notice confirms without interrupting. It arrives at the edge of the
 * screen, it leaves on its own, and the reader never has to acknowledge
 * it to get back to what they were doing. That rules out `Alert` (and
 * the browser's `alert`, which freezes the page): a modal for "Answer
 * copied" costs a tap to undo a tap.
 *
 * Everything about a notice's *lifetime* lives here rather than in the
 * view: the timers, the pause while a reader is reading the stack, the
 * cap on how many can be on screen at once, and the announcement to
 * assistive technology. The host component only draws what this store
 * says is showing, so a notice's clock keeps running the same way
 * whether or not anything is mounted to watch it.
 *
 * Decisions, not notifications, still take a real dialog with a cancel
 * in it — see `confirmDestructive` in `lib/notice.ts`.
 */

export type ToastKind = 'plain' | 'success' | 'error';

/** The one thing a notice may offer to do — a retry, usually. */
export type ToastAction = { label: string; onPress: () => void };

export type ToastOptions = {
  /** A second line, when the headline alone leaves the reader stuck. */
  detail?: string;
  action?: ToastAction;
  /** Override the lifetime in ms. `Infinity` keeps it until dismissed. */
  duration?: number;
};

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: ToastAction;
  /**
   * On its way out: it still occupies the screen for the length of its
   * exit, but it no longer takes a place in the stack, so the notices
   * under it start closing the gap while it fades.
   */
  leaving: boolean;
};

/** The exit the host animates, and therefore the delay before removal. */
export const TOAST_EXIT_MS = DURATION.exit;

/**
 * Three at a time. Past that the stack stops being chrome at the edge of
 * the screen and starts being a panel over the reading.
 */
const MAX_VISIBLE = 3;

/**
 * How long each kind stays. A confirmation is over as soon as it has
 * been seen; a failure has to survive being read, and the reader may
 * have looked away from the screen that produced it.
 */
const LIFETIME: Record<ToastKind, number> = {
  plain: 4200,
  success: 3600,
  error: 6000,
};

/** A notice carrying an action has to outlive the decision to take it. */
const ACTION_LIFETIME = 8000;

/**
 * Reduced motion means fewer and gentler moves — and, for something
 * that leaves by itself, more time to read before it does.
 */
const REDUCED_MOTION_FACTOR = 1.75;

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let counter = 0;

type Timer = {
  /** Milliseconds still to run. `Infinity` for a notice that waits. */
  remaining: number;
  /** When the current run began, so a pause can bank the difference. */
  startedAt: number;
  handle: ReturnType<typeof setTimeout> | null;
};
const timers = new Map<string, Timer>();

/** True while a finger or a pointer is on the stack. */
let paused = false;

// ---------------------------------------------------------------------
// What assistive technology is doing changes how long a notice lives.
// Both flags are read once and then kept current.

let screenReaderOn = false;
let reducedMotionOn = false;

// Native only, and deliberately so: react-native-web's
// `isScreenReaderEnabled` resolves `true` unconditionally (the browser
// exposes no such state), which would make every notice on the web
// persistent. The web path relies on the host's live region instead —
// the notice is announced when it arrives, and it still expires.
if (Platform.OS !== 'web') {
  AccessibilityInfo.isScreenReaderEnabled()
    .then((on) => {
      screenReaderOn = on;
    })
    .catch(() => {});
  AccessibilityInfo.addEventListener('screenReaderChanged', (on) => {
    screenReaderOn = on;
  });
}
AccessibilityInfo.isReduceMotionEnabled()
  .then((on) => {
    reducedMotionOn = on;
  })
  .catch(() => {});
AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => {
  reducedMotionOn = on;
});

// ---------------------------------------------------------------------

function publish(next: Toast[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

export function subscribeToToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): Toast[] {
  return toasts;
}

function clearTimer(id: string) {
  const timer = timers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
}

function start(id: string) {
  const timer = timers.get(id);
  if (!timer || !Number.isFinite(timer.remaining)) return;
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => dismissToast(id), timer.remaining);
}

function schedule(id: string, duration: number) {
  timers.set(id, { remaining: duration, startedAt: Date.now(), handle: null });
  if (!paused) start(id);
}

/**
 * A reader reaching for the stack — hovering it, or putting a finger on
 * it — is reading it. Nothing expires under their hand.
 */
export function pauseToastTimers() {
  if (paused) return;
  paused = true;
  const now = Date.now();
  for (const timer of timers.values()) {
    if (timer.handle) {
      clearTimeout(timer.handle);
      timer.handle = null;
      timer.remaining = Math.max(0, timer.remaining - (now - timer.startedAt));
    }
  }
}

export function resumeToastTimers() {
  if (!paused) return;
  paused = false;
  for (const id of timers.keys()) start(id);
}

/** Marks a notice as leaving, then drops it once its exit has played. */
export function dismissToast(id: string) {
  const toast = toasts.find((candidate) => candidate.id === id);
  if (!toast || toast.leaving) return;
  clearTimer(id);
  publish(
    toasts.map((candidate) =>
      candidate.id === id ? { ...candidate, leaving: true } : candidate,
    ),
  );
  setTimeout(() => removeToast(id), TOAST_EXIT_MS);
}

/** Drops a notice now — for a swipe, which has already carried it off. */
export function removeToast(id: string) {
  if (!toasts.some((candidate) => candidate.id === id)) return;
  clearTimer(id);
  publish(toasts.filter((candidate) => candidate.id !== id));
}

function lifetime(kind: ToastKind, options: ToastOptions): number {
  if (options.duration !== undefined) return options.duration;
  // A screen reader reads the stack at its own pace, and a notice that
  // vanishes mid-sentence is worse than one that waits to be dismissed.
  if (screenReaderOn) return Infinity;
  const base = options.action
    ? Math.max(LIFETIME[kind], ACTION_LIFETIME)
    : LIFETIME[kind];
  return reducedMotionOn ? base * REDUCED_MOTION_FACTOR : base;
}

/**
 * Spoken politely, so the reader hears the notice without the focus
 * being taken off whatever they were doing. On the web the host is a
 * live region and the browser does this itself; announcing here as well
 * would say it twice.
 */
function announce(toast: Toast) {
  if (Platform.OS === 'web') return;
  AccessibilityInfo.announceForAccessibility(
    toast.detail ? `${toast.message}. ${toast.detail}` : toast.message,
  );
}

/** The second half of the feedback; the notice arriving is the first. */
function feedback(kind: ToastKind) {
  if (kind === 'plain') return;
  if (kind === 'success') doneHaptic();
  else failedHaptic();
}

function raise(
  kind: ToastKind,
  message: string,
  options: ToastOptions = {},
): string {
  const id = `toast-${++counter}`;
  const next: Toast = {
    id,
    kind,
    message,
    detail: options.detail,
    action: options.action,
    leaving: false,
  };
  // Newest first — it is the one nearest the reader. When the stack is
  // full the *oldest* steps aside rather than the newest waiting its
  // turn behind it: a confirmation that arrives four seconds after the
  // tap has stopped being feedback.
  const showing = toasts.filter((toast) => !toast.leaving);
  if (showing.length >= MAX_VISIBLE) {
    dismissToast(showing[showing.length - 1].id);
  }
  publish([next, ...toasts]);
  schedule(id, lifetime(kind, options));
  announce(next);
  feedback(kind);
  return id;
}

/**
 * Raise a notice. One line at the call site, the way the blocking
 * helper it replaces was:
 *
 *   toast.success('Answer copied');
 *   toast.error("Couldn't start that question", {
 *     detail: 'Check your connection and ask again.',
 *     action: { label: 'Try again', onPress: retry },
 *   });
 */
export const toast = Object.assign(
  (message: string, options?: ToastOptions) => raise('plain', message, options),
  {
    success: (message: string, options?: ToastOptions) =>
      raise('success', message, options),
    error: (message: string, options?: ToastOptions) =>
      raise('error', message, options),
    dismiss: dismissToast,
  },
);
