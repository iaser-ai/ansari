import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import sharp from 'sharp';
import { BDD_DIR } from './env.ts';
import type { ImageInput } from './api.ts';

/** The app's settings (apps/frontend/lib/attachments.ts, lib/pick-images.ts). */
export const APP_MAX_EDGE = 1568;
const APP_JPEG_QUALITY = 80;

/** A photo-sized image: what the app sends after shrinking a 4:3 phone photo. */
export const PHOTO_SIZE = { width: 1568, height: 1176 };

/** Distinct random numbers a model cannot guess, one per image. */
export function randomNumbers(count: number): string[] {
  const out = new Set<string>();
  while (out.size < count) out.add(String(randomInt(10_000, 100_000)));
  return [...out];
}

/**
 * An image showing `label` in large digits on a mottled background, encoded
 * the way the app encodes a picked photo. The background noise keeps the JPEG
 * close to a real photo's size, so upload sizes are realistic.
 */
export async function numberedImage(label: string, size = PHOTO_SIZE): Promise<Buffer> {
  const { width, height } = size;
  const noise = await sharp({
    create: { width, height, channels: 3, background: '#cccccc', noise: { type: 'gaussian', mean: 200, sigma: 30 } },
  })
    .blur(1.2)
    .png()
    .toBuffer();
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <rect x="${width * 0.15}" y="${height * 0.3}" width="${width * 0.7}" height="${height * 0.4}" fill="white" rx="24"/>
       <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
             font-family="Helvetica, Arial, sans-serif" font-weight="bold"
             font-size="${Math.round(height * 0.22)}" fill="#111">${label}</text>
     </svg>`
  );
  return sharp(noise)
    .composite([{ input: svg }])
    .jpeg({ quality: APP_JPEG_QUALITY })
    .toBuffer();
}

/**
 * Shrink like the app: longest side down to `maxEdge` (never enlarged), then
 * JPEG at quality 0.8. `null` keeps the full size but still re-encodes, which
 * is what sending the original would look like.
 */
export async function shrinkLikeTheApp(image: Buffer, maxEdge: number | null): Promise<Buffer> {
  let pipeline = sharp(image).rotate();
  if (maxEdge !== null) {
    pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  }
  return pipeline.jpeg({ quality: APP_JPEG_QUALITY }).toBuffer();
}

export function toInput(jpeg: Buffer): ImageInput {
  return { media_type: 'image/jpeg', data: jpeg.toString('base64') };
}

export interface TextFixture {
  name: string;
  image: Buffer;
  text: string;
}

export const FIXTURE_DIR = path.join(BDD_DIR, 'fixtures', 'text-images');

/** Every fixture image that has a same-named .txt file with its exact text. */
export function loadTextFixtures(): TextFixture[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  const files = readdirSync(FIXTURE_DIR);
  return files
    .filter((f) => /\.(jpe?g|png|webp|heic|heif)$/i.test(f))
    .flatMap((f) => {
      const base = f.replace(/\.[^.]+$/, '');
      const txt = path.join(FIXTURE_DIR, `${base}.txt`);
      if (!existsSync(txt)) return [];
      return [{ name: f, image: readFileSync(path.join(FIXTURE_DIR, f)), text: readFileSync(txt, 'utf8') }];
    });
}
