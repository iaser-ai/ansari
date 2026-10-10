// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { useEffect, useState } from 'react';
import { createRequire } from 'node:module';
import path from 'node:path';
import { act, cleanup, render } from '@testing-library/react';

// Render through react-native-web: reanimated's animated wrappers are
// stood in for with plain ones, and its animation builders with no-ops.
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  return {
    default: { View },
    Easing: { bezier: () => () => 0 },
    ReduceMotion: { System: 'system' },
    cubicBezier: () => 'ease-out',
    useReducedMotion: () => reducedMotion,
    useSharedValue: (initial: number) => {
      let value = initial;
      return { get: () => value, set: (v: number) => (value = v) };
    },
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (v: unknown) => v,
  };
});
vi.mock('expo-image', () => ({ Image: () => null }));

/**
 * A stand-in for expo-video's player: it records every write to
 * `playbackRate` and emits `playingChange` the way the real one does, so
 * the watchdog sees the clip running and stays out of the way.
 */
class FakePlayer {
  loop = false;
  muted = false;
  playing = false;
  status = 'readyToPlay';
  duration = 11.37;
  bufferedPosition = 11.37;
  currentTime = 0;
  rateWrites: number[] = [];
  playCalls = 0;
  /** A player that never loads and never errors (iOS Low Power Mode). */
  inert = false;
  private listeners = new Set<(playing: boolean) => void>();
  private statusListeners = new Set<(status: string) => void>();

  set playbackRate(rate: number) {
    this.rateWrites.push(rate);
  }
  play() {
    this.playCalls += 1;
    // A failed or inert element accepts the call and plays nothing.
    if (this.status === 'error' || this.inert) return;
    this.setPlaying(true);
  }
  /** The element errors, wherever it had got to. */
  fail() {
    this.status = 'error';
    this.setPlaying(false);
    this.statusListeners.forEach((fn) => fn('error'));
  }
  onStatus(fn: (status: string) => void) {
    this.statusListeners.add(fn);
    return () => {
      this.statusListeners.delete(fn);
    };
  }
  pause() {
    this.setPlaying(false);
  }
  onPlaying(fn: (playing: boolean) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private setPlaying(next: boolean) {
    this.playing = next;
    this.listeners.forEach((fn) => fn(next));
  }
}

let player: FakePlayer;
let reducedMotion = false;

vi.mock('expo-video', () => ({
  useVideoPlayer: (_source: unknown, setup: (p: FakePlayer) => void) => {
    const [p] = useState(() => {
      setup(player);
      return player;
    });
    return p;
  },
  VideoView: () => null,
}));
vi.mock('expo', () => ({
  useEvent: (p: FakePlayer, name: string, initial: object) => {
    const [value, setValue] = useState(initial);
    useEffect(() => {
      if (name === 'statusChange') return p.onStatus((status) => setValue({ status }));
      if (name !== 'playingChange') return;
      return p.onPlaying((isPlaying) => setValue({ isPlaying }));
    }, [p, name]);
    return value;
  },
}));

import { DAY_STRENGTH } from '@/lib/ambientNight';

// The component `require`s its clips the way Metro wants them. Under Node
// that is a real CommonJS require, which knows neither the `@/` alias nor
// what to do with a video, so both are taught here: an asset resolves to
// its file and loads as its own path, which is all a mocked player needs.
const assetExtensions = ['.webm', '.mp4', '.jpg'];
const Module = createRequire(import.meta.url)('node:module') as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
  _extensions: Record<string, (m: { exports: unknown }, file: string) => void>;
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = (request, ...rest) =>
  request.startsWith('@/assets/')
    ? path.resolve(__dirname, '..', request.slice(2))
    : resolveFilename(request, ...rest);
for (const ext of assetExtensions) {
  Module._extensions[ext] = (m, file) => {
    m.exports = file;
  };
}
const { AmbientVideo } = await import('@/components/AmbientVideo');

/** Page settle (jsdom has no idle callback), the video's own beat, a
 *  buffer poll, and the rewind's settle — everything before the clip is
 *  ready to be seen. */
const UNTIL_READY = 250 + 600 + 200 + 200;

/** Moves the clock in small steps, each in its own `act`: React only
 *  re-renders when an `act` ends, so a timer a re-render would register
 *  (the next stage of the arrival) must not be skipped past in one leap. */
const STEP_MS = 10;
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= STEP_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(STEP_MS, left));
    });
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  player = new FakePlayer();
  reducedMotion = false;
});

/** The layer itself: the outermost view, which wears the fade. */
const layerOpacity = (container: HTMLElement) =>
  Number((container.firstElementChild as HTMLElement).style.opacity);
/** The video's own host inside the drifting wrapper (the poster is
 *  mocked to nothing, so it is the wrapper's only child). */
const videoOpacity = (container: HTMLElement) =>
  Number(
    (container.firstElementChild?.firstElementChild?.lastElementChild as HTMLElement)
      .style.opacity,
  );
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AmbientVideo — playback pace (issue #254)', () => {
  it('sets the rate to 1.0 once and never writes it again', async () => {
    render(<AmbientVideo dismissed={false} />);
    await advance(UNTIL_READY + 60_000);

    expect(player.rateWrites).toEqual([1]);
    expect(player.playing).toBe(true);
  });

  it('starts the clip the moment it is ready, without the watchdog', async () => {
    render(<AmbientVideo dismissed={false} />);
    // Up to the frame before it is ready: warmed, rewound, and held.
    await advance(UNTIL_READY - 10);
    expect(player.playing).toBe(false);
    const before = player.playCalls;

    // The effect that owns playback must re-run when `running` flips. The
    // watchdog would also start a stopped clip, but only 250ms later — so
    // a play inside that window can only have come from the effect.
    await advance(10);
    expect(player.playCalls).toBe(before + 1);
    expect(player.playing).toBe(true);
  });

  it('leaves no timer running once the clip is playing', async () => {
    render(<AmbientVideo dismissed={false} />);
    await advance(UNTIL_READY + 1_000);

    expect(player.playing).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses the clip when the layer is dismissed', async () => {
    const { rerender } = render(<AmbientVideo dismissed={false} />);
    await advance(UNTIL_READY + 1_000);
    expect(player.playing).toBe(true);

    rerender(<AmbientVideo dismissed />);
    await advance(0);
    expect(player.playing).toBe(false);
  });
});

describe('AmbientVideo — arrival (issue #254)', () => {
  it('shows nothing — not even the poster — until the clip is ready', async () => {
    const { container } = render(<AmbientVideo dismissed={false} />);
    await advance(UNTIL_READY - 10);
    expect(layerOpacity(container)).toBe(0);

    // Then the whole layer comes up in one fade, with the clip already
    // moving under it.
    await advance(10);
    expect(layerOpacity(container)).toBe(DAY_STRENGTH);
    expect(player.playing).toBe(true);
  });

  it('fades as a CSS transition, eased in and out', async () => {
    const { container } = render(<AmbientVideo dismissed={false} />);
    await advance(UNTIL_READY);
    const layer = container.firstElementChild as HTMLElement;
    expect(layer.style.transitionProperty).toBe('opacity');
    expect(layer.style.transitionDuration).toBe('1200ms');
  });

  it('brings the poster in alone when the player fails', async () => {
    player.status = 'error';
    const { container } = render(<AmbientVideo dismissed={false} />);
    // Past the buffer wait, which primes even a clip it never heard from:
    // the failure must still keep that clip from counting as ready.
    await advance(UNTIL_READY + 9_000);
    expect(layerOpacity(container)).toBe(DAY_STRENGTH);
    expect(videoOpacity(container)).toBe(0);
    expect(player.playing).toBe(false);
  });

  it('never shows a clip that failed mid-warm-up, even once the buffer wait primes it', async () => {
    player.bufferedPosition = 0;
    const { container } = render(<AmbientVideo dismissed={false} />);
    // Settle and the video's beat: the warm-up has it playing, which
    // latches readiness. Then it errors before the buffer is whole.
    await advance(250 + 600 + 100);
    expect(player.playing).toBe(true);
    await act(async () => player.fail());

    // The buffer wait gives up and primes it anyway.
    await advance(9_000);
    expect(videoOpacity(container)).toBe(0);
    expect(layerOpacity(container)).toBe(DAY_STRENGTH);
  });

  it('hides the video again, leaving the poster, when it fails after arriving', async () => {
    const { container } = render(<AmbientVideo dismissed={false} />);
    await advance(UNTIL_READY);
    expect(videoOpacity(container)).toBe(1);

    await act(async () => player.fail());
    await advance(10);
    expect(videoOpacity(container)).toBe(0);
    expect(layerOpacity(container)).toBe(DAY_STRENGTH);
  });

  it('brings the poster in by the deadline when the clip never loads', async () => {
    player.inert = true;
    player.status = 'loading';
    player.bufferedPosition = 0;
    const { container } = render(<AmbientVideo dismissed={false} />);
    // Settle and the video's own beat, then the full deadline.
    await advance(250 + 600 + 10_000 - 10);
    expect(layerOpacity(container)).toBe(0);
    await advance(10);
    expect(layerOpacity(container)).toBe(DAY_STRENGTH);
    expect(videoOpacity(container)).toBe(0);

    // A tap can still bring the clip to life, on the poster's own frame.
    player.inert = false;
    await act(async () => {
      document.dispatchEvent(new Event('pointerdown'));
    });
    await advance(10);
    expect(player.playing).toBe(true);
    expect(videoOpacity(container)).toBe(1);
  });

  it('brings the poster in alone under reduced motion, with no player', async () => {
    reducedMotion = true;
    const { container } = render(<AmbientVideo dismissed={false} />);
    await advance(250);
    expect(layerOpacity(container)).toBe(DAY_STRENGTH);
    expect(player.playCalls).toBe(0);
  });

  it('fades out on dismissal and waits for the clip again on return', async () => {
    const { container, rerender } = render(<AmbientVideo dismissed={false} />);
    await advance(UNTIL_READY + 1_000);
    rerender(<AmbientVideo dismissed />);
    await advance(0);
    expect(layerOpacity(container)).toBe(0);

    await advance(1_000);
    player = new FakePlayer();
    rerender(<AmbientVideo dismissed={false} />);
    await advance(10);
    expect(layerOpacity(container)).toBe(0);
    await advance(UNTIL_READY);
    expect(layerOpacity(container)).toBe(DAY_STRENGTH);
  });
});
