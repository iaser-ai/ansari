import { describe, expect, it } from 'vitest';
import { SSEParser } from '@/lib/api/sse';

/**
 * The SSE parser must survive exactly what apps/api's chat endpoint emits:
 * `data: <json>\n\n` frames, `: ping` heartbeat comments, and events split
 * across arbitrary network chunk boundaries.
 */

function collect(parser: SSEParser, chunks: string[]): unknown[] {
  return chunks
    .flatMap((chunk) => parser.push(chunk))
    .map((payload) => JSON.parse(payload));
}

describe('SSEParser', () => {
  it('parses whole data frames', () => {
    const p = new SSEParser();
    const events = collect(p, [
      'data: {"type":"text","content":"Hello"}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    expect(events).toEqual([
      { type: 'text', content: 'Hello' },
      { type: 'done' },
    ]);
  });

  it('ignores heartbeat comment lines', () => {
    const p = new SSEParser();
    const events = collect(p, [
      ': ping\n\n',
      'data: {"type":"text","content":"A"}\n\n',
      ': ping\n\n',
      'data: {"type":"text","content":"B"}\n\n',
    ]);
    expect(events).toEqual([
      { type: 'text', content: 'A' },
      { type: 'text', content: 'B' },
    ]);
  });

  it('reassembles an event split across chunks', () => {
    const p = new SSEParser();
    const payloads = [
      ...p.push('data: {"type":"te'),
      ...p.push('xt","content":"multi'),
      ...p.push('-chunk"}\n\n'),
    ];
    expect(payloads.map((x) => JSON.parse(x))).toEqual([
      { type: 'text', content: 'multi-chunk' },
    ]);
  });

  it('holds a partial trailing frame until its blank line arrives', () => {
    const p = new SSEParser();
    expect(p.push('data: {"type":"text","content":"x"}')).toEqual([]);
    expect(p.push('\n\n').map((x) => JSON.parse(x))).toEqual([
      { type: 'text', content: 'x' },
    ]);
  });

  it('tolerates CRLF line endings', () => {
    const p = new SSEParser();
    const events = collect(p, ['data: {"type":"done"}\r\n\r\n']);
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('concatenates multiple data lines in one event', () => {
    const p = new SSEParser();
    const [payload] = p.push('data: line1\ndata: line2\n\n');
    expect(payload).toBe('line1\nline2');
  });

  it('handles several events delivered in a single chunk', () => {
    const p = new SSEParser();
    const events = collect(p, [
      'data: {"type":"text","content":"A"}\n\ndata: {"type":"error","message":"boom"}\n\n',
    ]);
    expect(events).toEqual([
      { type: 'text', content: 'A' },
      { type: 'error', message: 'boom' },
    ]);
  });
});
