/**
 * Running a question set through the facilitator, one conversation at a time.
 *
 * The facilitator is injected, so the tests drive this with a scripted one and the CLI
 * (`run.ts`) passes the real `runFacilitator`, pinned to the model under test. History
 * between the turns of a conversation is built the way the chat route builds it: the
 * streamed text of each answer, with the final model turn's raw payload riding along.
 */
import type { ToolCallRecord, ModelProvenance, ContentBlock } from '@/db/schema/messages';
import type { GeminiUsageMetadata, Content } from '@/lib/ai/gemini-client';
import { withLogCapture } from './capture';
import { refsToLookUp } from './score-quran';
import { turnSources } from './sources';
import type { Question, TurnRecord } from './types';

/** The part of `Message` (lib/facilitator/agent.ts) the harness builds. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  rawPayload?: Content | null;
}

/** The part of `FacilitatorStreamEvent` the harness reads. */
export interface FacilitatorEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'done' | 'error';
  data: string;
  usage?: GeminiUsageMetadata;
  rawPayload?: Content | null;
  toolCalls?: ToolCallRecord[];
  provenance?: ModelProvenance;
}

export interface RunnerDeps {
  /** One facilitator request for `model` over `history`. */
  facilitator: (history: HistoryMessage[], model: string) => AsyncIterable<FacilitatorEvent>;
  /** The source text of one verse (`surah:ayah`), or null when it cannot be had. */
  lookupVerse: (key: string) => Promise<{ ar: string; en: string } | null>;
  now?: () => number;
}

/** No answer names more verses than this that a search did not return; the rest are left unverifiable. */
const MAX_LOOKUPS_PER_TURN = 12;

const userMessage = (text: string): HistoryMessage => ({ role: 'user', content: [{ type: 'text', text }] });

/**
 * Ask every turn of one question, in order, and return a record per turn. A turn that
 * errors ends the conversation: the turns after it are recorded as `skipped`, since
 * their history would be missing an answer.
 */
export async function runConversation(
  deps: RunnerDeps,
  model: string,
  question: Question,
  repeat: number,
): Promise<TurnRecord[]> {
  const now = deps.now ?? Date.now;
  const records: TurnRecord[] = [];
  const history: HistoryMessage[] = [];
  const haveVerses = new Set<string>();
  let failed = false;

  for (const [turn, { text, expectRefs }] of question.turns.entries()) {
    const base = {
      model,
      questionId: question.id,
      category: question.category,
      language: question.language,
      repeat,
      turn,
      question: text,
      ...(expectRefs ? { expectRefs } : {}),
    };
    if (failed) {
      records.push({
        ...base,
        outcome: 'skipped',
        answer: '',
        startedAt: new Date(now()).toISOString(),
        timing: { firstEventMs: null, firstTextMs: null, totalMs: 0 },
        usage: null,
        provenance: null,
        toolCalls: [],
        log: [],
        lookups: {},
      });
      continue;
    }

    history.push(userMessage(text));
    const startedAt = now();
    let answer = '';
    let firstEventMs: number | null = null;
    let firstTextMs: number | null = null;
    let terminal: FacilitatorEvent | null = null;
    let thrown: string | undefined;

    const { log } = await withLogCapture(async () => {
      try {
        for await (const event of deps.facilitator([...history], model)) {
          const at = now() - startedAt;
          firstEventMs ??= at;
          if (event.type === 'text') {
            firstTextMs ??= at;
            answer += event.data;
          } else if (event.type === 'done' || event.type === 'error') {
            terminal = event;
          }
        }
      } catch (error) {
        // The facilitator reports failures as an `error` event; a throw is a harness or
        // configuration fault. Recorded, not swallowed: the turn is an error either way.
        thrown = error instanceof Error ? error.message : String(error);
      }
    });
    const totalMs = now() - startedAt;
    // TypeScript cannot see the assignment inside the closure above.
    const end = terminal as FacilitatorEvent | null;

    const ok = end?.type === 'done' && thrown === undefined;
    const toolCalls = end?.toolCalls ?? [];
    const record: TurnRecord = {
      ...base,
      outcome: ok ? 'ok' : 'error',
      answer,
      startedAt: new Date(startedAt).toISOString(),
      timing: { firstEventMs, firstTextMs, totalMs },
      usage: end?.usage ?? null,
      provenance: end?.provenance ?? null,
      toolCalls,
      log,
      lookups: {},
    };
    if (!ok) {
      record.error = thrown ?? (end?.type === 'error' ? end.data : 'the facilitator ended without a done or error event');
      failed = true;
      records.push(record);
      continue;
    }

    // Fetch the source text of every verse the answer names that no search returned,
    // so a quote written from memory is still checked against a source.
    for (const verse of turnSources(toolCalls).verses) haveVerses.add(verse.key);
    for (const key of refsToLookUp(answer, haveVerses).slice(0, MAX_LOOKUPS_PER_TURN)) {
      record.lookups[key] = await deps.lookupVerse(key);
    }

    history.push({ role: 'assistant', content: [{ type: 'text', text: answer }], rawPayload: end?.rawPayload ?? null });
    records.push(record);
  }
  return records;
}

export interface Job {
  model: string;
  question: Question;
  repeat: number;
}

/** Every (question, model, repeat), question first: the models meet each question side by side. */
export function planJobs(models: string[], questions: Question[], repeats: number): Job[] {
  const jobs: Job[] = [];
  for (const question of questions) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const model of models) jobs.push({ model, question, repeat });
    }
  }
  return jobs;
}

/** Run the jobs with at most `concurrency` conversations in flight. */
export async function runJobs(
  deps: RunnerDeps,
  jobs: Job[],
  concurrency: number,
  onDone?: (job: Job, records: TurnRecord[], done: number) => void,
): Promise<TurnRecord[]> {
  const results: TurnRecord[][] = new Array<TurnRecord[]>(jobs.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      results[index] = await runConversation(deps, job.model, job.question, job.repeat);
      onDone?.(job, results[index], ++done);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
  return results.flat();
}
