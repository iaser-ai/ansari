import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';

/**
 * Putting words on the clipboard, on every platform the app runs on.
 *
 * The web has had this since the beginning through the browser's own
 * async clipboard. A phone had nothing: React Native ships no clipboard
 * of its own, so "Copy" on the native app used to raise a notice asking
 * the reader to select the answer and copy it themselves — which they
 * could not do, because answer prose was only selectable on the web.
 *
 * Both paths are kept rather than collapsed into one. `navigator`'s
 * clipboard is the browser's own, needs no native module, and is what
 * the web has always used; `expo-clipboard` is the real thing on iOS
 * and Android, and stands behind the browser path as a fallback for the
 * contexts where `navigator.clipboard` is missing (an insecure origin,
 * an old browser) and its `document.execCommand` route still works.
 *
 * Returns whether the words actually landed, so the caller can say so
 * — a confirmation nobody checked is worse than no confirmation.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Denied or unavailable — fall through to the fallback below.
      }
    }
  }
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
