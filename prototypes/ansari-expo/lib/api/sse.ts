/**
 * A minimal, transport-agnostic Server-Sent Events parser.
 *
 * apps/api's chat endpoint streams `data: <json>\n\n` frames interleaved with
 * `: ping` heartbeat comment lines. This parser:
 *   - reassembles events that arrive split across multiple network chunks,
 *   - ignores comment lines (heartbeats) and non-`data:` fields,
 *   - concatenates multiple `data:` lines within one event per the SSE spec,
 *   - tolerates both `\n` and `\r\n` line endings.
 *
 * `push()` returns the raw `data` payload string(s) for every complete event in
 * the accumulated buffer; the caller `JSON.parse`s them. It holds partial
 * trailing data until the terminating blank line arrives.
 */
export class SSEParser {
  private buffer = '';

  push(chunk: string): string[] {
    // Normalise CRLF so frame/line splitting is uniform.
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const payloads: string[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const data = extractData(frame);
      if (data !== null) payloads.push(data);
    }
    return payloads;
  }
}

function extractData(frame: string): string | null {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue; // blank or comment/heartbeat
    if (line.startsWith('data:')) {
      // A single leading space after the colon is part of the framing, not data.
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // event:, id:, retry: are ignored — this endpoint doesn't use them.
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}
