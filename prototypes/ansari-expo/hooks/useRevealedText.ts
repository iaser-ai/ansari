import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'react-native-reanimated';
import {
  advanceReveal,
  commonPrefixLength,
  revealSlice,
} from '@/lib/reveal';

/**
 * Commits at most this often. Every commit re-parses the answer's markdown,
 * and ~30 a second reads as continuous typing at half the work of 60.
 */
const TICK_MS = 32;

/**
 * The part of a streaming `target` that has been written onto the page so
 * far, walked towards it at a steady pace (see lib/reveal.ts). `settled`
 * is true once no more text is coming, and hurries the rest out.
 *
 * An empty target resets at once, and a target that revises text behind
 * the cursor pulls it back to where the two still agree, in the same
 * render. With reduced motion on, the target is simply returned: text
 * appears as it arrives, unpaced.
 */
export function useRevealedText(target: string, settled: boolean): string {
  const reduced = useReducedMotion();
  const [revealed, setRevealed] = useState('');
  const shown = useRef('');
  const position = useRef(0);
  // The timestamp of the last tick while the clock is running; null when
  // idle, so time spent caught up is not counted as writing time.
  const lastTick = useRef<number | null>(null);

  useEffect(() => {
    if (reduced || target === '') {
      position.current = target.length;
      shown.current = target;
      lastTick.current = null;
      setRevealed(target);
      return;
    }
    const agreed = commonPrefixLength(shown.current, target);
    if (position.current > agreed) {
      position.current = agreed;
      shown.current = target.slice(0, agreed);
      setRevealed(shown.current);
    }
    if (position.current >= target.length) {
      lastTick.current = null;
      return;
    }

    let frame = 0;
    const tick = (now: number) => {
      if (lastTick.current === null) lastTick.current = now;
      const dt = now - lastTick.current;
      if (dt >= TICK_MS) {
        lastTick.current = now;
        position.current = advanceReveal(
          position.current,
          target.length,
          dt,
          settled,
        );
        const next = revealSlice(target, position.current);
        if (next !== shown.current) {
          shown.current = next;
          setRevealed(next);
        }
      }
      if (position.current < target.length) {
        frame = requestAnimationFrame(tick);
      } else {
        lastTick.current = null;
      }
    };
    frame = requestAnimationFrame(tick);
    // A new delta restarts the clock without resetting `lastTick`, so the
    // time since the previous tick still counts.
    return () => cancelAnimationFrame(frame);
  }, [target, settled, reduced]);

  if (reduced) return target;
  // Between a new target and the effect catching up, never show text the
  // target no longer has.
  const agreed = commonPrefixLength(revealed, target);
  return agreed === revealed.length ? revealed : target.slice(0, agreed);
}
