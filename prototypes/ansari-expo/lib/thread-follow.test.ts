/**
 * The thread's whole sense of "the reader is on the newest turn" lives in
 * `lib/thread-follow.ts`; the chat screen only reports scrolls and growth
 * to it and does what it says. The sequences below are the ones a phone
 * reports while a follow-up is answered.
 */
import { describe, expect, it } from 'vitest';
import {
  createThreadFollow,
  distanceFromFoot,
  LATEST_SLACK,
  type ScrollPosition,
} from './thread-follow';

const VIEWPORT = 700;

/** A list scrolled to its very end at the given content height. */
const atFoot = (contentHeight: number): ScrollPosition => ({
  offset: contentHeight - VIEWPORT,
  contentHeight,
  viewportHeight: VIEWPORT,
});

describe('distanceFromFoot', () => {
  it('is zero at the end and grows as the reader goes up', () => {
    expect(distanceFromFoot(atFoot(2000))).toBe(0);
    expect(distanceFromFoot({ ...atFoot(2000), offset: 1000 })).toBe(300);
  });
});

describe('createThreadFollow', () => {
  it('opens neither following nor at the bottom', () => {
    const follow = createThreadFollow();
    expect(follow.atBottom).toBe(false);
    expect(follow.grew({ ...atFoot(3000), offset: 0 })).toEqual({
      scrollToEnd: false,
      showJump: true,
    });
  });

  it('follows every growth of a follow-up turn, not just the first (#246)', () => {
    const follow = createThreadFollow();
    follow.scrolled(atFoot(2000));
    follow.follow();

    // The question, the waiting line, then chunk after chunk of the answer
    // — each reported while the last scroll to the end is still under way,
    // so the offset trails the growing foot.
    let offset = 1300;
    for (let height = 2100; height <= 4000; height += 100) {
      expect(
        follow.grew({ offset, contentHeight: height, viewportHeight: VIEWPORT }),
      ).toEqual({ scrollToEnd: true, showJump: false });
      offset += 60;
      expect(
        follow.scrolled({
          offset,
          contentHeight: height,
          viewportHeight: VIEWPORT,
        }),
      ).toBe(false);
    }
    expect(follow.atBottom).toBe(true);
  });

  it('stops following, and offers the way back, once the reader scrolls up', () => {
    const follow = createThreadFollow();
    follow.scrolled(atFoot(2000));
    follow.follow();
    follow.grew(atFoot(2400));
    follow.scrolled(atFoot(2400));

    // The reader drags up to read something above.
    expect(follow.scrolled({ ...atFoot(2400), offset: 900 })).toBe(true);
    expect(follow.atBottom).toBe(false);

    // The answer keeps coming; the view is left where the reader put it.
    expect(follow.grew({ ...atFoot(2800), offset: 900 })).toEqual({
      scrollToEnd: false,
      showJump: true,
    });
  });

  it('keeps following through a small nudge that ends on the foot', () => {
    // A bounce past the end settles back up onto it.
    const follow = createThreadFollow();
    follow.follow();
    follow.scrolled({ ...atFoot(2000), offset: 1340 });
    expect(follow.scrolled(atFoot(2000))).toBe(false);
    expect(follow.grew(atFoot(2300)).scrollToEnd).toBe(true);
  });

  it('lets go for any upward scroll that ends short of the foot', () => {
    const follow = createThreadFollow();
    follow.follow();
    follow.scrolled(atFoot(2000));
    // Within the slack, so still "at the bottom" — but no longer followed.
    expect(follow.scrolled({ ...atFoot(2000), offset: 1250 })).toBe(false);
    expect(follow.grew({ ...atFoot(2100), offset: 1250 }).scrollToEnd).toBe(
      false,
    );
  });

  it('shows "Jump to latest" when growth alone leaves the reader behind', () => {
    // No scroll event fires here at all: only the content moves.
    const follow = createThreadFollow();
    expect(follow.scrolled(atFoot(1500))).toBe(false);
    expect(follow.grew({ ...atFoot(1500 + LATEST_SLACK), offset: 800 })).toEqual(
      { scrollToEnd: false, showJump: false },
    );
    expect(
      follow.grew({ ...atFoot(1500 + LATEST_SLACK + 1), offset: 800 }),
    ).toEqual({ scrollToEnd: false, showJump: true });
  });

  it('resumes following from "Jump to latest"', () => {
    const follow = createThreadFollow();
    follow.follow();
    follow.scrolled(atFoot(2000));
    follow.scrolled({ ...atFoot(2000), offset: 200 });
    expect(follow.grew({ ...atFoot(2200), offset: 200 }).scrollToEnd).toBe(
      false,
    );

    follow.follow();
    expect(follow.atBottom).toBe(true);
    expect(follow.grew({ ...atFoot(2400), offset: 300 })).toEqual({
      scrollToEnd: true,
      showJump: false,
    });
  });

  it('offers nothing before the list has been laid out', () => {
    const follow = createThreadFollow();
    expect(
      follow.grew({ offset: 0, contentHeight: 3000, viewportHeight: 0 }),
    ).toEqual({ scrollToEnd: false, showJump: false });
  });

  it('remembers the last offset for native, which cannot be asked for it', () => {
    const follow = createThreadFollow();
    follow.scrolled({ ...atFoot(2000), offset: 420 });
    expect(follow.offset).toBe(420);
  });
});
