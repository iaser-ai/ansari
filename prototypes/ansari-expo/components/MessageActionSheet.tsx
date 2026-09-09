import React, { useEffect, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { DURATION } from '@/constants/motion';
import { copyToClipboard } from '@/lib/clipboard';
import {
  closeMessageActions,
  useMessageActions,
  type MessageActionTarget,
} from '@/lib/messageActions';
import { toast } from '@/lib/toast';
import { PressableScale } from '@/components/PressableScale';
import { Sheet } from '@/components/Sheet';
import { answerExcerpt } from '@/components/SourcePanel';
import { RADIUS, rounded } from '@/constants/radius';

/**
 * What can be done with a message, when a reader holds it down.
 *
 * A desktop puts these under the cursor: the copy and share controls
 * appear on the answer the pointer is over. A thumb has no hover, so on
 * a phone the same three things arrive the way every other list of
 * choices in the app does — as a sheet, with the same grabber, the same
 * scrim, and the same pull-down to put it away.
 *
 * Mounted once by the root layout and driven by `lib/messageActions`,
 * because the press comes from a row inside a virtualized thread: a
 * sheet per message would be a modal in every row for the sake of the
 * one being held.
 *
 * The actions run *after* the sheet has left rather than beneath it. A
 * notice raised while a modal is still on screen is a notice behind a
 * modal, and the platform's own share sheet does not like being asked
 * to open over one that is on its way out.
 */
export function MessageActionSheet() {
  const colors = useColors();
  const target = useMessageActions();
  const open = target !== null;

  // Held past the store clearing, so the sheet still has something to
  // draw while it leaves.
  const [current, setCurrent] = useState<MessageActionTarget | null>(null);
  useEffect(() => {
    if (target) setCurrent(target);
  }, [target]);

  if (!current) return null;

  const noun = current.kind === 'answer' ? 'Answer' : 'Question';

  const run = (action: () => void) => {
    closeMessageActions();
    setTimeout(action, DURATION.exit);
  };

  const copy = () =>
    run(async () => {
      if (await copyToClipboard(current.text)) {
        toast.success(`${noun} copied`);
      } else {
        toast.error(`Couldn't copy the ${noun.toLowerCase()}`, {
          detail: 'Try “Select text” and copy the part you need.',
        });
      }
    });

  const share = () =>
    run(async () => {
      try {
        await Share.share({ message: current.text });
      } catch {
        toast.error('Sharing is unavailable', {
          detail: 'Try “Select text” and share the part you need.',
        });
      }
    });

  const select = () =>
    run(() => {
      current.onSelectText();
      toast('Press and hold to select', {
        detail: `This ${noun.toLowerCase()} can now be selected, word by word.`,
      });
    });

  const header = (
    <View style={styles.header}>
      <Text style={[styles.title, { color: colors.strongForeground }]}>
        {current.kind === 'answer' ? 'Answer' : 'Your question'}
      </Text>
      <Text
        style={[styles.excerpt, { color: colors.mutedForeground }]}
        numberOfLines={2}
      >
        “{answerExcerpt(current.text)}”
      </Text>
    </View>
  );

  return (
    <Sheet
      open={open}
      onClose={closeMessageActions}
      onExited={() => setCurrent(null)}
      accessibilityViewIsModal
      accessibilityLabel={`Actions for this ${noun.toLowerCase()}`}
      header={header}
    >
      <View style={styles.actions}>
        <Action icon="copy" label="Copy" onPress={copy} />
        <Action icon="share-2" label="Share" onPress={share} />
        <Action icon="type" label="Select text" onPress={select} />
      </View>
    </Sheet>
  );
}

/**
 * One choice. Full width and well over a thumb's minimum, because a
 * sheet raised by a thumb is a poor place to ask for precision.
 */
function Action({
  icon,
  label,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={`message-action-${label.toLowerCase().replace(/\s+/g, '-')}`}
      style={(state) => [
        styles.action,
        {
          backgroundColor: state.pressed ? colors.lifted : 'transparent',
        },
      ]}
    >
      <Feather name={icon} size={17} color={colors.mutedForeground} />
      <Text style={[styles.actionText, { color: colors.foreground }]}>
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: 2,
  },
  title: {
    fontSize: 19,
    fontFamily: fonts.display,
  },
  // The words the actions will act on, quoted the way the sources panel
  // quotes the answer it belongs to.
  excerpt: {
    fontSize: 12.5,
    lineHeight: 17,
    fontFamily: fonts.displayItalic,
  },
  actions: {
    paddingTop: 4,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 52,
    paddingHorizontal: 8,
    ...rounded(RADIUS.md),
    cursor: 'pointer',
  },
  actionText: {
    fontSize: 15.5,
    fontFamily: fonts.bodyMedium,
  },
});
