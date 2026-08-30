import type { SuggestedTopic } from '@/lib/api/types';

/**
 * Suggested questions are a STATIC, client-side list.
 *
 * `apps/api` has no suggested-questions endpoint and will not get one for this
 * prototype, so there is nothing to fetch and nothing to hunt for. The home
 * screen flattens these topics into the chip shelf / sample lines. Edit this
 * array to change the suggestions; no server round-trip is involved.
 */
export const SUGGESTED_TOPICS: SuggestedTopic[] = [
  {
    topic: 'Prayer',
    questions: [
      'How do I perform wudu correctly?',
      'What should I recite in the different parts of salah?',
      'Can I combine prayers when travelling?',
    ],
  },
  {
    topic: "Qur'an",
    questions: [
      'What is the meaning of Surah Al-Fatihah?',
      'How should I begin memorising the Qur’an?',
    ],
  },
  {
    topic: 'Everyday life',
    questions: [
      'What does Islam say about kindness to parents?',
      'How do I give zakat, and who is eligible to receive it?',
    ],
  },
];
