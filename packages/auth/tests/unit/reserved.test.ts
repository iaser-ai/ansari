// The non-interactive domain (spec 329, owner decision 1): `@noreply.askansari.ai`
// is reserved on every public path, beside the system domain, which is unchanged.
import { describe, expect, it } from 'vitest';

import {
  isNoreplyAddress,
  isReservedAddress,
  isSystemAddress,
  NOREPLY_EMAIL_DOMAIN,
  serviceAddress,
  SYSTEM_EMAIL_DOMAIN,
  whatsappAddress,
} from '../../src/reserved';

describe('the noreply domain', () => {
  it.each([
    ['whatsapp-3f2a9c1e-0000-4000-8000-000000000000@noreply.askansari.ai', true],
    ['service-whatsapp@noreply.askansari.ai', true],
    [' Anyone@NoReply.AskAnsari.AI ', true],
    ['someone@askansari.ai', false],
    ['x@noreply.askansari.ai.example.com', false],
    ['x@notnoreply.askansari.ai', false],
    ['noreply.askansari.ai@example.com', false],
  ])('%s → reserved %s', (email, reserved) => {
    expect(isNoreplyAddress(email)).toBe(reserved);
    expect(isReservedAddress(email)).toBe(reserved);
  });

  it('builds the two address shapes from an id or a service name, never anything else', () => {
    const id = '3f2a9c1e-0000-4000-8000-000000000000';
    expect(whatsappAddress(id)).toBe(`whatsapp-${id}@noreply.askansari.ai`);
    expect(serviceAddress('ansari-mcp')).toBe('service-ansari-mcp@noreply.askansari.ai');
    expect(isReservedAddress(whatsappAddress(id))).toBe(true);
    expect(isReservedAddress(serviceAddress('whatsapp'))).toBe(true);
    expect(NOREPLY_EMAIL_DOMAIN).toBe('@noreply.askansari.ai');
  });

  it('leaves the system domain as it was: system addresses are reserved, and are not noreply', () => {
    expect(SYSTEM_EMAIL_DOMAIN).toBe('@system.ansari.chat');
    expect(isReservedAddress('ai-skill@system.ansari.chat')).toBe(true);
    expect(isSystemAddress('ai-skill@system.ansari.chat')).toBe(true);
    expect(isNoreplyAddress('ai-skill@system.ansari.chat')).toBe(false);
    expect(isSystemAddress('service-whatsapp@noreply.askansari.ai')).toBe(false);
  });
});
