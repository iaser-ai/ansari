/**
 * Ansari brand tokens — "sunlit paper": warm greige paper with film grain,
 * linen surfaces, debossed hero ink, and a single vivid emerald action
 * color. The gold/Amiri illuminated-folio citation treatment stays the
 * boldest element; everything else is quiet around it.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: '#3C3831',
    tint: '#16A04A',

    // Core surfaces — warm greige paper
    background: '#DCD6CC',
    foreground: '#3C3831',

    // Elevated "linen" surfaces (composer card, floating buttons)
    card: '#F0EDE6',
    cardForeground: '#3C3831',

    // Primary action color — vivid emerald (send)
    primary: '#16A04A',
    primaryForeground: '#FFFFFF',

    // Suggestion chips — a step darker than the paper
    secondary: '#CFC8BC',
    secondaryForeground: '#413D35',

    // Muted / subdued elements
    muted: '#D3CCC0',
    mutedForeground: '#8A8275',

    // Hero ink — wordmark, greeting, placeholder; reads debossed
    heroInk: '#A29A8D',

    // Accent highlights — illuminated-folio gold
    accent: '#B9924A',
    accentForeground: '#FFFFFF',

    // Destructive actions
    destructive: '#B3402A',
    destructiveForeground: '#FFFFFF',

    // Borders and input outlines
    border: '#C9C2B4',
    input: '#C9C2B4',
  },

  dark: {
    text: '#E7E1D6',
    tint: '#2FBE6C',

    // Warm charcoal paper
    background: '#1C1915',
    foreground: '#E7E1D6',

    card: '#282520',
    cardForeground: '#E7E1D6',

    primary: '#22B45E',
    primaryForeground: '#0B1F13',

    secondary: '#2F2B25',
    secondaryForeground: '#D6CFC2',

    muted: '#2A2620',
    mutedForeground: '#98907F',

    heroInk: '#6F6759',

    accent: '#CBA45C',
    accentForeground: '#171207',

    destructive: '#D46A52',
    destructiveForeground: '#FFFFFF',

    border: '#3A342C',
    input: '#3A342C',
  },

  // Border radius (in px), applies to cards, buttons, inputs, and modals.
  radius: 14,
};

/**
 * Type roles, split between two serifs with distinct jobs.
 *
 * `display*` is Spectral — the app's chrome voice: wordmark, greeting
 * (in the italic face), and the citation sheet. Short, set-piece text.
 *
 * `prose*` is Literata — the reading voice. Designed for long-form
 * e-reading, it holds up over an unboxed answer's many lines and
 * carries the footnote pills at the foot of the same answer.
 *
 * Literata runs both larger and heavier than Spectral at the same
 * nominal setting, so the prose scale is offset twice: sizes sit a step
 * below the equivalent Spectral setting, and every prose role is one
 * weight lighter than its display counterpart (light body, regular
 * where Spectral would be medium, medium where it would be semibold).
 * At Literata's regular weight a full answer reads as heavy type.
 *
 * Amiri (classical Naskh, designed for Qur'anic typesetting) renders
 * Arabic source text. Inter stays as the quiet body/utility face —
 * labels, controls, and the reader's own messages.
 */
export const fonts = {
  display: 'Spectral_600SemiBold',
  displayMedium: 'Spectral_500Medium',
  displayItalic: 'Spectral_500Medium_Italic',
  prose: 'Literata_300Light',
  proseItalic: 'Literata_300Light_Italic',
  proseMedium: 'Literata_400Regular',
  proseSemiBold: 'Literata_500Medium',
  arabic: 'Amiri_400Regular',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemiBold: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',
} as const;

export default colors;
