/**
 * Loading a question set and failing loudly on a malformed one: a set that silently
 * dropped a question would make two runs look comparable when they are not.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseRef } from './quran-refs';
import { LANGUAGES } from './score-language';
import type { QuestionSet } from './types';

const turnSchema = z.strictObject({
  text: z.string().min(1),
  expectRefs: z
    .array(z.string().refine((r) => parseRef(r) !== null, 'must be a Quran reference like 52:48 or 94:5-6'))
    .optional(),
});

const questionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/, 'ids are lowercase letters, digits and hyphens'),
  category: z.string().min(1),
  language: z.enum(LANGUAGES),
  turns: z.array(turnSchema).min(1),
  note: z.string().optional(),
});

const setSchema = z
  .strictObject({
    id: z.string().min(1),
    version: z.number().int().positive(),
    description: z.string(),
    questions: z.array(questionSchema).min(1),
  })
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    for (const q of set.questions) {
      if (seen.has(q.id)) ctx.addIssue({ code: 'custom', message: `duplicate question id "${q.id}"` });
      seen.add(q.id);
    }
  });

export interface LoadedQuestionSet {
  set: QuestionSet;
  /** sha256 of the file's bytes: two runs with the same hash asked the same questions. */
  sha256: string;
}

export function parseQuestionSet(json: string): QuestionSet {
  const result = setSchema.safeParse(JSON.parse(json));
  if (!result.success) throw new Error(`Question set is not valid:\n${result.error.toString()}`);
  return result.data;
}

export function loadQuestionSet(path: string): LoadedQuestionSet {
  const text = readFileSync(path, 'utf8');
  return { set: parseQuestionSet(text), sha256: createHash('sha256').update(text).digest('hex') };
}
