import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  decodeConversation,
  decodeConversationDetail,
  decodeConversationList,
  decodeDeleteResult,
  loadConversationDetail,
} from '@/lib/api/decode';
import { SAMPLE_ANSWER_CONTENT, SAMPLE_CITATIONS } from '@/lib/sample-citations';
import { parseAnswer } from '@/lib/markdown';

/**
 * THE LOUD-FAILURE GATE (see issue #63).
 *
 * apps/api returns no safety signal (and citations only when a tool ran), so a
 * correct empty app and a broken app can look identical on screen. The only defence is proving the adapter
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

  it('rewrites the assistant answer content with inline [1]/[2]/[3] markers matching SAMPLE_CITATIONS (issue #145)', () => {
    const detail = decodeConversationDetail(khushuThread);
    const assistant = detail.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe(SAMPLE_ANSWER_CONTENT);
    // Not just present in the string — parseable as the footnote markers
    // `AnswerProse`/`lib/markdown.ts` look for, one per sample citation.
    const markers = parseAnswer(assistant!.content)
      .flatMap((block) => (block.type === 'paragraph' ? block.spans : []))
      .filter((span) => span.type === 'footnote')
      .map((span) => (span as { marker: number }).marker);
    expect(markers).toEqual(SAMPLE_CITATIONS.map((c) => c.marker));
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
    // Only the supported answer's content is rewritten with markers; the
    // unrelated follow-up keeps its real text untouched.
    expect(answers[0].content).toBe(SAMPLE_ANSWER_CONTENT);
    expect(answers[1].content).toBe('Zakat is 2.5%…');
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
    // Content is real (apps/api) text everywhere else — never overwritten.
    const assistant = detail.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('Zakat is 2.5%…');
  });
});

describe('unbacked citations — hidden where no sources back them', () => {
  const thread = (messages: unknown[]) =>
    decodeConversationDetail({ ...realThread, messages });

  it('collapses a non-khushu answer with markers and a Citations: block to just the prose', () => {
    const detail = thread([
      { id: 'u', role: 'user', content: 'How do I calculate zakat?' },
      {
        id: 'a',
        role: 'assistant',
        content:
          'Zakat is 2.5% of wealth held for a lunar year [1]. It is due above the nisab [2].\n\n' +
          "**Citations:**\n[1] Qur'an 9:60\n[2] Sahih Muslim 979",
      },
    ]);
    const assistant = detail.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe(
      'Zakat is 2.5% of wealth held for a lunar year. It is due above the nisab.',
    );
  });

  it('keeps [1]/[2]/[3] intact on the khushu sample answer, which carries its citations', () => {
    const detail = thread([
      { id: 'u', role: 'user', content: "How can I develop khushu' in my prayer?" },
      { id: 'a', role: 'assistant', content: 'Model text [1].\n\nCitations:\n[1] x' },
    ]);
    const assistant = detail.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe(SAMPLE_ANSWER_CONTENT);
    for (const marker of ['[1]', '[2]', '[3]']) {
      expect(assistant?.content).toContain(marker);
    }
  });

  it('strips a khushu follow-up, which carries no citations', () => {
    const detail = thread([
      { id: 'u1', role: 'user', content: "How do I develop khushu'?" },
      { id: 'a1', role: 'assistant', content: 'Understand what you recite…' },
      { id: 'u2', role: 'user', content: 'And in sujud [1]?' },
      { id: 'a2', role: 'assistant', content: 'Lengthen it [1].\n\n## Citations\n[1] x' },
    ]);
    const answers = detail.messages.filter((m) => m.role === 'assistant');
    expect(answers[1].content).toBe('Lengthen it.');
    // The reader's own words are never rewritten.
    expect(detail.messages[2].content).toBe('And in sujud [1]?');
  });
});

describe('source documents (spec 168) — joined from /threads/{id}/documents', () => {
  const verse = {
    type: 'document',
    source: {
      type: 'text',
      media_type: 'text/plain',
      data: JSON.stringify({
        ar: 'وَأَقِمِ ٱلصَّلَوٰةَ لِذِكْرِىٓ',
        en: 'And establish prayer for My remembrance.',
      }),
    },
    title: 'Quran 20:14',
    context: 'Retrieved from the Holy Quran',
  };

  const answerText =
    'Establish prayer for remembrance [1]. Something unsourced [2].\n\n' +
    "**Citations**:\n[1] Qur'an 20:14\n[2] Sahih Muslim 979";

  // The raw thread GET array, `tool` row included: the answer is at index 2.
  const rawMessages = [
    { id: 'u', role: 'user', content: 'Why do we pray?' },
    { id: 't', role: 'tool', content: [{ type: 'tool_result' }] },
    { id: 'a', role: 'assistant', content: answerText },
  ];
  const rawThread = { ...realThread, messages: rawMessages };
  const docsFor = (messages: unknown[]) => ({ thread_id: realThread.thread_id, messages });
  const entry = { message_id: 'a', message_index: 2, documents: [verse] };

  const answerOf = (raw: unknown, rawDocuments?: unknown) =>
    decodeConversationDetail(raw, rawDocuments).messages.find((m) => m.role === 'assistant')!;

  const STRIPPED = 'Establish prayer for remembrance. Something unsourced.';

  it('keeps resolved markers inline, drops the rest, and attaches the real sources', () => {
    const assistant = answerOf(rawThread, docsFor([entry]));
    expect(assistant.content).toBe('Establish prayer for remembrance [1]. Something unsourced.');
    expect(assistant.citations).toHaveLength(1);
    expect(assistant.citations[0]).toMatchObject({
      marker: 1,
      reference: "Qur'an 20:14",
      url: 'https://quran.com/20/14',
    });
    // The kept marker parses as a footnote the answer UI can open.
    const footnotes = parseAnswer(assistant.content)
      .flatMap((block) => (block.type === 'paragraph' ? block.spans : []))
      .filter((span) => span.type === 'footnote');
    expect(footnotes).toHaveLength(1);
  });

  it('counts tool rows in message_index (the join runs on the raw array)', () => {
    // Index 1 is the tool row: with the tool row filtered out first, index 1
    // would wrongly land on the answer.
    const assistant = answerOf(rawThread, docsFor([{ ...entry, message_index: 1 }]));
    expect(assistant.citations).toEqual([]);
    expect(assistant.content).toBe(STRIPPED);
  });

  it('attaches nothing when message_id and message_index name different answers', () => {
    // The id names the SECOND answer, the index points at the FIRST: either
    // key alone would attach the sources somewhere; together they disagree.
    const detail = decodeConversationDetail(
      {
        ...realThread,
        messages: [
          ...rawMessages,
          { id: 'u2', role: 'user', content: 'More?' },
          { id: 'a2', role: 'assistant', content: 'More prayer [1].\n\nCitations:\n[1] Quran 20:14' },
        ],
      },
      docsFor([{ message_id: 'a2', message_index: 2, documents: [verse] }]),
    );
    for (const m of detail.messages) expect(m.citations).toEqual([]);
  });

  it('drops only the inconsistent entry; a good one in the same response still attaches', () => {
    const twoAnswers = {
      ...realThread,
      messages: [
        ...rawMessages,
        { id: 'u2', role: 'user', content: 'More?' },
        { id: 'a2', role: 'assistant', content: 'More prayer [1].\n\nCitations:\n[1] Quran 20:14' },
      ],
    };
    const detail = decodeConversationDetail(
      twoAnswers,
      docsFor([{ ...entry, message_index: 9 }, { message_id: 'a2', message_index: 4, documents: [verse] }]),
    );
    const answers = detail.messages.filter((m) => m.role === 'assistant');
    expect(answers[0]!.citations).toEqual([]);
    expect(answers[1]!.citations).toHaveLength(1);
    expect(answers[1]!.content).toBe('More prayer [1].');
  });

  it('never attaches documents to a user message', () => {
    const detail = decodeConversationDetail(
      { ...realThread, messages: [{ id: 'u', role: 'user', content: 'Why [1]?' }] },
      docsFor([{ message_id: 'u', message_index: 0, documents: [verse] }]),
    );
    expect(detail.messages[0]!.citations).toEqual([]);
    expect(detail.messages[0]!.content).toBe('Why [1]?');
  });

  it('renders exactly as with no documents when the documents request failed', () => {
    const failed = decodeConversationDetail(rawThread, undefined);
    const empty = decodeConversationDetail(rawThread, docsFor([]));
    expect(failed).toEqual(empty);
    expect(answerOf(rawThread).content).toBe(STRIPPED);
  });

  it('does not fail the conversation when the documents body is malformed', () => {
    const { title: _dropped, ...noTitle } = verse;
    for (const bad of [
      docsFor([{ ...entry, documents: [noTitle] }]),
      docsFor([{ ...entry, message_index: -1 }]),
      { messages: 'nope' },
      '<html>error</html>',
    ]) {
      const assistant = answerOf(rawThread, bad);
      expect(assistant.citations).toEqual([]);
      expect(assistant.content).toBe(STRIPPED);
    }
  });

  it('still throws when the THREAD is malformed, documents or not', () => {
    expect(() =>
      decodeConversationDetail({ ...realThread, messages: 'nope' }, docsFor([entry])),
    ).toThrow(ZodError);
  });

  it('gives a khushu thread its real sources, not the sample, when it has documents', () => {
    const khushu = {
      ...rawThread,
      messages: [
        { id: 'u', role: 'user', content: "How can I develop khushu' in my prayer?" },
        ...rawMessages.slice(1),
      ],
    };
    const assistant = answerOf(khushu, docsFor([entry]));
    expect(assistant.content).not.toBe(SAMPLE_ANSWER_CONTENT);
    expect(assistant.citations[0]!.reference).toBe("Qur'an 20:14");
    // …and falls back to the sample when the answer has none.
    expect(answerOf(khushu, docsFor([])).citations).toEqual(SAMPLE_CITATIONS);
  });
});

describe('loadConversationDetail — the detail queryFn body (spec 168)', () => {
  const docs = {
    thread_id: realThread.thread_id,
    messages: [
      {
        message_id: 'a',
        message_index: 1,
        documents: [
          {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: '{"ar":"x","en":"y"}' },
            title: 'Quran 1:1',
            context: 'Retrieved from the Holy Quran',
          },
        ],
      },
    ],
  };
  const thread = {
    ...realThread,
    messages: [
      { id: 'u', role: 'user', content: 'Q' },
      { id: 'a', role: 'assistant', content: 'A [1].\n\nCitations:\n[1] Quran 1:1' },
    ],
  };

  const fetcher =
    (documents: () => Promise<unknown>, threadBody: () => Promise<unknown> = async () => thread) =>
    (path: string) =>
      path.endsWith('/documents') ? documents() : threadBody();

  it('requests the thread and its documents, and joins them', async () => {
    const paths: string[] = [];
    const detail = await loadConversationDetail('t 1', (path) => {
      paths.push(path);
      return fetcher(async () => docs)(path);
    });
    expect(paths.sort()).toEqual(['/api/v2/threads/t%201', '/api/v2/threads/t%201/documents']);
    expect(detail.messages[1]!.content).toBe('A [1].');
    expect(detail.messages[1]!.citations).toHaveLength(1);
  });

  it('still loads the conversation when the documents request fails', async () => {
    const error = Object.assign(new Error('Not Found'), { status: 404 });
    const detail = await loadConversationDetail('t', fetcher(() => Promise.reject(error)));
    expect(detail.messages[1]!.content).toBe('A.');
    expect(detail.messages[1]!.citations).toEqual([]);
  });

  it('fails when the thread request fails, even if documents succeed', async () => {
    await expect(
      loadConversationDetail(
        't',
        fetcher(async () => docs, () => Promise.reject(new Error('down'))),
      ),
    ).rejects.toThrow('down');
  });
});
