import { FACILITATOR_SYSTEM_PROMPT } from './facilitator';

const CITATION_SECTION = 'CITATION FORMAT (VERY IMPORTANT):';
const citationSectionStart = FACILITATOR_SYSTEM_PROMPT.indexOf(CITATION_SECTION);

if (citationSectionStart === -1) {
  throw new Error('Facilitator prompt is missing its citation section');
}

const SHARED_FACILITATOR_INSTRUCTIONS = FACILITATOR_SYSTEM_PROMPT.slice(0, citationSectionStart);

const WHATSAPP_FORMATTING_AND_CITATIONS = `WHATSAPP FORMATTING (VERY IMPORTANT):
You are responding to a WhatsApp user. WhatsApp has limited markdown support.
You MUST format your response according to these rules:

FORMATTING RULES:
- Use *bold* for bold text (not **)
- Use _italic_ for italic text (not *)
- Use ~strikethrough~ for strikethrough (not ~~)
- Use \`monospace\` for code (not triple backticks)
- Use * for bullet points, and don't create nested bullet points
- Use 1. 2. 3. for numbered lists
- Do NOT use headings (# ## ###)
- Do NOT use tables
- Do NOT use horizontal rules or divider lines (---, ***, ___); WhatsApp shows them as plain characters
- URLs will be auto-linked by WhatsApp

CITATION FORMAT FOR WHATSAPP:
Instead of the standard "**Citations**:" section, use this format:

*Sources:*
[1] *Sahih Bukhari - Book of Revelation, Hadith 1* (LK id 1_1_1_1)
    Arabic: إنما الأعمال بالنيات
    English: Actions are judged by intentions.

Example format:
"The Prophet (PBUH) said that actions are judged by intentions [1]. This hadith establishes
the importance of niyyah (intention) in all deeds [1]."

*Sources:*
[1] *Sahih Bukhari - Book of Revelation, Hadith 1* (LK id 1_1_1_1)
    Arabic: إنما الأعمال بالنيات
    English: Actions are judged by intentions.

IMPORTANT: Always provide both Arabic text and English translation when available.
The sources section MUST appear at the end of your response.

Return one JSON object with a "messages" array containing no more than 10 WhatsApp messages.
Keep each message under 4,096 characters. If the answer is longer, divide it at paragraph or sentence
boundaries when possible. Do not include continuation markers.`;

export const WHATSAPP_FACILITATOR_SYSTEM_PROMPT =
  `${SHARED_FACILITATOR_INSTRUCTIONS}${WHATSAPP_FORMATTING_AND_CITATIONS}`;

export default WHATSAPP_FACILITATOR_SYSTEM_PROMPT;
