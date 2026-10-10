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
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { useScheme } from '@/hooks/useScheme';
import { useDesktop } from '@/hooks/useDesktop';
import { AMBIENT, EASE_IN_OUT_CSS, EASE_OUT_CSS } from '@/constants/motion';
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
 * general; the portrait clip was once VP9 *Profile 1*, 4:4:4 chroma,
 * which Apple's decoders do not implement at all. (Both WebMs are
 * Profile 0 now — see `scripts/retime-ambient.sh` — but the next encode
 * could as easily drift, and nothing here would notice.) Safari on iOS
 * learned to say yes to WebM, so from that release onwards a phone was
 * handed a file it had just claimed it could play and then could not
 * decode —
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
// The pace.
//
// The clip plays at exactly 1.0x and nothing ever changes its rate. The
// speed the shadow crosses the wall at is baked into the file instead.
//
// That is the cure for a judder that only a phone showed (issue #254).
// The layer used to play a 30 fps file at 8/11 speed, which put ~21.8
// source frames a second in front of a 60 Hz display: a number that does
// not divide the refresh, so frames were held for an irregular mix of two
// and three refreshes and the drift surged and hesitated several times a
// second. Measured in mobile Safari with `requestVideoFrameCallback`:
// 233 frames held for three refreshes and 21 for two at 8/11, against 352
// of 354 held for exactly two at 1.0x. A desktop hides the difference; a
// phone does not.
//
// So the slowness lives in the file. The clips are retimed by 11/8 with
// motion interpolation (`scripts/retime-ambient.sh`, which holds the
// procedure), so plain playback moves the shadow exactly as fast as the
// old 8/11 did, with every presented frame a real one. They are ~11.4s at
// 30 fps, cross-faded end-to-start and interpolated across the wrap, so
// the player loops them itself and nothing ever seeks once the layer is
// up. Anything that changes PLAYBACK_RATE must retime the clips to match,
// or the shadow changes speed.
//
// There used to be a "breath" here as well — a JS-timer cycle that ramped
// the rate between 8/11 and 1.0 every ~16.6s. It never ran: its effect
// gated on a flag it did not list as a dependency, so it bailed out once
// before the fade and was never asked again, and the opening 8/11 was the
// only rate any reader saw. Making it run would have meant ~25 live
// `playbackRate` writes per ramp, each one a resync of the media pipeline
// mid-decode, which is the opposite of smooth. The look that was signed
// off is the steady pace, and that is what the retime preserves.
// ---------------------------------------------------------------------------

/** The one playback rate. The clip's own speed is the right one — see
 *  above — and 1.0x is the only rate at which the browser presents every
 *  source frame without resampling the timeline. */
const PLAYBACK_RATE = 1;

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
// and an animated scale showed up as extra dropped frames for a swell no
// one could see.
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
 *  ratio against the other rhythm on this layer, or the eye is handed a
 *  beat to learn: the clip loops every ~11.4s, and 27s is 2.38 loops,
 *  clear of both a whole and a half multiple. Vertical runs at twice the
 *  frequency, so the path is a slow figure eight rather than a line. */
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
 * So it waits for the load event, then for the page's fonts, then for an
 * idle moment, and the first screen gets the machine to itself. On a
 * page that never goes idle the timeout brings it in anyway.
 *
 * Native has no such notion and no bundle to fetch over the wire: there
 * the app is already up by the time this mounts, so it is settled from
 * the first frame and the video's own short delay below is the only
 * wait.
 */
/** The idle moment, on a browser that cannot report one. */
const SETTLE_FALLBACK_MS = 250;

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

    const settle = async () => {
      // A font that lands mid-fade reflows the words over the shadow while
      // it is surfacing. `fonts.ready` resolves at once if none is pending.
      await document.fonts?.ready.catch(() => undefined);
      if (cancelled) return;
      if (idleWindow.requestIdleCallback) {
        idle = idleWindow.requestIdleCallback(
          () => {
            if (!cancelled) setSettled(true);
          },
          { timeout: AMBIENT.settleIdle },
        );
      } else {
        // Safari does not ship `requestIdleCallback`, so on an iPhone this
        // is the path every reader takes. One frame past load proved too
        // soon there: the shadow arrived while the first screen was still
        // painting, and the fade dropped frames with it (issue #254). A
        // short beat lets the page's own first work finish.
        timer = setTimeout(() => {
          if (!cancelled) setSettled(true);
        }, SETTLE_FALLBACK_MS);
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
 * The layer is strictly additive: the paper paints first and nothing
 * here blocks it. The shadow then arrives as one event — nothing at all
 * until the page has settled and the clip is fully buffered, rewound to
 * the poster's frame and already moving, then a single fade of the
 * whole layer to its ambient strength. Where no clip is coming (reduced
 * motion, data saver, a player error) the poster arrives in that same
 * fade instead, as a still. When
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
  // `usePageSettled`. On web that is the load event, the fonts and an
  // idle moment; on native it is true from the first frame.
  const settled = usePageSettled();

  // And then the video waits a little longer still, so its download and
  // decode do not compete with the page's last work either.
  const videoExpected =
    settled && !silent && !reducedMotion && connectionAllowsVideo();
  const [videoWanted, setVideoWanted] = useState(false);
  useEffect(() => {
    if (!videoExpected) return;
    const handle = setTimeout(() => setVideoWanted(true), 600);
    return () => clearTimeout(handle);
  }, [videoExpected]);

  // What the player has to say about itself: nothing yet, ready to be
  // seen (buffered, on the poster's frame, moving), or failed — in which
  // case the poster arrives alone.
  const [clip, setClip] = useState<ClipState>('pending');

  // And a deadline on hearing it. A phone can neither load the clip nor
  // report an error — iOS Low Power Mode refuses muted autoplay and
  // defers the fetch, and expo-video only reports ready once frames are
  // held — and a layer waiting on that would never show at all, poster
  // included. So past the deadline the poster arrives alone, as it does
  // for a failure. A clip that comes good later (a tap can start it)
  // still takes over: it surfaces on the very frame the poster shows.
  useEffect(() => {
    if (!videoWanted || dismissed || clip !== 'pending') return;
    const handle = setTimeout(
      () => setClip((now) => (now === 'pending' ? 'failed' : now)),
      ARRIVAL_DEADLINE_MS,
    );
    return () => clearTimeout(handle);
  }, [videoWanted, dismissed, clip]);

  // Once the fade-out finishes, unmount everything so the decoder and
  // texture are released while a conversation is on screen; coming
  // back remounts the player, which has to earn its arrival again.
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!dismissed) {
      setGone(false);
      return;
    }
    setClip('pending');
    const handle = setTimeout(() => setGone(true), 500);
    return () => clearTimeout(handle);
  }, [dismissed]);

  // The one fade (see AMBIENT.layerIn). Held at nothing until the page
  // is done working and, where a clip is coming, until it is ready —
  // so the poster never shows first and then gives way to the clip.
  // Eased at both ends on the way in, so there is no frame where the
  // shadow appears; dismissal is a real exit and takes the exit curve.
  const shown =
    settled && !dismissed && (videoExpected ? clip !== 'pending' : true);
  // Reanimated's CSS transition props, which its typings will not let
  // share a style array with the plain view styles around them.
  const layerFade = {
    opacity: shown ? ambientOpacity : 0,
    transitionProperty: 'opacity',
    transitionDuration: `${shown ? AMBIENT.layerIn : AMBIENT.layerOut}ms`,
    transitionTimingFunction: shown ? EASE_IN_OUT_CSS : EASE_OUT_CSS,
  } as unknown as ViewStyle;
  if (gone || silent) return null;

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFillObject,
        ambientStyle,
        // Outside the drifting wrapper below, so the fade stays put
        // against the glass while the picture moves under it.
        Platform.OS === 'web' && !desktop ? edgeFade : null,
        layerFade,
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
        {videoWanted && !dismissed && (
          <AmbientVideoPlayer
            // A new source (crossing the desktop breakpoint) is a new
            // player, which has to earn its arrival like the first.
            key={source}
            source={source}
            onSettle={setClip}
          />
        )}
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
/** How long, from asking for the clip, the layer waits to hear from the
 *  player before bringing the poster in alone. Past the buffer wait, so
 *  a slow fetch that does complete still arrives as the moving clip. */
const ARRIVAL_DEADLINE_MS = BUFFER_WAIT_MAX_MS + 2000;

/** Where the clip stands, as the layer sees it. */
type ClipState = 'pending' | 'ready' | 'failed';
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
      // the end of the buffered range holding the playhead; the warm-up
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
 *
 * It never shows itself: it says when it is ready to be seen — or that
 * it never will be — and the layer above runs the one fade.
 */
function AmbientVideoPlayer({
  source,
  onSettle,
}: {
  source: number;
  onSettle: (state: Exclude<ClipState, 'pending'>) => void;
}) {
  const player = useVideoPlayer(source, (p) => {
    // The player owns the wrap: the clip runs through its end and comes
    // back to the start on its own, since seeking mid-motion would hitch.
    // The one seek this file performs happens before the layer is up,
    // while there is nothing on screen — see `primed` below.
    //
    // The rate is set once, here, and never again (see PLAYBACK_RATE). It
    // is written rather than left to the default so no player can start
    // at anything else.
    p.loop = true;
    p.muted = true;
    p.playbackRate = PLAYBACK_RATE;
  });

  const { status } = useEvent(player, 'statusChange', {
    status: player.status,
  });

  // Backgrounding stops playback entirely — no decode — and coming back
  // to the foreground plays on from wherever the clip was.
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
  // teardown and restart of playback below at every wrap.
  // A real failure is the one status worth listening to: without this the
  // latch above would keep playback wanted, and the watchdog retrying,
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
  // prompting, which is why the preview has always looked right. So
  // playback starts on anything that is not an outright error and lets the
  // clip prove itself by running; the layer's fade is still held back
  // until it does, so nothing appears before there is a picture.
  // A failure is latched like readiness is: a player that has errored is
  // done, whatever it reports afterwards, and never counts as ready —
  // not even when the buffer wait times out and primes it regardless.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (status === 'error') setFailed(true);
  }, [status]);
  const live = (Platform.OS === 'web' || ready) && !failed;

  const hostRef = useRef<View>(null);
  const clipBuffered = useClipBuffered(player, hostRef);

  // Warm-up. On the web a browser fetches nothing until something asks it
  // to play, so the clip is run purely to pull itself in — invisibly, and
  // before playback proper owns it. However it looks while it does that
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
  // The poster *is* the clip's first frame, so the clip arrives exactly
  // where the still underneath it is, and the reduced-motion and error
  // paths show the same picture the clip starts from. Left wherever the
  // warm-up happened to stop, the shadow would surface already a second
  // into its pass — and if the clip ever failed after that, fall back to
  // a still a second behind it.
  //
  // Seeking is safe here for the same reason the warm-up is: nothing is on
  // screen. The wait afterwards is for that frame to be decoded and
  // painted before the layer begins to fade up over it.
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

  // Ready to be seen: able to play, holding the whole clip, back on the
  // poster's frame, and not failed. From here it moves — and it moves
  // from the first frame of the layer's fade, so the shadow surfaces
  // already drifting rather than as a still that then lurches into
  // motion. A failure after this point takes it away again, and the
  // poster underneath carries the layer.
  const running = ready && primed && !failed;

  // Tell the layer.
  useEffect(() => {
    if (running) onSettle('ready');
  }, [running, onSettle]);
  useEffect(() => {
    if (failed) onSettle('failed');
  }, [failed, onSettle]);

  // What the watchdog and the resume handler below should be enforcing at
  // any given moment: the clip is meant to be running during the warm-up
  // and once it is ready to be seen, and is deliberately stopped in
  // between while it waits on its first frame.
  const wantPlaying = running || (Platform.OS === 'web' && !clipBuffered);

  // Playback, once the clip is ready to be seen. `running` is a dependency
  // here like everything else the effect reads: the breath cycle this
  // replaced gated on it without listing it, so it bailed out once before
  // the fade and never ran at all. Unmounting, dismissing the layer, or
  // backgrounding the app pauses the clip; coming back plays it on.
  useEffect(() => {
    if (!live || !foreground || !running) return;
    try {
      player.play();
    } catch {
      // Released player — nothing left to drive.
    }
    return () => {
      try {
        player.pause();
      } catch {
        // Released — nothing to stop.
      }
    };
  }, [live, foreground, running, player]);

  // Watchdog: the system can pause a muted ambient player behind our
  // back (audio-session interruptions around the keyboard on iOS,
  // autoplay policy inside the workspace preview iframe, app
  // backgrounding). So any stop while the clip is meant to be running is
  // a stall: start it again. `wantPlaying` is what stops this fighting
  // the one pause that is deliberate — the rewind onto the poster's
  // frame, which the watchdog would otherwise undo a quarter of a second
  // later, before that frame was ever painted.
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
  // Kept armed while the clip has never managed to play at all: after
  // the buffer wait gives up on such a clip nothing else is still
  // trying, and a tap is the one thing that can still start it.
  const awaitingGesture = Platform.OS === 'web' && !ready && !failed;
  useEffect(() => {
    if (Platform.OS !== 'web' || !(wantPlaying || awaitingGesture)) return;
    const resume = () => {
      try {
        if (!player.playing) player.play();
      } catch {
        // Ignore — released players just stay quiet.
      }
    };
    document.addEventListener('pointerdown', resume, { passive: true });
    return () => document.removeEventListener('pointerdown', resume);
  }, [player, wantPlaying, awaitingGesture]);

  // Hidden until it is ready to be seen, so a clip mid-warm-up never
  // shows through the poster — and hidden again for good the moment it
  // fails, leaving the poster to carry the layer alone. No fade of its
  // own: on arrival the layer above is still at nothing while this flips.
  const videoStyle = { opacity: running ? 1 : 0 };

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
