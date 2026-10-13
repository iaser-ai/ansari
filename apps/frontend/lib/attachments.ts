import type { Attachment, ImageInput } from '@/lib/api/types';

/**
 * Images attached to a question (spec 211) — the pure part: limits and the
 * shapes an image takes on its way out. Picking lives in `lib/pick-images.ts`,
 * which needs the native modules.
 *
 * The model sees an image for the turn it is sent with only; apps/api never
 * stores it. So the picked image is held in memory here, sent once, and
 * afterwards the thread shows only that an image was there.
 */

/** apps/api accepts at most four images per message. */
export const MAX_IMAGES = 4;

/**
 * Longest edge after downscaling. Large enough for a page of Arabic text to
 * stay legible, small enough that four images sit well inside the API's
 * request cap.
 */
export const MAX_IMAGE_EDGE = 1568;

/** apps/api's per-image cap, decoded. Checked before sending, not after a 422. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A picked, downscaled image, ready to show and to send. */
export interface PickedImage {
  /** For display: a local file URI on native, a data or blob URI on the web. */
  uri: string;
  mediaType: ImageInput['media_type'];
  /** Base64, no `data:` prefix. */
  base64: string;
}

/** How many more images can be picked when `count` are already attached. */
export function remainingSlots(count: number): number {
  return Math.max(0, MAX_IMAGES - count);
}

/** Append newly picked images, never past the limit. */
export function addImages(current: PickedImage[], picked: PickedImage[]): PickedImage[] {
  return [...current, ...picked].slice(0, MAX_IMAGES);
}

/** Decoded size of a base64 string, without decoding it. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** The request body's `images`, or undefined when there are none. */
export function toImageInputs(images: PickedImage[]): ImageInput[] | undefined {
  if (images.length === 0) return undefined;
  return images.map((img) => ({ media_type: img.mediaType, data: img.base64 }));
}

/** What the question's own bubble shows while it is on screen. */
export function toLocalAttachments(images: PickedImage[]): Attachment[] {
  return images.map((img) => ({ mediaType: img.mediaType, uri: img.uri }));
}

/** A question can be sent with words, images, or both — never neither. */
export function hasQuestion(text: string, images: readonly unknown[] = []): boolean {
  return text.trim().length > 0 || images.length > 0;
}
