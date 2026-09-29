/**
 * Geometry shared by the ask (home screen) and the thread.
 *
 * Asking is meant to read as one continuous move: the question lifts out
 * of the composer, takes its place at the head of the page, and the
 * waiting line appears beneath it — and *then* the thread takes over.
 * That only holds if the last frame of the home screen and the first
 * frame of the thread are the same picture: question in the same place,
 * same column, same gaps, composer at the same height. These numbers are
 * the contract between the two screens; change one and the hand-off
 * visibly jumps.
 */

/**
 * The desktop reading column: message text lands near 70 characters a
 * line — a book's measure, not a stretched web page. The home screen's
 * composer takes the same width so the composer does not resize at the
 * hand-off.
 */
export const READING_COLUMN = 672;

/**
 * The desktop conversation rail. It is a fixture of the desktop
 * composition — present on the ask and on the thread alike — so both
 * screens inset their content by exactly this much and the reading
 * column lands in the same place either side of the hand-off.
 */
export const SIDEBAR_WIDTH = 268;
/**
 * The rail collapsed to a slim strip: wide enough to keep the mark and
 * a column of icon buttons centred, narrow enough that the reading
 * column reclaims most of the paper.
 */
export const SIDEBAR_COLLAPSED_WIDTH = 68;
/**
 * The sources panel along the right edge of the thread: the answer's
 * whole apparatus, stacked, beside the answer it belongs to. Wide
 * enough for a line of Amiri at the folio's setting and a translation
 * that still reads as prose, narrow enough to leave the reading column
 * a book's measure on a normal laptop.
 */
export const SOURCE_PANEL_WIDTH = 380;

/**
 * The window a panel presentation needs. The rail and the panel between
 * them eat 648pt at their widest, so below this the reading column
 * would be squeezed to a gutter — narrow web takes the phone's
 * full-height sheet instead, which covers the answer but keeps it
 * legible.
 */
export const SOURCE_PANEL_MIN_WIDTH = 1100;

/**
 * The phone's page, at the three sizes it is actually read on.
 *
 * A handset is not one size and the page cannot be composed as though
 * it were: 320pt (an SE, a small Android) and 430pt (a Max) are a third
 * apart, and a single set of numbers pleases neither. Everything the
 * phone lays out — the side air, the emblem, the greeting, the reading
 * measure — resolves from these two thresholds, so a change to the
 * scale moves the whole page rather than one screen of it.
 */
export const PHONE_COMPACT_MAX_WIDTH = 359;
/** A Plus/Max-class handset, where the page can afford wider margins. */
export const PHONE_ROOMY_MIN_WIDTH = 414;
/**
 * A window with no room for a portrait composition: a handset turned
 * sideways in a browser, or a short desktop window still narrow enough
 * to be reading the phone's page. The hero gives up its emblem here
 * rather than pushing the composer off the bottom of the screen.
 */
export const PHONE_SHORT_MAX_HEIGHT = 560;

export type PhoneSize = 'compact' | 'regular' | 'roomy';

export function phoneSize(width: number): PhoneSize {
  if (width <= PHONE_COMPACT_MAX_WIDTH) return 'compact';
  return width < PHONE_ROOMY_MIN_WIDTH ? 'regular' : 'roomy';
}

/**
 * The widest the phone's page is allowed to get, gutters included.
 *
 * A handset in landscape is 667–932pt across, and the phone's page is
 * what it is still reading: without a ceiling an answer would run to a
 * hundred characters a line. Past this, the extra goes to the margins,
 * exactly as the desktop's 672 does.
 */
export const PHONE_COLUMN = 448;

/**
 * The air down each side of the phone's page — and the single lever the
 * reading measure is set by, since the measure is simply what is left.
 *
 * It grows with the handset (14 / 18 / 22) rather than holding one
 * value, which keeps the line between roughly 36 characters on the
 * smallest phone and 48 on the largest: short by a book's standards
 * either way, but read at arm's length rather than at a desk.
 *
 * The chrome discs take the same figure, so the menu button's edge and
 * the first word of an answer stand on one line.
 */
export function phoneGutter(width: number): number {
  const air =
    width <= PHONE_COMPACT_MAX_WIDTH
      ? 14
      : width < PHONE_ROOMY_MIN_WIDTH
        ? 18
        : 22;
  return air + Math.max(0, (width - PHONE_COLUMN) / 2);
}

/**
 * The em size an answer's body copy is set at.
 *
 * The phone is not a smaller desktop: it is held closer, and its
 * measure is half the desktop's. 17pt is the reading size for a normal
 * handset; the smallest phones step down to 16 rather than let the line
 * fall under 35 characters.
 */
export function answerSize(desktop: boolean, width: number): number {
  if (desktop) return 18;
  return width <= PHONE_COMPACT_MAX_WIDTH ? 16 : 17;
}

/**
 * ...and its leading. Leading follows the measure, not the size: the
 * desktop's 70-character line needs the eye carried back a long way and
 * takes 1.69; the phone's 40-character line finds the next line by
 * itself and reads tighter and denser at 1.59, which is also what keeps
 * a paragraph from filling the screen.
 */
export function answerLeading(desktop: boolean, width: number): number {
  if (desktop) return 30.5;
  return Math.round(answerSize(false, width) * 1.59 * 2) / 2;
}

/** Air between turns in the thread (and between the lifted question and
 * the waiting line on the home screen).
 *
 * It has to beat the 15pt that parts two paragraphs *inside* an answer
 * by a clear margin, or a turn does not read as a turn — and by more on
 * a phone than on a desktop, where a turn is already set apart by the
 * width of the column it sits in. */
export const THREAD_GAP = { phone: 26, desktop: 24 };

/** Padding under the last row of the thread, above the composer. */
export const THREAD_BOTTOM_PAD = { phone: 24, desktop: 28 };

/** Clearance between the frosted bar and the first row under it. */
export const THREAD_TOP_PAD = { phone: 18, desktop: 24 };

/** Breathing room above the composer, on both screens. */
export const COMPOSER_TOP_PAD = 8;

/** Where a phone hangs its floating chrome, below the safe area. */
export const CHROME_TOP = 10;

/** Diameter of a floating chrome disc. */
export const CHROME_BUTTON = 46;

/** Air under that disc before the page's first row. */
const CHROME_CLEARANCE = 14;

/**
 * The emblem crowning the phone's empty page, sized by the room it has
 * in both directions.
 *
 * Width alone was enough while every phone was portrait and tall. It is
 * not enough in a short window — a rotated handset, a browser holding
 * the app in the strip above its keyboard — where a mark sized off the
 * width is taller than the paper left to draw it on and the composer
 * ends up shouldered off the bottom of the screen. Below the point
 * where the mark could still be struck at a legible size it stands
 * down altogether and the greeting takes the hero on its own.
 *
 * `room` is the height left after the safe areas, not the screen's.
 */
export function phoneMarkHeight(width: number, room: number): number {
  const byWidth = Math.min(Math.max(Math.round(width * 0.25), 84), 108);
  const byRoom = Math.round(room * 0.16);
  if (byRoom < 60) return 0;
  return Math.min(byWidth, byRoom);
}

/**
 * Height of the frosted bar.
 *
 * No thread has one at any width: desktop names the conversation in
 * the rail and a phone reaches that same rail through the drawer, so
 * on both the transcript scrolls under bare paper and a single
 * floating disc. What is left is the About page's bar, and the line a
 * phone's toasts hang from.
 */
export function headerBarHeight(desktop: boolean, safeAreaTop: number): number {
  return desktop ? 64 : safeAreaTop + 50;
}

/** Where a page that does sit under that bar begins. */
export function barContentTop(desktop: boolean, safeAreaTop: number): number {
  return (
    headerBarHeight(desktop, safeAreaTop) +
    (desktop ? THREAD_TOP_PAD.desktop : THREAD_TOP_PAD.phone)
  );
}

/**
 * Where the first row of a thread begins, measured from the top of the
 * screen. A conversation reads downward from its opening question, so
 * that question sits at the head of the page — and the ask screen puts
 * it there before handing over, rather than leaving it hovering above
 * the composer for the thread to move.
 *
 * Nothing is ruled across the top of either width, so this is not a
 * bar's height: desktop holds back the band a bar used to take, which
 * is the shoulder the reading column is drawn with, and a phone clears
 * the one disc it floats there.
 */
export function threadContentTop(
  desktop: boolean,
  safeAreaTop: number,
): number {
  return desktop
    ? headerBarHeight(true, safeAreaTop) + THREAD_TOP_PAD.desktop
    : safeAreaTop + CHROME_TOP + CHROME_BUTTON + CHROME_CLEARANCE;
}

/** Padding below the composer, on both screens, with the keyboard away. */
export function composerBottomPad(safeAreaBottom: number): number {
  return safeAreaBottom + 10;
}

/**
 * Padding below the composer with the keyboard raised — the composer
 * hugs the keyboard on both screens, and a question sent with the
 * keyboard up must not land on a screen that pads it differently.
 */
export const COMPOSER_KEYBOARD_PAD = 10;
