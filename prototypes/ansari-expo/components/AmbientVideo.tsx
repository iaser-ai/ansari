import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useScheme } from '@/hooks/useScheme';
import { useDesktop } from '@/hooks/useDesktop';

// Web gets VP9/WebM: Chromium builds without proprietary codecs (dev
// previews, some Linux browsers) cannot demux H.264 at all, while VP9
// decodes everywhere Chromium runs. Native AVPlayer/ExoPlayer is the
// mirror image — H.264 MP4 is the safe universal choice there.
const videoSource =
  Platform.OS === 'web'
    ? require('@/assets/video/ambient-shadow.webm')
    : require('@/assets/video/ambient-shadow.mp4');
const posterSource = require('@/assets/video/ambient-shadow-poster.jpg');

// Desktop-width web gets a landscape twin so the shadow fills a wide
// window without the hard cropping the portrait clip suffers. It is
// web-only (native is phone-only), so only the WebM/poster pair exists.
const desktopVideoSource = require('@/assets/video/ambient-shadow-desktop.webm');
const desktopPosterSource = require('@/assets/video/ambient-shadow-desktop-poster.jpg');

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

/**
 * The ambient "shadow on wall" loop behind the empty chat screen: a
 * heavily compressed monochrome clip that drifts under the sunlit-paper
 * surface. It is felt more than seen — low opacity, muted, no controls.
 *
 * The layer is strictly additive: the paper background paints first and
 * a tiny poster still stands in immediately, so nothing blocks first
 * paint. The video mounts a beat later, fades in only once it can play,
 * and if it errors (or reduced motion / data saver is on) the screen
 * simply keeps the paper. When `dismissed` flips on (first prompt sent,
 * or the screen loses focus to a conversation) the whole layer fades
 * out and the player is torn down; when it flips back off — the reader
 * returned to the home screen — the layer quietly fades back in.
 */
export function AmbientVideo({ dismissed }: { dismissed: boolean }) {
  const scheme = useScheme();
  const reducedMotion = useReducedMotion();
  const desktop = useDesktop();

  // Desktop-width web drifts the landscape twin; everything else keeps
  // the portrait clip. The poster stands in for whichever will mount.
  const poster = desktop ? desktopPosterSource : posterSource;
  const source = desktop ? desktopVideoSource : videoSource;

  // The shadow should whisper: bright regions sink into the paper.
  const ambientOpacity = scheme === 'dark' ? 0.16 : 0.3;

  // Defer the video past first paint so it never competes with fonts
  // or layout; the poster (a ~9 KB still) carries the first frame.
  const [videoWanted, setVideoWanted] = useState(false);
  useEffect(() => {
    if (reducedMotion || !connectionAllowsVideo()) return;
    const handle = setTimeout(() => setVideoWanted(true), 600);
    return () => clearTimeout(handle);
  }, [reducedMotion]);

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

  const layerFade = useSharedValue(1);
  useEffect(() => {
    layerFade.value = withTiming(dismissed ? 0 : 1, {
      duration: 420,
      easing: Easing.out(Easing.quad),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed]);
  const layerStyle = useAnimatedStyle(() => ({
    opacity: layerFade.value * ambientOpacity,
  }));

  if (gone) return null;

  return (
    <Animated.View
      style={[StyleSheet.absoluteFillObject, layerStyle]}
      pointerEvents="none"
    >
      <Image
        source={poster}
        style={StyleSheet.absoluteFillObject}
        contentFit="cover"
        transition={0}
      />
      {videoWanted && !dismissed && <AmbientVideoPlayer source={source} />}
    </Animated.View>
  );
}

/**
 * Mounted only once the screen is interactive and the reader hasn't
 * opted out. Unmounting releases the player via useVideoPlayer's own
 * cleanup, which stops decode work the moment the layer is dismissed.
 */
function AmbientVideoPlayer({ source }: { source: number }) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
    // The shadow should drift, not march — a touch under real time.
    p.playbackRate = 0.7;
    p.play();
  });

  const { status } = useEvent(player, 'statusChange', {
    status: player.status,
  });

  // Watchdog: the system can pause a muted ambient player behind our
  // back (audio-session interruptions around the keyboard on iOS,
  // autoplay policy inside the workspace preview iframe, app
  // backgrounding). Whenever playback stops while the layer is still
  // meant to be alive, quietly start it again.
  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });
  useEffect(() => {
    if (isPlaying || status !== 'readyToPlay') return;
    const handle = setTimeout(() => {
      try {
        player.play();
      } catch {
        // Player already released — nothing to resume.
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [isPlaying, status, player]);

  // Web autoplay policies reject play() until a user gesture; retry on
  // the first touch so the loop still comes alive in strict contexts.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const resume = () => {
      try {
        if (!player.playing) player.play();
      } catch {
        // Ignore — released players just stay quiet.
      }
    };
    document.addEventListener('pointerdown', resume, { passive: true });
    return () => document.removeEventListener('pointerdown', resume);
  }, [player]);

  // The video only appears once it can actually play; on error it
  // stays invisible and the poster/paper carry the screen alone.
  const ready = status === 'readyToPlay';
  const fadeIn = useSharedValue(0);
  useEffect(() => {
    if (ready) {
      fadeIn.value = withTiming(1, {
        duration: 700,
        easing: Easing.out(Easing.quad),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const videoStyle = useAnimatedStyle(() => ({ opacity: fadeIn.value }));

  return (
    <Animated.View style={[StyleSheet.absoluteFillObject, videoStyle]}>
      <VideoView
        player={player}
        // On web the VideoView is a raw <video> (a replaced element):
        // absolute offsets alone leave it at its intrinsic size pinned
        // top-left instead of stretching, so the landscape clip showed
        // small over the filling poster. Explicit 100% sizing makes the
        // element itself fill so `contentFit: cover` can crop to the box.
        style={[StyleSheet.absoluteFillObject, { width: '100%', height: '100%' }]}
        contentFit="cover"
        nativeControls={false}
        // Ambient decor must never claim the hardware "now playing" slot.
        showsTimecodes={false}
      />
    </Animated.View>
  );
}
