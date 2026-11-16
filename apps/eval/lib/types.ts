/**
 * The shapes the harness reads and writes: the question set, and the results file a run
 * leaves behind (inputs, model ids, git revision, date, raw answers, scores).
 */
import type { ModelProvenance, ToolCallRecord } from '@/db/schema/messages';
import type { GeminiUsageMetadata } from '@/lib/ai/gemini-client';
import type { HadithScore } from './score-hadith';
import type { LanguageScore } from './score-language';
import type { QuranScore } from './score-quran';

export interface QuestionTurn {
  text: string;
  /** Quran references the answer to this turn should quote, e.g. ["52:48"]. */
  expectRefs?: string[];
}

export interface Question {
  id: string;
  category: string;
  /** Language the question is asked in, and so the answer must be in. */
  language: string;
  turns: QuestionTurn[];
  /** Why the question is in the set. */
  note?: string;
}

export interface QuestionSet {
  id: string;
  version: number;
  description: string;
  questions: Question[];
}

/** A console.warn / console.error line the facilitator or the Gemini client wrote during a request. */
export interface LogEvent {
  level: 'warn' | 'error';
  message: string;
}

export interface TurnTiming {
  /** Milliseconds to the first event of any kind (a tool call shows the request is alive). */
  firstEventMs: number | null;
  /** Milliseconds to the first visible text: time to first token, as a user sees it. */
  firstTextMs: number | null;
  totalMs: number;
}

export interface ToolUseScore {
  calls: number;
  byName: Record<string, number>;
  /** Calls that did not return a source: degraded, skipped, refused, unknown. */
  notOk: number;
  searchedQuran: boolean;
  searchedHadith: boolean;
}

/** Things the facilitator did on the way to the answer, read from its own log lines. */
export interface RequestEvents {
  emptyFinalRetries: number;
  transientRetries: number;
  repetitionCuts: number;
  /** The answer is a best-effort synthesis written after the request budget ran out. */
  budgetSynthesis: boolean;
}

export interface TurnScores {
  quran: QuranScore;
  hadith: HadithScore;
  language: LanguageScore;
  tools: ToolUseScore;
  /** Scripture was quoted or cited in a turn where the matching search tool never returned a result. */
  scriptureWithoutSearch: { quran: boolean; hadith: boolean };
  events: RequestEvents;
  /** Null when the model has no price in models.json or the turn reported no usage. */
  costUsd: number | null;
}

export interface TurnRecord {
  model: string;
  questionId: string;
  category: string;
  language: string;
  repeat: number;
  /** 0 for the first turn of a conversation. */
  turn: number;
  question: string;
  expectRefs?: string[];
  /**
   * `ok`: the facilitator finished with an answer. `error`: it ended with an error event
   * (the message is in `error`). `skipped`: an earlier turn of this conversation errored,
   * so this one was never asked.
   */
  outcome: 'ok' | 'error' | 'skipped';
  error?: string;
  /** The visible text, exactly as streamed. On an error, whatever arrived before it. */
  answer: string;
  startedAt: string;
  timing: TurnTiming;
  /** Tokens summed over every model call of the turn. Null on an error (the facilitator reports none). */
  usage: GeminiUsageMetadata | null;
  provenance: ModelProvenance | null;
  toolCalls: ToolCallRecord[];
  log: LogEvent[];
  /** Source text looked up for references the answer names that no search returned. */
  lookups: Record<string, { ar: string; en: string } | null>;
  scores?: TurnScores;
}

export interface ModelPrice {
  /** US dollars per million input tokens; null when not known. */
  inputPerMTok: number | null;
  /** US dollars per million output tokens (visible and thinking); null when not known. */
  outputPerMTok: number | null;
  source?: string;
  /** True only when a person has checked the numbers against the Vertex AI pricing page. */
  confirmed?: boolean;
  /** A weaker check than `confirmed`, in a few words: shown beside the NO in the report. */
  checked?: string;
  /** A price change already announced: the report also costs the run at this price. */
  next?: { from: string; inputPerMTok: number; outputPerMTok: number };
}

export interface RunFile {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  git: { revision: string; dirty: boolean };
  models: string[];
  /** The first model: what the others are compared against. */
  baseline: string;
  questionSet: { id: string; version: number; sha256: string; questions: number; turns: number };
  /** sha256 of the facilitator system prompt the run used. */
  promptSha256: string;
  options: { repeats: number; concurrency: number; only?: string[] };
  prices: Record<string, ModelPrice>;
  records: TurnRecord[];
}
