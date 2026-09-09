import { Platform } from 'react-native';

/**
 * Ansari brand tokens — "sunlit paper" by day, "the same page at night"
 * after dark.
 *
 * Light mode's neutrals are Tailwind `stone` (the warmest of the grey
 * ramps, which keeps the paper feeling like paper). There is exactly
 * one hue on the page — `yellow`, the illuminated-folio citation gold,
 * which stays the boldest thing on it with everything else quiet
 * around it. Everything that used to be emerald (the primary action,
 * the caret, the focus ring, an answer's links, a pressed source
 * marker) is now ink: a page of print has black type, one colour of
 * rubrication, and nothing else.
 *
 * Dark mode does *not* run that ramp backwards. Stone flipped end for
 * end gives a near-neutral black with three of its steps collapsed onto
 * one another, which is why the composer used to sit at 1.06:1 against
 * the page. Dark draws from `night` instead: a purpose-built warm
 * charcoal ladder where every rung is a measured contrast step, so a
 * surface can rise by growing lighter and warmer rather than by casting
 * a shadow nobody can see.
 */

/** Tailwind stone — the single source for every light-mode neutral. */
export const stone = {
  50: '#FAFAF9',
  100: '#F5F5F4',
  200: '#E7E5E4',
  300: '#D6D3D1',
  400: '#A8A29E',
  500: '#78716C',
  600: '#57534E',
  700: '#44403C',
  800: '#292524',
  900: '#1C1917',
  950: '#0C0A09',
} as const;

/**
 * Night — the dark room, built as an elevation ladder rather than a
 * grey ramp. One hue family (a warm 28–32°, the same warmth stone has
 * at its light end) with the saturation easing off as values rise, so
 * the page reads as warm charcoal and the light end reads as paper
 * rather than tan.
 *
 * The surface rungs are spaced by contrast, not by eye: each is a fixed
 * ratio against `page` (1.22 / 1.45 / 1.80 / 2.15 / 2.75), which is what
 * makes a card visibly sit above the page and a sheet visibly sit above
 * the card. The ink rungs are spaced the same way (3.2 / 6.0 / 9.0 /
 * 12.5 / 15.0 against the page) — note that `body` lands at 12.4:1, not
 * the 16:1 of near-white on near-black, so a long answer read in a dark
 * room doesn't halate. The brightest value is reserved for emphasis.
 */
export const night = {
  /** Beneath the page: scrims, overscroll, the launch screen. */
  well: '#0A0908',
  /** The page itself. */
  page: '#13100E',
  /** Raised once — quiet fills: chips, the reader's own message, input beds. */
  raised: '#28241F',
  /** Raised twice — the working surfaces: the composer, cards. */
  card: '#362F2A',
  /** Raised three times — sheets and dialogs. */
  sheet: '#453E37',
  /** Raised four times — hover and pressed states on top of a sheet. */
  lifted: '#514943',
  /** Rules, hairlines, and the edge of a resting control. */
  rule: '#615951',
  /** Dim ink — debossed marks, the greeting, disabled labels. */
  dim: '#6C6258',
  /** Quiet ink — placeholders (4.6:1 on the composer). */
  quiet: '#A1978C',
  /** Muted ink — labels and secondary copy (4.6:1 even on a sheet). */
  muted: '#B7AFA6',
  /** Body copy, held back from white so long answers don't glare. */
  body: '#D7D0C9',
  /** Emphasis — headings, titles, the values body copy leaves spare. */
  strong: '#E8E4DF',
  /** The brightest value in the room. Reserved. */
  bright: '#F5F3EF',
} as const;

/**
 * One stop in the composer's depth ramp — a cast shadow, a contact
 * shadow, and an inner glow, all in the same units CSS box-shadow
 * takes. Kept as numbers rather than a finished string so the composer
 * can interpolate between two stops on the UI thread.
 */
export type DepthStop = {
  /** How far the cast shadow falls, and how soft it is. */
  castY: number;
  castBlur: number;
  castAlpha: number;
  /** The tighter shadow where the bar meets the page. */
  contactY: number;
  contactBlur: number;
  contactAlpha: number;
  /** An inner glow along the top edge — how the bar lifts after dark. */
  glowY: number;
  glowBlur: number;
  glowAlpha: number;
};

export type ComposerDepth = {
  /** The colour the two drop shadows are drawn in, as `r, g, b`. */
  shadowRgb: string;
  /** The colour the inner glow is drawn in, as `r, g, b`. */
  glowRgb: string;
  rest: DepthStop;
  focus: DepthStop;
};

const DEPTH_LIGHT: ComposerDepth = {
  shadowRgb: '28, 25, 23',
  glowRgb: '255, 255, 255',
  rest: {
    castY: 10,
    castBlur: 40,
    castAlpha: 0.09,
    contactY: 2,
    contactBlur: 14,
    contactAlpha: 0.05,
    glowY: 10,
    glowBlur: 0,
    glowAlpha: 0,
  },
  focus: {
    castY: 18,
    castBlur: 54,
    castAlpha: 0.18,
    contactY: 3,
    contactBlur: 10,
    contactAlpha: 0.12,
    glowY: 10,
    glowBlur: 0,
    glowAlpha: 0,
  },
};

/**
 * The same cue after dark, by a different mechanism.
 *
 * A black shadow cannot deepen on charcoal: over the night page, black
 * at 0.55 measures 1.06:1 and black at 0.90 only reaches 1.10:1, so
 * there is no shadow ramp there to spend. At night a surface rises by
 * catching more light, which is how every other floating thing in the
 * app lifts after dark. So focus brightens an inner glow across the
 * top of the bar — 1.33:1 against the composer's own surface, the same
 * order of change the daytime shadow makes — while the cast shadow
 * still deepens for what little it is worth on a lighter backdrop.
 */
const DEPTH_DARK: ComposerDepth = {
  shadowRgb: '0, 0, 0',
  glowRgb: '255, 255, 255',
  rest: {
    castY: 10,
    castBlur: 40,
    castAlpha: 0.55,
    contactY: 2,
    contactBlur: 14,
    contactAlpha: 0.35,
    glowY: 10,
    glowBlur: 22,
    glowAlpha: 0,
  },
  focus: {
    castY: 18,
    castBlur: 54,
    castAlpha: 0.72,
    contactY: 3,
    contactBlur: 10,
    contactAlpha: 0.5,
    glowY: 8,
    glowBlur: 18,
    /*
     * 0.18, held tight to the top edge.
     *
     * Matching the daytime shadow's measured step was not enough here,
     * and the reason is where each cue lands. A drop shadow falls on
     * the page beside the bar, so the eye reads it against bare paper.
     * This glow falls *inside* the bar, over a rim that already sits at
     * 1.37:1 — so anything near that vanishes into the edge the bar
     * always wears. It has to clear it: 0.12 measures 1.46:1 and read
     * as barely there, 0.18 measures 1.78:1 and reads as a lift.
     */
    glowAlpha: 0.18,
  },
};

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: stone[800],
    tint: '#CA8A04',

    // Core surfaces — stone paper
    background: stone[200],
    foreground: stone[800],
    /** Emphasis ink: headings and titles, above body copy. */
    strongForeground: stone[900],
    /**
     * A link inside running text. Emphasis ink, one step above the body
     * it interrupts (13.9:1 against the page where body sits at 12.1:1)
     * and always underlined — the underline is what marks it, the way a
     * printed page marks one. Colour would put a second hue on a page
     * that has exactly one.
     */
    link: stone[900],

    // The elevation ladder. Light mode rises toward white; dark mode
    // rises toward warm charcoal. Both ladders answer the same four
    // questions: what is the page, what sits quietly on it, what is a
    // working surface, what is a sheet over everything else.
    /** Raised once — quiet fills and input beds. */
    surface: stone[100],
    /** Raised twice — the composer card, floating buttons. */
    card: stone[50],
    cardForeground: stone[800],
    /** Raised three times — sheets and dialogs. */
    sheet: stone[50],
    /**
     * Raised four times — a row, tile or button sitting *on* a sheet,
     * and the hover step above it. Note the direction reverses here:
     * light mode's sheet is already near-white, so a thing on top of it
     * separates by going a step darker, where dark mode's goes lighter.
     */
    lifted: stone[200],
    liftedHover: stone[300],

    /**
     * The primary action — ink, not a hue.
     *
     * This was emerald-600, left over from an early palette, and it was
     * doing the work of an accent the page already had. A filled button
     * on paper is a struck block of type: stone-900 measures 13.9:1
     * against the page and 16.7:1 on a sheet, and its label clears
     * 16.7:1 on the block. The brass stays reserved for the send disc
     * and the folio, so the two metal things on a page still read as
     * one object.
     */
    primary: stone[900],
    primaryForeground: stone[50],

    /**
     * The quiet fill — one material for every quiet filled shape in the
     * app: a suggestion chip, the reader's own sent question, the
     * safety card. Anything that wants a soft block of paper under a
     * short line of text asks for this and nothing else.
     *
     * It is the ladder's first rung above the page — the same value
     * `surface` carries — so a quiet fill *rises* off the paper and
     * still sits a rung below the composer's `card`. That is the whole
     * point of naming it: it used to be stone-300, a step *darker* than
     * the paper, while dark mode's was `night.raised`, a step lighter.
     * The same chip therefore read as pressed into the page by day and
     * lifted off it after dark, and the borderless sweep that took the
     * chips' hairline away reached for a wash of `heroInk` — the
     * debossed register — rather than for this.
     */
    secondary: stone[100],
    secondaryForeground: stone[700],

    // Muted / subdued elements
    muted: stone[300],
    mutedForeground: stone[500],

    // Hero ink — the debossed register: a mark pressed into the page,
    // a footnote pill's ring, the wash behind a quoted line. It is an
    // ink, never a fill: every use of it is a faint wash or a rule.
    heroInk: stone[400],

    /**
     * The greeting on the empty page.
     *
     * It used to take hero ink, which is the ink of something *pressed
     * into* the paper — right for a mark, wrong for a sentence. At
     * 2.0:1 the one line of writing on an otherwise empty page was the
     * faintest thing on it, and on a bright phone screen outdoors it
     * simply was not there. Two steps down the ramp puts it at 6.4:1:
     * plainly a greeting rather than a heading, and plainly legible.
     */
    greetingInk: stone[600],

    // Accent highlights — illuminated-folio gold (yellow-600)
    accent: '#CA8A04',
    accentForeground: '#FFFFFF',

    // Destructive actions — red-700
    destructive: '#B91C1C',
    destructiveForeground: '#FFFFFF',

    // Borders and input outlines
    border: stone[300],
    input: stone[300],

    // ---- Text entry -------------------------------------------------
    /**
     * Placeholder ink. The hero ink used to carry this at 2.2:1 —
     * decorative, not readable. Off-ramp rather than stone-500, because
     * a placeholder has to clear 4.5:1 on the *recessed* bed of a search
     * field as well as on the composer's near-white surface, and
     * stone-500 fell to 3.5:1 on the darkest of those beds. Still two
     * clear steps lighter than body ink.
     */
    placeholder: '#5F5A54',
    /** The caret, and the selection wash behind selected text. */
    caret: stone[900],
    selection: 'rgba(202,138,4,0.20)',
    /** The bed a text field is recessed into, and its hairline. */
    inputFill: 'rgba(28,25,23,0.05)',
    inputRim: 'rgba(28,25,23,0.11)',
    /**
     * The same hairline, inked in, for a focused search field.
     *
     * A field answers focus by darkening the rim it already wears —
     * nothing new is drawn outside it, so the pill keeps its geometry
     * and nothing moves. The step is large enough to be unmissable:
     * the rim goes from 1.25:1 against its bed to 3.75:1, and 4.1:1
     * against the surface the field sits on.
     */
    inputRimFocus: 'rgba(28,25,23,0.55)',
    /**
     * The keyboard focus indicator, drawn by the web stylesheet around
     * every focusable element. Ink rather than a hue: it reads at
     * 11.7:1 or better on every surface in the mode — the page, a
     * sheet, a lifted row, a suggestion chip — where the old emerald
     * ring sat just over 3:1 on the darkest of them.
     */
    focusRing: stone[900],

    // ---- Glass and depth --------------------------------------------
    /** The wash a floating surface paints over its blur. */
    glassWash: 'rgba(250,250,249,0.62)',
    /** The thinner wash for glass sitting over moving media. */
    glassWashClear: 'rgba(255,255,255,0.50)',
    /** The opaque floor under that wash where blur can't be trusted. */
    glassBase: 'rgba(255,255,255,0.55)',
    /**
     * The edge that catches light, and the lip along the top.
     *
     * The lip is toned to the weight of the rim it sits above rather
     * than to the brightest white available: drawn at 0.90 over a
     * half-pixel rim it stopped reading as light landing on the pane
     * and started reading as a second, heavier stroke.
     */
    glassRim: 'rgba(255,255,255,0.68)',
    glassLip: 'rgba(255,255,255,0.66)',
    /**
     * The resting fill of a round glass button, which carries the
     * button's shape now that it draws no outline. Firmer than the
     * clear wash it used to sit behind the rim with, so the disc is a
     * findable step of value on bare paper (1.16:1) and over the
     * darkest frame of the ambient shadow (1.46:1) — a light material
     * on light paper cannot do better than 1.26:1 — while the icon on
     * it stays at 12.8:1, far clear of the 3:1 non-text bar.
     */
    glassButtonFill: 'rgba(255,255,255,0.66)',
    /** The broad inner glow under the lip that makes the pane read as lit. */
    glassSheen: 'rgba(255,255,255,0.18)',
    /** The web backdrop-filter recipe for floating chrome. */
    glassFilter: 'blur(26px) brightness(1.06)',
    /**
     * The frosted glass of a panel that takes a whole edge of the
     * window, and the sheets of paper laid on it.
     *
     * Thinner than the chrome washes above, and tinted to the paper
     * rather than to white: a panel this large reads as a wall if it is
     * opaque, and as nothing at all if it is white on white. Held one
     * step *below* the page so the cards on it are the brightest thing
     * in the column and each one reads as a separate leaf.
     */
    panelWash: 'rgba(231,229,228,0.55)',
    panelPaper: '#FFFFFF',
    panelPaperRim: 'rgba(28,25,23,0.07)',
    /** The tint every drop shadow is drawn in. */
    shadowTint: 'rgba(28,25,23,0.09)',
    shadowTintSoft: 'rgba(28,25,23,0.05)',
    /**
     * How the composer answers focus.
     *
     * It used to fade in a 2pt rim over its glass edge, which on a
     * surface that already has a lit rim and a drop shadow read as an
     * outline stuck onto the bar. Instead the bar lifts: the cast
     * shadow throws further and deepens while the contact shadow pulls
     * in and firms, which is what a real object does when it rises off
     * the page. Measured at the shadow's darkest point, the paper goes
     * from 1.19:1 to 1.44:1 — a change of the same order as the whole
     * resting shadow, so it cannot be missed.
     */
    composerDepth: DEPTH_LIGHT,
    /** The wash a modal lays over the page behind it. */
    scrim: 'rgba(28,25,23,0.45)',
  },

  dark: {
    text: night.body,
    tint: '#E9B949',

    // Warm charcoal paper, lit from the same direction as day
    background: night.page,
    foreground: night.body,
    strongForeground: night.strong,
    /** 15.0:1 on the night page, over body ink's 12.4:1. Underlined. */
    link: night.strong,

    surface: night.raised,
    card: night.card,
    cardForeground: night.body,
    sheet: night.sheet,
    lifted: night.lifted,
    liftedHover: night.rule,

    // Gold warmed off Tailwind's lemon yellow to belong to the same
    // warm room, and still the boldest thing on the page at 10.4:1.
    /**
     * The primary action inverts after dark, the way a printed block
     * does: a pale slab of paper on charcoal. 8.3:1 against the sheet
     * it usually sits on, 15.0:1 against the page, with its label at
     * 15.0:1 on the slab.
     */
    primary: night.strong,
    primaryForeground: night.page,

    /**
     * The same quiet fill after dark, and the rung light mode now
     * matches: raised once off the page — chips, the reader's own
     * message, the safety card.
     */
    secondary: night.raised,
    secondaryForeground: night.body,

    muted: night.raised,
    mutedForeground: night.muted,

    heroInk: night.dim,
    /** The same step up after dark: dim ink's 3.2:1 becomes muted's 7.6:1. */
    greetingInk: night.muted,

    accent: '#E9B949',
    accentForeground: night.page,

    destructive: '#F26D5B',
    destructiveForeground: night.well,

    border: night.rule,
    input: night.rule,

    // ---- Text entry -------------------------------------------------
    placeholder: night.quiet,
    caret: night.strong,
    selection: 'rgba(233,185,73,0.26)',
    /**
     * A recessed bed digs *down* from the surface it sits in, in both
     * modes. Lightening it here instead would raise the field toward
     * the placeholder's own value: on a sheet, a white 6% bed left the
     * placeholder at 3.1:1, under the bar.
     */
    inputFill: 'rgba(0,0,0,0.30)',
    inputRim: 'rgba(255,255,255,0.10)',
    /**
     * A focused field firms the same hairline. After dark that means
     * brightening rather than darkening — the rim is a moonlit edge,
     * not an ink line — but it is the same move: the border the field
     * already wears, and nothing outside it. 5.3:1 against its bed on a
     * sheet, 6.1:1 in the rail.
     */
    inputRimFocus: 'rgba(255,255,255,0.55)',
    /**
     * Keyboard focus, at the bright end of the night ramp so it clears
     * every surface it can be drawn on — 17.1:1 on the page down to
     * 6.2:1 on the lightest rung a row ever reaches.
     */
    focusRing: night.bright,

    // ---- Glass and depth --------------------------------------------
    // On charcoal a floating surface can't lift by casting a shadow, so
    // it lifts by growing lighter: the backdrop is brightened rather
    // than dimmed, and the rim is a moonlit edge rather than the bright
    // white lip that works on paper.
    glassWash: 'rgba(54,47,42,0.90)',
    glassWashClear: 'rgba(54,47,42,0.86)',
    glassBase: 'rgba(19,16,14,0.58)',
    glassRim: 'rgba(255,255,255,0.10)',
    glassLip: 'rgba(255,255,255,0.15)',
    /**
     * The same disc after dark. Night's ambient shadow multiplies, so
     * it can only ever pull the page *down* — the worst case for a
     * puck that lifts by growing lighter is therefore the bare page,
     * and every frond that crosses it only helps (2.00:1 on the page,
     * 2.08:1 over the deepest frond).
     *
     * That is why it climbs to the `lifted` rung rather than sitting at
     * the composer's `card`: the ramp's next step up is where a solid
     * grey chip starts and glass stops, and this is the last rung that
     * still reads as a lit surface while carrying the icon at 6.2:1.
     */
    glassButtonFill: 'rgba(81,73,67,0.92)',
    glassSheen: 'rgba(255,255,255,0.05)',
    glassFilter: 'blur(26px) brightness(1.55)',
    // After dark the same idea inverts: the glass darkens towards the
    // page and each sheet rises off it by lightening, since a shadow
    // cannot lift anything on charcoal.
    panelWash: 'rgba(19,16,14,0.55)',
    panelPaper: night.card,
    panelPaperRim: 'rgba(255,255,255,0.07)',
    shadowTint: 'rgba(0,0,0,0.55)',
    shadowTintSoft: 'rgba(0,0,0,0.35)',
    composerDepth: DEPTH_DARK,
    scrim: 'rgba(6,5,4,0.62)',
  },
};

/**
 * Brass — the metal the sidebar emblem is struck from.
 *
 * Warm and satin with a copper undertone rather than yellow gold, and
 * muted enough to sit on stone paper as a stamped mark rather than an
 * ornament. Ordered from the pale glint the light catches down to the
 * warm brown where the mark meets the surface, so a gradient can be
 * read straight off the ramp.
 *
 * Dark is the same metal in a dimmer, less saturated room: the same
 * emboss, without blazing against the charcoal paper.
 */
export const brass = {
  light: {
    glint: '#F4E3C4',
    highlight: '#EBD2A6',
    warm: '#C49A63',
    mid: '#A87F4E',
    deep: '#75512C',
    shadow: '#3F2C18',
  },
  dark: {
    glint: '#D6C3A2',
    highlight: '#BCA582',
    warm: '#9A7F5C',
    mid: '#7E664A',
    deep: '#4E3A28',
    shadow: '#17100A',
  },
} as const;

/**
 * Type roles: one serif, two jobs, told apart by weight rather than by
 * face.
 *
 * `prose*` is the reading voice — Literata's light grades, designed for
 * long-form e-reading, holding up over an unboxed answer's many lines
 * and carrying the footnote pills at the foot of the same answer. At
 * Literata's regular weight a full answer already reads as heavy type,
 * which is why the body is light and every prose role sits a grade
 * below where a chrome role would.
 *
 * `display*` is the same face with more ink — the app's speaking voice:
 * wordmark, titles, a card's heading, a source's reference. Short,
 * set-piece text, at medium and semibold.
 *
 * Amiri (classical Naskh, designed for Qur'anic typesetting) renders
 * Arabic source text. Inter stays as the quiet body/utility face —
 * labels, controls, and the reader's own messages.
 *
 * `mono` is the one non-serif inside an answer, and it is the platform's
 * own: code in a scholarly answer is a rare aside, not a feature, and
 * shipping a fourth typeface to set two lines of it would cost more
 * bytes than the whole prose family.
 */
export const fonts = {
  /*
   * One serif, at every size.
   *
   * There used to be two: Spectral for the chrome that speaks — titles,
   * the brand, a toast's headline — and Literata for reading. Two
   * scholarly serifs a few degrees apart do not read as a distinction;
   * they read as a mistake, and the app's voice is the one an answer is
   * set in. So the display grades are Literata's own heavier weights:
   * the same face the reader has been reading, with more ink.
   *
   * Literata sets a touch larger than Spectral did at the same nominal
   * size, so anything that was tuned against Spectral wants pulling
   * back a step rather than being left where it was.
   */
  display: 'Literata_600SemiBold',
  displayMedium: 'Literata_500Medium',
  displayItalic: 'Literata_500Medium_Italic',
  prose: 'Literata_300Light',
  proseItalic: 'Literata_300Light_Italic',
  proseMedium: 'Literata_400Regular',
  proseSemiBold: 'Literata_500Medium',
  /** Bold emphasis that is also italic. Without it the two collapse. */
  proseSemiBoldItalic: 'Literata_500Medium_Italic',
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  }) as string,
  arabic: 'Amiri_400Regular',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemiBold: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',
} as const;

export default colors;
