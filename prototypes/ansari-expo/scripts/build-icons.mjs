/**
 * Ansari as it appears when it is not on screen: the app icon, the
 * splash, the favicon, the home-screen tiles and the link preview.
 *
 *   pnpm build:icons
 *
 * Every file is drawn from the same two sources the app draws from — the
 * mark's paths (`constants/ansariMark.ts`) and the brass it is struck in
 * (`constants/colors.ts`, `constants/brassEmboss.ts`) — so an icon can
 * never show a different mark, or a different metal, than the rail. The
 * one photographic ingredient is the palm-shadow paper the mark sits on
 * where there is room for paper to read (`assets/icon-source/`).
 *
 * Three treatments:
 *   - the brass mark on palm-shadow paper, wherever the paper can read;
 *   - a brass tile with the mark knocked out in white for the `.ico`,
 *     where 16 px leaves no room for paper, relief or a gradient on the
 *     mark itself — only for a silhouette against a field;
 *   - the bare mark in a single ink for `favicon.svg`, the tab icon of
 *     every browser that reads SVG favicons, the ink following the
 *     reader's light or dark theme (see `themedFaviconSvg`).
 *
 * Every file is full-bleed: each platform applies its own shape, and iOS
 * in particular rounds the corners itself, so anything left in the
 * corners survives as a notch.
 *
 * Deterministic: the same sources produce byte-identical files, so a
 * re-run with nothing changed leaves `git status` clean.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The constants modules are the app's own TypeScript, loaded by Node's
// type stripping. They reach for `react-native` only for `Platform`,
// which nothing here reads; stand it in rather than fork the data.
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'react-native'
      ? {
          url: 'data:text/javascript,export const Platform = { OS: "node", select: (o) => o.default };',
          shortCircuit: true,
        }
      : next(specifier, context),
});

const { brass } = await import(join(ROOT, 'constants/colors.ts'));
const { ANSARI_MARK_PATH, ANSARI_MARK_SHAPES, ANSARI_MARK_VIEWBOX } =
  await import(join(ROOT, 'constants/ansariMark.ts'));
const {
  BRASS_BLEED,
  BRASS_EDGE,
  BRASS_GRADIENT,
  BRASS_GRAIN,
  BRASS_HIGHLIGHT,
  BRASS_SHADOW,
  brassRelief,
} = await import(join(ROOT, 'constants/brassEmboss.ts'));

const { width: VB_W, height: VB_H } = ANSARI_MARK_VIEWBOX;
const PAPER = join(ROOT, 'assets/icon-source/figma-paper-frond.png');

/**
 * The emblem as `AnsariMarkBrass` strikes it on the web, as a standalone
 * SVG `height` px tall plus bleed on every side. Kept layer for layer in
 * step with that component: back to front, shadow, dark edge, body,
 * grain, highlight.
 */
function brassSvg(height, tone) {
  const metal = brass[tone];
  const relief = brassRelief(height);
  const scale = height / VB_H;
  const bleed = BRASS_BLEED;
  const box = `${-bleed} ${-bleed} ${VB_W + bleed * 2} ${VB_H + bleed * 2}`;
  const width = Math.round((VB_W + bleed * 2) * scale);
  const tall = Math.round((VB_H + bleed * 2) * scale);
  const stops = BRASS_GRADIENT.map(
    (stop) =>
      `<stop offset="${stop.offset}" stop-color="${metal[stop.tone]}"/>`,
  ).join('');
  const grain =
    height >= BRASS_GRAIN.minHeight
      ? `<g clip-path="url(#clip)" opacity="${BRASS_GRAIN.opacity}">
           <rect x="${-bleed}" y="${-bleed}" width="${VB_W + bleed * 2}" height="${VB_H + bleed * 2}" filter="url(#grain)"/>
         </g>`
      : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${tall}" viewBox="${box}">
  <defs>
    <path id="mark" d="${ANSARI_MARK_PATH}"/>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="${BRASS_SHADOW.blur * relief}"/>
    </filter>
    <mask id="highlight" maskUnits="userSpaceOnUse" x="${-bleed}" y="${-bleed}" width="${VB_W + bleed * 2}" height="${VB_H + bleed * 2}">
      <use xlink:href="#mark" fill="#FFFFFF"/>
      <use xlink:href="#mark" x="${BRASS_HIGHLIGHT.width * relief}" y="${BRASS_HIGHLIGHT.width * relief}" fill="#000000"/>
    </mask>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="${BRASS_GRAIN.frequency / relief}" numOctaves="2" seed="11"/>
      <feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 0 1"/>
    </filter>
    <clipPath id="clip"><path d="${ANSARI_MARK_PATH}"/></clipPath>
  </defs>
  <g filter="url(#shadow)" opacity="${BRASS_SHADOW.opacity[tone]}">
    <use xlink:href="#mark" x="${BRASS_SHADOW.dx * relief}" y="${BRASS_SHADOW.dy * relief}" fill="${metal.shadow}"/>
  </g>
  <use xlink:href="#mark" x="${BRASS_EDGE.offset * relief}" y="${BRASS_EDGE.offset * relief}" fill="${metal.deep}" opacity="${BRASS_EDGE.opacity[tone]}"/>
  <use xlink:href="#mark" fill="url(#body)"/>
  ${grain}
  <g mask="url(#highlight)">
    <use xlink:href="#mark" fill="${metal.glint}" opacity="${BRASS_HIGHLIGHT.opacity[tone]}"/>
  </g>
</svg>`;
  return { svg: Buffer.from(svg), width, height: tall };
}

/** The struck mark, `markHeight` px tall, as a transparent PNG layer. */
async function brassLayer(markHeight, tone) {
  const { svg } = brassSvg(markHeight, tone);
  return sharp(svg, { density: 72 }).png().toBuffer();
}

/**
 * The mark centred on a canvas. `markShare` is the mark's height as a
 * share of the canvas height — the measure every composition below is
 * quoted in, since the mark is taller than it is wide.
 */
async function compose({ width, height, markShare, tone, background }) {
  const markHeight = Math.round(height * markShare);
  const layer = await brassLayer(markHeight, tone);
  const { width: lw, height: lh } = await sharp(layer).metadata();
  const base = background
    ? sharp(await background(width, height))
    : sharp({
        create: {
          width,
          height,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      });
  return base
    .composite([
      {
        input: layer,
        left: Math.round((width - lw) / 2),
        top: Math.round((height - lh) / 2),
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * The palm-shadow paper, cropped to cover the canvas from its upper-left
 * corner, where the frond is — so every size shows the same corner of
 * the same leaf.
 */
async function paper(width, height) {
  return sharp(PAPER)
    .resize(width, height, { fit: 'cover', position: 'left top' })
    .png()
    .toBuffer();
}

/**
 * The favicon's tile: a field of the emblem's own gradient with the mark
 * knocked out of it in white, `markShare` of the tile tall.
 */
async function knockoutTile(size, markShare) {
  const metal = brass.light;
  const markHeight = size * markShare;
  const s = markHeight / VB_H;
  const tx = (size - VB_W * s) / 2;
  const ty = (size - VB_H * s) / 2;
  const stops = BRASS_GRADIENT.map(
    (stop) =>
      `<stop offset="${stop.offset}" stop-color="${metal[stop.tone]}"/>`,
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="field" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient></defs>
  <rect width="${size}" height="${size}" fill="url(#field)"/>
  <path transform="translate(${tx} ${ty}) scale(${s})" d="${ANSARI_MARK_PATH}" fill="#FFFFFF"/>
</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * Tailwind v4's `taupe-800` and `taupe-200`, converted from the palette's
 * OKLCH to sRGB hex: the mark's ink on a light tab strip and a dark one.
 */
const FAVICON_INK = { light: '#2B2422', dark: '#E8E4E3' };

/**
 * The SVG favicon: the mark's three pieces on a transparent ground, inked
 * by an embedded `prefers-color-scheme` query. The query is resolved when
 * the browser rasterises the icon, not live: Chrome keeps that bitmap
 * across a theme switch, so `public/index.html` re-links the SVG when the
 * scheme flips to make it rasterise again (#232).
 */
function themedFaviconSvg() {
  const paths = ANSARI_MARK_SHAPES.map(
    (shape) => `  <path d="${shape.d}"/>`,
  ).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}">
  <style>
    path { fill: ${FAVICON_INK.light}; }
    @media (prefers-color-scheme: dark) {
      path { fill: ${FAVICON_INK.dark}; }
    }
  </style>
${paths}
</svg>
`;
}

/**
 * An `.ico` holding PNG images, which every browser that still asks for
 * `/favicon.ico` reads: a 6-byte header, a 16-byte directory entry per
 * image, then the images.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/**
 * Mark shares, carried over from the compositions the previous artwork
 * was exported at so the new mark sits in each frame at the same weight:
 *   - ICON: the app icon and every "mark on paper" tile.
 *   - MASKABLE: inside the 80% safe circle an Android launcher may crop
 *     to — the mark's corners, not just its height, must clear it.
 *   - ADAPTIVE: inside the 66% safe zone of an Android adaptive icon's
 *     foreground layer (the paper is its separate background layer).
 *   - SPLASH: the splash mark, drawn on the splash's own flat colour.
 *   - OG: the link preview's mark, on a 1200×630 card.
 *   - FAVICON: as much of a 16 px tile as the mark can take and still
 *     leave a field around it.
 */
const ICON = 0.5;
const MASKABLE = 0.56;
const ADAPTIVE = 0.36;
const SPLASH = 0.41;
const OG = 0.45;
const FAVICON = 0.78;

const outputs = [
  [
    'assets/images/icon.png',
    {
      width: 1024,
      height: 1024,
      markShare: ICON,
      tone: 'light',
      background: paper,
    },
  ],
  [
    'assets/images/adaptive-icon.png',
    { width: 1024, height: 1024, markShare: ADAPTIVE, tone: 'light' },
  ],
  [
    'assets/images/splash-icon.png',
    { width: 1024, height: 1024, markShare: SPLASH, tone: 'light' },
  ],
  [
    'assets/images/splash-icon-dark.png',
    { width: 1024, height: 1024, markShare: SPLASH, tone: 'dark' },
  ],
  [
    'public/icon-512.png',
    {
      width: 512,
      height: 512,
      markShare: ICON,
      tone: 'light',
      background: paper,
    },
  ],
  [
    'public/icon-192.png',
    {
      width: 192,
      height: 192,
      markShare: ICON,
      tone: 'light',
      background: paper,
    },
  ],
  [
    'public/apple-touch-icon.png',
    {
      width: 180,
      height: 180,
      markShare: ICON,
      tone: 'light',
      background: paper,
    },
  ],
  [
    'public/icon-maskable-512.png',
    {
      width: 512,
      height: 512,
      markShare: MASKABLE,
      tone: 'light',
      background: paper,
    },
  ],
  [
    'public/og-image.png',
    {
      width: 1200,
      height: 630,
      markShare: OG,
      tone: 'light',
      background: paper,
    },
  ],
];

for (const [path, spec] of outputs) {
  writeFileSync(join(ROOT, path), await compose(spec));
  console.log(`wrote ${path}`);
}

const favicon = ico(
  await Promise.all(
    [16, 32, 48].map(async (size) => ({
      size,
      png: await knockoutTile(size, FAVICON),
    })),
  ),
);
writeFileSync(join(ROOT, 'public/favicon.ico'), favicon);
console.log('wrote public/favicon.ico');

writeFileSync(join(ROOT, 'public/favicon.svg'), themedFaviconSvg());
console.log('wrote public/favicon.svg');

// Read back once so a silently empty write fails loudly here, not in a
// browser tab weeks later.
for (const [path] of outputs) {
  const { width, height } = await sharp(
    readFileSync(join(ROOT, path)),
  ).metadata();
  if (!width || !height) throw new Error(`${path}: unreadable output`);
}
