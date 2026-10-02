import { describe, it, expect } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  decodeImages,
  imagesSchema,
  placeholderBlocks,
  splitForWire,
} from '../lib/attachments';
import type { ContentBlock } from '../db/schema/messages';

/** Image attachment validation and wire projection — spec 211. */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const b64 = (b: Buffer) => b.toString('base64');

const PLACEHOLDER = { type: 'image', status: 'not_stored', media_type: 'image/png' } as const;

describe('imagesSchema', () => {
  it('accepts 0 to 4 images and rejects 5', () => {
    const one = { media_type: 'image/png', data: b64(PNG) };
    expect(imagesSchema.safeParse([]).success).toBe(true);
    expect(imagesSchema.safeParse(Array(4).fill(one)).success).toBe(true);
    expect(imagesSchema.safeParse(Array(5).fill(one)).success).toBe(false);
  });

  it('rejects media types outside png/jpeg/webp', () => {
    expect(imagesSchema.safeParse([{ media_type: 'image/gif', data: b64(PNG) }]).success).toBe(false);
    expect(imagesSchema.safeParse([{ media_type: 'application/pdf', data: b64(PNG) }]).success).toBe(false);
  });
});

describe('decodeImages', () => {
  it('accepts each supported type when the bytes match', () => {
    const result = decodeImages([
      { media_type: 'image/png', data: b64(PNG) },
      { media_type: 'image/jpeg', data: b64(JPEG) },
      { media_type: 'image/webp', data: b64(WEBP) },
    ]);
    expect(result).toEqual({
      ok: true,
      images: [
        { mediaType: 'image/png', data: b64(PNG) },
        { mediaType: 'image/jpeg', data: b64(JPEG) },
        { mediaType: 'image/webp', data: b64(WEBP) },
      ],
    });
  });

  it('rejects bytes that do not match the declared type, naming only the position', () => {
    const result = decodeImages([
      { media_type: 'image/png', data: b64(PNG) },
      { media_type: 'image/png', data: b64(JPEG) },
    ]);
    expect(result).toEqual({ ok: false, error: 'Image 2 is not a valid image/png file' });
  });

  it('rejects invalid base64 instead of silently decoding garbage', () => {
    expect(decodeImages([{ media_type: 'image/png', data: 'not base64!!' }]).ok).toBe(false);
    expect(decodeImages([{ media_type: 'image/png', data: b64(PNG).slice(0, -1) }]).ok).toBe(false);
  });

  it('accepts exactly the size cap and rejects one byte over', () => {
    const at = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length)]);
    const over = Buffer.concat([at, Buffer.alloc(1)]);
    expect(decodeImages([{ media_type: 'image/png', data: b64(at) }]).ok).toBe(true);
    expect(decodeImages([{ media_type: 'image/png', data: b64(over) }])).toEqual({
      ok: false,
      error: 'Image 1 is larger than 5 MB',
    });
  });
});

describe('placeholderBlocks', () => {
  it('records the media type only — no data key, whatever the input carried', () => {
    const images = [{ mediaType: 'image/jpeg' as const, data: b64(JPEG), extra: 'x' }];
    const blocks = placeholderBlocks(images);
    expect(blocks).toEqual([{ type: 'image', status: 'not_stored', media_type: 'image/jpeg' }]);
    expect(JSON.stringify(blocks)).not.toContain(b64(JPEG));
  });
});

describe('splitForWire', () => {
  it('a single text block stays a bare string with no attachments key (frozen contract)', () => {
    const wire = splitForWire([{ type: 'text', text: 'hi' }]);
    expect(wire).toEqual({ content: 'hi' });
    expect('attachments' in wire).toBe(false);
  });

  it('other shapes without images are returned untouched', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ];
    expect(splitForWire(blocks)).toEqual({ content: blocks });
    expect(splitForWire([])).toEqual({ content: [] });
  });

  it('text + images: content is the bare text, placeholders move to attachments', () => {
    expect(splitForWire([{ type: 'text', text: 'What is this?' }, PLACEHOLDER, PLACEHOLDER])).toEqual({
      content: 'What is this?',
      attachments: [PLACEHOLDER, PLACEHOLDER],
    });
  });

  it('an image-only message serializes as an empty string plus attachments', () => {
    expect(splitForWire([PLACEHOLDER])).toEqual({ content: '', attachments: [PLACEHOLDER] });
  });
});
