/**
 * Masking of identifiers before they reach a log.
 *
 * Python tests ported: the `test_masking_hides_identifier_shapes_and_leaves_ordinary_text`
 * table in test_meta_sender_logging.py (identical inputs and expected outputs), plus cases
 * for `redact_values`, which the Python suite only exercised through the Meta sender.
 */
import { describe, expect, it } from 'vitest';
import { maskIdentifiers, redactValues } from '../src/logMasking';

describe('maskIdentifiers', () => {
  it.each([
    ['Recipient 201234567899 not allowed', 'Recipient <phone> not allowed'],
    ['Recipient +20 123 456-7899 not allowed', 'Recipient <phone> not allowed'],
    ['Recipient (631) 555-1234 not allowed', 'Recipient <phone> not allowed'],
    ['user EG.3225570644499982 blocked', 'user <bsuid> blocked'],
    ['user US.ENT.11815799212886844830 blocked', 'user <bsuid> blocked'],
    ['id wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI1RjQy= end', 'id <message-id> end'],
    ['(#131030) Recipient phone number not in allowed list', '(#131030) Recipient phone number not in allowed list'],
    ['code 2655007 and trace Axly7O1UTgCLGu6n8EXWWTD', 'code 2655007 and trace Axly7O1UTgCLGu6n8EXWWTD'],
  ])('%s', (text, masked) => {
    expect(maskIdentifiers(text)).toBe(masked);
  });

  it('masks every occurrence, not just the first', () => {
    expect(maskIdentifiers('US.111 and US.222 and 201234567899 and 201234567800')).toBe('<bsuid> and <bsuid> and <phone> and <phone>');
  });

  it('gives the same answer when called twice (a shared regex must not remember its position)', () => {
    const text = 'user US.13491208655302741918';
    expect(maskIdentifiers(text)).toBe(maskIdentifiers(text));
  });
});

describe('redactValues', () => {
  const safe = new Set(['type', 'messaging_product']);

  it('keeps the structure and replaces strings with their length', () => {
    expect(redactValues({ to: '201234567899', text: { body: 'hello' }, type: 'text' }, safe)).toEqual({
      to: '<str len=12>',
      text: { body: '<str len=5>' },
      type: 'text',
    });
  });

  it('applies the parent key to every item of a list', () => {
    expect(redactValues({ type: ['a', 'b'], other: ['c'] }, safe)).toEqual({ type: ['a', 'b'], other: ['<str len=1>'] });
  });

  it('leaves numbers, booleans and null alone', () => {
    expect(redactValues({ code: 131030, ok: false, none: null }, safe)).toEqual({ code: 131030, ok: false, none: null });
  });
});
