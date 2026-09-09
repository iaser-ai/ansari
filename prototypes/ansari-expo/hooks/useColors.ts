import colors from '@/constants/colors';
import { useScheme } from '@/hooks/useScheme';

/**
 * Returns the color tokens for the current color scheme.
 *
 * Corners are not here: they do not change between modes, so they live
 * on the `RADIUS` scale in `constants/radius` and are imported
 * directly by whatever draws them.
 *
 * Falls back to the light palette when no dark key is defined in
 * constants/colors.ts (the scaffold ships light-only by default).
 * When a sibling web artifact's dark tokens are synced into a `dark`
 * key, this hook will automatically switch palettes based on the
 * device's appearance setting.
 */
export function useColors() {
  const scheme = useScheme();
  return scheme === 'dark' ? colors.dark : colors.light;
}
