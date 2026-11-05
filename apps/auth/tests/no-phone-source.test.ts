// Spec 329 §5, owner amendment 2: no phone number is read, stored or logged.
// A `phone_number` the WhatsApp service sends is accepted and ignored, so no
// code in packages/auth/src or apps/auth/src may mention it outside comments
// (comments document the "accepted and ignored" rule).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNED = ['packages/auth/src', 'apps/auth/src'];
const PHONE = /phone/i;

/** The source with comments removed (block, then line; string contents are kept). */
export function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Lines of code (not comments) that mention a phone number. */
export function phoneHits(source: string): string[] {
  return codeOnly(source)
    .split('\n')
    .filter((line) => PHONE.test(line));
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

describe('no code reads a phone number', () => {
  it('reports 0 hits over packages/auth/src and apps/auth/src (comments excluded)', () => {
    const files = SCANNED.flatMap((dir) => tsFiles(join(REPO, dir)));
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap((file) =>
      phoneHits(readFileSync(file, 'utf8')).map((line) => `${relative(REPO, file)}: ${line.trim()}`)
    );
    process.stdout.write(`no-phone scan: ${hits.length} hit(s) in ${files.length} files\n`);
    expect(hits).toEqual([]);
  });

  it('catches a planted read, and ignores the same words in a comment (negative tests)', () => {
    expect(phoneHits("  const { bsuid, phone_number: phone } = body as Record<string, unknown>;")).toHaveLength(1);
    expect(phoneHits('  phoneNumber: text(\'phone_number\'),')).toHaveLength(1);
    expect(phoneHits('// A `phone_number` field is accepted and ignored.')).toEqual([]);
    expect(phoneHits('/**\n * never the BSUID or a phone number.\n */')).toEqual([]);
    expect(phoneHits("const url = 'https://example.com/phone'; // a string is code")).toHaveLength(1);
  });
});
