import { Easing, cubicBezier } from 'react-native-reanimated';

/**
 * One motion language for Ansari.
 *
 * Every animation in the app used to carry its own curve and its own
 * number — a dozen durations between 220ms and 700ms, all of them
 * riding Reanimated's built-in easings. Those easings are weak: they
 * decelerate too little at the end of a move, which is exactly the part
 * a reader watches. So the whole app now speaks from this one file.
 *
 * The rule for picking a curve is short enough to remember:
 *
 *   - something entering or leaving the screen  -> EASE_OUT
 *   - something already on screen that moves    -> EASE_IN_OUT
 *   - something coming to rest after a hand-off -> a spring, not a curve
 *
 * Nothing here is tuned by eye. The curves, the duration scale and the
 * spring presets are the values from the motion spec the app follows;
 * pick the closest token rather than inventing a number beside it.
 */

/**
 * The workhorse. A steep, late deceleration — the thing arrives quickly
 * and settles rather than coasting. Everything that enters or leaves
 * uses it.
 */
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/**
 * For a thing that is already on screen and moves to a new place: it
 * has to get going as well as stop, so both ends are eased.
 */
export const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);

/**
 * The sheet curve — iOS's own. Used where a panel leaves the screen on
 * a timing curve rather than a spring.
 */
export const EASE_SHEET = Easing.bezier(0.32, 0.72, 0, 1);

/**
 * The same EASE_OUT curve in the form Reanimated's CSS transitions
 * take. `Easing.bezier` builds a worklet easing for `withTiming`;
 * declarative transitions want the CSS description of the curve.
 */
export const EASE_OUT_CSS = cubicBezier(0.23, 1, 0.32, 1);

/**
 * The duration scale. Four steps, and a reason to reach for each:
 *
 * Interface motion stays under 300ms. Anything longer stops reading as
 * a response to what the reader did and starts reading as a wait.
 */
export const DURATION = {
  /** Finger-down feedback. Long enough to see, short enough to feel instant. */
  press: 120,
  /** A small state change in place: a chip appearing, a line of status text. */
  state: 200,
  /** Something leaving. Exits run quicker than entrances — nobody watches a goodbye. */
  exit: 240,
  /** Something arriving. The ceiling for interface motion. */
  enter: 300,
} as const;

/**
 * Springs, for the things that come to rest rather than fade.
 *
 * These are written the way Apple writes them — a duration and a
 * damping ratio — rather than as mass, stiffness and damping, because
 * "settles in 400ms, without overshooting" is a description anyone can
 * check against the screen.
 */
export const SPRING = {
  /**
   * The default settle: critically damped, so it arrives and stops. Use
   * where the end position is a hard landing — a hand-off whose final
   * frame has to match the next screen's first frame exactly.
   */
  settle: { duration: 400, dampingRatio: 1 },
  /**
   * A snap back into place after a gesture or a drag, with just enough
   * give to read as physical.
   */
  snap: { duration: 400, dampingRatio: 0.8 },
  /** Sheets, drawers, panels rising into view. */
  sheet: { duration: 300, dampingRatio: 0.8 },
  /**
   * A whole region of the screen changing shape — the desktop rail
   * collapsing, and the reading column that follows its edge.
   *
   * Deliberately outside the 300ms ceiling, and the reason is the same
   * one that puts the ambient layer outside it: the ceiling is for a
   * control answering a touch, where anything longer reads as lag. This
   * is the furniture of the screen rearranging itself, and the reader is
   * meant to watch it happen rather than find it already done. At
   * interface speed a move this large reads as a cut.
   *
   * Critically damped, like `settle`, so it decelerates all the way into
   * its resting place and cannot overshoot — which for the rail also
   * means the mark cannot be carried past a whole turn.
   */
  glide: { duration: 620, dampingRatio: 1 },
  /**
   * A sheet the reader has flicked off the screen. Critically damped and
   * clamped: an overshoot here would carry the sheet past the bottom edge
   * and flash a gap under it on the way out.
   */
  dismiss: { duration: 300, dampingRatio: 1, overshootClamping: true },
} as const;

/**
 * How long a "this is the one" mark is held before it fades.
 *
 * Outside the interface scale above on purpose, and for the opposite
 * reason to the ambient layer's: this is not motion at all but a piece
 * of information shown for a while. It has to outlast the movement that
 * brings the marked thing into view — otherwise the mark has already
 * gone by the time the reader's eye arrives — and then stay just long
 * enough to be read, without becoming a selection the reader has to
 * dismiss.
 */
export const ANCHOR_HOLD = 900;

/**
 * When a dragged sheet leaves rather than springs home.
 *
 * Two rules, whichever comes first, because a sheet that only measures
 * distance feels heavy: a slow drag has to travel, but a flick from near
 * the top is already an unambiguous "go away".
 */
export const SHEET_DISMISS = {
  /**
   * Fraction of the sheet's own height the finger has to have carried it
   * past at the moment it lets go.
   */
  travel: 0.4,
  /** Downward speed, in px/s, that dismisses from anywhere. */
  flick: 900,
} as const;

/**
 * A swipe that begins at the very edge of the screen — back out of a
 * thread, or in to the rail.
 *
 * Same two rules as a dragged sheet, for the same reason: a slow drag
 * has to travel, but a flick from the edge is already an unambiguous
 * "take me there". The zone is the strip the finger has to *start* in,
 * which is what keeps the gesture from stealing an ordinary sideways
 * drag anywhere else on the page.
 */
export const EDGE_SWIPE = {
  /** How wide the strip along the edge a swipe has to begin in. */
  zone: 24,
  /** Movement, in px, before the swipe is an intention rather than a wobble. */
  slop: 12,
  /** Fraction of the full travel the finger must have carried it past. */
  travel: 0.4,
  /** Sideways speed, in px/s, that commits from anywhere. */
  flick: 700,
} as const;

/**
 * When a row swiped sideways stays open rather than closing again.
 *
 * Shorter fuses than a sheet's: the travel is a button's width rather
 * than a screen's, so the same fractions in absolute terms are a much
 * smaller move, and the flick has to be reachable inside it.
 */
export const ROW_REVEAL = {
  /** Fraction of the action's width past which letting go leaves it open. */
  travel: 0.5,
  /** Sideways speed, in px/s, that opens or closes from anywhere. */
  flick: 500,
} as const;

/**
 * A boundary that resists rather than stops dead. Dragging a sheet past
 * its resting place — or a notice against the direction it can be flung
 * — keeps following the finger, at less and less of it.
 */
export function rubberband(
  overshoot: number,
  dimension: number,
  constant = 0.55,
): number {
  'worklet';
  return (
    (overshoot * dimension * constant) /
    (dimension + constant * Math.abs(overshoot))
  );
}

/**
 * A struck emblem turning about its own vertical axis, the way a coin
 * flips on a table rather than the way a wheel spins: the top stays up
 * and the near edge swings toward the reader, which is what makes it
 * read as a piece of metal instead of a loading spinner.
 *
 * `perspective` is deep enough for that swing to be visible and shallow
 * enough that a 32px emblem does not fish-eye.
 *
 * A real coin does not turn at an even brightness. It catches the light
 * as its face sweeps through the angle that throws the light back, and
 * loses it again — so the glint rides the turn rather than pulsing on a
 * clock of its own. The bloom is narrow, and centred a little short of
 * edge-on, where a raised surface is still wide enough to see it happen;
 * at both rest angles it has died away completely, so a mark that is not
 * turning is drawn exactly as it was authored.
 *
 * Returned whole rather than as a handful of exported numbers: the
 * caller is a worklet, and one call across that boundary is cheaper to
 * read — and to keep in step — than four.
 */
export function coinTurnAt(progress: number) {
  'worklet';
  const glance = Math.abs(Math.sin(progress * 2 * Math.PI));
  const glint = Math.exp(-((glance - 0.86) ** 2) / 0.045);
  return {
    perspective: 620,
    degrees: progress * 360,
    brightness: 1 + 0.45 * glint,
    contrast: 1 + 0.16 * glint,
  };
}

/**
 * The ask-to-thread cross-dissolve. Not a curve this module gets to
 * choose: the navigator runs its own fade and only takes a length. Held
 * at its tuned value — long enough to cover the swap of screens, short
 * enough that the question appears to stay put on one sheet of paper —
 * and named here so no duration in the app is anonymous.
 */
export const SCREEN_FADE_MS = 260;

/**
 * Ambient motion — the palm-shadow layer behind the ask — is
 * deliberately outside the scale above, and these are the only
 * durations in the app that break the 300ms ceiling.
 *
 * The ceiling exists because interface motion is a response to a touch:
 * past 300ms it reads as lag. The shadow layer is not responding to
 * anything. It is weather. A wash of light coming up over most of a
 * second is the point of it, and an interface-speed fade would read as
 * a light being switched on.
 */
export const AMBIENT = {
  /**
   * The shadow layer arriving over the paper.
   *
   * Long, and deliberately so: the layer no longer starts until the
   * page has finished loading and gone idle, so it is never racing the
   * first screen and can afford to take its time. Slower actually reads
   * as *fewer* layers here — what makes an arrival feel like a stage in
   * a loading sequence is its edge, not its length, and eased at both
   * ends over most of a second there is no frame where the shadow can
   * be said to have appeared.
   */
  layerIn: 800,
  /**
   * How long the layer will wait for an idle moment after load before
   * giving up and arriving anyway. A page that never goes idle is still
   * a page that should get its shadow.
   */
  settleIdle: 2000,
  /** The layer dismissed — quicker, so the paper is ready to be read. */
  layerOut: 420,
  /**
   * The video itself surfacing over its own poster.
   *
   * It is held back until the whole clip is buffered rather than merely
   * playable, and the clip is then stopped and wound back to the frame
   * the poster is showing, so this dissolves between two copies of the
   * same picture. There is nothing to reveal, in other words — only a
   * still that has to start moving without a moment where it can be said
   * to have started, and it does not begin moving until this is spent.
   * That wants an ambient length, close to the layer's own arrival, not
   * an interface one.
   *
   * Left to reveal wherever the download happened to leave the playhead,
   * this cross-faded a still against a picture a second further on, and
   * a soft-edged shadow blended over an offset copy of itself reads as
   * the video jumping.
   */
  videoIn: 1100,
} as const;
