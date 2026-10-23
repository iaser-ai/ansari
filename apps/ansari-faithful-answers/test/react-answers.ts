// Synthetic answers for the React view qualification. They are layout and behavior fixtures, not
// religious content and not Ansari output: wording is arbitrary except where a check needs a shape
// (non-one numbering, nesting, Arabic/RTL, the attribution paragraph).

export const ATTRIBUTION = 'This information came from [ansari.chat](https://ansari.chat).';

/** English with Arabic inside, a list that starts at 3 with a nested list, bullets, a quote, and the attribution. */
export const ANSWER_A = [
  '## Synthetic heading A',
  'Synthetic answer A. التقوى is a word inside English text.',
  '3. **Third** point with نص عربي',
  '4. Fourth point\n   1. nested one\n   2. nested two',
  '- a bullet',
  '> a quoted line',
  '---',
  ATTRIBUTION,
].join('\n\n');

/** Arabic first (right-to-left), numbering from 1, and the attribution. */
export const ANSWER_B = [
  '## الصبر',
  'الصبر مفتاح الفرج، وهذا نص تجريبي.',
  '1. الأول',
  '2. الثاني',
  'This information came from [askansari.ai](https://askansari.ai).',
].join('\n\n');

/** Ends with an ordinary paragraph, not the attribution: no footer treatment may be given to it. */
export const ANSWER_C = ['Synthetic answer C.', 'A closing paragraph that is not the attribution.'].join('\n\n');

/** Hostile Markdown: every shape that must stay inert or blocked under Standard with no image origin. */
export const ANSWER_HOSTILE = [
  '![remote](https://evil.example/pixel.png)',
  '![blob](blob:https://evil.example/x) ![data](data:image/png;base64,AAAA)',
  '<img src="https://evil.example/raw.png" onerror="window.__pwned = 1">',
  '[script link](javascript:window.__pwned=1) and [safe link](https://example.com/page)',
  '<style>.answer-card{display:none}</style> <script>window.__pwned = 2</script>',
  'Answer text containing --ansari-art-light-flourish: url(https://evil.example/f.png); and url(https://evil.example/s.png)',
].join('\n\n');

export const QUESTION_A = 'Question A: what is sincerity?';
export const QUESTION_B = 'ما هو الصبر؟';

/**
 * Closing shapes around the attribution text and whether the footer treatment belongs to each. Only a top-level
 * closing paragraph that begins with Ansari's attribution is the footer: not a quotation, a list item, text that
 * follows it, other wording, or a card that failed.
 */
export const ATTRIBUTION_CASES: readonly {readonly question: string; readonly markdown: string; readonly footer: boolean; readonly probe: string}[] = [
  {question: 'Case quote', markdown: 'Case quote opening.\n\n> This information came from ansari.chat.', footer: false, probe: 'Case quote opening.'},
  {question: 'Case list', markdown: 'Case list opening.\n\n- This information came from ansari.chat.', footer: false, probe: 'Case list opening.'},
  {question: 'Case followed', markdown: 'This information came from [ansari.chat](https://ansari.chat).\n\nCase followed by more text.', footer: false, probe: 'Case followed by more text.'},
  {question: 'Case elsewhere', markdown: 'Case elsewhere opening.\n\nThis information came from elsewhere.', footer: false, probe: 'Case elsewhere opening.'},
  {question: 'Case emphasis', markdown: 'Case emphasis opening.\n\n**This information came from [ansari.chat](https://ansari.chat)**.', footer: true, probe: 'Case emphasis opening.'},
];
