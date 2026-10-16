/**
 * Image attachments on chat messages (spec 211).
 *
 * Images reach the model for the turn they are sent with and are NEVER stored:
 * the bytes live only in request memory. What is persisted is one
 * `ImagePlaceholderBlock` per image, which has no field that can hold data.
 * This module owns the request limits, the decode/validate step, the
 * placeholder construction, and the wire projection that keeps the frozen
 * thread contract intact (placeholders travel in an additive `attachments`
 * key, never inside `content`).
 */
import { z } from 'zod';
import {
  IMAGE_MEDIA_TYPES,
  type ContentBlock,
  type ImageMediaType,
  type ImagePlaceholderBlock,
} from '@/db/schema/messages';

export const MAX_IMAGES = 4;
/** Per image, decoded. Clients downscale first; this is the server's backstop. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * Whole request body. Four maximal images are ~26.7 MB as base64, but the body
 * cap is deliberately tighter: realistic (downscaled) images fit many times
 * over, and the cap keeps any one request's buffered body bounded.
 */
export const MAX_CHAT_BODY_BYTES = 16 * 1024 * 1024;

// Standard base64, padded. Checked before decoding because Buffer.from(…,
// 'base64') silently skips characters it does not understand.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const imageInputSchema = z.object({
  media_type: z.enum(IMAGE_MEDIA_TYPES),
  data: z.string().min(1, 'Image data is required'),
});
export type ImageInput = z.infer<typeof imageInputSchema>;

export const imagesSchema = z
  .array(imageInputSchema)
  .max(MAX_IMAGES, `At most ${MAX_IMAGES} images can be attached`);

/** A validated image, held in memory for one request. Never persisted. */
export interface ImageAttachment {
  mediaType: ImageMediaType;
  /** Base64, exactly as Gemini's `inlineData.data` takes it. */
  data: string;
}

function matchesMagicBytes(bytes: Buffer, mediaType: ImageMediaType): boolean {
  switch (mediaType) {
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/webp':
      return (
        bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
        bytes.subarray(8, 12).toString('latin1') === 'WEBP'
      );
  }
}

/**
 * Validate already schema-checked inputs: real base64, within the size cap, and
 * bytes that are what `media_type` claims. Errors name the image's position
 * only — never any of its content.
 */
export function decodeImages(
  inputs: ImageInput[]
): { ok: true; images: ImageAttachment[] } | { ok: false; error: string } {
  const images: ImageAttachment[] = [];
  for (const [i, input] of inputs.entries()) {
    const n = i + 1;
    if (input.data.length % 4 !== 0 || !BASE64.test(input.data)) {
      return { ok: false, error: `Image ${n} is not valid base64` };
    }
    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image ${n} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB` };
    }
    if (!matchesMagicBytes(bytes, input.media_type)) {
      return { ok: false, error: `Image ${n} is not a valid ${input.media_type} file` };
    }
    images.push({ mediaType: input.media_type, data: input.data });
  }
  return { ok: true, images };
}

/** One placeholder per image. Built field by field so no input key can ride along. */
export function placeholderBlocks(images: ImageAttachment[]): ImagePlaceholderBlock[] {
  return images.map((img) => ({ type: 'image', status: 'not_stored', media_type: img.mediaType }));
}

export function isImagePlaceholder(block: ContentBlock): block is ImagePlaceholderBlock {
  return block.type === 'image';
}

export interface WireAttachment {
  type: 'image';
  status: 'not_stored';
  media_type: string;
}

/**
 * Project stored content onto the thread/share wire shape. Image placeholders
 * move out of `content` into `attachments`; what remains serializes exactly as
 * before — a lone text block collapses to a bare string (the frozen mobile
 * contract), anything else stays an array. An image-only message serializes as
 * `""`. `attachments` is present only on messages that had images, so every
 * other message is byte-identical to the pre-211 response.
 */
export function splitForWire(content: ContentBlock[]): {
  content: string | ContentBlock[];
  attachments?: WireAttachment[];
} {
  const images = content.filter(isImagePlaceholder);
  const rest = images.length > 0 ? content.filter((b) => !isImagePlaceholder(b)) : content;
  const wireContent =
    rest.length === 1 && rest[0].type === 'text'
      ? rest[0].text
      : images.length > 0 && rest.length === 0
        ? ''
        : rest;
  if (images.length === 0) return { content: wireContent };
  return {
    content: wireContent,
    attachments: images.map((b) => ({ type: 'image', status: 'not_stored', media_type: b.media_type })),
  };
}
