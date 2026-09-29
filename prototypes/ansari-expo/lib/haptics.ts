import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

/**
 * The app's haptic vocabulary, in one place.
 *
 * Haptics are the *second* half of a piece of feedback, never the whole
 * of it: they are switched off for many readers, silent on a good deal
 * of Android hardware, and absent from the web entirely. Something on
 * the screen always has to say the same thing first — the sheet
 * leaving, the row opening, the notice arriving.
 *
 * Which is why there are only five of them, and why they are named for
 * the *moment* rather than for the waveform. A phone that speaks four
 * strengths of impact is not more expressive than one that speaks two;
 * it is just noisier. Pick the moment that fits and take the feel that
 * comes with it, rather than reaching for `Haptics` directly:
 *
 *   - `tapHaptic`     something opened, dismissed, or was carried over
 *                     the line by a gesture
 *   - `sendHaptic`    the reader sent their question — the one weightier
 *                     moment in the app
 *   - `tickHaptic`    a quiet acknowledgement where nothing was decided:
 *                     a keyboard put away, a row's action revealed
 *   - `doneHaptic` / `failedHaptic`  an operation reported its outcome;
 *                     raised with the notice that says it in words
 *
 * Every one of them is a no-op on the web, so a call site never has to
 * ask which platform it is on.
 */

/** The web has no hands to tap. Checked once. */
const silent = Platform.OS === 'web';

/**
 * Something opened, dismissed, or committed. The app's default, and the
 * only one most interactions need.
 */
export function tapHaptic() {
  if (silent) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** The question going. Heavier, because it is the one thing that is. */
export function sendHaptic() {
  if (silent) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** A tick: heard, nothing decided. */
export function tickHaptic() {
  if (silent) return;
  Haptics.selectionAsync().catch(() => {});
}

/** It worked — paired with the notice that says so. */
export function doneHaptic() {
  if (silent) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
    () => {},
  );
}

/** It did not. */
export function failedHaptic() {
  if (silent) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
    () => {},
  );
}
