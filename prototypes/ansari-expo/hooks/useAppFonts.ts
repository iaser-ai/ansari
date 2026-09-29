import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import {
  Literata_300Light,
  Literata_300Light_Italic,
  Literata_400Regular,
  Literata_500Medium,
  Literata_500Medium_Italic,
  Literata_600SemiBold,
} from '@expo-google-fonts/literata';
import { Amiri_400Regular } from '@expo-google-fonts/amiri';

/**
 * Ansari's type, loaded the way native wants it.
 *
 * The faces are bundled into the binary, the runtime loader registers
 * them, and the splash screen covers the wait — so gating the first
 * render on this costs the reader nothing and guarantees no text is
 * ever set in a substitute face.
 *
 * The web takes the other route entirely (see `useAppFonts.web.ts`):
 * there the faces are real web fonts declared in the document, the
 * browser has them before it paints, and none of these TTFs are in the
 * bundle at all.
 *
 * Returns whether the app may render — loaded, or failed in a way that
 * waiting longer will not fix.
 */
export function useAppFonts(): boolean {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Literata_300Light,
    Literata_300Light_Italic,
    Literata_400Regular,
    Literata_500Medium,
    // Bold-italic inside an answer. Without the real face loaded the
    // renderer would ask for a synthetic slant and silently get the
    // upright medium instead, collapsing bold-italic onto bold.
    Literata_500Medium_Italic,
    // The display grade: titles, the brand, a card's heading. Literata
    // carries those too, so the app has one serif rather than two.
    Literata_600SemiBold,
    Amiri_400Regular,
  });

  return fontsLoaded || !!fontError;
}
