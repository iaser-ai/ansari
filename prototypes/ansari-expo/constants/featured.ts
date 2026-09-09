/**
 * Recently featured — the podcasts, talks, papers and writing about
 * Ansari, kept as a plain list so adding one is a single entry here.
 *
 * Deliberately local and static. There is no feed to scrape and no API
 * to call: a press list changes a few times a year, and a page that
 * fetches one at runtime can only be slower and less certain than a
 * page that already knows.
 *
 * Everything here was opened and read before it was listed. Searching
 * for "Ansari" turns up a great many people and one same-named podcast
 * that have nothing to do with this project, so the bar for an entry is
 * that the item itself is about Ansari or about the person who builds
 * it. Two candidates were dropped against that bar:
 *
 *  - The AI Conference's speaker page for Waleed Kadous: a 2023 talk on
 *    running LLMs in production at Anyscale, his day job. Nothing to do
 *    with Ansari.
 *  - The IMAN 2023 day-one recording on YouTube: five and three quarter
 *    hours of unlisted conference video with no way to reach the Ansari
 *    talk inside it. The slides from that same talk are listed instead.
 *
 * Kept newest first, which is the order the page reads them in.
 */
export interface FeaturedItem {
  /** As the piece calls itself. */
  title: string;
  /**
   * Where it appeared, and what kind of thing it is. The kind is
   * carried by these words alone — no badges, no labels, no tags.
   */
  venue: string;
  /** One human line on what is actually in it. */
  description: string;
  /** ISO `YYYY-MM-DD`. The page shows the month and the year. */
  date: string;
  href: string;
}

export const FEATURED: readonly FeaturedItem[] = [
  {
    title: 'The New AI Empires',
    venue: 'The Thinking Muslim — podcast',
    description:
      "An hour with Ansari's author on who is shaping the world's AI, and what that does to education, politics and religious authority.",
    date: '2026-07-17',
    href: 'https://www.youtube.com/watch?v=4tHAm2o1Uyg',
  },
  {
    title: 'Ansari: A Retrieval-Grounded Islamic AI Assistant',
    venue: 'arXiv — paper, with Elsayed, Al Nahas and Haress',
    description:
      'The technical account: how Ansari is built and deployed, and what 140,000 conversations taught the people running it.',
    date: '2026-06-30',
    href: 'https://arxiv.org/abs/2608.20390',
  },
  {
    title: 'Islam and AI',
    venue: 'Belief in the Future — podcast, hosted by DZ Kalman',
    description:
      'A conversation about how a faith without a single authority is settling on its norms for AI, with the maker of Ansari.',
    date: '2026-06-26',
    href: 'https://www.timesofisrael.com/spotlight/islam-and-ai-w-waleed-kadous',
  },
  {
    title: 'How Islam Helps Us Think and Work in the Age of AI',
    venue: 'Productive Muslim — essay, with Mohammed Faris',
    description:
      "Working with AI as something entrusted to you, and giving part of the time it frees back to the ummah — Ansari as one author's example.",
    date: '2026-05-04',
    href: 'https://productivemuslim.com/age-of-ai/',
  },
  {
    title: 'Faith and Algorithms',
    venue: 'MuslimMatters — essay',
    description:
      'An argument for an Islamic ethics of AI, which takes Ansari as its worked example of the principles in code.',
    date: '2025-12-30',
    href: 'https://muslimmatters.org/2025/12/30/can-you-fatwah-shop-with-ai/',
  },
  {
    title: 'Lessons learned building a practical AI assistant',
    venue: 'Medium — written by Waleed Kadous',
    description:
      'An early account of the first year of Ansari: what it was for, what surprised him, and what he would do differently.',
    date: '2024-02-29',
    href: 'https://waleedk.medium.com/what-ive-learned-building-a-real-ai-assistant-5d520b0e6a46',
  },
  {
    title: 'Ansari: Practical experiences with an LLM-based Islamic Assistant',
    venue:
      'IMAN 2023, the International Conference on Islamic Applications in Computer Science and Technologies — conference talk',
    description:
      "Slides from Ansari's first conference talk: how it was assembled, and what its first months of questions showed.",
    date: '2023-12-04',
    href: 'https://www.slideshare.net/slideshow/ansari-practical-experiences-with-an-llmbased-islamic-assistant/264284588',
  },
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The month and year, read straight off the ISO string rather than
 * through `Date`: a bare `YYYY-MM-DD` is parsed as UTC and printed in
 * the reader's zone, which quietly moves a first-of-the-month entry
 * into the month before.
 */
export function featuredMonth(date: string): string {
  const [year, month] = date.split('-');
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : year;
}

/** The year alone, for the column an entry hangs from. */
export function featuredYear(date: string): string {
  return date.slice(0, 4);
}
