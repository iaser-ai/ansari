/**
 * Where a tapped citation lands in the sources column (#226).
 *
 * The column rests with air above its first leaf. Scrolling to a source
 * used to throw that air away, landing the leaf flush under the header
 * so a few pixels of rounding tucked its first line beneath the rule.
 * The target is now the leaf's offset less the column's own top padding,
 * so every source arrives where the first one rests.
 */
import { describe, expect, it, vi } from 'vitest';
import { StyleSheet } from 'react-native';

// The component module pulls in reanimated, the motion curves and the
// folio; only the pure
// scroll arithmetic is under test here.
vi.mock('react-native-reanimated', () => ({
  default: { View: () => null },
  ReduceMotion: {},
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: () => ({ value: 0 }),
  withDelay: () => 0,
  withSequence: () => 0,
  withTiming: () => 0,
}));
vi.mock('@/constants/motion', () => ({
  ANCHOR_HOLD: 0,
  DURATION: {},
  EASE_OUT: () => 0,
}));
vi.mock('@/components/SourceFolio', () => ({ SourceFolio: () => null }));
vi.mock('@/hooks/useColors', () => ({ useColors: () => ({}) }));

const { LEAF_SHADOW_REACH, stackScrollTarget } = await import(
  '@/components/SourceStack'
);

describe('stackScrollTarget', () => {
  it('keeps the resting top padding above the target source', () => {
    const styles = StyleSheet.create({ content: { paddingTop: 22 } });
    expect(stackScrollTarget(340, styles.content)).toBe(318);
  });

  it('lands the first source exactly where the column rests', () => {
    const paddingTop = LEAF_SHADOW_REACH.above + 9;
    // The first leaf's offset is the padding itself.
    expect(stackScrollTarget(paddingTop, { paddingTop })).toBe(0);
  });

  it('never asks for a negative scroll', () => {
    expect(stackScrollTarget(5, { paddingTop: 22 })).toBe(0);
  });

  it('reads the padding through style arrays and shorthands', () => {
    expect(stackScrollTarget(100, [{ padding: 30 }, { paddingTop: 12 }])).toBe(
      88,
    );
    expect(stackScrollTarget(100, { paddingVertical: 16 })).toBe(84);
    expect(stackScrollTarget(100, { padding: 10 })).toBe(90);
  });

  it('falls back to the shadow reach when the column has no numeric padding', () => {
    expect(stackScrollTarget(100)).toBe(100 - LEAF_SHADOW_REACH.above);
    expect(stackScrollTarget(100, { paddingTop: '5%' })).toBe(
      100 - LEAF_SHADOW_REACH.above,
    );
  });
});
