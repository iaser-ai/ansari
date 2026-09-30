// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { Platform } from 'react-native';
import type { Message } from '@/lib/api';

// Whether the answer is selectable is decided here and handed to the
// prose, so the prose is replaced by a probe that reports what it was
// given. The rest are Expo-native or animated modules that don't load
// under Node.
vi.mock('@/components/AnswerProse', () => ({
  AnswerProse: ({ selectable }: { selectable?: boolean }) => (
    <span data-testid="prose" data-selectable={String(selectable)} />
  ),
}));
vi.mock('@/components/PressableScale', () => ({
  PressableScale: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock('@/components/SafetyCard', () => ({ SafetyCard: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@/lib/haptics', () => ({ tapHaptic: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn() }));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/messageActions', () => ({ openMessageActions: vi.fn() }));

import { AnswerMessage } from '@/components/AnswerMessage';

const webOS = Platform.OS;

afterEach(() => {
  cleanup();
  Platform.OS = webOS;
});

const message = {
  id: 'm1',
  role: 'assistant',
  content: 'Patience is half of faith.',
  citations: [],
} as unknown as Message;

describe('AnswerMessage on web', () => {
  // react-native is aliased to react-native-web, so Platform.OS is 'web'.
  it('hands the prose selectable text from the first render', () => {
    render(<AnswerMessage message={message} onSourcesOpen={() => {}} />);
    expect(screen.getByTestId('prose').dataset.selectable).toBe('true');
  });
});

describe('AnswerMessage on a phone', () => {
  // Selection waits for the hold menu, so the long press stays free
  // for it rather than going to the platform's magnifier.
  it('starts with the prose unselectable', () => {
    Platform.OS = 'ios';
    render(<AnswerMessage message={message} onSourcesOpen={() => {}} />);
    expect(screen.getByTestId('prose').dataset.selectable).toBe('false');
  });
});
