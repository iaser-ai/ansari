/**
 * The two environment templates stay in step with the config.
 *
 * Python counterpart: none (the Python `.env.example` was never checked). apps/auth has the
 * same kind of test, `tests/env-templates.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { buildConfig, CONFIG_KEYS } from '../src/config';

const root = join(import.meta.dirname, '..');
const read = (name: string) => readFileSync(join(root, name), 'utf8');

describe('.env.example', () => {
  it('is a valid configuration as written', () => {
    expect(() => buildConfig(parse(read('.env.example')))).not.toThrow();
  });

  it('documents every setting, active or as a commented example', () => {
    const text = read('.env.example');
    const missing = CONFIG_KEYS.filter((key) => !new RegExp(`^#?\\s*${key}=`, 'm').test(text));
    expect(missing).toEqual([]);
  });

  it('does not set the retired zrok variable', () => {
    expect(read('.env.example')).not.toMatch(/^META_WEBHOOK_ZROK_SHARE_TOKEN=/m);
  });
});

describe('.env.ci', () => {
  it('is a valid configuration (every required variable is present)', () => {
    const lines = read('.env.ci')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(() => buildConfig(parse(lines.join('\n')))).not.toThrow();
  });
});
