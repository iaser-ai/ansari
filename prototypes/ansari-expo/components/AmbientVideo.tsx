import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Platform,
  StyleSheet,
  type View,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useEvent } from 'expo';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useScheme } from '@/hooks/useScheme';
import { useDesktop } from '@/hooks/useDesktop';
import { AMBIENT, EASE_IN_OUT, EASE_OUT } from '@/constants/motion';
import { ambientTreatment, videoSurfaceType } from '@/lib/ambientNight';

// Two encodings of the same clip, because no single one plays
// everywhere. H.264 MP4 is the universal choice — every phone decodes
// it in hardware, and it is the only thing native AVPlayer/ExoPlayer is
// handed. WebM/VP9 exists for the one case H.264 cannot serve: a
// Chromium built without proprietary codecs (dev previews, some Linux
// browsers) cannot demux H.264 at all.
//
// Which of the two a browser is handed is decided by `webPrefersMp4`
// below, and the order it asks in is the whole of the reasoning — see
// the note there before changing it.
const webmSource = require('@/assets/video/ambient-shadow.webm');
const mp4Source = require('@/assets/video/ambient-shadow.mp4');
const posterSource = require('@/assets/video/ambient-shadow-poster.jpg');

// `Platform.OS` narrowed to the three targets the compositing rules in
// `lib/ambientNight.ts` are written against; every other RN platform
// (none of which this app ships to) behaves like the web there.
const PLATFORM =
  Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
const API_LEVEL =
  Platform.OS === 'android' ? Number(Platform.Version) : undefined;

// Desktop-width web gets a landscape twin so the shadow fills a wide
// window without the hard cropping the portrait clip suffers. Web-only
// (native is phone-only), and carried in both encodings for the same
// reason the portrait clip is — desktop Safari is no more willing to
// decode VP9 than the phone is.
const desktopWebmSource = require('@/assets/video/ambient-shadow-desktop.webm');
const desktopMp4Source = require('@/assets/video/ambient-shadow-desktop.mp4');
const desktopPosterSource = require('@/assets/video/ambient-shadow-desktop-poster.jpg');

/**
 * Which of the two web encodings this browser can actually play.
 *
 * H.264 is asked first, and wins wherever the answer is a confident
 * yes. That is the opposite of the obvious order — WebM is the smaller
 * file and the one this app would rather send — and the reason is that
 * `canPlayType` cannot express the question that actually matters.
 *
 * A browser is asked about `codecs="vp9"` and answers for VP9 in
 * general; the portrait clip is VP9 *Profile 1*, 4:4:4 chroma, which
 * Apple's decoders do not implement at all. Safari on iOS learned to
 * say yes to WebM, so from that release onwards a phone was handed a
 * file it had just claimed it could play and then could not decode —
 * and what a reader saw was the poster underneath, a palm shadow that
 * never moved. There is no profile string precise enough to have caught
 * that, and there would be no way to know when the next one is wrong.
 *
 * So the order is by certainty rather than by size. H.264 Main is
 * hardware-decoded on every phone this app will ever be opened on,
 * which also makes it the cheaper clip to run even where it is the
 * larger one to fetch. WebM is left to the case it exists for: a
 * Chromium built without proprietary codecs, which cannot play H.264 at
 * all and decodes any VP9 profile in software quite happily.
 *
 * Read once: the answer cannot change while the page is open.
 */
const webPrefersMp4 = (() => {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return false;
  const probe = document.createElement('video');
  // Main profile, level 4.0 — the portrait clip's own encoding, not a
  // baseline stand-in for it.
  if (probe.canPlayType('video/mp4; codecs="avc1.4D4028"') === 'probably') {
    return true;
  }
  // Only a confident yes to VP9 earns the WebM; anything less, including
  // a hedge, falls back to H.264 and lets the element decide.
  return probe.canPlayType('video/webm; codecs="vp9"') !== 'probably';
})();

/** The clip for this platform and width, in an encoding it can decode. */
function ambientSource(desktop: boolean): number {
  if (Platform.OS !== 'web') return mp4Source;
  if (desktop) return webPrefersMp4 ? desktopMp4Source : desktopWebmSource;
  return webPrefersMp4 ? mp4Source : webmSource;
}

/**
 * On web, skip the video entirely for readers who asked to save data or
 * are on a connection where even ~50 KB is unwelcome. Native apps ship
 * the clip in the bundle, so there is nothing to save there.
 */
function connectionAllowsVideo(): boolean {
  if (Platform.OS !== 'web') return true;
  const nav = globalThis.navigator as
    | (Navigator & {
        connection?: { saveData?: boolean; effectiveType?: string };
      })
    | undefined;
  const connection = nav?.connection;
  if (!connection) return true;
  if (connection.saveData) return false;
  const type = connection.effectiveType ?? '';
  return type !== 'slow-2g' && type !== '2g';
}

// ---------------------------------------------------------------------------
// The breath. Every number that shapes the shadow's rhythm lives here.
//
// One "breath" is: swell into a drift pass across the wall, ease back down,
// creep through a lull, and swell again — where the cycle used to stop dead
// for twelve seconds. The shadow never comes to a standstill; the lull is a
// slowing, not a stop.
//
// The speeds sit closer together than the idea first suggests, and the
// reason is the source. Read the note on CREEP_RATE before widening the
// gap: a slower rate does not soften a step, it only makes the steps rarer,
// so a dramatic lull is also a visibly stuttering one. The rhythm here is
// two unhurried passes of the clip at slightly different speeds, not a
// sprint followed by a crawl.
//
// The clips are ~8.3s at 30 fps, cross-faded end-to-start, so the player
// loops them itself and the cycle never seeks: a rewind by hand would hitch
// now that the wrap happens while the picture is moving.
//
// That 8.1s is a *retimed* master. The shadow used to move at exactly the
// speed it does now, but it got there by playing a 4.5s / 24 fps clip at
// 0.55x, which is another way of saying only thirteen distinct frames
// reached the screen each second — and on a phone that is not slow motion,
// it is stepping. The slowness was moved out of the player and into the
// file: the clips were retimed by 20/11 with motion interpolation filling
// in the frames the rate used to skip, so the drift pass is now plain 1.0x
// playback of a 30 fps file. Same speed on the wall, two and a quarter
// times the frames, and the busiest phase asks nothing of the decoder at
// all. Anything that changes these rates must retime the clips to match,
// or the shadow changes speed.
//
// The retime was run over a doubled copy of each clip and cut at one
// loop's worth of frames, which is worth repeating if they are ever
// re-exported: it stops the interpolator running out of source pairs and
// truncating the tail of the cross-fade, and it puts an interpolated
// glide across the wrap, so the loop point is now softer than it was in
// the originals rather than a cut made twice as conspicuous by the
// smoother motion either side of it.
// ---------------------------------------------------------------------------

/** Drift speed: the clip's own, which the retime above made the right one.
 *  A single pass reads as a breath of light crossing a wall rather than a
 *  clip playing (~8s per pass), and at 1.0x the browser presents all 30 of
 *  the file's frames per second and never resamples the timeline. */
const DRIFT_RATE = 1;
/** The speed the lull is spent at, and the number this whole file is most
 *  sensitive to.
 *
 *  Multiply it by the file's 30 fps and you have the frames per second
 *  actually reaching the screen — and the trap is that a slower rate does
 *  not make each step smaller. A step is always one source frame of
 *  movement; a lower rate only spaces the steps further apart, which if
 *  anything makes each one easier to see. Judged by eye against the old
 *  24 fps master, in what it presented: ~2.4 fps stepped, ~6 fps still
 *  stepped, and leaning on the layer's own drift to cover it did not
 *  rescue it either — a drift strong enough to stand in for the clip is
 *  strong enough to be seen turning around. Nothing much under ~15 fps
 *  presented is fluid on its own, and ~13 was the jitter that prompted
 *  the retime.
 *
 *  So the lull is a genuine slowing rather than a crawl: 8/11 of the pass
 *  is ~22 fps, close enough to it to stay liquid, far enough below to read
 *  as the shadow easing off. The rhythm comes from the *shape* — a swell,
 *  a long slack stretch, a swell — not from the size of the gap. */
const CREEP_RATE = 8 / 11;
/** Wall-clock lengths of the four phases. Shorter and more even than the
 *  original pass-then-twelve-second-hold: at these speeds the clip gets
 *  through roughly two of its own loops per breath, which is the rhythm
 *  the layer is meant to have — unhurried, not a sprint and a stall.
 *  Deceleration is the longer ramp because a swell can arrive faster than
 *  it may leave. */
const RAMP_IN_MS = 2000;
const DRIFT_MS = 5000;
const RAMP_OUT_MS = 2600;
const CREEP_MS = 7000;
/** How often the cycle nudges the playback rate while ramping, and the
 *  smallest change worth writing — every write to `playbackRate` makes the
 *  player resync, so tiny ones only cost frame pacing. Outside the two
 *  ramps the rate is never written at all. */
const TICK_MS = 100;
/** Scaled with the rates above, so the retime did not quietly buy the
 *  player two-thirds more resyncs per ramp for the same ramp. */
const RATE_EPSILON = 0.027;

// ---------------------------------------------------------------------------
// The masking drift.
//
// The whole layer travels a slow figure eight on the compositor, under
// both the video and the poster, at display refresh, so the composite is
// never completely static between one decoded frame and the next.
//
// It is deliberately a whisper. Raising it far enough to stand in for the
// clip's own motion was tried, and the figure eight then reads as exactly
// what it is: the picture sliding one way and coming back. Below a pixel
// or so a second there is no direction to notice — only a layer that is
// never quite still.
//
// It translates and nothing else: a pure translation is the one transform
// a compositor can replay without re-rasterising the video underneath it,
// and an animated scale showed up as extra dropped frames during the fast
// pass for a breath no one could see.
// ---------------------------------------------------------------------------

/** Overscale, so the pan can never drag an edge into view. 4.5% of
 *  reserve on each side is ~14px even on a 320pt phone, twice what the
 *  pan below asks for. The shadow is a blurred wash, so the slight
 *  enlargement costs the image nothing. */
const MASK_SCALE = 1.09;
/** Pan amplitude in points. Peak speed (2π·A/period) is ~1.5 px/s: enough
 *  that the composite keeps changing while a video frame is held, small
 *  and slow enough that the turn at each end of the figure cannot be
 *  seen. Anything near 30pt reads as the layer sliding back and forth. */
const MASK_PAN_X = 7;
const MASK_PAN_Y = 5;
/** One full figure of the drift. It has to stay clear of a whole-number
 *  ratio against both of the other rhythms on this layer, or the eye is
 *  handed a beat to learn: the breath cycle below is 16.6s and the clip
 *  loops every 8.3s. 27s is 1.63 breaths and 3.27 loops, clear of both a
 *  whole and a half multiple of either. (It used to be 33s, against a
 *  stale note claiming 21.4s for the breath — which was in fact 1.99
 *  breaths and 4.06 loops, very nearly in step with each.) Vertical runs
 *  at twice the frequency, so the path is a slow figure eight rather
 *  than a line. */
const MASK_PERIOD_MS = 27000;

/**
 * The figure eight, sampled into keyframes. It is a CSS animation rather
 * than a shared value driven from JS: this runs on the UI thread on
 * native and as a real `@keyframes` rule on web, so the layer keeps
 * moving at display refresh without asking the JS thread for a frame —
 * which is the whole point of it, since it exists to cover the moments
 * the video has nothing new to show. Sampled every 2%: the segments are
 * linear, but at fifty samples a turn the corners between them are far
 * below anything the eye resolves. (Scale stays last in the list, so the
 * pan is measured in screen points rather than being magnified by it.)
 */
const MASK_KEYFRAMES = Object.fromEntries(
  Array.from({ length: 51 }, (_, i) => {
    const turn = (i / 50) * 2 * Math.PI;
    return [
      `${i * 2}%`,
      {
        transform: [
          { translateX: Math.sin(turn) * MASK_PAN_X },
          { translateY: Math.sin(2 * turn) * MASK_PAN_Y },
          { scale: MASK_SCALE },
        ],
      },
    ];
  }),
);
const maskDrift = {
  animationName: MASK_KEYFRAMES,
  animationDuration: MASK_PERIOD_MS,
  animationIterationCount: 'infinite',
  // Linear: an eased repeat would slow to nothing at every turn, which is
  // the very stillness this exists to prevent.
  animationTimingFunction: 'linear',
} as const;

const smoothstep = (p: number) => p * p * (3 - 2 * p);

/**
 * Whether the page is done with everything that actually matters.
 *
 * The shadow is the least important thing on the screen and the most
 * expensive: two encodings, a still, a decoder and a compositing layer,
 * none of which any reader is waiting for. Started on a timer, as this
 * was, it lands in the middle of the first screen's own work — fonts
 * still blocking the first word, the bundle still evaluating — and
 * costs the page real time to deliver something nobody asked for. What
 * a reader sees for that is a sequence of layers assembling.
 *
 * So it waits for the load event and then for an idle moment, and the
 * first screen gets the machine to itself. On a page that never goes
 * idle the timeout brings it in anyway.
 *
 * Native has no such notion and no bundle to fetch over the wire: there
 * the app is already up by the time this mounts, so it is settled from
 * the first frame and the video's own short delay below is the only
 * wait.
 */
function usePageSettled(): boolean {
  const [settled, setSettled] = useState(Platform.OS !== 'web');

  useEffect(() => {
    if (settled) return;

    let cancelled = false;
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const idleWindow = window as unknown as {
      requestIdleCallback?: (
        cb: () => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    const settle = () => {
      if (cancelled) return;
      if (idleWindow.requestIdleCallback) {
        idle = idleWindow.requestIdleCallback(
          () => {
            if (!cancelled) setSettled(true);
          },
          { timeout: AMBIENT.settleIdle },
        );
      } else {
        // Safari shipped `requestIdleCallback` late enough that a phone
        // in the field may still not have it; one frame past load is
        // close enough to the same moment.
        timer = setTimeout(() => {
          if (!cancelled) setSettled(true);
        }, 100);
      }
    };

    if (document.readyState === 'complete') settle();
    else window.addEventListener('load', settle, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener('load', settle);
      if (idle !== undefined) idleWindow.cancelIdleCallback?.(idle);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [settled]);

  return settled;
}

// ---------------------------------------------------------------------------
// The layer's own top and bottom edges, dissolved.
//
// A phone browser keeps a band of its own furniture above and below the
// page — the status bar, the address bar — and the page cannot paint
// into them. What it can decide is what meets them. The shadow used to
// run to the page's edge and stop dead against those bands, which is
// what made the app read as a strip cut out and laid over the browser
// rather than a page continuing under it: a wall of fronds, then a
// straight line, then cream.
//
// So the layer fades to nothing before it gets there, and what the
// browser's band meets is the page's own quiet stone. The grain is
// untouched — it is painted below this layer, and this reduces the
// layer's alpha rather than covering it over.
//
// Depths: the top clears the status bar and the floating menu button
// under it; the bottom clears the composer and the line beneath it. Web
// and phone only — a native app owns the whole glass and has no band to
// meet, and the desktop window is not clipped by anything.
// ---------------------------------------------------------------------------
const EDGE_FADE_TOP = 108;
const EDGE_FADE_BOTTOM = 140;
const edgeFade = {
  maskImage: `linear-gradient(to bottom, transparent 0px, #000 ${EDGE_FADE_TOP}px, #000 calc(100% - ${EDGE_FADE_BOTTOM}px), transparent 100%)`,
} as unknown as ViewStyle;

/**
 * The ambient "shadow on wall" loop behind the empty chat screen: a
 * heavily compressed monochrome clip that drifts under the sunlit-paper
 * surface. It is felt more than seen — low opacity, muted, no controls.
 *
 * The layer is strictly additive: the paper background paints first and
 * a tiny poster still stands in immediately, so nothing blocks first
 * paint — but the layer as a whole eases up to its ambient strength
 * rather than snapping in with the still. The video mounts a beat
 * later, fades in only once the whole clip is buffered, and if it
 * errors (or reduced
 * motion / data saver is on) the screen simply keeps the paper. When
 * `dismissed` flips on (first prompt sent, or the screen loses focus to
 * a conversation) the whole layer fades out and the player is torn
 * down; when it flips back off — the reader returned to the home
 * screen — the layer quietly eases back in.
 */
export function AmbientVideo({ dismissed }: { dismissed: boolean }) {
  const scheme = useScheme();
  const reducedMotion = useReducedMotion();
  const desktop = useDesktop();

  // Desktop-width web drifts the landscape twin; everything else keeps
  // the portrait clip. The poster stands in for whichever will mount.
  const poster = desktop ? desktopPosterSource : posterSource;
  const source = ambientSource(desktop);

  // Day lays the clip straight onto the paper: the wall is close enough
  // to the stone the page is made of to disappear into it, and the
  // fronds darken it. Night reaches the same place by multiplying — the
  // wall is multiply's identity and drops out, the fronds pull the page
  // toward the well. `lib/ambientNight.ts` holds the reasoning, the
  // measured grade, and the platform matrix; all this does is wear it.
  const treatment = ambientTreatment({
    dark: scheme === 'dark',
    clip: desktop ? 'landscape' : 'portrait',
    platform: PLATFORM,
    apiLevel: API_LEVEL,
  });
  // Nothing to draw: a platform that cannot subtract would paint the
  // near-white wall over the page, which is the defect, not the layer.
  const silent = treatment.kind === 'omit';
  const ambientOpacity = silent ? 0 : treatment.opacity;
  // Both the poster and the video hang below this view, so the still,
  // the reduced-motion path and the data-saver path all wear the same
  // grade — the video fades in over a frame already treated like it.
  const ambientStyle: ViewStyle | null =
    treatment.kind === 'night'
      ? {
          mixBlendMode: treatment.blend,
          ...(treatment.filter ? { filter: treatment.filter } : null),
        }
      : null;

  // Nothing here starts until the page has stopped working — see
  // `usePageSettled`. On web that is the load event plus an idle
  // moment; on native it is true from the first frame.
  const settled = usePageSettled();

  // And then the video waits a little longer still, behind its own
  // poster (a ~9 KB still), so the layer's arrival is one fade of a
  // finished picture rather than a still that is swapped for a clip
  // while the reader is watching it.
  const [videoWanted, setVideoWanted] = useState(false);
  useEffect(() => {
    if (!settled || silent || reducedMotion || !connectionAllowsVideo()) return;
    const handle = setTimeout(() => setVideoWanted(true), 600);
    return () => clearTimeout(handle);
  }, [settled, silent, reducedMotion]);

  // Once the fade-out finishes, unmount everything so the decoder and
  // texture are released while a conversation is on screen; coming
  // back remounts and fades in again.
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!dismissed) {
      setGone(false);
      return;
    }
    const handle = setTimeout(() => setGone(true), 500);
    return () => clearTimeout(handle);
  }, [dismissed]);

  // Starts at zero so first arrival is a ramp to ambient strength, not a
  // pop; returning from a conversation runs the very same ramp.
  const layerFade = useSharedValue(0);
  useEffect(() => {
    // Ambient, so it keeps its long durations (see AMBIENT). The
    // arrival is eased at both ends rather than front-loaded: over
    // nearly a second, a strong ease-out would put most of the light on
    // the paper in the first few frames and read as a switch being
    // thrown. Dismissal is a real exit and takes the app's exit curve.
    // Held at nothing until the page is done working. This is what
    // moves the shadow out of the load and into the moment after it.
    if (!settled) return;
    layerFade.set(
      withTiming(dismissed ? 0 : 1, {
        duration: dismissed ? AMBIENT.layerOut : AMBIENT.layerIn,
        easing: dismissed ? EASE_OUT : EASE_IN_OUT,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed, settled]);
  const layerStyle = useAnimatedStyle(() => ({
    opacity: layerFade.get() * ambientOpacity,
  }));

  if (gone || silent) return null;

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFillObject,
        ambientStyle,
        // Outside the drifting wrapper below, so the fade stays put
        // against the glass while the picture moves under it.
        Platform.OS === 'web' && !desktop ? edgeFade : null,
        layerStyle,
      ]}
      pointerEvents="none"
    >
      {/* The masking drift (see MASK_* above). Wrapping the poster as
          well as the video means the still underneath moves with the
          clip rather than sliding against it. */}
      <Animated.View
        style={[
          StyleSheet.absoluteFillObject,
          reducedMotion ? null : maskDrift,
        ]}
      >
        <Image
          source={poster}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          transition={0}
        />
        {videoWanted && !dismissed && <AmbientVideoPlayer source={source} />}
      </Animated.View>
    </Animated.View>
  );
}

/** How close the buffer must come to the end of the clip, in seconds, to
 *  count as holding the whole of it. A buffered range rarely lands
 *  exactly on the duration the metadata claims. */
const BUFFER_EPSILON_S = 0.1;
/** How long to wait for a fully buffered clip before showing it anyway.
 *  A browser that never reports a complete range — or a fetch that
 *  stalls — must not cost the reader the shadow entirely; a clip that
 *  arrives late and hitches once is still better than a still. */
const BUFFER_WAIT_MAX_MS = 8000;
const BUFFER_POLL_MS = 200;
/** Long enough for a rewound frame to be decoded and painted before
 *  anything starts dissolving toward it. */
const SEEK_SETTLE_MS = 200;

/**
 * Whether the browser holds the entire clip, not merely enough of it to
 * begin.
 *
 * `canplay` — which is what "playing" on the web amounts to — promises
 * only that playback can *start*, so the first pass runs against a file
 * that is still arriving and steps wherever the buffer runs dry. Every
 * pass after it is smooth, which is exactly what the defect looked like:
 * a bad first loop and a fine clip thereafter.
 *
 * So the player is run from the moment it mounts (on the web a browser
 * fetches nothing until asked to play, so this is also what *causes* the
 * download) and the layer above simply stays invisible over its poster
 * until the buffer is whole. What happens at that point — a stop, a
 * rewind, and only then the fade — is `primed` in the player below.
 *
 * Native needs none of this: `readyToPlay` there already means playable
 * through, and no buffered range is surfaced to check.
 */
function useClipBuffered(
  player: VideoPlayer,
  hostRef: React.RefObject<View | null>,
): boolean {
  const [buffered, setBuffered] = useState(Platform.OS !== 'web');

  useEffect(() => {
    if (Platform.OS !== 'web' || buffered) return;

    const startedAt = Date.now();
    // Polled rather than driven by the player's `timeUpdate`, which would
    // have to be left running at an interval forever to deliver the same
    // reading. This loop stops the moment it has its answer.
    const poll = setInterval(() => {
      // A nudge, and best effort only: expo-video sets no `preload`, and
      // a phone browser left to itself fetches the minimum that lets it
      // start and dribbles in the rest. Nothing below depends on this
      // landing — it only shortens the wait.
      const host = hostRef.current as unknown as HTMLElement | null;
      const el = host?.querySelector?.('video') as HTMLVideoElement | null;
      if (el && el.preload !== 'auto') el.preload = 'auto';

      // The decision itself is the player's own reading, so it does not
      // rest on expo-video's DOM staying as it is. `bufferedPosition` is
      // the end of the buffered range holding the playhead; the cycle
      // never seeks and the file arrives in order, so reaching the
      // duration means the whole clip is held.
      const { bufferedPosition, duration } = player;
      if (
        Number.isFinite(duration) &&
        duration > 0 &&
        bufferedPosition >= duration - BUFFER_EPSILON_S
      ) {
        clearInterval(poll);
        setBuffered(true);
        return;
      }

      if (Date.now() - startedAt >= BUFFER_WAIT_MAX_MS) {
        clearInterval(poll);
        setBuffered(true);
      }
    }, BUFFER_POLL_MS);

    return () => clearInterval(poll);
  }, [buffered, hostRef, player]);

  return buffered;
}

/**
 * Mounted only once the screen is interactive and the reader hasn't
 * opted out. Unmounting releases the player via useVideoPlayer's own
 * cleanup, which stops decode work the moment the layer is dismissed.
 */
function AmbientVideoPlayer({ source }: { source: number }) {
  const player = useVideoPlayer(source, (p) => {
    // The player owns the wrap. Once the layer is up the cycle below only
    // ever changes speed, so the clip runs through its end and must come
    // back to the start on its own: seeking mid-motion would hitch. The
    // one seek this file performs happens before any of that, while there
    // is nothing on screen — see `primed` below.
    //
    // This opening rate is load-bearing on the web in a way it should not
    // be: see the note on the cycle's opening phase further down.
    p.loop = true;
    p.muted = true;
    p.playbackRate = CREEP_RATE;
  });

  const { status } = useEvent(player, 'statusChange', {
    status: player.status,
  });

  // Backgrounding stops the cycle entirely — no timers, no ramps, no
  // decode — and coming back to the foreground starts a fresh breath.
  const [foreground, setForeground] = useState(
    () => AppState.currentState !== 'background',
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) =>
      setForeground(next !== 'background'),
    );
    return () => sub.remove();
  }, []);

  // Readiness is latched: once the player has been able to play, it
  // counts as ready for good. The loop seek at the end of the clip drops
  // the element back to "loading" for a few milliseconds, and a live
  // `status === 'readyToPlay'` check turned that flicker into a full
  // teardown and restart of the cycle below — the breath began again at
  // every wrap and the lull never lasted more than a second or two.
  // A real failure is the one status worth listening to: without this the
  // latch above would keep the cycle ticking, and the watchdog retrying,
  // against a player that has nothing left to give.
  //
  // Playing counts as ready even if the status never says so. A phone
  // browser can hold an element at "loading" while it is demonstrably
  // running — it buffers on its own schedule and reports late — and the
  // layer would then stay invisible over a clip that is already
  // drifting, which is indistinguishable from the still it replaced.
  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });
  const [ready, setReady] = useState(
    () => status === 'readyToPlay' || player.playing,
  );
  useEffect(() => {
    if (status === 'readyToPlay' || isPlaying) setReady(true);
  }, [status, isPlaying]);
  // On the web, playing is what *makes* a clip ready — not the other way
  // round. A browser fetches no frames until something asks it to play,
  // and iOS will not call a clip ready before it holds those frames, so
  // waiting for readiness before starting it is a deadlock: the element
  // sits on its metadata, the layer stays invisible, and the poster is
  // left standing in as a shadow that never moves. Chromium hides this
  // completely by buffering ahead unasked and reporting ready with no
  // prompting, which is why the preview has always looked right. So the
  // cycle starts on anything that is not an outright error and lets the
  // clip prove itself by running; the fade below is still held back
  // until it does, so nothing appears before there is a picture.
  const live = (Platform.OS === 'web' || ready) && status !== 'error';

  const hostRef = useRef<View>(null);
  const clipBuffered = useClipBuffered(player, hostRef);

  // Warm-up. On the web a browser fetches nothing until something asks it
  // to play, so the clip is run purely to pull itself in — invisibly, and
  // before the breath cycle owns it. However it looks while it does that
  // is nobody's business: the layer is at zero.
  useEffect(() => {
    if (Platform.OS !== 'web' || !foreground || clipBuffered) return;
    try {
      player.play();
    } catch {
      // Released player — nothing to warm.
    }
  }, [player, foreground, clipBuffered]);

  // Then it is stopped and wound back to the frame the poster is showing.
  //
  // This is what makes the fade invisible. The poster *is* the clip's
  // first frame, so a dissolve between the two is a dissolve between
  // identical pictures — but only while the clip is actually sitting on
  // that frame. Revealing it wherever the warm-up happened to leave it
  // meant cross-fading a still against a picture a second further on, and
  // a soft shadow blended over a copy of itself at a different position
  // reads precisely like the video jumping or starting again. Which is
  // what it was.
  //
  // Seeking is safe here for the same reason the warm-up is: nothing is on
  // screen. The wait afterwards is for that frame to be decoded and
  // painted before anything begins dissolving toward it.
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    if (!clipBuffered || primed) return;
    try {
      player.pause();
      player.currentTime = 0;
    } catch {
      // Released player — a remount will prime a fresh one.
    }
    const handle = setTimeout(() => setPrimed(true), SEEK_SETTLE_MS);
    return () => clearTimeout(handle);
  }, [clipBuffered, primed, player]);

  // And the breath does not begin until the fade has finished, so the clip
  // holds its first frame for the whole dissolve and starts moving only
  // once it is the only thing on screen. Nothing about the arrival asks
  // the eye to follow two changes at once.
  const [running, setRunning] = useState(false);

  // What the watchdog and the resume handler below should be enforcing at
  // any given moment: the clip is meant to be running during the warm-up
  // and once the breath has begun, and is deliberately stopped in between
  // while it waits on its first frame.
  const wantPlaying = running || (Platform.OS === 'web' && !clipBuffered);

  // The breath cycle. One effect owns every timer, so unmounting,
  // dismissing the layer, or backgrounding the app tears all of them
  // down together and remounting starts exactly one new cycle.
  useEffect(() => {
    if (!live || !foreground || !running) return;

    let cancelled = false;
    // Opens on the crawl and ramps up, which is also the speed the clip is
    // built at rest — and on the web that opening rate is, in practice,
    // the only rate there is.
    //
    // Measured over twenty-four seconds in a browser: the element reports
    // one constant playback rate and advances at exactly that rate through
    // three loops. None of the ramps below reach it. Whether the ticker is
    // being torn down or the writes are simply not forwarded is not yet
    // known, and it is not this task's to answer — but it means the rate
    // set here is the rate a reader on the web actually sees, for as long
    // as they look. Opening on anything else silently rescales the whole
    // ambient layer. Opening it at the drift speed, briefly, made the
    // shadow travel 1.4x faster than the pass that was signed off.
    let phase: 'rampIn' | 'drift' | 'rampOut' | 'creep' = 'rampIn';
    let phaseStart = Date.now();

    let lastRate = -1;
    const setRate = (rate: number, force = false) => {
      if (!force && Math.abs(rate - lastRate) < RATE_EPSILON) return;
      lastRate = rate;
      try {
        player.playbackRate = rate;
      } catch {
        // Player released mid-tick — the cleanup below is on its way.
      }
    };

    const enter = (next: typeof phase) => {
      phase = next;
      phaseStart = Date.now();
    };

    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - phaseStart;

      switch (phase) {
        case 'rampIn': {
          const p = Math.min(1, elapsed / RAMP_IN_MS);
          // The last step lands exactly on the drift speed, so the pass
          // holds the documented rate rather than wherever epsilon stopped.
          setRate(
            CREEP_RATE + (DRIFT_RATE - CREEP_RATE) * smoothstep(p),
            p >= 1,
          );
          if (p >= 1) enter('drift');
          break;
        }
        case 'drift':
          // Nothing to write: the rate stands until the pass is spent.
          if (elapsed >= DRIFT_MS) enter('rampOut');
          break;
        case 'rampOut': {
          const p = Math.min(1, elapsed / RAMP_OUT_MS);
          // Likewise lands exactly on the crawl, so the twelve seconds
          // that follow are spent at one rate and never touched again.
          setRate(
            DRIFT_RATE - (DRIFT_RATE - CREEP_RATE) * smoothstep(p),
            p >= 1,
          );
          if (p >= 1) enter('creep');
          break;
        }
        case 'creep':
          // The whole lull passes without a single write to the player:
          // a resync in the middle of a crawl is exactly what judders.
          if (elapsed >= CREEP_MS) enter('rampIn');
          break;
      }
    };

    // Start on the speed the opening phase above runs at, and from here
    // on never seek: the clip is a shadow on a wall, and wherever it
    // happens to run to is where it belongs.
    lastRate = CREEP_RATE;
    try {
      player.playbackRate = CREEP_RATE;
      player.play();
    } catch {
      // Released player — nothing left to drive.
    }
    const ticker = setInterval(tick, TICK_MS);

    return () => {
      cancelled = true;
      clearInterval(ticker);
      try {
        player.pause();
      } catch {
        // Released — nothing to stop.
      }
    };
  }, [live, foreground, player]);

  // Watchdog: the system can pause a muted ambient player behind our
  // back (audio-session interruptions around the keyboard on iOS,
  // autoplay policy inside the workspace preview iframe, app
  // backgrounding). So any stop while the clip is meant to be running is
  // a stall: start it again. `wantPlaying` is what stops this fighting
  // the one pause that is deliberate — the rewind onto the poster's
  // frame, which the watchdog would otherwise undo a quarter of a second
  // later, leaving the fade to dissolve against a moving picture again.
  useEffect(() => {
    if (isPlaying || !live || !foreground || !wantPlaying) return;
    const handle = setTimeout(() => {
      try {
        player.play();
      } catch {
        // Player already released — nothing to resume.
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [isPlaying, live, foreground, wantPlaying, player]);

  // Web autoplay policies reject play() until a user gesture; retry on
  // the first touch so the drift still comes alive in strict contexts.
  useEffect(() => {
    if (Platform.OS !== 'web' || !wantPlaying) return;
    const resume = () => {
      try {
        if (!player.playing) player.play();
      } catch {
        // Ignore — released players just stay quiet.
      }
    };
    document.addEventListener('pointerdown', resume, { passive: true });
    return () => document.removeEventListener('pointerdown', resume);
  }, [player, wantPlaying]);

  // The video only appears once it can play, the browser holds the whole
  // clip, and it is back on the poster's frame; on error it stays
  // invisible and the poster/paper carry the screen alone. The breath is
  // released at the end of the fade, not the start of it.
  const fadeIn = useSharedValue(0);
  useEffect(() => {
    if (!ready || !primed) return;
    fadeIn.set(withTiming(1, { duration: AMBIENT.videoIn, easing: EASE_OUT }));
    const handle = setTimeout(() => setRunning(true), AMBIENT.videoIn);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, primed]);
  const videoStyle = useAnimatedStyle(() => ({ opacity: fadeIn.get() }));

  return (
    <Animated.View
      ref={hostRef}
      style={[StyleSheet.absoluteFillObject, videoStyle]}
    >
      <VideoView
        player={player}
        // On web the VideoView is a raw <video> (a replaced element):
        // absolute offsets alone leave it at its intrinsic size pinned
        // top-left instead of stretching, so the landscape clip showed
        // small over the filling poster. Explicit 100% sizing makes the
        // element itself fill so `contentFit: cover` can crop to the box.
        style={[
          StyleSheet.absoluteFillObject,
          { width: '100%', height: '100%' },
        ]}
        contentFit="cover"
        nativeControls={false}
        // Without this, mobile Safari refuses to play the clip in place
        // at all: an iPhone treats a bare <video> as something to be
        // taken fullscreen on a tap, so it never autoplays and the
        // shadow stays a still. The attribute is the whole permission
        // slip for inline playback (muted is the other half, and the
        // player sets that), and expo-video only writes it if it is
        // passed. It has no meaning off the web.
        playsInline
        // Ambient decor must never claim the hardware "now playing" slot.
        showsTimecodes={false}
        // Android must decode into the view hierarchy, not a SurfaceView,
        // or the night blend and grade worn by the wrapper above never
        // reach the clip and it fades in near-white over a graded
        // poster. See `videoSurfaceType` for why this is constant.
        surfaceType={videoSurfaceType(PLATFORM)}
      />
    </Animated.View>
  );
}
