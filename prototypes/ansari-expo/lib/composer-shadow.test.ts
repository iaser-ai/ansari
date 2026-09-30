/**
 * The web composer's edge is drawn in shadows, never a border (#206).
 */
import { describe, expect, it } from 'vitest';
import colors from '@/constants/colors';
import { composerShadow } from '@/lib/composer-shadow';

const modes = ['light', 'dark'] as const;

describe('composerShadow', () => {
  for (const mode of modes) {
    const palette = colors[mode];
    const edge = { lip: palette.composerLip, ring: palette.inputRimFocus };

    describe(`${mode} mode`, () => {
      it('lights the top edge with a crisp one-pixel inset at rest', () => {
        const shadow = composerShadow(palette.composerDepth, 0, edge);
        expect(shadow).toContain(`inset 0 1px 0 ${palette.composerLip}`);
      });

      it('draws no ring at rest', () => {
        const shadow = composerShadow(palette.composerDepth, 0, edge);
        expect(shadow).not.toContain(palette.inputRimFocus);
      });

      it('rings the bar at a whole pixel when focused', () => {
        const shadow = composerShadow(palette.composerDepth, 1, edge);
        expect(shadow).toContain(`0 0 0 1px ${palette.inputRimFocus}`);
      });

      it('keeps its drop shadows', () => {
        const shadow = composerShadow(palette.composerDepth, 0, edge);
        const { shadowRgb, rest } = palette.composerDepth;
        expect(shadow).toContain(
          `0 ${rest.castY}px ${rest.castBlur}px rgba(${shadowRgb}, ${rest.castAlpha})`,
        );
      });
    });
  }

  it('adds no edge layers off the web', () => {
    const shadow = composerShadow(colors.dark.composerDepth, 1, null);
    expect(shadow).not.toMatch(/inset 0 1px 0|0 0 0 /);
  });

  it('keeps the after-dark lift glow when focused', () => {
    const { focus, glowRgb } = colors.dark.composerDepth;
    const shadow = composerShadow(colors.dark.composerDepth, 1, null);
    expect(shadow).toContain(`rgba(${glowRgb}, ${focus.glowAlpha})`);
  });

  it('keeps the dark highlight subtler than the light one', () => {
    const alpha = (c: string) => Number(c.match(/,\s*([\d.]+)\)$/)![1]);
    expect(alpha(colors.dark.composerLip)).toBeLessThan(
      alpha(colors.light.composerLip),
    );
  });
});
