import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { Attachment } from '@/lib/api';
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
  attachments = [],
  selectable = false,
  onLongPress,
}: {
  text: string;
  /**
   * The images the question was asked with (spec 211). A thumbnail while the
   * picked image is still in hand; afterwards only a marker that one was
   * there, because the image itself is never stored.
   */
  attachments?: Attachment[];
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
  const images =
    attachments.length > 0 ? (
      <View style={styles.images}>
        {attachments.map((a, i) => (
          <AttachmentTile key={i} attachment={a} />
        ))}
      </View>
    ) : null;
  // An image-only question has no words to set in a bubble.
  if (!text) {
    return <View style={styles.row}>{images}</View>;
  }
  return (
    <View style={styles.column}>
      {images}
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
    </View>
  );
}

/**
 * One attached image. With the picked image in hand it is a thumbnail;
 * without it — any time after the question left this screen — it is a quiet
 * tile that says plainly the image was not kept, so nobody goes looking for
 * a picture that no longer exists.
 */
function AttachmentTile({ attachment }: { attachment: Attachment }) {
  const colors = useColors();
  const frame = [styles.tile, rounded(RADIUS.md)];
  if (attachment.uri) {
    return (
      <Image
        source={{ uri: attachment.uri }}
        style={frame}
        accessibilityLabel="Attached image"
      />
    );
  }
  return (
    <View
      style={[frame, styles.placeholder, { backgroundColor: colors.secondary }]}
      accessible
      accessibilityLabel="Attached image, not stored"
    >
      <Feather name="image" size={18} color={colors.mutedForeground} />
      <Text style={[styles.placeholderText, { color: colors.mutedForeground }]}>
        Not stored
      </Text>
    </View>
  );
}

const TILE = 72;

const styles = StyleSheet.create({
  column: {
    gap: 6,
  },
  images: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 6,
    maxWidth: '84%',
  },
  tile: {
    width: TILE,
    height: TILE,
    overflow: 'hidden',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  placeholderText: {
    fontSize: 11,
    fontFamily: fonts.bodyMedium,
  },
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
