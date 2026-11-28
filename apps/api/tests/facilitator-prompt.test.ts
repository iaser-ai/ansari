import { describe, it, expect } from 'vitest';
import { FACILITATOR_SYSTEM_PROMPT } from '../lib/ai/prompts/facilitator';
import { WHATSAPP_FACILITATOR_SYSTEM_PROMPT } from '../lib/ai/prompts/facilitator-whatsapp';

// The facilitator must still surface crisis resources when a user shows genuine
// suicidality or self-harm intent — but ONLY then. An earlier version of this
// block (ported from ansari-backend cb2f73c) fired on any "hopelessness" or
// "anguish" and told the model not to answer the user's question, which caused
// ~93% false-positive helpline firings on fiqh/dua/theodicy questions and
// suppressed the verses/hadith users were asking for. These tests lock in BOTH
// the safety net (numbers present) and the guardrails that keep it narrow.
describe('Facilitator system prompt — distress handling', () => {
  // --- Safety net: crisis resources must remain present ---
  it('includes the Naseeha helpline', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toContain('Naseeha');
    expect(FACILITATOR_SYSTEM_PROMPT).toContain('1-866-627-3342');
  });

  it('includes the Amala Youth Hopeline', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toContain('Amala Youth Hopeline');
    expect(FACILITATOR_SYSTEM_PROMPT).toContain('1-855-952-6252');
  });

  it('refers users to their local imam', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/local imam/i);
  });

  it('acknowledges the model is not qualified for crisis counseling', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/not\s+qualified/i);
  });

  // --- Guardrails: keep the trigger narrow and non-suppressive ---
  it('restricts the crisis path to explicit suicidal / self-harm intent', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/acute mental-health crisis/i);
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/want to die/i);
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/kill myself/i);
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/hurt myself/i);
  });

  it('does not treat ordinary hardship, grief, or theodicy as a crisis', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(
      /do not treat ordinary emotional or spiritual struggle as a crisis/i
    );
    // Hardship/theodicy questions must still get full theological depth.
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/names and\s+attributes of Allah/i);
  });

  it('adds resources in addition to — never instead of — the Islamic answer', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/in addition\s+to \(never instead of\)/i);
  });

  it('offers the helplines at most once and respects the user declining them', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/at most once per conversation/i);
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/asks you not to bring\s+them up again/i);
  });
});

// Spec 43: the prompt must use the EXACT registered tool names and guide the model
// on handling a "temporarily unavailable" tool result (graceful degradation).
describe('Facilitator system prompt — tool names & degradation guidance', () => {
  it('uses the exact registered tool name search_tafsir_encyclopedia (not the stale search_tafsir)', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toContain('search_tafsir_encyclopedia');
    // The old stale bare "search_tafsir:" list entry must be gone.
    expect(FACILITATOR_SYSTEM_PROMPT).not.toMatch(/- search_tafsir:/);
  });

  it('lists all four current tool names', () => {
    for (const name of ['search_quran', 'search_hadith', 'search_mawsuah', 'search_tafsir_encyclopedia']) {
      expect(FACILITATOR_SYSTEM_PROMPT).toContain(name);
    }
  });

  it('instructs the model to continue when a source is temporarily unavailable', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/temporarily unavailable/i);
    expect(FACILITATOR_SYSTEM_PROMPT).toMatch(/do not retry that tool/i);
  });
});

// Issue #403: on gemini-4-hydrogen the section headed "For questions outside Islamic
// knowledge domain:" produced flat refusals of everyday advice questions ("I
// specialize in Islamic topics... reformulate your question"): 9 of 840 first
// answers in taqwabench's JaleesBench run on staging, none on the June production
// run with the same text. PR #405 kept the section and added one sentence after it
// saying such questions are in scope.
//
// Issue #407 replaces the whole section with one paragraph, in two steps:
// - The #405 sentence ended "and bring in the Islamic perspective where it is
//   relevant", which the model read as an afterthought: on a request that itself
//   raises an Islamic concern (JLS-116, pricing a mural of realistic human figures)
//   it gave the full help first and the Islamic view second. The owner's wording
//   opens with the Islamic perspective applying to every question.
// - With the heading and its four numbered lines still above that wording, the
//   model still declined unrelated requests (a Python question, 3 of 3 on
//   gemini-4-hydrogen). The owner had them removed, so nothing in the prompt now
//   names a class of question that is outside Ansari's domain.
describe('Facilitator system prompt — the Islamic perspective on every question', () => {
  const PARAGRAPH =
    'Islam is an all-encompassing way of life, so consider the Islamic perspective on every question, whatever the topic. Requests for advice or guidance on everyday life (work, family, money, personal decisions) are not outside this domain: answer what was asked, fully and practically, in light of that perspective.';
  const REMOVED_LINES = [
    'For questions outside Islamic knowledge domain:',
    '1. Politely explain that you are specialized in Islamic topics',
    '2. Suggest reformulating the question to relate to Islamic perspective if relevant',
    '3. For purely secular topics, acknowledge the limits of your expertise',
    '4. Avoid speculation on topics outside your knowledge base',
  ];
  // The lines on either side of the old section, which must now sit on either side
  // of the paragraph with one blank line between.
  const LINE_BEFORE = 'briefly note in your response that the source could not be consulted this time.';
  const LINE_AFTER = 'Questions about hardship, trials, grief, loss, loneliness, anxiety, anger,';

  it('says the paragraph once', () => {
    expect(FACILITATOR_SYSTEM_PROMPT.split(PARAGRAPH)).toHaveLength(2);
  });

  it('puts the paragraph where the section was, as a paragraph of its own', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).toContain(`${LINE_BEFORE}\n\n${PARAGRAPH}\n\n${LINE_AFTER}`);
  });

  it.each(REMOVED_LINES)('no longer contains the line %j', (line) => {
    expect(FACILITATOR_SYSTEM_PROMPT).not.toContain(line);
  });

  it('keeps none of the removed instructions in other words', () => {
    // The text after each list number, and the two phrases that carried the refusal.
    for (const line of REMOVED_LINES) {
      expect(FACILITATOR_SYSTEM_PROMPT).not.toContain(line.replace(/^\d+\. /, ''));
    }
    expect(FACILITATOR_SYSTEM_PROMPT).not.toMatch(/outside Islamic knowledge domain/i);
    expect(FACILITATOR_SYSTEM_PROMPT).not.toMatch(/specialized in Islamic topics/i);
  });

  it('no longer makes the Islamic perspective conditional on relevance', () => {
    expect(FACILITATOR_SYSTEM_PROMPT).not.toContain('where it is relevant');
    expect(FACILITATOR_SYSTEM_PROMPT.split('Requests for advice or guidance on everyday life')).toHaveLength(2);
  });
});

describe('WhatsApp facilitator prompt', () => {
  it('reuses the main prompt before replacing only its citation and formatting section', () => {
    const sharedPromptEnd = FACILITATOR_SYSTEM_PROMPT.indexOf('CITATION FORMAT (VERY IMPORTANT):');
    const whatsappFormattingStart = WHATSAPP_FACILITATOR_SYSTEM_PROMPT.indexOf('WHATSAPP FORMATTING (VERY IMPORTANT):');

    expect(sharedPromptEnd).toBeGreaterThan(0);
    expect(WHATSAPP_FACILITATOR_SYSTEM_PROMPT.slice(0, whatsappFormattingStart)).toBe(
      FACILITATOR_SYSTEM_PROMPT.slice(0, sharedPromptEnd),
    );
    expect(WHATSAPP_FACILITATOR_SYSTEM_PROMPT).toContain('Return one JSON object with a "messages" array');
  });

  it('inherits the latest shared guidance rather than the obsolete outside-domain refusal', () => {
    expect(WHATSAPP_FACILITATOR_SYSTEM_PROMPT).toContain(
      'Requests for advice or guidance on everyday life (work, family, money, personal decisions) are not outside this domain',
    );
    expect(WHATSAPP_FACILITATOR_SYSTEM_PROMPT).not.toContain('For questions outside Islamic knowledge domain:');
  });
});
