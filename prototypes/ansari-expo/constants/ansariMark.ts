import { Platform } from 'react-native';

/**
 * The Ansari symbol's geometry — the one place the artwork lives.
 *
 * Every rendering of the mark (the flat wordmark, the sidebar's embossed
 * brass emblem, the waiting mark that lights piece by piece, and any
 * layer inside them) draws from these paths, so the silhouette can never
 * drift between them: an emboss is stacked copies of one shape, and two
 * copies that disagree by a curve stop reading as a single piece of
 * metal.
 */

/** The artwork's own coordinate space. Never rescale it in place. */
export const ANSARI_MARK_VIEWBOX = { width: 216, height: 246 } as const;

export const ANSARI_MARK_ASPECT_RATIO =
  ANSARI_MARK_VIEWBOX.width / ANSARI_MARK_VIEWBOX.height;

/**
 * The three disjoint pieces the mark is built from, in the order the eye
 * reads them: down the mark.
 *
 * The artwork does not hand them over in that order — it lists them foot
 * first, wave then band then diamond — so anything that wants to treat
 * the pieces as separate objects (light them one after another, tint one
 * of them) would otherwise have to re-derive which is which from the
 * path data every time. They are named for their place in the artwork
 * here once, and nowhere else.
 */
export const ANSARI_MARK_SHAPES = [
  {
    /** The diamond crowning the mark. */
    name: 'diamond',
    d: 'M144 36L108 72L72 36L108 0L144 36Z',
  },
  {
    /** The chevron band across the middle. */
    name: 'band',
    d: 'M125.998 90.0107C145.88 70.1289 178.108 70.129 197.99 90.0107L143.972 144.005L143.996 144.03L125.998 162.028C116.057 171.967 99.9424 171.969 90.002 162.028L18.0098 90.0361C37.8921 70.1541 70.1197 70.154 90.002 90.0361L108 108.009L125.998 90.0107Z',
  },
  {
    /** The wide wave across the foot. */
    name: 'wave',
    d: 'M216 201.092C202.957 201.092 189.949 206.049 180 215.998C161.736 234.261 138.269 244.123 114.381 245.617C110.145 245.881 105.855 245.881 101.619 245.617C87.7501 244.756 74.0214 241.082 61.3828 234.561C52.2422 229.85 43.6641 223.662 36 215.998C30.8144 210.813 24.7852 206.963 18.334 204.484C12.4453 202.217 6.22266 201.092 0 201.092V150.186C2.1445 150.186 4.25394 150.256 6.38086 150.379C30.2696 151.873 53.7363 161.734 72 179.998C91.8808 199.879 124.119 199.879 144 179.998C155.707 168.291 169.559 160.029 184.289 155.213C192.533 152.523 201.041 150.906 209.619 150.379L212.889 150.238L216 150.186V201.092Z',
  },
] as const;

/**
 * One `d` string per piece, for renderers that draw the whole mark in
 * one ink and do not care which piece is which.
 */
export const ANSARI_MARK_PATHS = ANSARI_MARK_SHAPES.map((shape) => shape.d);

/**
 * All three subpaths as one `d` string, for the layers that need the
 * whole silhouette as a single reusable shape (a `<Defs>` template, a
 * mask, a clip). The subpaths are disjoint, so concatenating them draws
 * exactly what the three draw.
 */
export const ANSARI_MARK_PATH = ANSARI_MARK_PATHS.join(' ');

/**
 * The mark is decorative everywhere it appears: the product name beside
 * it is the label a screen reader speaks, and hearing "Ansari" twice is
 * worse than not hearing the logo at all.
 */
export const ANSARI_MARK_DECORATIVE_PROPS =
  Platform.OS === 'web'
    ? {}
    : {
        accessible: false,
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no' as const,
      };

/**
 * The mark at its full, standing size — the sidebar's emblem at the head
 * of the rail. Anywhere else the mark stands on its own rather than as a
 * character in a line of type (the generating mark beneath a streaming
 * answer), it takes this size, so the one mark is only ever seen alone
 * at one size.
 */
export const ANSARI_MARK_EMBLEM_HEIGHT = 32;
