/**
 * The keyboard and screen of the operator script, behind one small interface.
 *
 * Python counterpart: `input()`, `getpass.getpass()` and `print()`. The script's flows talk only to `Io`, so a test drives them with
 * scripted answers (see `tests/helpers/scriptedIo.ts`) and no terminal.
 *
 * Differences from Python:
 * - `null` means "no more input" (the keyboard was closed with Ctrl+D, Ctrl+C, or a pipe ended). Python's `input()` raised
 *   `EOFError` and ended with a traceback; the script treats `null` as "quit".
 * - Lines typed ahead of a question are kept for it. `readline`'s own `question()` loses a line that arrives before the question is
 *   asked (checked on Node 22: a piped-in second answer never reached its question).
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export interface Io {
  /** Write `text` and a line break. */
  print(text: string): void;
  /** Show `prompt` (no line break after it) and wait for a line. `null` when there is no more input. */
  ask(prompt: string): Promise<string | null>;
  /** Like `ask`, but what is typed is not shown (Python: `getpass.getpass`). */
  askHidden(prompt: string): Promise<string | null>;
}

/** An `Io` on real streams. Call `close()` when the script ends, or the keyboard keeps the process alive. */
export function createTerminalIo(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Io & { close(): void } {
  let hidden = false;
  // readline echoes what is typed by writing to its output; this one stays silent while a hidden answer is being typed
  const gated = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!hidden) output.write(chunk);
      callback();
    },
  });
  const reader = createInterface({ input, output: gated, terminal: input.isTTY === true });

  const typedAhead: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let ended = false;

  reader.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else typedAhead.push(line);
  });
  reader.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) next(null);
  });
  // Ctrl+C needs no code here: with no `SIGINT` listener, readline closes itself, which gives a question in progress `null`
  // (tests/terminalIo.test.ts sends a real Ctrl+C keystroke). Adding a listener would take that default away.

  function nextLine(): Promise<string | null> {
    const line = typedAhead.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  }

  return {
    print: (text) => {
      output.write(`${text}\n`);
    },
    ask: (prompt) => {
      output.write(prompt);
      return nextLine();
    },
    askHidden: async (prompt) => {
      output.write(prompt);
      hidden = true;
      try {
        return await nextLine();
      } finally {
        hidden = false;
        // The Enter that ended the answer was not echoed, so end the prompt's line ourselves
        output.write('\n');
      }
    },
    close: () => reader.close(),
  };
}
