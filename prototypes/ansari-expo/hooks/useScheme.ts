import { useColorScheme } from 'react-native';

/**
 * Single source of truth for the active color scheme.
 * (Also the one place to temporarily hardcode 'dark' when verifying
 * dark-mode parity on the web preview.)
 */
export function useScheme(): 'light' | 'dark' {
  const scheme = useColorScheme();
  return scheme === 'dark' ? 'dark' : 'light';
}
