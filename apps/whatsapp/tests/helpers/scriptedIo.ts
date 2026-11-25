/**
 * Test helpers for the operator script: a keyboard that types scripted answers, a screen that keeps what was printed, and a
 * Meta stand-in that answers from a list and records every call.
 *
 * Python counterpart: none (the legacy script had no tests). It stands in for `builtins.input` and `requests`.
 */
import type { Io } from '../../scripts/terminalIo';

export interface ScriptedIo extends Io {
  /** Every printed line, in order; a `print` of text with line breaks counts as several lines, as on a screen. */
  lines: string[];
  /** Every prompt shown, in order, with whether it was a hidden one. */
  prompts: Array<{ text: string; hidden: boolean }>;
  /** Answers not yet used. */
  remaining: () => number;
}

/** Answers are used one per question, in order. `null` is "no more input". Running out of answers is a test error. */
export function scriptedIo(answers: Array<string | null>): ScriptedIo {
  const queue = [...answers];
  const lines: string[] = [];
  const prompts: ScriptedIo['prompts'] = [];

  function next(prompt: string, hidden: boolean): Promise<string | null> {
    prompts.push({ text: prompt, hidden });
    if (queue.length === 0) throw new Error(`the script asked ${JSON.stringify(prompt)} but the test has no answer left`);
    return Promise.resolve(queue.shift() ?? null);
  }

  return {
    lines,
    prompts,
    remaining: () => queue.length,
    print: (text) => {
      lines.push(...text.split('\n'));
    },
    ask: (prompt) => next(prompt, false),
    askHidden: (prompt) => next(prompt, true),
  };
}

export interface RecordedMetaCall {
  method: string;
  path: string;
  query: string;
  bearer: boolean;
  redirect: NonNullable<Parameters<typeof fetch>[1]>['redirect'];
}

export type MetaAnswer = Response | Error;

/** Answers Meta calls from a list, in order, and records them (path without the host and version). */
export function metaStandIn(token: string, version: string, answers: MetaAnswer[]): { fetch: typeof fetch; calls: RecordedMetaCall[] } {
  const calls: RecordedMetaCall[] = [];
  const remaining = [...answers];
  const standIn = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname.replace(`/${version}`, ''),
      query: [...url.searchParams.entries()].map(([key, value]) => `${key}=${value}`).join('&'),
      bearer: headers.get('authorization') === `Bearer ${token}`,
      redirect: init?.redirect,
    });
    const answer = remaining.shift();
    if (answer === undefined) throw new Error(`unexpected call ${init?.method ?? 'GET'} ${url.pathname}: the test has no answer left`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch: standIn as typeof fetch, calls };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
