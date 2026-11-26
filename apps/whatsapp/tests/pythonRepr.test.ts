/**
 * `pythonRepr` prints values the way Python's `repr()` does, because log lines and the Python tests rely on that shape
 * (`code=131030 type='OAuthException'`, `['messaging_product', 'text']`). The expected text is what `repr()` returned
 * (`tests/fixtures/pythonOracle.ts`).
 */
import { describe, expect, it } from 'vitest';
import { pythonList, pythonRepr } from '../src/utils/pythonRepr';
import { REPR_CASES } from './fixtures/pythonOracle';

describe('pythonRepr', () => {
  it.each(REPR_CASES)('%j', (value, python) => {
    expect(pythonRepr(value)).toBe(python);
  });
});

describe('pythonList', () => {
  it('prints a list of strings like Python', () => {
    expect(pythonList(['messaging_product', 'text'])).toBe("['messaging_product', 'text']");
    expect(pythonList([])).toBe('[]');
  });
});
