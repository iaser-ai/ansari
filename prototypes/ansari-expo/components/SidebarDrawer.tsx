import React, { useEffect } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { useOverlayFocus } from '@/hooks/useOverlayFocus';
import {
  closeSidebarDrawer,
  useSidebarDrawer,
  useSidebarDrawerDrawn,
  useSidebarDrawerProgress,
} from '@/hooks/useSidebarDrawer';
import { SIDEBAR_WIDTH } from '@/constants/layout';
import { Sidebar } from '@/components/Sidebar';

/**
 * The rail on a phone.
 *
 * A phone has no width to spare — the rail is 268pt and the narrowest
 * screen worth designing for is 320 — so it cannot stand beside the
 * page the way it does on a desktop. It arrives over it instead, on a
 * scrim, and leaves as soon as the reader has done what they opened it
 * for. That is the same rail, not a second navigation written twice:
 * the past questions, the search, the way to start a new one and the
 * colophon are all the component below, told it is a drawer.
 *
 * The remaining sliver of page at the trailing edge is deliberate. It
 * is what says the drawer is over the page rather than being a page of
 * its own, and it is the largest target for putting it away.
 *
 * Being over the page is a claim a keyboard has to be able to feel as
 * well: while the drawer is out, Tab stays inside it, Escape puts it
 * away, and focus goes back to the button that opened it. Unlike a
 * sheet this is not a modal — it is a view lying over the page — so
 * nothing supplies that but `useOverlayFocus`, the same lifecycle the
 * sheets and the sources panel take.
 */
export function SidebarDrawer() {
  const colors = useColors();
  const open = useSidebarDrawer();
  const drawn = useSidebarDrawerDrawn();
  const progress = useSidebarDrawerProgress();
  const overlayID = useOverlayFocus(open, closeSidebarDrawer);

  // Android's back gesture puts away whatever is over the page before
  // it leaves the page — a drawer that ignored it would send the reader
  // out of the app instead of back to what they were reading.
  useEffect(() => {
    if (Platform.OS !== 'android' || !open) return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        closeSidebarDrawer();
        return true;
      },
    );
    return () => subscription.remove();
  }, [open]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.get() }));

  // The rail travels its own width, so it is fully off the screen at
  // rest rather than peeking. Handed to the rail itself rather than
  // applied to a wrapper around it — see the `style` prop on `Sidebar`.
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(progress.get(), [0, 1], [-SIDEBAR_WIDTH, 0]),
      },
    ],
  }));

  if (!drawn) return null;

  return (
    <>
      <Animated.View
        style={[styles.scrim, { backgroundColor: colors.scrim }, scrimStyle]}
      >
        {/* The page behind is not a place to press while the drawer is
            over it. This is also the way out: tapping the page you can
            still see is how every drawer is dismissed. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={closeSidebarDrawer}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          testID="sidebar-drawer-scrim"
        />
      </Animated.View>

      <Sidebar
        drawer
        onNavigate={closeSidebarDrawer}
        style={panelStyle}
        nativeID={overlayID}
      />
    </>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    // Over the page, under the rail — which carries its own layer at
    // 30 — and under the toasts, which sit far above both: a notice
    // raised from inside the drawer still has to be readable.
    zIndex: 29,
  },
});
