import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_RELEASE,
  stampHtmlRevision,
  writeOperationLog,
} from '../src/server/operation-log.ts';
import { answerFingerprint } from '../src/server/answer-fingerprint.ts';

describe('operation log', () => {
  it('stamps a data-revision on the HTML body', () => {
    const html = stampHtmlRevision('<body data-release="ansari-answer-card@0.1.0">x</body>', 'abc123');
    assert.match(html, /data-revision="abc123"/);
  });

  it('omits questions, answers, and session tokens', () => {
    const records: unknown[] = [];
    writeOperationLog(
      {
        event: 'tool.start',
        method: 'tools/call',
        requestId: 10,
        question: 'should-not-appear',
        answer: 'should-not-appear',
        sessionId: 'raw-session-token',
      },
      (record) => records.push(record),
    );
    const serialized = JSON.stringify(records[0]);
    assert.equal(serialized.includes('should-not-appear'), false);
    assert.equal(serialized.includes('raw-session-token'), false);
    assert.match(serialized, /"event":"tool.start"/);
    assert.match(serialized, new RegExp(`"release":"${DEFAULT_RELEASE}"`));
  });

  it('fingerprints answer bytes without retaining the text', () => {
    const text = 'سلام\nattribution';
    const fingerprint = answerFingerprint(text);
    assert.equal(fingerprint.answerBytes, Buffer.byteLength(text, 'utf8'));
    assert.equal(fingerprint.answerSha256.length, 64);
    assert.equal(JSON.stringify(fingerprint).includes(text), false);
  });
});
