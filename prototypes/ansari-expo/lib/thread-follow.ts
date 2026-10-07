/**
 * Keeping a thread on its newest turn while that turn is written.
 *
 * A streamed answer does not arrive as one change of size but as dozens:
 * the question, the waiting line, then every chunk of text. A scroll
 * spent on the first of them lands somewhere short of an answer that
 * goes on growing below the fold (#246). So the thread *follows* — every
 * growth is answered with a scroll to its foot — from the moment the
 * reader asks for the newest turn until they scroll up away from it.
 *
 * The same bookkeeping decides whether "Jump to latest" is offered, and
 * re-decides it on growth as well as on scroll: content that grows under
 * a reader who is not following moves the foot away from them without
 * any scroll event ever saying so.
 */

/** How far short of the foot still counts as reading the newest turn. */
export const LATEST_SLACK = 160;

export type ScrollPosition = {
  /** How far the list is scrolled. */
  offset: number;
  /** The height of everything in it. */
  contentHeight: number;
  /** The height of the window onto it; 0 when never measured. */
  viewportHeight: number;
};

export function distanceFromFoot(position: ScrollPosition): number {
  return position.contentHeight - position.viewportHeight - position.offset;
}

export type ThreadFollow = {
  /** Whether the reader is reading the newest turn. */
  readonly atBottom: boolean;
  /** The offset as last reported. */
  readonly offset: number;
  /** The reader has asked for the newest turn: a send, or the button. */
  follow(): void;
  /** A scroll event; returns whether to offer "Jump to latest". */
  scrolled(position: ScrollPosition): boolean;
  /** The content changed size; says whether to scroll to its foot and
   * whether to offer "Jump to latest". */
  grew(position: ScrollPosition): { scrollToEnd: boolean; showJump: boolean };
};

/**
 * Starts neither following nor at the bottom, so that opening an
 * existing conversation lands at its beginning rather than jumping to
 * the end of the last answer.
 */
export function createThreadFollow(): ThreadFollow {
  let following = false;
  let atBottom = false;
  let offset = 0;
  return {
    get atBottom() {
      return atBottom;
    },
    get offset() {
      return offset;
    },
    follow() {
      following = true;
      atBottom = true;
    },
    scrolled(position) {
      // Leaving is moving up *and* ending short of the foot. A scroll to
      // the end only ever moves down, even when the content grows under
      // it mid-animation; a bounce past the end settles back up, but onto
      // the foot. Neither is the reader leaving.
      if (
        following &&
        position.offset < offset &&
        distanceFromFoot(position) > 1
      ) {
        following = false;
      }
      offset = position.offset;
      // While following, a scroll still on its way down to a foot that
      // keeps moving is not a reader left behind.
      atBottom = following || distanceFromFoot(position) <= LATEST_SLACK;
      return !atBottom;
    },
    grew(position) {
      if (following) return { scrollToEnd: true, showJump: false };
      // Before the list is laid out there is no foot to be short of.
      if (position.viewportHeight <= 0) {
        return { scrollToEnd: false, showJump: false };
      }
      atBottom = distanceFromFoot(position) <= LATEST_SLACK;
      return { scrollToEnd: false, showJump: !atBottom };
    },
  };
}
