// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render } from '@testing-library/react';

// The markdown renderer is exercised through react-native-web (aliased in
// vitest.config.ts) — the same layer the staging web export actually runs on.
// Only the Expo-native modules are mocked out.
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  const chain = { duration: () => chain, reduceMotion: () => chain };
  return {
    default: { View },
    FadeInDown: chain,
    ReduceMotion: { System: 'system' },
  };
});
// SafetyCard pulls @expo/vector-icons (expo-font native module); not under test.
vi.mock('@/components/SafetyCard', () => ({ SafetyCard: () => null }));

import { AnswerMessage } from '@/components/AnswerMessage';
import { fonts } from '@/constants/colors';
import type { Citation, Message } from '@/lib/api';

afterEach(() => cleanup());

// react-native-web emits styles as CSS classes inserted into a runtime
// stylesheet (jsdom's getComputedStyle doesn't cascade those), so style
// assertions read the rule text for an element's classes.
function cssFor(el: Element): string {
  const selectors = new Set(Array.from(el.classList, (c) => `.${c}`));
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const styleRule = rule as CSSStyleRule;
      if (selectors.has(styleRule.selectorText)) css += styleRule.cssText;
    }
  }
  return css;
}

// Text styling may sit on the queried span itself or on the styled <Text>
// wrapping it (text runs nest), so assertions climb the ancestor chain.
function someAncestorCss(el: Element, needle: string): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (cssFor(node).includes(needle)) return true;
  }
  return false;
}

const citation: Citation = {
  id: 'c1',
  marker: 1,
  sourceType: 'quran' as Citation['sourceType'],
  reference: "Qur'an 20:14",
  sourceTitle: 'The Clear Quran',
  arabicText: 'وَأَقِمِ ٱلصَّلَوٰةَ لِذِكْرِىٓ',
  translationText: 'Establish prayer for My remembrance.',
};

function makeMessage(content: string): Message {
  return {
    id: 'm1',
    conversationId: 'conv1',
    role: 'assistant',
    content,
    citations: [citation],
    safety: null,
    createdAt: '2026-09-01T00:00:00Z',
  };
}

const ANSWER = [
  '## On prayer',
  '',
  'Prayer is **obligatory** [1]:',
  '',
  '> **وَأَقِمِ ٱلصَّلَوٰةَ لِذِكْرِىٓ**',
  '',
  '- First point',
  '- Second point',
  '',
  '[Learn more](https://ansari.chat/about)',
].join('\n');

function renderAnswer(content: string) {
  return render(
    <AnswerMessage message={makeMessage(content)} onCitationPress={() => {}} />,
  );
}

describe('AnswerMessage markdown rendering', () => {
  it('renders markdown typographically, with no literal syntax', () => {
    const { container, getByText } = renderAnswer(ANSWER);
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('##');
    expect(container.textContent).not.toContain('](');
    // Bold takes the heavier prose cut.
    expect(someAncestorCss(getByText('obligatory'), fonts.proseSemiBold)).toBe(
      true,
    );
    // List items render with bullets, syntax stripped.
    expect(container.textContent).toContain('•');
    expect(container.textContent).toContain('First point');
  });

  it('substitutes [1] with a citation chip inside markdown text', () => {
    const { getByTestId, container } = renderAnswer(ANSWER);
    expect(getByTestId('citation-chip-1')).toBeTruthy();
    expect(container.textContent).not.toContain('[1]');
  });

  it('renders the attribution link as a tappable link', () => {
    const { getByRole } = renderAnswer(ANSWER);
    const link = getByRole('link', { name: 'Learn more' });
    expect(link).toBeTruthy();
  });

  it('sets Arabic runs in Amiri and lays the verse block out RTL', () => {
    const { getByText } = renderAnswer(ANSWER);
    const verse = getByText('وَأَقِمِ ٱلصَّلَوٰةَ لِذِكْرِىٓ');
    expect(cssFor(verse)).toContain(fonts.arabic);
    // Some element enclosing the verse carries the RTL writing direction.
    expect(someAncestorCss(verse, 'direction: rtl')).toBe(true);
  });

  it('renders a partially streamed answer without crashing or literals', () => {
    // Cut mid-bold, mid-link — the shape of an in-flight SSE answer.
    const partial = ANSWER.slice(0, ANSWER.indexOf('obligatory') + 4);
    const { container } = renderAnswer(partial);
    expect(container.textContent).toContain('Prayer is');
    expect(container.textContent).not.toContain('**');
  });
});
