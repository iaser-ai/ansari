import React, { useEffect, useState } from 'react';
import {
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useDesktop } from '@/hooks/useDesktop';
import { fonts } from '@/constants/colors';
import { isHovered } from '@/lib/web';
import type { Citation } from '@/lib/api';

const SOURCE_LABEL: Record<string, string> = {
  quran: "Qur'an",
  hadith: 'Hadith',
  scholarly: 'Scholarly work',
};

/**
 * The signature surface: an "illuminated folio" source viewer.
 * Arabic source text is set in Amiri (classical Naskh) beneath a gold
 * ornament rule, so verifying evidence feels like opening the book
 * itself. Presented with a Reanimated fade-and-rise that runs on the
 * UI thread and collapses to instant when reduced motion is on.
 */
export function CitationSheet({
  citation,
  onClose,
}: {
  citation: Citation | null;
  onClose: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  // On desktop widths the folio presents as a centered dialog — the
  // same illuminated card, lifted off the bottom edge.
  const desktop = useDesktop();
  const [current, setCurrent] = useState<Citation | null>(null);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (citation) {
      setCurrent(citation);
      progress.value = withTiming(1, {
        duration: reducedMotion ? 0 : 260,
        easing: Easing.out(Easing.cubic),
      });
    } else if (current) {
      progress.value = withTiming(
        0,
        { duration: reducedMotion ? 0 : 180, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setCurrent)(null);
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citation, reducedMotion]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * (desktop ? 24 : 48) }],
  }));

  const bottomPad = desktop
    ? 22
    : Platform.OS === 'web'
      ? 34
      : Math.max(insets.bottom, 16);

  return (
    <Modal
      visible={current !== null}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={styles.backdropPress} onPress={onClose} />
      </Animated.View>
      <View
        style={[styles.sheetContainer, desktop && styles.dialogContainer]}
        pointerEvents="box-none"
      >
        <Animated.View
          style={[
            styles.sheet,
            desktop && styles.dialogSheet,
            sheetStyle,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              paddingBottom: bottomPad,
            },
          ]}
        >
          {current && (
            <>
              {!desktop && (
                <View
                  style={[styles.grabber, { backgroundColor: colors.border }]}
                />
              )}
              <View style={styles.header}>
                <View style={styles.headerText}>
                  <Text
                    style={[
                      styles.kind,
                      {
                        color:
                          current.sourceType === 'hadith'
                            ? colors.accent
                            : colors.primary,
                      },
                    ]}
                  >
                    {SOURCE_LABEL[current.sourceType] ?? current.sourceType}
                  </Text>
                  <Text
                    style={[styles.reference, { color: colors.cardForeground }]}
                  >
                    {current.reference}
                  </Text>
                  <Text
                    style={[
                      styles.sourceTitle,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {current.sourceTitle}
                  </Text>
                </View>
                <Pressable
                  onPress={onClose}
                  hitSlop={8}
                  style={(state) => [
                    styles.closeButton,
                    {
                      backgroundColor: colors.muted,
                      opacity:
                        state.pressed ? 0.6 : isHovered(state) ? 0.8 : 1,
                    },
                  ]}
                  testID="citation-close"
                >
                  <Feather name="x" size={17} color={colors.mutedForeground} />
                </Pressable>
              </View>

              <ScrollView
                style={styles.body}
                showsVerticalScrollIndicator={false}
              >
                {current.arabicText && (
                  <>
                    <View style={styles.ornamentRow}>
                      <View
                        style={[
                          styles.ornamentRule,
                          { backgroundColor: colors.accent },
                        ]}
                      />
                      <Text style={[styles.ornament, { color: colors.accent }]}>
                        ۝
                      </Text>
                      <View
                        style={[
                          styles.ornamentRule,
                          { backgroundColor: colors.accent },
                        ]}
                      />
                    </View>
                    <Text
                      selectable={Platform.OS === 'web'}
                      style={[styles.arabic, { color: colors.cardForeground }]}
                    >
                      {current.arabicText}
                    </Text>
                  </>
                )}
                <Text
                  selectable={Platform.OS === 'web'}
                  style={[
                    styles.translation,
                    { color: colors.cardForeground },
                    current.arabicText ? styles.translationSpacing : null,
                  ]}
                >
                  {current.translationText}
                </Text>
              </ScrollView>

              {current.url && (
                <Pressable
                  onPress={() => Linking.openURL(current.url!)}
                  style={(state) => [
                    styles.linkButton,
                    {
                      backgroundColor: colors.primary,
                      borderRadius: colors.radius,
                      opacity:
                        state.pressed ? 0.85 : isHovered(state) ? 0.92 : 1,
                    },
                  ]}
                  testID="citation-open-source"
                >
                  <Feather
                    name="book-open"
                    size={16}
                    color={colors.primaryForeground}
                  />
                  <Text
                    style={[
                      styles.linkText,
                      { color: colors.primaryForeground },
                    ]}
                  >
                    Read the full source
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 25, 22, 0.45)',
  },
  backdropPress: {
    flex: 1,
  },
  sheetContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  // Desktop: the folio centers with a scrim on every side.
  dialogContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 8,
    maxHeight: '78%',
    gap: 12,
  },
  dialogSheet: {
    width: '100%',
    maxWidth: 620,
    borderRadius: 24,
    paddingTop: 20,
    paddingHorizontal: 24,
    maxHeight: '80%',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  kind: {
    fontSize: 11,
    fontFamily: fonts.bodySemiBold,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  reference: {
    fontSize: 21,
    fontFamily: fonts.display,
  },
  sourceTitle: {
    fontSize: 13,
    fontFamily: fonts.body,
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  body: {
    flexGrow: 0,
  },
  ornamentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  ornamentRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    opacity: 0.6,
  },
  ornament: {
    fontSize: 18,
    lineHeight: 24,
  },
  arabic: {
    fontSize: 26,
    lineHeight: 52,
    fontFamily: fonts.arabic,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  translation: {
    fontSize: 15.5,
    lineHeight: 25,
    fontFamily: fonts.body,
  },
  translationSpacing: {
    marginTop: 14,
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
  },
  linkText: {
    fontSize: 14.5,
    fontFamily: fonts.bodySemiBold,
  },
});
