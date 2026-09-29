import {
  makeMutable,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { EASE_OUT } from '@/constants/motion';
import { keyboardOverlap, KEYBOARD_MIN } from '@/lib/keyboard';
import { touchBrowser } from '@/lib/web';

/**
 * The on-screen keyboard on the web: getting out of its way before it
 * arrives, rather than answering it afterwards.
 *
 * A browser never says "the keyboard is up". What it does instead is
 * shrink the *visual* viewport — the part of the page the reader can
 * actually see — while the layout viewport keeps its full height, and
 * then scroll that visual viewport down inside the layout one to lift
 * the focused field clear. Both arrive here as `resize` and `scroll` on
 * `window.visualViewport`, and they are the only signal there is.
 *
 * That scroll — the pan — is the whole problem. It is the browser
 * moving the app rather than the app moving, so the "fixed" menu button
 * leaves the top of the screen, the hero is sliced by the edge of the
 * glass, and for a moment the app is off the top of the screen
 * altogether. It is neither followed (a reaction, always a beat late:
 * the app rides up and snaps back) nor accepted (smooth, but the chrome
 * and the hero leave with it). It is made unnecessary.
 *
 * A browser only pans to bring a *covered* field into view. So the
 * moment a field is touched — before the keyboard exists — the app
 * shortens itself to the room the keyboard is about to leave, and the
 * field the browser was going to scroll to is already standing above
 * it. Nothing is covered, so nothing scrolls: the app is simply a
 * shorter app for as long as the keyboard is up, the menu button stays
 * where it was, and the hero re-centres in the room that is left.
 *
 * Three things make that hold rather than nearly hold:
 *
 *   - **The height is remembered.** The first keyboard a browser ever
 *     raises is estimated; every one after it, in this session or a
 *     later one, uses the height measured last time on this device.
 *   - **The room is made in one step.** The reshape is written
 *     synchronously inside the focus event and forced to lay out before
 *     the handler returns. It is tempting to ease it — a quarter second
 *     of CSS, the way the native build rides the real keyboard's
 *     animation — but an eased shell is still its old height at the
 *     instant the browser decides whether the field is covered, and it
 *     decides that the field is. That was the pan in the recording.
 *     The step is the price of the browser holding still.
 *   - **Any pan that happens anyway is cancelled per frame.** A browser
 *     reports the pan long after it has drawn it, so waiting for the
 *     event is watching the app leave the screen and come back. While a
 *     keyboard is being handled the viewport is read every frame
 *     instead, and the shell is held to it.
 *
 * A shell that changes height in one frame changes everything standing
 * in it in one frame too, and the temptation is to let the pieces the
 * browser is *not* measuring take their time — measure one either side
 * of the reshape, hand it back the distance it jumped, animate that
 * away. It was tried, on the hero of the empty screen, and it is
 * recorded here so it is not tried again: those two measurements cannot
 * both be trusted. Whatever iOS has already done to the document by the
 * time `focusin` is dispatched is in the first one, so on a real phone
 * the pair produced an offset that left the emblem parked a hundred
 * points above where it belonged — a resting layout that is wrong is a
 * far worse failure than a transition that is abrupt. Everything moves
 * in the one frame, deliberately.
 *
 * Measured once for the whole app, at module scope, because the
 * viewport is one object and every screen is asking the same question
 * of it.
 */

/** 0 with the keyboard away, 1 with it up — the native shape. */
const progress = makeMutable(0);

let raised = false;

/**
 * How long the app takes to give the room back.
 *
 * Only the way back is timed. Making room races the browser's own
 * decision and has to be a step (see above); giving it back races
 * nothing, and a keyboard slides off the screen in about a quarter of a
 * second. The curve is `EASE_OUT` from `constants/motion` written the
 * way CSS takes it — this is the app's motion, not the platform's.
 */
const SHELL_MOTION = 260;
const SHELL_CURVE = 'cubic-bezier(0.23, 1, 0.32, 1)';

/**
 * How much of the screen a first, unmeasured keyboard leaves.
 *
 * What is remembered and applied is the *room* — how tall the app is
 * with a keyboard up — rather than the keyboard's own height, because
 * they are not the same subtraction. A phone browser collapses its own
 * bottom toolbar as the keyboard rises, so the page is handed back
 * forty-odd points at the same moment it loses three hundred, and a
 * shell sized by subtracting the keyboard from today's height ends up
 * short by the toolbar and has to grow again once everything has
 * stopped. The room is the one number that is already both.
 *
 * Phone keyboards with their suggestion bar run to about two fifths of
 * the screen. This first guess leaves a little less room than that:
 * guessing small leaves a band of bare paper under the composer for a
 * moment, which the first real measurement closes, while guessing
 * generously leaves the composer covered — and a covered field is the
 * one thing that makes the browser pan.
 */
const FIRST_GUESS = 0.52;

/** Where the measured room is kept between sessions. */
const REMEMBERED = 'ansari.keyboard';

/**
 * Keyed by width, because a keyboard's height is a property of the
 * device and its orientation rather than of the app.
 */
function rememberedKey() {
  return `${REMEMBERED}.${Math.round(window.innerWidth)}`;
}

function remember(room: number) {
  try {
    window.localStorage.setItem(rememberedKey(), String(room));
  } catch {
    // Private browsing, or storage turned off. The session's own
    // measurement still stands; only the memory of it is lost.
  }
}

function recall(): number {
  try {
    const kept = Number(window.localStorage.getItem(rememberedKey()));
    // A room from a phone that has since changed its furniture is worse
    // than no memory at all: it has to be short enough to have had a
    // keyboard in it and tall enough for the app to stand up in.
    const plausible =
      kept >= FLOOR && window.innerHeight - kept >= KEYBOARD_MIN / 2;
    return Number.isFinite(kept) && plausible ? kept : 0;
  } catch {
    return 0;
  }
}

/**
 * What was last written to the shell.
 *
 * Every write of `top` or `height` on the body relays out the entire
 * app beneath it, so the shell is written only when the rectangle it is
 * being held to has actually changed — which, once a keyboard is up and
 * still, is never, though the frame loop below keeps asking.
 */
let writtenTop = '';
let writtenHeight = '';

function writeShell(top: string, height: string): boolean {
  if (top === writtenTop && height === writtenHeight) return false;
  writtenTop = top;
  writtenHeight = height;
  const shell = document.body.style;
  shell.top = top;
  shell.height = height;
  return true;
}

/**
 * The transition, worn only on the way back.
 *
 * `height` is also what follows the browser's own chrome as it grows
 * and shrinks (`100dvh` in the shell stylesheet), and a URL bar the app
 * lags a quarter second behind would read as the layout being loose —
 * so the transition goes on when the room is handed back and comes off
 * again once it has been.
 */
function easeShell(on: boolean) {
  document.body.style.transition = on
    ? `height ${SHELL_MOTION}ms ${SHELL_CURVE}`
    : '';
}

/**
 * Never so short that the app has nowhere to stand: a wrong reading
 * should cost a cramped screen, not a folded one.
 */
const FLOOR = 240;

/** The room this session last measured, before anything is written. */
let lastRoom = 0;

/** Whether the app is currently holding itself clear of a keyboard. */
let engaged = false;

/** The height the shell is being held to while it is. */
let shortHeight = 0;

let easeOffTimer: ReturnType<typeof setTimeout> | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * @param eased - false while making room, where every part of the
 * change lands in the same frame as the reshape; true on the way back,
 * where the shell is easing and these ride with it.
 */
function raise(up: boolean, eased: boolean) {
  if (up === raised) return;
  raised = up;
  // The state that rides the shell — the composer giving up its
  // safe-area padding, the emblem making way on native — so the app
  // changes shape once rather than in parts.
  progress.set(
    eased
      ? withTiming(up ? 1 : 0, { duration: SHELL_MOTION, easing: EASE_OUT })
      : up
        ? 1
        : 0,
  );
}

/**
 * Put the document back where it belongs.
 *
 * The visual viewport is not the only thing iOS moves to reveal a
 * focused field: it will also scroll the *document*, and it does so
 * even when the page has told it there is nothing to scroll — the shell
 * is a fixed, overflow-hidden body exactly one viewport tall. That
 * scroll does not show up in `visualViewport.offsetTop`, so the frame
 * loop below cannot see it and cannot cancel it; what a reader gets is
 * the whole app slid up under the status bar with its menu button gone.
 *
 * There is nothing to lose by undoing it. The app has no page-level
 * scroll of its own — every scroller in it is an element — so a
 * non-zero document offset is always something the browser did on the
 * app's behalf and always wrong.
 */
function unscroll() {
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
  const root = document.scrollingElement;
  if (root && root.scrollTop !== 0) root.scrollTop = 0;
}

function takesText(node: EventTarget | null): boolean {
  const element = node as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || element.isContentEditable;
}

/**
 * Holding the shell to the visible rectangle, frame by frame.
 *
 * The events a viewport emits arrive well after the browser has drawn
 * the movement they describe, which is why every attempt to answer them
 * has looked like a snap. Reading the same numbers in a frame loop
 * costs two property reads and, while nothing is moving, no write at
 * all — and it catches a pan on the frame it is drawn rather than a
 * fifth of a second later.
 *
 * The loop stops itself once the rectangle has been still for long
 * enough to believe, and any report from the viewport starts it again.
 */
const QUIET_FRAMES = 20;

let frame: number | undefined;
let stillFor = 0;

function track() {
  frame = undefined;
  if (!engaged) return;
  const viewport = window.visualViewport;
  if (!viewport) return;
  // A pinch is the reader's own business: while the page is zoomed the
  // visual viewport is a window they are moving on purpose.
  if (viewport.scale > 1) return;
  unscroll();
  const moved = writeShell(
    `${Math.round(viewport.offsetTop)}px`,
    // Never taller than the room that was made. Until the keyboard is
    // fully up the viewport still reports its old height, and handing
    // the app that height back would put the composer under the
    // keyboard again halfway through.
    `${Math.min(shortHeight, Math.round(viewport.height))}px`,
  );
  stillFor = moved ? 0 : stillFor + 1;
  if (stillFor < QUIET_FRAMES) frame = requestAnimationFrame(track);
}

function startTracking() {
  stillFor = 0;
  if (frame === undefined) frame = requestAnimationFrame(track);
}

function stopTracking() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
}

/**
 * A field has been touched: make room now, on the best height known.
 */
function engage(event: FocusEvent) {
  const viewport = window.visualViewport;
  if (viewport && viewport.scale > 1) return;
  if (!takesText(event.target)) return;
  clearTimeout(releaseTimer);
  clearTimeout(easeOffTimer);
  const room =
    lastRoom || recall() || Math.round(window.innerHeight * FIRST_GUESS);
  engaged = true;
  // No transition on the way in, and none left over from the way out:
  // the browser is about to measure this field, and it has to measure
  // it where it will be.
  easeShell(false);
  unscroll();
  shortHeight = Math.max(FLOOR, Math.min(room, window.innerHeight));
  writeShell(`${Math.round(viewport?.offsetTop ?? 0)}px`, `${shortHeight}px`);
  // Lay it out before this handler returns. The browser works out
  // whether the field needs scrolling into view once the event has been
  // dispatched, and it must find the app already short by then — an
  // invalidated layout it has not performed yet is the old layout.
  void document.body.offsetHeight;
  raise(true, false);
  unscroll();
  startTracking();
  // Not every focused field raises a keyboard — a hardware one is
  // attached, or the focus came from the page rather than from a
  // finger, which iOS answers with no keyboard at all. Those cases
  // produce no viewport event whatsoever, so without a clock of its own
  // the room would be held for the rest of the session.
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, GRACE);
}

/** The field has let go: give the room back as the keyboard leaves. */
function release() {
  if (!engaged) return;
  engaged = false;
  stopTracking();
  easeShell(true);
  writeShell('', '');
  raise(false, true);
  clearTimeout(easeOffTimer);
  easeOffTimer = setTimeout(() => easeShell(false), SHELL_MOTION + 80);
}

function onFocusOut() {
  // Moving between two fields is a blur followed immediately by a
  // focus, and the keyboard never leaves the screen between them. A
  // shell handed back and taken again inside a frame would be a flinch.
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    if (takesText(document.activeElement)) return;
    release();
  }, 80);
}

/**
 * What the viewport turned out to be, once it stopped moving.
 *
 * Nothing here is a reaction the reader can see: by the time this runs
 * the app has made its room, the frame loop has held it there, and the
 * keyboard has finished arriving. It exists to replace the height that
 * was assumed with the height that happened — usually the same number,
 * so usually nothing is written — and to catch the case no guess can: a
 * keyboard that never came.
 */
function settle() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  if (viewport.scale > 1) return;
  // Nothing to measure against a keyboard that was never raised.
  if (simulated) return;

  // What counts as a keyboard, and what is only the browser moving its
  // own furniture, is decided in `lib/keyboard` — where it can be held
  // to the cases a real phone reports (see the tests beside it).
  const covered = keyboardOverlap({
    innerHeight: window.innerHeight,
    viewportHeight: viewport.height,
    offsetTop: viewport.offsetTop,
    scale: viewport.scale,
  });

  if (covered > 0) {
    // The room this device leaves, measured rather than assumed, so
    // the next field touched on it needs no guess at all.
    lastRoom = Math.round(viewport.height);
    remember(lastRoom);
    engaged = true;
    // The visible rectangle, exactly: shortened by the keyboard that
    // actually appeared and, if the browser panned regardless, moved
    // down by as far as it panned so the app sits still under it.
    const measured = Math.max(FLOOR, lastRoom);
    // Only the first keyboard on a device is ever wrong about this, and
    // then usually by a few points — but the first one is the one a
    // reader meets. The correction *may* be eased where the reshape
    // could not: the browser made its decision about the field a third
    // of a second ago and is not going to make it again.
    const corrects = measured !== shortHeight;
    if (corrects) easeShell(true);
    shortHeight = measured;
    writeShell(`${Math.round(viewport.offsetTop)}px`, `${shortHeight}px`);
    if (corrects) {
      clearTimeout(easeOffTimer);
      easeOffTimer = setTimeout(() => easeShell(false), SHELL_MOTION + 80);
    }
    raise(true, false);
    return;
  }

  // No keyboard, and the viewport has been still long enough to believe
  // it: a hardware keyboard, a field that raises nothing, or the moment
  // after one has closed. Either way the room is not needed.
  if (engaged) release();
}

/**
 * Restart the clock on every report.
 *
 * One movement of the keyboard emits both `resize` and `scroll`, many
 * times over, passing through every intermediate rectangle on the way.
 * None of them is acted on here: they only wake the frame loop, which
 * is quicker than they are, and push the reckoning further out so
 * `settle` runs once, against the shape the reader is left with.
 */
const SETTLE = 320;

/**
 * How long a keyboard has to appear before the app stops waiting for
 * one. Long enough to cover the slide, short enough that a field which
 * raises nothing does not leave the app short for a beat the reader
 * would notice.
 */
const GRACE = 700;

let settleTimer: ReturnType<typeof setTimeout> | undefined;

function onViewportChange() {
  if (engaged) startTracking();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, SETTLE);
}

/**
 * `?kb=<room>` — stand the app up in its keyboard-up shape and leave it
 * there.
 *
 * The one state in this app that no desktop browser will ever enter on
 * its own, and the one that has been wrong the most often. Without this
 * the only way to look at it is to hold a phone, which means every
 * correction costs a round trip through a reader. With it, the layout a
 * keyboard leaves behind can be screenshotted at any width: pass the
 * room the keyboard leaves — a notched iPhone in Safari leaves a little
 * over 400 of its 844 points, because the browser keeps its address bar
 * and the field's own accessory bar above the keyboard as well.
 *
 * It is deliberately not gated on a development build: the shape is
 * worth being able to ask any deployment for, and a query string a
 * reader will never type costs a URL read at startup.
 */
function simulatedRoom(): number {
  try {
    const asked = new URLSearchParams(window.location.search).get('kb');
    const room = Number(asked);
    return asked !== null && Number.isFinite(room) && room >= FLOOR ? room : 0;
  } catch {
    return 0;
  }
}

let simulated = 0;

if (typeof window !== 'undefined' && window.visualViewport) {
  simulated = simulatedRoom();
  if (simulated) {
    // The real path, on a made-up room: the composer is focused for
    // the reader, which runs the same reshape a finger would, so what
    // is on screen afterwards is the layout — and the movement into
    // it — that a phone would have produced.
    lastRoom = simulated;
    window.addEventListener('focusin', engage);
    window.setTimeout(() => {
      const field = document.querySelector('input, textarea');
      if (field instanceof HTMLElement) field.focus();
    }, 400);
  } else {
    window.visualViewport.addEventListener('resize', onViewportChange);
    window.visualViewport.addEventListener('scroll', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    // Only a finger raises a keyboard. On a desktop browser, focusing a
    // field must leave the app exactly as tall as it was.
    if (touchBrowser) {
      window.addEventListener('focusin', engage);
      window.addEventListener('focusout', onFocusOut);
    }
  }
}

export function useKeyboardProgress(): SharedValue<number> {
  return progress;
}
