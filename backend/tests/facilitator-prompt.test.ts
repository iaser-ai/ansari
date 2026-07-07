import { describe, it, expect } from 'vitest';
import { FACILITATOR_SYSTEM_PROMPT } from '../lib/ai/prompts/facilitator';

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
