import { createHash } from 'node:crypto';

export function answerFingerprint(text: string): { answerSha256: string; answerBytes: number } {
  const bytes = Buffer.from(text, 'utf8');
  return {
    answerSha256: createHash('sha256').update(bytes).digest('hex'),
    answerBytes: bytes.byteLength,
  };
}
