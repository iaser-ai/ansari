// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Render through react-native-web: reanimated's animated wrapper and the
// icon font are Expo-native, so they are stood in for with plain ones.
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  Easing: { bezier: () => () => 0 },
  cubicBezier: () => 'ease-out',
  useReducedMotion: () => false,
}));
vi.mock('@/lib/haptics', () => ({ tapHaptic: () => {} }));
vi.mock('@expo/vector-icons', () => ({
  Feather: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

import colors from '@/constants/colors';
import { FootnoteToggle } from '@/components/FootnoteGroup';

afterEach(cleanup);

function renderToggle(expanded: boolean, onPress = vi.fn()) {
  render(
    <FootnoteToggle
      kind="hadith"
      label="Hadith"
      hidden={6}
      expanded={expanded}
      onPress={onPress}
    />,
  );
  return { toggle: screen.getByTestId('footnote-toggle-hadith'), onPress };
}

describe('FootnoteToggle (issue #196)', () => {
  it('is drawn as a filled pill at the footnote pills\' tap size', () => {
    const { toggle } = renderToggle(false);
    const style = getComputedStyle(toggle);

    expect(style.minHeight).toBe('44px');
    // Filled with the quiet fill, not left transparent on the page.
    expect(style.backgroundColor).toBe('rgb(245, 245, 244)');
    expect(colors.light.secondary.toLowerCase()).toBe('#f5f5f4');
    // Rounded like the pills above it.
    expect(parseFloat(style.borderTopLeftRadius)).toBeGreaterThan(0);
  });

  it('no longer reads as an underlined text link', () => {
    renderToggle(false);
    const text = screen.getByText('View 6 more');
    expect(getComputedStyle(text).textDecorationLine ?? '').not.toContain(
      'underline',
    );
    expect(getComputedStyle(text).textDecoration ?? '').not.toContain(
      'underline',
    );
  });

  it('folded: offers the hidden count with a down chevron', () => {
    const { toggle } = renderToggle(false);
    expect(screen.getByText('View 6 more')).toBeTruthy();
    expect(screen.getByTestId('icon-chevron-down')).toBeTruthy();
    expect(toggle.getAttribute('aria-label')).toBe('View 6 more Hadith sources');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('expanded: offers to collapse with an up chevron', () => {
    const { toggle } = renderToggle(true);
    expect(screen.getByText('Show less')).toBeTruthy();
    expect(screen.getByTestId('icon-chevron-up')).toBeTruthy();
    expect(toggle.getAttribute('aria-label')).toBe('Show fewer Hadith sources');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('is a button that calls onPress when tapped', () => {
    const { toggle, onPress } = renderToggle(false);
    expect(toggle.getAttribute('role')).toBe('button');
    fireEvent.click(toggle);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
