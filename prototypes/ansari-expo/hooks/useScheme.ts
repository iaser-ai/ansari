import { useColorScheme } from 'react-native';

/**
 * Single source of truth for the active color scheme.
 * (Also the one place to temporarily hardcode a scheme when verifying
 * dark-mode parity on the web preview, where the browser follows the
 * host OS and cannot be flipped from inside the app.)
 */
export function useScheme(): 'light' | 'dark' {
  const scheme = useColorScheme();
  return scheme === 'dark' ? 'dark' : 'light';
}
