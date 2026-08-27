import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
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
import { confirmDestructive } from '@/lib/notice';
import { isHovered } from '@/lib/web';
import type { Conversation } from '@/lib/api';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Past conversations, tucked behind the menu button: recent list with
 * a search field, tap to reopen, long-press to delete.
 *
 * The search query is controlled by the parent, which forwards it to the
 * server so matches cover full answer text — not just titles and previews.
 */
export function HistorySheet({
  open,
  onClose,
  conversations,
  loading,
  query,
  onQueryChange,
  searching,
  onOpenConversation,
  onDeleteConversation,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  conversations: Conversation[];
  loading: boolean;
  query: string;
  onQueryChange: (text: string) => void;
  searching: boolean;
  onOpenConversation: (conversation: Conversation) => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onLogout: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  // On desktop widths the sheet becomes a centered dialog: same card,
  // same motion language, just lifted off the bottom edge.
  const desktop = useDesktop();
  const [rendered, setRendered] = useState(false);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (open) {
      onQueryChange('');
      setRendered(true);
      progress.value = withTiming(1, {
        duration: reducedMotion ? 0 : 260,
        easing: Easing.out(Easing.cubic),
      });
    } else if (rendered) {
      progress.value = withTiming(
        0,
        { duration: reducedMotion ? 0 : 180, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setRendered)(false);
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reducedMotion]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * (desktop ? 24 : 48) }],
  }));

  const confirmDelete = (conversation: Conversation) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    confirmDestructive('Delete conversation?', conversation.title, 'Delete', () =>
      onDeleteConversation(conversation),
    );
  };

  const bottomPad = desktop
    ? 22
    : Platform.OS === 'web'
      ? 34
      : Math.max(insets.bottom, 16);

  return (
    <Modal
      visible={rendered}
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
          {!desktop && (
            <View style={[styles.grabber, { backgroundColor: colors.border }]} />
          )}
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.cardForeground }]}>
              Past questions
            </Text>
            <View style={styles.headerActions}>
              <Pressable
                onPress={onLogout}
                hitSlop={8}
                style={(state) => [
                  styles.logoutButton,
                  { opacity: state.pressed ? 0.6 : isHovered(state) ? 0.8 : 1 },
                ]}
                testID="history-logout"
              >
                <Feather name="log-out" size={15} color={colors.mutedForeground} />
                <Text style={[styles.logoutText, { color: colors.mutedForeground }]}>
                  Log out
                </Text>
              </Pressable>
              <Pressable
                onPress={onClose}
                hitSlop={8}
                style={(state) => [
                  styles.closeButton,
                  {
                    backgroundColor: colors.muted,
                    opacity: state.pressed ? 0.6 : isHovered(state) ? 0.8 : 1,
                  },
                ]}
                testID="history-close"
              >
                <Feather name="x" size={17} color={colors.mutedForeground} />
              </Pressable>
            </View>
          </View>

          <View
            style={[
              styles.searchBox,
              {
                backgroundColor: colors.muted,
                borderColor: colors.border,
              },
            ]}
          >
            <Feather name="search" size={15} color={colors.mutedForeground} />
            <TextInput
              value={query}
              onChangeText={onQueryChange}
              placeholder="Search your questions and answers"
              placeholderTextColor={colors.mutedForeground}
              autoFocus={desktop}
              style={[styles.searchInput, { color: colors.cardForeground }]}
              testID="history-search"
            />
            {query.length > 0 && (
              <Pressable
                onPress={() => onQueryChange('')}
                hitSlop={8}
                style={(state) => [
                  styles.pointer,
                  { opacity: state.pressed || isHovered(state) ? 0.7 : 1 },
                ]}
              >
                <Feather
                  name="x-circle"
                  size={15}
                  color={colors.mutedForeground}
                />
              </Pressable>
            )}
          </View>

          {loading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : conversations.length === 0 ? (
            <View style={styles.empty}>
              <Feather
                name={searching ? 'search' : 'message-circle'}
                size={22}
                color={colors.mutedForeground}
              />
              <Text
                style={[styles.emptyText, { color: colors.mutedForeground }]}
              >
                {searching
                  ? 'No matches — try a different word.'
                  : 'Questions you ask will appear here.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={conversations}
              keyExtractor={(c) => c.id}
              style={styles.list}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.listContent}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => onOpenConversation(item)}
                  onLongPress={() => confirmDelete(item)}
                  style={(state) => [
                    styles.row,
                    {
                      backgroundColor: isHovered(state)
                        ? colors.secondary
                        : colors.muted,
                      borderRadius: colors.radius,
                      opacity: state.pressed ? 0.7 : 1,
                    },
                  ]}
                  testID={`conversation-${item.id}`}
                >
                  <View style={styles.rowText}>
                    <Text
                      style={[
                        styles.rowTitle,
                        { color: colors.cardForeground },
                      ]}
                      numberOfLines={1}
                    >
                      {item.title}
                    </Text>
                    <Text
                      style={[
                        styles.rowPreview,
                        { color: colors.mutedForeground },
                      ]}
                      numberOfLines={1}
                    >
                      {item.preview}
                    </Text>
                  </View>
                  <Text
                    style={[styles.rowTime, { color: colors.mutedForeground }]}
                  >
                    {timeAgo(item.updatedAt)}
                  </Text>
                </Pressable>
              )}
            />
          )}
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            {desktop
              ? 'Click and hold a question to delete it.'
              : 'Hold a question to delete it.'}
          </Text>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(40, 36, 30, 0.45)',
  },
  backdropPress: {
    flex: 1,
  },
  sheetContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  // Desktop: the same card, centered with air on every side.
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
    maxHeight: '82%',
    gap: 12,
  },
  dialogSheet: {
    width: '100%',
    maxWidth: 560,
    borderRadius: 24,
    paddingTop: 18,
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
    alignItems: 'center',
    gap: 12,
  },
  title: {
    flex: 1,
    fontSize: 20,
    fontFamily: fonts.display,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  logoutText: {
    fontSize: 14,
    fontFamily: fonts.bodyMedium,
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'web' ? 10 : 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14.5,
    fontFamily: fonts.body,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  loader: {
    marginVertical: 24,
  },
  empty: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 26,
  },
  emptyText: {
    fontSize: 13.5,
    fontFamily: fonts.body,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    gap: 8,
    paddingBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
    cursor: 'pointer',
  },
  pointer: {
    cursor: 'pointer',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 14.5,
    fontFamily: fonts.bodySemiBold,
  },
  rowPreview: {
    fontSize: 12.5,
    fontFamily: fonts.body,
  },
  rowTime: {
    fontSize: 12,
    fontFamily: fonts.bodyMedium,
  },
  hint: {
    fontSize: 11.5,
    fontFamily: fonts.body,
    textAlign: 'center',
  },
});
