// @vitest-environment jsdom
/**
 * The web keyboard shim, driven the way a phone browser drives it.
 *
 * The shim listens at import time, to a `visualViewport` and a coarse
 * pointer that jsdom has neither of, so every test stands both up and
 * imports a fresh copy. Nothing here lays anything out — jsdom has no
 * layout — so what is held to account is what the shim writes to the
 * shell, and when, which is what the reader sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-reanimated', () => ({
  makeMutable: (value: number) => ({
    value,
    set(next: number) {
      this.value = next;
    },
  }),
  // The destination is all a test can see of an animation.
  withTiming: (to: number) => to,
}));
vi.mock('@/constants/motion', () => ({ EASE_OUT: 'ease-out' }));

type Viewport = EventTarget & {
  height: number;
  offsetTop: number;
  scale: number;
};

const SCREEN = 844;
const FIRST_GUESS_ROOM = Math.round(SCREEN * 0.52);

let viewport: Viewport;
let listening: [string, EventListenerOrEventListenerObject][] = [];
let shim: typeof import('./useKeyboard.web');

async function load() {
  vi.resetModules();
  shim = await import('./useKeyboard.web');
}

function field(tag: 'textarea' | 'input' | 'button' = 'textarea') {
  const element = document.createElement(tag);
  document.body.appendChild(element);
  return element;
}

const shell = () => document.body.style;

beforeEach(async () => {
  vi.useFakeTimers();
  window.localStorage.clear();
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: SCREEN,
  });
  viewport = Object.assign(new EventTarget(), {
    height: SCREEN,
    offsetTop: 0,
    scale: 1,
  });
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  });
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: coarse)',
  })) as unknown as typeof window.matchMedia;
  // Each fresh import listens again, on the same window; the ones it
  // leaves behind are taken off after the test.
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      listening.push([type, listener]);
      add(type, listener);
    },
  );
  await load();
});

afterEach(() => {
  (document.activeElement as HTMLElement | null)?.blur?.();
  for (const [type, listener] of listening) {
    window.removeEventListener(type, listener);
  }
  listening = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('making room', () => {
  it('shortens the shell inside the focus event itself', () => {
    field().focus();
    // Synchronously: the browser decides whether the field is covered
    // as soon as the event is dispatched.
    expect(shell().height).toBe(`${FIRST_GUESS_ROOM}px`);
    expect(shim.useKeyboardProgress().value).toBe(1);
  });

  it('leaves the shell alone for a field that takes no text', () => {
    field('button').focus();
    expect(shell().height).toBe('');
  });

  it('leaves the shell alone while the page is pinched', () => {
    viewport.scale = 2;
    field().focus();
    expect(shell().height).toBe('');
  });

  it('tells listeners after the new shell is laid out, before focus returns', () => {
    const order: string[] = [];
    const bodyHeight = vi
      .spyOn(document.body, 'offsetHeight', 'get')
      .mockImplementation(() => {
        order.push('layout');
        return 0;
      });
    shim.onShellResize(() => order.push(`listener:${shell().height}`));
    field().focus();
    // A listener reads the scroller's new height; before the forced
    // layout it would still read the old one.
    expect(order).toEqual(['layout', `listener:${FIRST_GUESS_ROOM}px`]);
    bodyHeight.mockRestore();
  });

  it('stops telling a listener once it unsubscribes', () => {
    const heard = vi.fn();
    const unsubscribe = shim.onShellResize(heard);
    unsubscribe();
    field().focus();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('giving room back', () => {
  it('holds the room when focus moves between two fields', () => {
    field().focus();
    field('input').focus();
    vi.advanceTimersByTime(100);
    expect(shell().height).toBe(`${FIRST_GUESS_ROOM}px`);
  });

  it('hands the room back once the field lets go', () => {
    const composer = field();
    composer.focus();
    composer.blur();
    vi.advanceTimersByTime(79);
    expect(shell().height).toBe(`${FIRST_GUESS_ROOM}px`);
    vi.advanceTimersByTime(1);
    expect(shell().height).toBe('');
    expect(shim.useKeyboardProgress().value).toBe(0);
  });

  it('hands the room back when no keyboard ever arrives', () => {
    // A hardware keyboard: the viewport never moves.
    field().focus();
    vi.advanceTimersByTime(700);
    expect(shell().height).toBe('');
  });
});

describe('measuring the keyboard that came', () => {
  function keyboardUp(room: number) {
    viewport.height = room;
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(320);
  }

  it('corrects the guess to the measured room and remembers it', () => {
    field().focus();
    keyboardUp(400);
    expect(shell().height).toBe('400px');
    expect(
      window.localStorage.getItem(`ansari.keyboard.${Math.round(window.innerWidth)}`),
    ).toBe('400');
  });

  it('tells listeners about the correction', () => {
    const heard = vi.fn();
    field().focus();
    shim.onShellResize(heard);
    keyboardUp(400);
    expect(heard).toHaveBeenCalled();
  });

  it('uses the remembered room on the next visit instead of guessing', async () => {
    window.localStorage.setItem(
      `ansari.keyboard.${Math.round(window.innerWidth)}`,
      '410',
    );
    await load();
    field().focus();
    expect(shell().height).toBe('410px');
  });
});
