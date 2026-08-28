import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import type { SafetySignal } from '@/lib/api';

/**
 * Compassionate guidance card shown when a response carries a distress
 * signal. Soft, warm, and non-alarming by design.
 */
export function SafetyCard({ safety }: { safety: SafetySignal }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.secondary,
          borderColor: colors.accent,
          borderRadius: colors.radius + 4,
        },
      ]}
      testID="safety-card"
    >
      <View style={styles.header}>
        <View
          style={[styles.iconCircle, { backgroundColor: colors.accent }]}
        >
          <Feather name="heart" size={14} color={colors.accentForeground} />
        </View>
        <Text style={[styles.title, { color: colors.secondaryForeground }]}>
          You are not alone
        </Text>
      </View>
      <Text style={[styles.message, { color: colors.secondaryForeground }]}>
        {safety.message}
      </Text>
      <View style={styles.resources}>
        {safety.resources.map((resource) => (
          <Pressable
            key={resource.label}
            disabled={!resource.url}
            onPress={() => resource.url && Linking.openURL(resource.url)}
            style={({ pressed }) => [
              styles.resource,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: colors.radius,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <View style={styles.resourceText}>
              <Text
                style={[styles.resourceLabel, { color: colors.cardForeground }]}
              >
                {resource.label}
              </Text>
              <Text
                style={[
                  styles.resourceDescription,
                  { color: colors.mutedForeground },
                ]}
              >
                {resource.description}
              </Text>
            </View>
            {resource.url && (
              <Feather
                name="external-link"
                size={15}
                color={colors.mutedForeground}
              />
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 15,
    fontFamily: fonts.displayMedium,
  },
  message: {
    fontSize: 13.5,
    lineHeight: 20,
    fontFamily: 'Inter_400Regular',
  },
  resources: {
    gap: 6,
  },
  resource: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  resourceText: {
    flex: 1,
    gap: 1,
  },
  resourceLabel: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  resourceDescription: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
  },
});
