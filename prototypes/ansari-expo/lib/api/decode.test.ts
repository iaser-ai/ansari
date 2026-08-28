import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  decodeConversation,
  decodeConversationDetail,
  decodeConversationList,
  decodeDeleteResult,
} from '@/lib/api/decode';
import { SAMPLE_CITATIONS } from '@/lib/sample-citations';

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

describe('decodeConversationList — client-side title-only search (issue #64)', () => {
  // apps/api's GET /threads ignores query params, so the History search box
  // filters the loaded list here. It matches the raw `thread_name` ONLY,
  // case-insensitively, and an unnamed thread (null name) must neither match nor
  // crash. These fixtures share one list so each assertion narrows a real set.
  const named = (thread_id: string, thread_name: string | null) => ({
    thread_id,
    thread_name,
    source: 'web',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  });
  const list = [
    named('t-1', 'Prayer times'),
    named('t-2', 'How to develop khushu'),
    named('t-3', null), // unnamed thread → maps to "New conversation"
  ];

  it('matches thread_name case-insensitively', () => {
    expect(decodeConversationList(list, 'PRAYER').map((c) => c.id)).toEqual([
      't-1',
    ]);
    expect(decodeConversationList(list, 'khushu').map((c) => c.id)).toEqual([
      't-2',
    ]);
  });

  it('is title-only: a query matching another field (source/id) matches nothing', () => {
    // "web" is every thread's `source`, and "t-" every thread's id prefix — a
    // title-only filter must not surface them.
    expect(decodeConversationList(list, 'web')).toEqual([]);
    expect(decodeConversationList(list, 't-')).toEqual([]);
  });

  it('a null thread_name neither matches nor crashes', () => {
    // The unnamed thread maps to the display title "New conversation"; searching
    // "new"/"conversation" must NOT surface it (we filter raw name, not title).
    expect(decodeConversationList(list, 'new')).toEqual([]);
    expect(decodeConversationList(list, 'conversation')).toEqual([]);
    // And it is simply absent from an unrelated query — no throw.
    expect(decodeConversationList(list, 'prayer').map((c) => c.id)).toEqual([
      't-1',
    ]);
  });

  it('an empty or whitespace query returns the whole list (clearing restores)', () => {
    expect(decodeConversationList(list)).toHaveLength(3);
    expect(decodeConversationList(list, '')).toHaveLength(3);
    expect(decodeConversationList(list, '   ')).toHaveLength(3);
  });

  it('still throws on a bad list shape even with a query (loud failure holds)', () => {
    expect(() => decodeConversationList([oldConversation], 'prayer')).toThrow(
      ZodError,
    );
  });
});

describe('decodeDeleteResult — loud failure (issue #64)', () => {
  it('accepts the real DELETE /threads/{id} `{ message }` shape', () => {
    expect(() => decodeDeleteResult({ message: 'Thread deleted' })).not.toThrow();
  });

  it('rejects a response missing `message`', () => {
    expect(() => decodeDeleteResult({})).toThrow(ZodError);
  });

  it('rejects a `message` of the wrong type', () => {
    expect(() => decodeDeleteResult({ message: 204 })).toThrow(ZodError);
  });

  it('rejects the old Replit Conversation shape (wrong backend)', () => {
    expect(() => decodeDeleteResult(oldConversation)).toThrow(ZodError);
  });

  it('rejects a non-object payload (e.g. an HTML error page string)', () => {
    expect(() => decodeDeleteResult('<html>500</html>')).toThrow(ZodError);
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
    // A non-khushu thread carries no citations.
    expect(detail.messages[1].citations).toEqual([]);
    expect(detail.messages[1].safety).toBeNull();
  });
});

describe('sample citations — khushu-gated placement', () => {
  const khushuThread = {
    ...realThread,
    messages: [
      {
        id: 'u',
        role: 'user',
        content: "How can I develop khushu' in my prayer?",
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'a',
        role: 'assistant',
        content: 'Begin by understanding the meaning of what you recite…',
        created_at: '2026-01-01T00:00:05.000Z',
      },
    ],
  };

  it('attaches the sample set to the assistant answer in a khushu thread', () => {
    const detail = decodeConversationDetail(khushuThread);
    const assistant = detail.messages.find((m) => m.role === 'assistant');
    const user = detail.messages.find((m) => m.role === 'user');
    expect(assistant?.citations).toEqual(SAMPLE_CITATIONS);
    expect(assistant?.citations).toHaveLength(3);
    // The user's own message never gets citations.
    expect(user?.citations).toEqual([]);
  });

  it('attaches to ONLY the first assistant answer, not follow-ups', () => {
    const detail = decodeConversationDetail({
      ...khushuThread,
      messages: [
        { id: 'u1', role: 'user', content: "How do I develop khushu'?" },
        { id: 'a1', role: 'assistant', content: 'Understand what you recite…' },
        { id: 'u2', role: 'user', content: 'And what about zakat?' },
        { id: 'a2', role: 'assistant', content: 'Zakat is 2.5%…' },
      ],
    });
    const answers = detail.messages.filter((m) => m.role === 'assistant');
    expect(answers[0].citations).toEqual(SAMPLE_CITATIONS); // supported answer
    expect(answers[1].citations).toEqual([]); // unrelated follow-up
  });

  it('attaches nothing when the thread is not about khushu', () => {
    const detail = decodeConversationDetail({
      ...khushuThread,
      messages: [
        { id: 'u', role: 'user', content: 'How do I calculate zakat?' },
        { id: 'a', role: 'assistant', content: 'Zakat is 2.5%…' },
      ],
    });
    for (const m of detail.messages) expect(m.citations).toEqual([]);
  });
});
