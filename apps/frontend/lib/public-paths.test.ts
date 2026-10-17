import { describe, expect, it } from 'vitest';
import { isPublicPath } from '@/lib/public-paths';

describe('isPublicPath', () => {
  it('matches a shared thread, the two reset pages and account deletion', () => {
    expect(isPublicPath('/share/d4757c81-660b-47f1-b178-095492dc2920')).toBe(true);
    expect(isPublicPath('/forgot-password')).toBe(true);
    expect(isPublicPath('/reset-password')).toBe(true);
    expect(isPublicPath('/delete-account')).toBe(true);
  });

  it('matches nothing else (near-misses included)', () => {
    for (const path of ['/', '/chat/x', '/share', '/delete-account-x', '/reset-password-x', '/forgot', '/login', '/about']) {
      expect(isPublicPath(path)).toBe(false);
    }
  });
});
