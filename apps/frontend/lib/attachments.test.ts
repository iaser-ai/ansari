import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGES,
  addImages,
  base64Bytes,
  hasQuestion,
  remainingSlots,
  toImageInputs,
  toLocalAttachments,
  type PickedImage,
} from '@/lib/attachments';
import { clearOpeningImages, peekOpeningImages, stashOpeningImages } from '@/lib/pending-attachments';
import { reconcileThread } from '@/lib/chat-reconcile';
import { decodeConversationDetail } from '@/lib/api/decode';
import type { Message } from '@/lib/api';

/** Image attachments on questions — spec 211. */

const img = (n: number): PickedImage => ({
  uri: `file:///img-${n}.jpg`,
  mediaType: 'image/jpeg',
  base64: `QUJD${n}`,
});

describe('limits and shapes', () => {
  it('never holds more than four images', () => {
    expect(MAX_IMAGES).toBe(4);
    expect(remainingSlots(0)).toBe(4);
    expect(remainingSlots(3)).toBe(1);
    expect(remainingSlots(4)).toBe(0);
    expect(remainingSlots(6)).toBe(0);
    expect(addImages([img(1), img(2), img(3)], [img(4), img(5)])).toEqual([img(1), img(2), img(3), img(4)]);
  });

  it('measures decoded size from base64 without decoding', () => {
    expect(base64Bytes('QUJD')).toBe(3); // "ABC"
    expect(base64Bytes('QUI=')).toBe(2); // "AB"
    expect(base64Bytes('QQ==')).toBe(1); // "A"
  });

  it('builds the request images, or nothing when there are none', () => {
    expect(toImageInputs([])).toBeUndefined();
    expect(toImageInputs([img(1)])).toEqual([{ media_type: 'image/jpeg', data: 'QUJD1' }]);
  });

  it('keeps only what a thumbnail needs for the bubble — never the bytes', () => {
    const local = toLocalAttachments([img(1)]);
    expect(local).toEqual([{ mediaType: 'image/jpeg', uri: 'file:///img-1.jpg' }]);
    expect(JSON.stringify(local)).not.toContain('QUJD');
  });

  it('a question is words, images, or both', () => {
    expect(hasQuestion('', [])).toBe(false);
    expect(hasQuestion('   ', [])).toBe(false);
    expect(hasQuestion('why?', [])).toBe(true);
    expect(hasQuestion('', [img(1)])).toBe(true);
  });
});

describe('home → thread hand-off', () => {
  it('holds images per conversation until cleared, and peeking does not consume', () => {
    stashOpeningImages('c1', [img(1)]);
    expect(peekOpeningImages('c1')).toEqual([img(1)]);
    expect(peekOpeningImages('c1')).toEqual([img(1)]);
    expect(peekOpeningImages('c2')).toEqual([]);
    clearOpeningImages('c1');
    expect(peekOpeningImages('c1')).toEqual([]);
  });

  it('stashing nothing leaves nothing behind', () => {
    stashOpeningImages('c3', []);
    expect(peekOpeningImages('c3')).toEqual([]);
  });
});

describe('thread GET attachments decode', () => {
  const thread = (messages: unknown[]) => ({
    thread_id: 't',
    thread_name: 'n',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    messages,
  });

  it('maps placeholders onto the question; a message without them has no key', () => {
    const detail = decodeConversationDetail(
      thread([
        {
          id: 'u1',
          role: 'user',
          content: 'What is this?',
          attachments: [{ type: 'image', status: 'not_stored', media_type: 'image/jpeg' }],
        },
        { id: 'u2', role: 'user', content: 'plain' },
      ]),
    );
    expect(detail.messages[0].attachments).toEqual([{ mediaType: 'image/jpeg' }]);
    expect(detail.messages[0].content).toBe('What is this?');
    expect('attachments' in detail.messages[1]).toBe(false);
  });

  it('an image-only question decodes with empty content', () => {
    const detail = decodeConversationDetail(
      thread([
        { id: 'u1', role: 'user', content: '', attachments: [{ type: 'image', status: 'not_stored', media_type: 'image/png' }] },
      ]),
    );
    expect(detail.messages[0]).toMatchObject({ content: '', attachments: [{ mediaType: 'image/png' }] });
  });
});

describe('reconcileThread with attachments', () => {
  const CID = 'conv1';
  const base = {
    conversationId: CID,
    streamKey: '__s1',
    followUpKey: '__f1',
    streamingText: '',
    sentAtCount: 0,
    pendingFollowUp: undefined,
  };
  const local = [{ mediaType: 'image/jpeg', uri: 'file:///img-1.jpg' }];
  const user = (content: string, id: string): Message => ({
    id,
    conversationId: CID,
    role: 'user',
    content,
    citations: [],
    safety: null,
    createdAt: '',
    attachments: [{ mediaType: 'image/jpeg' }],
  });

  it('an image-only opening question gets an echo row with its thumbnails', () => {
    const { messages } = reconcileThread({
      ...base,
      serverMessages: [],
      q: '',
      openingAttachments: local,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: '__asked-question', content: '', attachments: local });
  });

  it('once persisted, the opening question keeps its local thumbnails', () => {
    const { messages } = reconcileThread({
      ...base,
      serverMessages: [user('What is this?', 'u1')],
      q: 'What is this?',
      openingAttachments: local,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: '__asked-question', attachments: local });
  });

  it('an image-only follow-up gets a synthetic row, then hands off to the persisted one', () => {
    const before = reconcileThread({
      ...base,
      serverMessages: [],
      q: undefined,
      pendingFollowUp: '',
      pendingFollowUpAttachments: local,
    });
    expect(before.messages).toEqual([
      expect.objectContaining({ id: '__f1', content: '', attachments: local }),
    ]);

    const after = reconcileThread({
      ...base,
      serverMessages: [user('', 'u9')],
      q: undefined,
      pendingFollowUp: '',
      pendingFollowUpAttachments: local,
    });
    expect(after.landedFollowUp?.id).toBe('u9');
    expect(after.messages).toEqual([
      expect.objectContaining({ id: '__f1', attachments: local }),
    ]);
  });

  it('without attachments an empty follow-up is still no follow-up (unchanged)', () => {
    const { messages } = reconcileThread({ ...base, serverMessages: [], q: undefined, pendingFollowUp: '' });
    expect(messages).toEqual([]);
  });
});
