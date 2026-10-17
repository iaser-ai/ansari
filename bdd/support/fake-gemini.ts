import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the Gemini HTTP API. The API server under test is pointed at
 * it with GOOGLE_GEMINI_BASE_URL, which the @google/genai SDK honours, so the
 * server runs its real code and only the model on the other end is fake.
 *
 * Used only where the real model cannot do what the scenario needs: return an
 * empty answer on demand, or absorb a flood of requests for free.
 */
export type FakeGeminiMode = 'empty' | 'answer';

const USAGE = { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 };

class FakeGemini {
  mode: FakeGeminiMode = 'answer';
  delayMs = 0;
  calls = 0;
  private server: http.Server | null = null;

  async start(): Promise<string> {
    if (!this.server) {
      this.server = http.createServer((req, res) => this.handle(req, res));
      await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    }
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  reset(): void {
    this.mode = 'answer';
    this.delayMs = 0;
    this.calls = 0;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private candidate(): object {
    const text = this.mode === 'empty' ? '' : 'This is a fake answer from the test Gemini.';
    return {
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: USAGE,
      modelVersion: 'fake-gemini',
    };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Drain the request body; its content does not matter to the fake.
    req.resume();
    req.on('end', async () => {
      this.calls += 1;
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      const url = req.url ?? '';
      if (url.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(this.candidate())}\r\n\r\n`);
      } else if (url.includes(':generateContent')) {
        // Non-streaming calls are thread naming; give it a name.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [
              { content: { role: 'model', parts: [{ text: 'Test thread' }] }, finishReason: 'STOP', index: 0 },
            ],
            usageMetadata: USAGE,
          })
        );
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 404, message: `fake Gemini has no route for ${url}` } }));
      }
    });
  }
}

export const fakeGemini = new FakeGemini();
