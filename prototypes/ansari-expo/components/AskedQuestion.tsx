import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { RADIUS, rounded } from '@/constants/radius';

/**
 * The reader's own words.
 *
 * Solid, unoutlined: a soft card a step *above* the paper — `secondary`,
 * the palette's one quiet fill, and so exactly the material of the
 * suggested question it replaces. The two are the same shape with the
 * same ink, and they take one decision between them; nothing here picks
 * its own colour. It is the one filled block on the page, which is what
 * keeps it from reading like the outlined source pills beneath an
 * answer.
 *
 * The chip carries a relief that this does not, and the difference is
 * what each one is: a chip is a control and has to read as raised
 * enough to press, while this is the reader's own words lying on the
 * page.
 *
 * Lives in its own component because it is drawn on *two* screens: it
 * lifts out of the composer on the home screen and then continues into
 * the thread. Any difference between the two would show as a jump at the
 * hand-off, so both must render exactly this.
 */
export function AskedQuestion({
  text,
  selectable = false,
  onLongPress,
}: {
  text: string;
  /**
   * On the web this is simply whether the words can be dragged over. On
   * a phone it is a mode the hold menu switches on, because a
   * selectable <Text> swallows the long press that opens that menu.
   */
  selectable?: boolean;
  /** Held down. Absent while the question is in flight, and on the web. */
  onLongPress?: () => void;
}) {
  const colors = useColors();
  const bubble = [
    styles.bubble,
    {
      backgroundColor: colors.secondary,
      ...rounded(RADIUS.lg),
    },
  ];
  const words = (
    <Text
      selectable={selectable}
      style={[styles.text, { color: colors.secondaryForeground }]}
    >
      {text}
    </Text>
  );
  return (
    <View style={styles.row}>
      {/* A pressable only where there is something to press: a held
          mouse button is not a gesture, and wrapping the bubble on the
          web would put a pointer cursor over the reader's own words.
          `accessible={false}` — this is one short line of what they
          said, and a screen reader should hear it as that. */}
      {onLongPress ? (
        <Pressable onLongPress={onLongPress} accessible={false} style={bubble}>
          {words}
        </Pressable>
      ) : (
        <View style={bubble}>{words}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '84%',
    paddingHorizontal: 15,
    paddingVertical: 11,
  },
  text: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.bodyMedium,
  },
});
