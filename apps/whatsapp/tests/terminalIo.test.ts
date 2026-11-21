/**
 * The keyboard and screen of the operator script, on fake streams.
 *
 * Python counterpart: `input()` and `getpass.getpass()`. Two behaviours here exist because Node's own `readline.question` got them
 * wrong in a probe on Node 22: a line typed before the question is asked is lost, and a question pending when the input ends
 * never finishes.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTerminalIo } from '../scripts/terminalIo';

function rig(options: { tty?: boolean } = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: options.tty === true });
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString('utf8');
  });
  const io = createTerminalIo(input, output);
  return { io, input, written: () => written };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const pending = <T>(promise: Promise<T>) => Promise.race([promise, settle().then(() => 'STILL PENDING' as const)]);

describe('ask', () => {
  it('shows the prompt without a line break and returns the line typed', async () => {
    const { io, input, written } = rig();
    const answer = io.ask('Name: ');
    input.write('Ansari\n');
    expect(await answer).toBe('Ansari');
    expect(written()).toBe('Name: ');
    io.close();
  });

  it('keeps lines typed BEFORE the question is asked, in order (readline.question loses them)', async () => {
    const { io, input } = rig();
    input.write('first\nsecond\nthird\n');
    await settle();
    expect(await io.ask('1> ')).toBe('first');
    expect(await io.ask('2> ')).toBe('second');
    expect(await io.ask('3> ')).toBe('third');
    io.close();
  });

  it('gives each question its own line when answers arrive one at a time', async () => {
    const { io, input } = rig();
    const a = io.ask('a> ');
    input.write('one\n');
    expect(await a).toBe('one');
    const b = io.ask('b> ');
    input.write('two\n');
    expect(await b).toBe('two');
    io.close();
  });

  it('returns an empty string for a bare Enter, not null', async () => {
    const { io, input } = rig();
    const answer = io.ask('> ');
    input.write('\n');
    expect(await answer).toBe('');
    io.close();
  });

  it('answers a pending question with null when the input ends', async () => {
    const { io, input } = rig();
    const answer = io.ask('> ');
    input.end();
    expect(await pending(answer)).toBeNull();
    io.close();
  });

  it('answers a pending question with null when the interface is closed (what Ctrl+C does)', async () => {
    const { io } = rig();
    const answer = io.ask('> ');
    io.close();
    expect(await pending(answer)).toBeNull();
  });

  // On a real terminal Ctrl+C arrives as the character U+0003, and readline reports it as a SIGINT event instead of ending the line
  it('answers a pending question with null on a real Ctrl+C keystroke, and later questions too', async () => {
    const { io, input } = rig({ tty: true });
    const answer = io.ask('> ');
    input.write('\u0003');
    expect(await pending(answer)).toBeNull();
    expect(await pending(io.ask('again> '))).toBeNull();
    io.close();
  });

  it('answers with null at once for a question asked after the input has ended', async () => {
    const { io, input } = rig();
    input.end();
    await settle();
    expect(await pending(io.ask('> '))).toBeNull();
    io.close();
  });

  it('still hands over lines typed before the end of input, then null', async () => {
    const { io, input } = rig();
    input.write('last\n');
    input.end();
    await settle();
    expect(await io.ask('> ')).toBe('last');
    expect(await pending(io.ask('> '))).toBeNull();
    io.close();
  });

  it('answers every question waiting when the input ends', async () => {
    const { io, input } = rig();
    const a = io.ask('a> ');
    const b = io.ask('b> ');
    input.end();
    expect(await pending(Promise.all([a, b]))).toEqual([null, null]);
    io.close();
  });

  it('can be closed twice', () => {
    const { io } = rig();
    io.close();
    expect(() => io.close()).not.toThrow();
  });
});

describe('askHidden', () => {
  it('returns the line typed and does not echo it back', async () => {
    const { io, input, written } = rig();
    const answer = io.askHidden('Token: ');
    input.write('SECRET-TYPED-VALUE\n');
    expect(await answer).toBe('SECRET-TYPED-VALUE');
    expect(written()).not.toContain('SECRET-TYPED-VALUE');
    io.close();
  });

  it('shows the prompt, and ends its line afterwards so the next text starts on a fresh one', async () => {
    const { io, input, written } = rig();
    const answer = io.askHidden('Token: ');
    input.write('x\n');
    await answer;
    expect(written()).toBe('Token: \n');
    io.close();
  });

  it('echoes again for the next, ordinary question', async () => {
    const { io, input, written } = rig({ tty: true });
    const hidden = io.askHidden('Token: ');
    input.write('HIDDENPART\n');
    await hidden;
    const plain = io.ask('Name: ');
    input.write('VISIBLEPART\n');
    await plain;
    expect(written()).not.toContain('HIDDENPART');
    expect(written()).toContain('VISIBLEPART');
    io.close();
  });

  it('returns null when the input ends during the hidden question, and still ends the prompt line', async () => {
    const { io, input, written } = rig();
    const answer = io.askHidden('Token: ');
    input.end();
    expect(await pending(answer)).toBeNull();
    expect(written()).toBe('Token: \n');
    io.close();
  });

  it('keeps a line typed ahead for the hidden question too', async () => {
    const { io, input } = rig();
    input.write('typed-ahead\n');
    await settle();
    expect(await io.askHidden('Token: ')).toBe('typed-ahead');
    io.close();
  });
});

describe('print', () => {
  it('writes the text and one line break', () => {
    const { io, written } = rig();
    io.print('hello');
    io.print('');
    expect(written()).toBe('hello\n\n');
    io.close();
  });
});
