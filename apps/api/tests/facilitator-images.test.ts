import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Image attachments in the facilitator — spec 211.
 *
 * Images ride on the CURRENT user turn of every Gemini call in the request
 * (first call, tool continuation, empty-final retry, synthesis) and nowhere
 * else. Stored placeholders on earlier messages become a "no longer available"
 * note. Image turns never go to Inkling (it cannot see images).
 *
 * Scaffolding mirrors tests/facilitator-continuation.test.ts, with Inkling
 * mocked as configured so a wrongly-engaged rung would show up as a call.
 */

type AnyEvent = { type: string; data?: unknown; response?: unknown };
type Content = { role: string; parts: Array<Record<string, unknown>> };
type Call = { message: unknown; options: { history?: Content[] } & Record<string, unknown> };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  scripts: [] as Array<() => AsyncGenerator<AnyEvent>>,
  inklingCalls: [] as Call[],
  primaryBackend: 'gemini' as 'gemini' | 'inkling',
}));

function doneResponse(text: string, toolCalls: Array<{ name: string; args: unknown }> = []) {
  return {
    text,
    toolCalls,
    rawPayload: { role: 'model', parts: text ? [{ text }] : [] },
    allParts: text ? [{ text }] : [],
    hasThinking: false,
    usage: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 },
    finishReason: 'STOP',
  };
}

function textRound(text: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    if (text) yield { type: 'text', data: text };
    yield { type: 'done', response: doneResponse(text) };
  };
}

function toolRound(name: string): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'tool_call', data: { name, args: { query: 'q' } } };
    yield { type: 'done', response: doneResponse('', [{ name, args: { query: 'q' } }]) };
  };
}

function emptyRound(): () => AsyncGenerator<AnyEvent> {
  return async function* () {
    yield { type: 'done', response: doneResponse('') };
  };
}

function throwingRound(): () => AsyncGenerator<AnyEvent> {
  // eslint-disable-next-line require-yield
  return async function* () {
    throw new Error('vertex 500');
  };
}

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: {
    get gemini() {
      return { model: 'primary-model', fallbackModel: 'fallback-model' };
    },
    get inkling() {
      return { apiKey: 'k', model: 'thinkingmachines/Inkling', timeoutMs: 180000 };
    },
    get primaryBackend() {
      return h.primaryBackend;
    },
  },
}));

vi.mock('@/lib/ai/gemini-client', () => ({
  streamGemini: vi.fn((message: unknown, options: Call['options']) => {
    // Snapshot the history: the loop mutates its array after the call.
    h.calls.push({ message, options: { ...options, history: structuredClone(options.history ?? []) } });
    const script = h.scripts.shift();
    return (script ?? textRound('default answer'))();
  }),
}));

vi.mock('@/lib/ai/inkling-client', () => ({
  isInklingConfigured: vi.fn(() => true),
  streamInkling: vi.fn((message: unknown, options: Call['options']) => {
    h.inklingCalls.push({ message, options });
    return textRound('answer from inkling')();
  }),
}));

vi.mock('@/lib/tools', () => ({
  getGeminiToolDescriptions: () => [{ name: 'search_quran' }],
  createToolMap: () =>
    new Map([
      [
        'search_quran',
        {
          run: async () => ({
            content: 'result',
            documents: [
              {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: 'doc' },
                title: 'search_quran',
                context: 'src',
                citations: { enabled: false },
              },
            ],
          }),
        },
      ],
    ]),
}));

import { runFacilitator, imageUnavailableNote, type Message } from '../lib/facilitator/agent';
import type { ImageAttachment } from '../lib/attachments';

const IMAGE: ImageAttachment = { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAE=' };
const IMAGE_PART = { inlineData: { mimeType: 'image/png', data: IMAGE.data } };

function user(text: string, images = 0): Message {
  return {
    role: 'user',
    content: [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...Array.from({ length: images }, () => ({
        type: 'image' as const,
        status: 'not_stored' as const,
        media_type: 'image/png' as const,
      })),
    ],
  };
}

function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], rawPayload: { role: 'model', parts: [{ text }] } };
}

async function collect(gen: AsyncGenerator<{ type: string }>) {
  const events: Array<{ type: string; data?: unknown; rawPayload?: unknown }> = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** Every inlineData part in a Content list. */
function inlineParts(history: Content[]) {
  return history.flatMap((c) => c.parts.filter((p) => 'inlineData' in p));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.scripts = [];
  h.inklingCalls = [];
  h.primaryBackend = 'gemini';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('current turn carries the images (spec 211)', () => {
  it('first call sends text + inlineData parts; earlier history has no inlineData', async () => {
    h.scripts = [textRound('It is a mosque.')];
    const history = [user('earlier'), assistant('earlier answer'), user('What is this?', 1)];

    const events = await collect(runFacilitator(history, undefined, { images: [IMAGE] }));

    expect(events.map((e) => e.type)).toContain('done');
    expect(h.calls[0].message).toEqual([{ text: 'What is this?' }, IMAGE_PART]);
    expect(inlineParts(h.calls[0].options.history!)).toEqual([]);
  });

  it('a text-only turn still sends a plain string (unchanged)', async () => {
    await collect(runFacilitator([user('What is sabr?')]));
    expect(h.calls[0].message).toBe('What is sabr?');
  });

  it('an image-only turn sends only the image parts', async () => {
    await collect(runFacilitator([user('', 2)], undefined, { images: [IMAGE, IMAGE] }));
    expect(h.calls[0].message).toEqual([IMAGE_PART, IMAGE_PART]);
  });

  it('after a tool round the images enter history with the user turn, once', async () => {
    h.scripts = [toolRound('search_quran'), textRound('Answer.')];

    await collect(runFacilitator([user('What is this?', 1)], undefined, { images: [IMAGE] }));

    expect(h.calls).toHaveLength(2);
    const continuationHistory = h.calls[1].options.history!;
    expect(continuationHistory[0]).toEqual({ role: 'user', parts: [{ text: 'What is this?' }, IMAGE_PART] });
    expect(inlineParts(continuationHistory)).toHaveLength(1);
  });

  it('an empty-final retry re-sends the images', async () => {
    h.scripts = [emptyRound(), textRound('Recovered.')];

    await collect(runFacilitator([user('What is this?', 1)], undefined, { images: [IMAGE] }));

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].message).toEqual([{ text: 'What is this?' }, IMAGE_PART]);
  });

  it('the synthesis pass sees the images', async () => {
    h.scripts = [textRound('Synthesized.')];

    // Reserve >= budget puts the soft deadline in the past: straight to synthesis.
    await collect(
      runFacilitator([user('What is this?', 1)], undefined, { images: [IMAGE], budgetMs: 30_000, reserveMs: 30_000 })
    );

    const synthesisHistory = h.calls[0].options.history!;
    expect(synthesisHistory.at(-1)).toEqual({ role: 'user', parts: [{ text: 'What is this?' }, IMAGE_PART] });
  });

  it('the persisted payload never carries the user parts', async () => {
    h.scripts = [toolRound('search_quran'), textRound('Answer.')];
    const events = await collect(runFacilitator([user('What is this?', 1)], undefined, { images: [IMAGE] }));
    const done = events.find((e) => e.type === 'done')!;
    expect(JSON.stringify(done)).not.toContain(IMAGE.data);
  });
});

describe('later turns: placeholder becomes a note (spec 211)', () => {
  it('a past image message is replaced by the unavailable note, no inlineData', async () => {
    const history = [user('What is this?', 2), assistant('A mosque.'), user('Which city?')];

    await collect(runFacilitator(history));

    const sent = h.calls[0].options.history!;
    expect(sent[0]).toEqual({
      role: 'user',
      parts: [{ text: 'What is this?' }, { text: imageUnavailableNote(2) }],
    });
    expect(inlineParts(sent)).toEqual([]);
  });

  it('an image-only past message keeps the previous assistant turn in history', async () => {
    // Before spec 211 the image-only message produced no Content, so the
    // slice(0, -1) that removes the current turn dropped 'A mosque.' instead.
    const history = [user('', 1), assistant('A mosque.'), user('Which city?')];

    await collect(runFacilitator(history));

    const sent = h.calls[0].options.history!;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ role: 'user', parts: [{ text: imageUnavailableNote(1) }] });
    expect(sent[1]).toEqual({ role: 'model', parts: [{ text: 'A mosque.' }] });
    expect(h.calls[0].message).toBe('Which city?');
  });

  it('the note names the count and says the images are gone', () => {
    expect(imageUnavailableNote(1)).toMatch(/an image.*no longer available/);
    expect(imageUnavailableNote(3)).toMatch(/3 images.*no longer available/);
  });
});

describe('image turns never reach Inkling (spec 211)', () => {
  it('a twice-empty final errors instead of escalating to the Inkling rung', async () => {
    h.scripts = [emptyRound(), emptyRound()];

    const events = await collect(runFacilitator([user('What is this?', 1)], undefined, { images: [IMAGE] }));

    expect(h.inklingCalls).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('error');
  });

  it('a terminal Gemini error is not rescued on Inkling', async () => {
    h.scripts = [throwingRound()];

    const events = await collect(runFacilitator([user('What is this?', 1)], undefined, { images: [IMAGE] }));

    expect(h.inklingCalls).toHaveLength(0);
    expect(events.at(-1)?.type).toBe('error');
  });

  it('control: the same error on a text-only turn IS rescued (the gate is the images)', async () => {
    h.scripts = [throwingRound()];

    await collect(runFacilitator([user('What is sabr?')]));

    expect(h.inklingCalls).toHaveLength(1);
  });

  it('an image turn on an Inkling-primary request errors before any model call', async () => {
    h.primaryBackend = 'inkling';

    const events = await collect(runFacilitator([user('What is this?', 1)], undefined, { images: [IMAGE] }));

    expect(events).toEqual([{ type: 'error', data: 'Image attachments are not available right now' }]);
    expect(h.calls).toHaveLength(0);
    expect(h.inklingCalls).toHaveLength(0);
  });
});
