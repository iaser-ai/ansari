// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/haptics', () => ({ tapHaptic: () => {} }));
// The scripture pill dips under the finger through reanimated, which is
// Expo-native; a plain component stands in for its animated wrapper.
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  Easing: { bezier: () => () => 0 },
  cubicBezier: () => 'ease-out',
  useReducedMotion: () => true,
}));

import { fonts } from '@/constants/colors';
import { AnswerProse } from '@/components/AnswerProse';
import type { Citation } from '@/lib/api';

afterEach(cleanup);

const AYAH = 'قَدْ أَفْلَحَ ٱلْمُؤْمِنُونَ';
const TRANSLATION = 'Successful indeed are the believers.';

function renderAnswer(content: string) {
  return render(
    <AnswerProse
      content={content}
      byMarker={new Map()}
      onCitationPress={() => {}}
    />,
  ).container;
}

/**
 * The font family react-native-web gave an element. Static styles land
 * as atomic classes in an injected stylesheet, which jsdom's computed
 * style does not resolve (and jsdom's CSS parser rejects an unquoted
 * `Amiri_400Regular` written inline), so the class's rule is read
 * directly.
 */
function fontFamilyOf(el: Element): string {
  const classes = Array.from(el.classList).filter((c) => c.startsWith('r-fontFamily'));
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (classes.some((c) => rule.cssText.includes(`.${c}`))) {
        return rule.cssText;
      }
    }
  }
  return '';
}

/** An element's text-align, from its inline style or its atomic class's rule. */
function textAlignOf(el: HTMLElement): string {
  if (el.style.textAlign) return el.style.textAlign;
  const classes = Array.from(el.classList).filter((c) =>
    c.startsWith('r-textAlign'),
  );
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const m = /text-align:\s*([a-z]+)/.exec(rule.cssText);
      if (m && classes.some((c) => rule.cssText.includes(`.${c}`))) {
        return m[1]!;
      }
    }
  }
  return '';
}

/** A CSS property's value on an element, from its inline style or its atomic class's rule. */
function cssOf(el: HTMLElement, property: string): string {
  const inline = el.style.getPropertyValue(property);
  if (inline) return inline;
  const pattern = new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;}]+)`);
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const m = pattern.exec(rule.cssText);
      if (m && Array.from(el.classList).some((c) => rule.cssText.includes(`.${c}`))) {
        return m[1]!.trim();
      }
    }
  }
  return '';
}

/** The root text element (a block) whose text starts with `text`. */
function blockStartingWith(container: HTMLElement, text: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>('[dir]')).find(
    (el) => el.textContent?.startsWith(text),
  );
  if (!match) throw new Error(`no block starting with ${text}`);
  return match;
}

describe('AnswerProse direction (issue #228)', () => {
  it('pins a translation that shares a paragraph with its verse to LTR', () => {
    // Before the fix this was ONE block opened by Arabic, rendered
    // dir="auto", which the browser resolves to RTL for the English too.
    const container = renderAnswer(`${AYAH}\n${TRANSLATION}`);
    expect(blockStartingWith(container, TRANSLATION).getAttribute('dir')).toBe(
      'ltr',
    );
    expect(container.querySelector('[dir="auto"]')).toBeNull();
  });

  it('sets the verse right-to-left, in Amiri, centred with its translation', () => {
    const container = renderAnswer(`${AYAH}\n${TRANSLATION}`);
    const passage = blockStartingWith(container, AYAH);
    expect(passage.getAttribute('dir')).toBe('rtl');
    expect(fontFamilyOf(passage)).toContain(fonts.arabic);
    expect(textAlignOf(passage)).toBe('center');
    expect(textAlignOf(blockStartingWith(container, TRANSLATION))).toBe(
      'center',
    );
  });

  it('balances the lines of the verse and its translation, and nothing else', () => {
    const container = renderAnswer(`Allah says:\n${AYAH}\n${TRANSLATION}`);
    expect(cssOf(blockStartingWith(container, AYAH), 'text-wrap')).toBe(
      'balance',
    );
    expect(
      cssOf(blockStartingWith(container, TRANSLATION), 'text-wrap'),
    ).toBe('balance');
    expect(
      cssOf(blockStartingWith(container, 'Allah says'), 'text-wrap'),
    ).toBe('');
  });

  it('never lets a verse number start a line', () => {
    const container = renderAnswer('وَٱلْعَصْرِ ﴿١﴾\nBy time.');
    expect(blockStartingWith(container, 'وَٱلْعَصْرِ').textContent).toBe(
      'وَٱلْعَصْرِ\u00A0﴿١﴾',
    );
  });

  it('leaves prose outside scripture uncentred', () => {
    const container = renderAnswer(`Allah says:\n${AYAH}\n${TRANSLATION}`);
    expect(textAlignOf(blockStartingWith(container, 'Allah says'))).not.toBe(
      'center',
    );
  });

  it('pins plain English paragraphs, headings and list items to LTR', () => {
    const container = renderAnswer('## Heading\n\nProse.\n\n- item');
    for (const text of ['Heading', 'Prose.', 'item']) {
      expect(blockStartingWith(container, text).getAttribute('dir')).toBe(
        'ltr',
      );
    }
  });

  it('sets a short Arabic phrase inside English in Amiri, inline', () => {
    const container = renderAnswer('Presence of heart (خشوع) in prayer.');
    const paragraph = blockStartingWith(container, 'Presence');
    expect(paragraph.getAttribute('dir')).toBe('ltr');
    const run = Array.from(paragraph.querySelectorAll<HTMLElement>('*')).find(
      (el) => el.textContent === 'خشوع',
    );
    expect(run && fontFamilyOf(run)).toContain(fonts.arabic);
    expect(fontFamilyOf(paragraph)).not.toContain(fonts.arabic);
  });

  it('reads an answer written in Arabic right-to-left, without lifting', () => {
    const container = renderAnswer(
      'الخشوع في الصلاة هو حضور القلب.\n\n> ' + AYAH,
    );
    const roots = Array.from(container.querySelectorAll('[dir]'));
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((el) => el.getAttribute('dir') === 'rtl')).toBe(true);
    expect(screen.queryByTestId('answer-scripture')).toBeNull();
  });
});

describe('AnswerProse scripture box (issue #228)', () => {
  it('sets a quoted verse in the scripture box', () => {
    renderAnswer(`> ${AYAH}\n> ${TRANSLATION}`);
    expect(screen.getByTestId('answer-scripture')).toBeTruthy();
  });

  it('gives an unquoted verse the same treatment', () => {
    renderAnswer(`${AYAH}\n${TRANSLATION}`);
    expect(screen.getByTestId('answer-scripture')).toBeTruthy();
  });

  it('sets the trailing reference on its own line beneath the pair', () => {
    renderAnswer(`${AYAH} (Qur'an 23:1)\n${TRANSLATION}`);
    const reference = screen.getByTestId('answer-scripture-reference');
    expect(reference.textContent).toBe("Qur'an 23:1");
    // Taken off the Arabic line, and after the translation in the box.
    const box = screen.getByTestId('answer-scripture');
    expect(box.lastElementChild).toBe(reference);
    expect(blockStartingWith(box, AYAH).textContent).toBe(AYAH);
  });

  it('draws no attribution when the verse carried no reference', () => {
    renderAnswer(`${AYAH}\n${TRANSLATION}`);
    expect(screen.queryByTestId('answer-scripture-reference')).toBeNull();
  });

  it('leaves a quotation with no Arabic in the ink rule', () => {
    renderAnswer('> A scholar once wrote this.');
    expect(screen.queryByTestId('answer-scripture')).toBeNull();
  });
});

describe('AnswerProse source markers (issue #228)', () => {
  const citation = {
    id: 'c1',
    marker: 1,
    sourceType: 'quran',
    reference: "Qur'an 23:1",
    sourceTitle: "Surah al-Mu'minun",
    translationText: TRANSLATION,
  } as Citation;

  function renderCited(content: string) {
    render(
      <AnswerProse
        content={content}
        byMarker={new Map([[1, citation]])}
        onCitationPress={() => {}}
      />,
    );
    return screen.getByTestId('citation-chip-1');
  }

  it('sets the marker as its number on a brass disc', () => {
    renderCited('Successful are the believers. [1]');
    const disc = screen.getByTestId('citation-disc-1');
    expect(disc.textContent).toBe('1');
    expect(disc.style.backgroundColor).not.toBe('');
  });

  it('binds the marker to the word before it, dropping the space between', () => {
    const chip = renderCited('Successful are the believers. [1] And more.');
    const run = chip.parentElement!;
    expect(run.style.whiteSpace).toBe('nowrap');
    expect(run.textContent?.startsWith('believers.')).toBe(true);
    // The rest of the sentence is untouched, and no word is lost or doubled.
    expect(run.parentElement!.textContent).toMatch(
      /^Successful are the believers\.\u200A1\u2009 And more\.$/,
    );
  });

  it('leaves an unresolved marker as its literal text', () => {
    const container = renderAnswer('Unbacked claim. [7]');
    expect(screen.queryByTestId('citation-chip-7')).toBeNull();
    expect(container.textContent).toBe('Unbacked claim. [7]');
  });
});

describe('AnswerProse scripture source pill (issue #228)', () => {
  const quran = {
    id: 'q',
    marker: 1,
    sourceType: 'quran',
    reference: "Qur'an 23:1",
    sourceTitle: "Surah al-Mu'minun",
    translationText: TRANSLATION,
  } as Citation;
  const hadith = {
    id: 'h',
    marker: 2,
    sourceType: 'hadith',
    reference: 'Sahih al-Bukhari 528',
    sourceTitle: 'Sahih al-Bukhari',
    translationText: 'Do you think…',
    grade: 'Sahih',
  } as Citation;

  function renderWith(content: string, onCitationPress = vi.fn()) {
    render(
      <AnswerProse
        content={content}
        byMarker={new Map([[1, quran], [2, hadith]])}
        onCitationPress={onCitationPress}
      />,
    );
    return onCitationPress;
  }

  it('names the source, its kind and its number on the box', () => {
    renderWith(`${AYAH}\n${TRANSLATION} [1]`);
    const pill = screen.getByTestId('scripture-source-1');
    // Qur'an's pill drops the "Qur'an" its kind label already says.
    expect(pill.textContent).toBe("1\u2002Qur'an\u200223:1");
    expect(screen.getByTestId('answer-scripture').contains(pill)).toBe(true);
  });

  it("labels a hadith as one, with its grade", () => {
    renderWith(`${AYAH}\n"Do you think…" [2]`);
    expect(screen.getByTestId('scripture-source-2').textContent).toBe(
      '2\u2002Hadith\u2002Sahih al-Bukhari 528 · Sahih',
    );
  });

  it('opens the source when tapped', () => {
    const onPress = renderWith(`${AYAH}\n${TRANSLATION} [1]`);
    fireEvent.click(screen.getByTestId('scripture-source-1'));
    expect(onPress).toHaveBeenCalledWith(quran);
  });

  it('does not draw the marker again inside the box', () => {
    renderWith(`${AYAH} [1]\n${TRANSLATION} [1]`);
    expect(screen.queryByTestId('citation-chip-1')).toBeNull();
    expect(screen.getAllByTestId('scripture-source-1')).toHaveLength(1);
  });

  it('takes the place of the written reference', () => {
    renderWith(`${AYAH} (Qur'an 23:1)\n${TRANSLATION} [1]`);
    expect(screen.getByTestId('scripture-source-1')).toBeTruthy();
    expect(screen.queryByTestId('answer-scripture-reference')).toBeNull();
  });

  it('keeps the marker inline when it is outside a box', () => {
    renderWith(`Prose that cites. [1]`);
    expect(screen.getByTestId('citation-chip-1')).toBeTruthy();
    expect(screen.queryByTestId('scripture-source-1')).toBeNull();
  });
});
