import http from 'node:http';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { settings } from './env.ts';

export interface ImageInput {
  media_type: string;
  /** Base64, no `data:` prefix — the shape the app sends. */
  data: string;
}

export interface Account {
  email: string;
  token: string;
}

export interface ChatResult {
  status: number;
  /** The streamed answer text (empty when refused or failed). */
  text: string;
  /** The error message: the refusal body, or an SSE `error` event. */
  error: string | null;
  /** Milliseconds from sending until the first answer text arrived. */
  firstWordMs: number | null;
  /** Milliseconds from sending until the response ended. */
  totalMs: number;
  /** Size of the request body, in bytes. */
  uploadBytes: number;
}

function randomId(): string {
  return randomBytes(6).toString('hex');
}

async function postJson(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/**
 * A registered account, or a guest one. A guest is registered exactly the way
 * the app's "Continue as guest" does it (apps/frontend/lib/auth/guest.ts).
 */
export async function signUp(baseUrl: string, kind: 'registered' | 'guest'): Promise<Account> {
  const email = kind === 'guest' ? `guest_${randomId()}@ansari.chat` : `bdd_${randomId()}@example.com`;
  const { status, json } = await postJson(`${baseUrl}/api/v2/users/register`, {
    email,
    password: `Bdd-${randomId()}-Pass!9`,
    first_name: kind === 'guest' ? 'Welcome' : 'Bdd',
    last_name: kind === 'guest' ? 'Guest' : 'Tester',
    register_to_mail_list: false,
  });
  if (status !== 200 || !json?.access_token) {
    throw new Error(`register failed: ${status} ${JSON.stringify(json)}`);
  }
  return { email, token: json.access_token };
}

export async function createThread(baseUrl: string, token: string): Promise<string> {
  const { status, json } = await postJson(`${baseUrl}/api/v2/threads`, {}, token);
  if (status !== 200 || !json?.thread_id) {
    throw new Error(`create thread failed: ${status} ${JSON.stringify(json)}`);
  }
  return json.thread_id;
}

/** Ask a question on the real chat endpoint and read the streamed answer. */
export async function ask(
  baseUrl: string,
  token: string,
  threadId: string,
  message: string,
  images: ImageInput[]
): Promise<ChatResult> {
  const body = JSON.stringify(images.length > 0 ? { message, images } : { message });
  const uploadBytes = Buffer.byteLength(body);
  const started = performance.now();
  const res = await fetch(`${baseUrl}/api/v2/threads/${threadId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
  });

  if (!res.ok || !res.body) {
    const raw = await res.text();
    let error = raw;
    try {
      error = JSON.parse(raw).detail ?? JSON.parse(raw).error ?? raw;
    } catch {
      // keep raw
    }
    return { status: res.status, text: '', error: String(error), firstWordMs: null, totalMs: performance.now() - started, uploadBytes };
  }

  let text = '';
  let error: string | null = null;
  let firstWordMs: number | null = null;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === 'text') {
          if (firstWordMs === null) firstWordMs = performance.now() - started;
          text += event.content;
        } else if (event.type === 'error') {
          error = event.message;
        }
      }
    }
  }
  return { status: res.status, text, error, firstWordMs, totalMs: performance.now() - started, uploadBytes };
}

export interface RawSendResult {
  status: number | null;
  /** Bytes this client had handed to the socket when the server answered or hung up. */
  bytesSentWhenAnswered: number;
  totalBytes: number;
}

/**
 * Send a body of `totalBytes` to the chat endpoint at a low level, so the test
 * controls whether the size is declared (Content-Length) or hidden (chunked).
 */
export function sendRawBody(
  baseUrl: string,
  path: string,
  token: string | null,
  totalBytes: number,
  declareSize: boolean
): Promise<RawSendResult> {
  const url = new URL(path, baseUrl);
  const CHUNK = 1024 * 1024;
  // A JSON body that stays valid-looking: one huge base64 string.
  const head = Buffer.from('{"message":"x","images":[{"media_type":"image/jpeg","data":"');
  const tail = Buffer.from('"}]}');
  const filler = Buffer.alloc(CHUNK, 'A');

  return new Promise((resolve) => {
    let sent = 0;
    let answered = false;
    const finish = (status: number | null) => {
      if (answered) return;
      answered = true;
      resolve({ status, bytesSentWhenAnswered: sent, totalBytes });
      req.destroy();
    };
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(declareSize ? { 'Content-Length': String(totalBytes) } : {}),
        },
      },
      (res) => {
        res.resume();
        finish(res.statusCode ?? null);
      }
    );
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));

    const write = () => {
      if (answered) return;
      if (sent === 0) {
        req.write(head);
        sent += head.length;
      }
      while (sent < totalBytes - tail.length) {
        const n = Math.min(CHUNK, totalBytes - tail.length - sent);
        sent += n;
        if (!req.write(n === CHUNK ? filler : filler.subarray(0, n))) {
          req.once('drain', write);
          return;
        }
        if (answered) return;
      }
      req.end(tail);
      sent += tail.length;
    };
    write();
  });
}

/** Send any JSON body to the chat endpoint and return just the status. */
export async function sendChatBody(baseUrl: string, token: string, threadId: string, body: unknown): Promise<number> {
  const { status } = await postJson(`${baseUrl}/api/v2/threads/${threadId}/chat`, body, token);
  return status;
}

export interface AnswerRecord {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  modelProvider: string | null;
  modelId: string | null;
}

let pool: pg.Pool | null = null;

/** What the server recorded for the latest answer in a thread: tokens and model. */
export async function latestAnswerRecord(threadId: string): Promise<AnswerRecord | null> {
  pool ??= new pg.Pool({ connectionString: settings.databaseUrl });
  const { rows } = await pool.query(
    `select input_tokens, output_tokens, thinking_tokens, model_provider, model_id
       from messages where thread_id = $1 and role = 'assistant'
      order by created_at desc limit 1`,
    [threadId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    thinkingTokens: r.thinking_tokens ?? 0,
    modelProvider: r.model_provider,
    modelId: r.model_id,
  };
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}
