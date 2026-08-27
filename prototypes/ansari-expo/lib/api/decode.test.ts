import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  decodeConversation,
  decodeConversationDetail,
  decodeConversationList,
} from '@/lib/api/decode';

/**
 * THE LOUD-FAILURE GATE (see issue #63).
 *
 * apps/api returns no citations and no safety signal, so a correct empty app and
 * a broken app look identical on screen. The only defence is proving the adapter
 * THROWS when the response shape is wrong. These fixtures are the prototype's
 * ORIGINAL Replit "Ansari 4" shapes (`{ id, title, preview }`, `MessageExchange`,
 * …); feeding them to the decoders must throw, exactly as it would at runtime if
 * someone pointed the app at the wrong backend. The positive cases prove the
 * real apps/api shapes decode into the UI types. Do not delete these tests.
 */

// --- Fixtures: the real apps/api wire shapes -------------------------------

const realThread = {
  thread_id: 't-1',
  thread_name: 'Prayer times',
  source: 'web',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

const realThreadList = [realThread];

const realThreadDetail = {
  ...realThread,
  messages: [
    { id: 'm-1', role: 'user', content: 'When is Fajr?', created_at: '2026-01-01T00:00:00.000Z' },
    {
      id: 'm-2',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Fajr begins at dawn.' },
        { type: 'tool_use', id: 'tu-1', name: 'search', input: { q: 'fajr' } },
        { type: 'text', text: 'See your local timetable.' },
      ],
      agent_name: 'facilitator',
      created_at: '2026-01-01T00:00:05.000Z',
    },
    { id: 'm-3', role: 'tool', content: 'internal', created_at: '2026-01-01T00:00:06.000Z' },
  ],
};

// --- Fixtures: the OLD Replit shapes (must be rejected) --------------------

const oldConversation = {
  id: 'c-1',
  title: 'Prayer times',
  preview: 'When is Fajr?',
  messageCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const oldConversationDetail = {
  ...oldConversation,
  messages: [
    { id: 'm-1', conversationId: 'c-1', role: 'user', content: 'When is Fajr?', citations: [], createdAt: '' },
  ],
};

describe('decodeConversationList — loud failure', () => {
  it('rejects the old Replit Conversation[] shape', () => {
    expect(() => decodeConversationList([oldConversation])).toThrow(ZodError);
  });

  it('rejects a near-miss where thread_id is the wrong type', () => {
    expect(() =>
      decodeConversationList([{ ...realThread, thread_id: 123 }]),
    ).toThrow(ZodError);
  });

  it('rejects a non-array payload', () => {
    expect(() => decodeConversationList(realThread)).toThrow(ZodError);
  });

  it('decodes the real apps/api thread list into Conversation[]', () => {
    const [c] = decodeConversationList(realThreadList);
    expect(c.id).toBe('t-1');
    expect(c.title).toBe('Prayer times');
    // Fields apps/api never carries are filled by design, not silently defaulted.
    expect(c.preview).toBe('');
    expect(c.messageCount).toBe(0);
  });

  it('filters nothing away — the empty list decodes to an empty list', () => {
    expect(decodeConversationList([])).toEqual([]);
  });
});

describe('decodeConversation — loud failure', () => {
  it('rejects the old Replit Conversation shape', () => {
    expect(() => decodeConversation(oldConversation)).toThrow(ZodError);
  });

  it('decodes a real thread and titles an unnamed thread', () => {
    expect(decodeConversation(realThread).title).toBe('Prayer times');
    expect(decodeConversation({ ...realThread, thread_name: null }).title).toBe(
      'New conversation',
    );
  });
});

describe('decodeConversationDetail — loud failure + content handling', () => {
  it('rejects the old Replit ConversationDetail shape', () => {
    expect(() => decodeConversationDetail(oldConversationDetail)).toThrow(ZodError);
  });

  it('rejects a message whose content is a number', () => {
    expect(() =>
      decodeConversationDetail({
        ...realThreadDetail,
        messages: [{ id: 'm', role: 'user', content: 42 }],
      }),
    ).toThrow(ZodError);
  });

  it('flattens string and block-array content, and drops tool messages', () => {
    const detail = decodeConversationDetail(realThreadDetail);
    // 'user' + 'assistant' survive; the 'tool' message is dropped.
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // A bare-string content passes through.
    expect(detail.messages[0].content).toBe('When is Fajr?');
    // A block array joins only its text blocks (tool_use dropped).
    expect(detail.messages[1].content).toBe(
      'Fajr begins at dawn.\n\nSee your local timetable.',
    );
    // citations/safety are empty by design.
    expect(detail.messages[1].citations).toEqual([]);
    expect(detail.messages[1].safety).toBeNull();
  });
});
