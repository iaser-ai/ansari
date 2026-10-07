// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Render the legal page through react-native-web. Navigation, safe
// areas, the rail's animated inset and the Expo-native modules are
// stood in for; what is under test is what the page sets and where its
// links go.
const push = vi.fn();
vi.mock('expo-router', () => ({
  router: {
    push: (href: string) => push(href),
    back: vi.fn(),
    replace: vi.fn(),
    canGoBack: () => false,
  },
}));
vi.mock('react-native-reanimated', () => {
  const chain = {
    duration: () => chain,
    easing: () => chain,
    reduceMotion: () => chain,
  };
  return {
    default: {
      View: ({ entering: _e, ...props }: Record<string, unknown>) =>
        React.createElement('div', props as object),
    },
    FadeIn: chain,
    ReduceMotion: { System: 'system' },
    Easing: { bezier: () => () => 0 },
    cubicBezier: () => 'ease-out',
    useReducedMotion: () => false,
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/hooks/useDesktop', () => ({ useDesktop: () => true }));
vi.mock('@/hooks/useSidebarCollapsed', () => ({ useSidebarInset: () => ({}) }));
vi.mock('@/hooks/useScreenLandmark', () => ({ useScreenLandmark: () => ({}) }));
vi.mock('@/components/PressableScale', () => ({
  PressableScale: ({
    children,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@/components/HeaderBar', () => ({ HeaderBar: () => null }));
vi.mock('@/components/GlassCircleButton', () => ({
  GlassCircleButton: () => null,
}));
const openEmail = vi.fn();
vi.mock('@/lib/link', () => ({
  openEmail: (address: string) => openEmail(address),
}));

import { PRIVACY, TERMS } from '@/constants/legal';
import { LegalPage } from '@/components/LegalPage';

afterEach(() => {
  cleanup();
  push.mockClear();
  openEmail.mockClear();
});

describe('LegalPage (issue #241)', () => {
  it('sets the title, the date and every section heading', () => {
    render(<LegalPage doc={TERMS} barTitle="Terms" />);
    expect(screen.getByText('Ansari Terms of Service')).toBeTruthy();
    expect(screen.getByText('Effective Date: 2026-10-06')).toBeTruthy();
    for (const section of TERMS.sections) {
      expect(screen.getByText(section.heading)).toBeTruthy();
    }
  });

  it('links "Privacy Policy" in the Terms to the in-app page', () => {
    render(<LegalPage doc={TERMS} barTitle="Terms" />);
    const link = screen.getByText('Privacy Policy');
    expect(link.getAttribute('role')).toBe('link');
    fireEvent.click(link);
    expect(push).toHaveBeenCalledWith('/privacy');
  });

  it('opens mail from the contact address', () => {
    render(<LegalPage doc={PRIVACY} barTitle="Privacy" />);
    const links = screen.getAllByText('feedback@askansari.ai');
    fireEvent.click(links[0]);
    expect(openEmail).toHaveBeenCalledWith('feedback@askansari.ai');
  });

  it('sets each list item with a bullet beside it', () => {
    render(<LegalPage doc={PRIVACY} barTitle="Privacy" />);
    const items = PRIVACY.sections.flatMap((s) =>
      s.blocks.flatMap((b) => (b.type === 'list' ? b.items : [])),
    );
    expect(screen.getAllByText('•')).toHaveLength(items.length);
  });

  it('ends on the Ask Ansari button', () => {
    render(<LegalPage doc={PRIVACY} barTitle="Privacy" />);
    expect(screen.getByTestId('legal-back-to-ask').textContent).toContain(
      'Ask Ansari a question',
    );
  });
});
