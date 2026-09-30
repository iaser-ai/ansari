import type { ComposerDepth } from '@/constants/colors';

/**
 * The web composer's edge, drawn as shadows rather than a border.
 *
 * A border has to be a whole number of device pixels, and the rim the
 * composer used to wear was sized in fractions of one: a light line
 * over dark page on the outside, the wash clipped to a second curve on
 * the inside. At 1x or a fractional zoom the two curves antialiased
 * into a soft halo round the pill's ends (#206). A box-shadow is
 * painted on the box's own edge, so the top highlight and the focus
 * ring stay crisp at every density.
 */
export type ComposerEdge = { lip: string; ring: string };

/**
 * The composer's full `box-shadow` at lift `t` — 0 at rest, 1 focused.
 * The drop shadows and the after-dark glow interpolate between the
 * palette's two stops; the web edge (when given) adds the top-edge
 * highlight always and the focus ring as the bar lifts.
 */
export function composerShadow(
  depth: ComposerDepth,
  t: number,
  edge: ComposerEdge | null,
): string {
  'worklet';
  const { rest, focus, shadowRgb, glowRgb } = depth;
  const at = (key: keyof typeof rest) =>
    rest[key] + (focus[key] - rest[key]) * t;

  const layers = [
    `0 ${at('castY')}px ${at('castBlur')}px rgba(${shadowRgb}, ${at('castAlpha')})`,
    `0 ${at('contactY')}px ${at('contactBlur')}px rgba(${shadowRgb}, ${at('contactAlpha')})`,
  ];
  if (edge) {
    layers.push(`inset 0 1px 0 ${edge.lip}`);
    if (t > 0) layers.push(`0 0 0 ${t}px ${edge.ring}`);
  }
  const glow = at('glowAlpha');
  if (glow > 0) {
    layers.push(
      `inset 0 ${at('glowY')}px ${at('glowBlur')}px rgba(${glowRgb}, ${glow})`,
    );
  }
  return layers.join(', ');
}
