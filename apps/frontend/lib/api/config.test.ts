import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_API_URL,
  DEFAULT_AUTH_URL,
  resolveAuthUrl,
  resolveBaseUrl,
} from '@/lib/api/config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('service URLs', () => {
  it('the defaults name the same environment (an env-less build never mixes them)', () => {
    expect(DEFAULT_API_URL).toBe('https://api-staging.askansari.ai');
    expect(DEFAULT_AUTH_URL).toBe('https://auth-staging.askansari.ai');
    vi.stubEnv('EXPO_PUBLIC_API_URL', '');
    vi.stubEnv('EXPO_PUBLIC_AUTH_URL', '  ');
    expect([resolveBaseUrl(), resolveAuthUrl()]).toEqual([DEFAULT_API_URL, DEFAULT_AUTH_URL]);
  });

  it('an override wins, trailing slashes trimmed', () => {
    vi.stubEnv('EXPO_PUBLIC_API_URL', 'http://localhost:3000/');
    vi.stubEnv('EXPO_PUBLIC_AUTH_URL', ' http://localhost:3100// ');
    expect([resolveBaseUrl(), resolveAuthUrl()]).toEqual([
      'http://localhost:3000',
      'http://localhost:3100',
    ]);
  });
});
