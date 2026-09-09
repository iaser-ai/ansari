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
export const ANSARI_MARK_VIEWBOX = { width: 106, height: 142 } as const;

export const ANSARI_MARK_ASPECT_RATIO =
  ANSARI_MARK_VIEWBOX.width / ANSARI_MARK_VIEWBOX.height;

/**
 * The three disjoint pieces the mark is built from, in the order the eye
 * reads them: down the mark.
 *
 * The artwork does not hand them over in that order — it carries the
 * foot's arcs and the middle band inside a single subpath string, with
 * the arcs first — so anything that wants to treat the pieces as
 * separate objects (light them one after another, tint one of them)
 * would otherwise have to re-derive which is which from the path data
 * every time. They are named for their place in the artwork here once,
 * and nowhere else.
 */
export const ANSARI_MARK_SHAPES = [
  {
    /** The eight-point star crowning the mark. */
    name: 'star',
    d: 'M54.1386 0.868896C53.5255 -0.289625 51.7624 -0.289629 51.1492 0.868868C46.9177 8.86339 40.3701 15.4309 32.401 19.674C31.2471 20.2884 31.2471 22.0442 32.401 22.6585C40.369 26.9006 46.9173 33.4657 51.1493 41.4579C51.7626 42.6161 53.5252 42.6161 54.1385 41.4579C58.3695 33.4668 64.9153 26.901 72.881 22.6584C74.0346 22.044 74.0346 20.2886 72.881 19.6742C64.9142 15.4306 58.3691 8.86226 54.1386 0.868896Z',
  },
  {
    /** The chevron band across the middle. */
    name: 'band',
    d: 'M93.4687 70.2913C93.8402 71.0318 93.541 71.9332 92.8006 72.3047L53.313 92.1156C52.8897 92.328 52.391 92.328 51.9677 92.1156L12.4797 72.3047C11.7392 71.9332 11.4401 71.0318 11.8116 70.2913L18.8463 56.2694C19.2178 55.5289 20.1192 55.2298 20.8596 55.6013L51.9673 71.2079C52.3906 71.4202 52.8893 71.4203 53.3126 71.2079L84.4206 55.6012C85.1611 55.2298 86.0625 55.5289 86.434 56.2694L93.4687 70.2913Z',
  },
  {
    /** The nested arcs cradling the foot. */
    name: 'arcs',
    d: 'M61.5572 119.084C61.5572 119.082 61.558 119.08 61.5595 119.079C73.4427 107.159 92.504 106.814 104.802 118.045C105.414 118.604 105.41 119.557 104.824 120.142L93.7122 131.215C93.1254 131.8 92.1801 131.79 91.5307 131.275C86.5746 127.35 79.3748 127.681 74.7973 132.269C74.7956 132.27 74.7947 132.273 74.7947 132.275C74.7947 132.278 74.7937 132.28 74.792 132.282C62.5552 144.556 42.707 144.555 30.4703 132.281C30.4686 132.28 30.4676 132.277 30.4675 132.275C30.4675 132.273 30.4665 132.271 30.4648 132.269C25.8874 127.681 18.6877 127.35 13.7317 131.275C13.0823 131.79 12.137 131.8 11.5502 131.215L0.43873 120.142C-0.148055 119.557 -0.151523 118.604 0.460207 118.045C12.7583 106.814 31.8195 107.159 43.7027 119.079C43.7042 119.08 43.7051 119.082 43.705 119.084C43.705 119.087 43.7058 119.089 43.7074 119.09C48.6411 124.036 56.6211 124.036 61.5548 119.09C61.5563 119.089 61.5572 119.087 61.5572 119.084Z',
  },
] as const;

/**
 * The original source-order export, kept stable for renderers that draw
 * the whole mark in one ink and do not care which piece is which.
 *
 * The second source path historically contained the bottom arcs followed
 * by the middle band. Keep that ordering here even though
 * `ANSARI_MARK_SHAPES` deliberately names them in visual order.
 */
export const ANSARI_MARK_PATHS = [
  ANSARI_MARK_SHAPES[0].d,
  `${ANSARI_MARK_SHAPES[2].d} ${ANSARI_MARK_SHAPES[1].d}`,
] as const;

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
