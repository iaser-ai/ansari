import { describe, expect, it } from 'vitest';
// The shared parser apps/auth runs on X-Ansari-Client. It has no
// dependencies, so it is imported by path rather than adding a workspace
// dependency for a test.
import { parseClientId } from '../../../../packages/types/src/attribution';
import { CLIENT_IDS, clientId } from '@/lib/auth/client-id';

describe('X-Ansari-Client ids', () => {
  it('names one id per platform', () => {
    expect(clientId('web')).toBe('askansari-web');
    expect(clientId('ios')).toBe('askansari-ios');
    expect(clientId('android')).toBe('askansari-android');
  });

  // packages/auth/tests/config/sign-up.test.ts pins the same three ids as
  // stored verbatim in registered_via.
  it.each(Object.values(CLIENT_IDS))('%s is a valid id to the shared parser, unchanged', (id) => {
    expect(parseClientId(id, null)).toEqual({ kind: 'valid', clientId: id, source: 'header' });
  });

  it('the parser check can fail (a near-miss is refused)', () => {
    expect(parseClientId('AskAnsari Web', null).kind).toBe('invalid');
  });
});
