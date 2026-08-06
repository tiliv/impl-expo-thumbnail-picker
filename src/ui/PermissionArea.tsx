/**
 * The big area with the single button in it.
 *
 * > A big area with a single button in it is clear. A tiny button hiding on the
 * > screen is not clear.
 *
 * `core/permission.ts` makes the tiny button unrepresentable — there is no
 * affordance shape that means "small control". This file is the other half of
 * that: it makes the big one *look* big, and it is the only component allowed to
 * render a permission prompt.
 *
 * ## Two shapes, and the difference matters
 *
 * - **`block`** — the region cannot work. It **replaces** the region, filling
 *   it, with the headline as the largest text in view and one full-width
 *   button. Nothing else competes for the tap.
 * - **`notice`** — the region *works*, partially (iOS limited photos, Android
 *   14 partial media). It sits **above** the region, full width and short, and
 *   the region stays live underneath. Demoting this to a block would be lying
 *   about the feature and nagging somebody about a choice they made on purpose.
 *
 * ## What this component will not do
 *
 * No dismiss affordance. A permission banner you can dismiss is one you dismiss
 * once and then cannot find again, which is the tiny-hidden-button problem
 * arriving by another route. It disappears when the permission changes and at
 * no other time.
 *
 * No secondary action. `Affordance.action` is one-or-none by construction, and
 * a "not now" beside a "Continue" turns a clear area into a decision.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ActionEffect, Affordance } from '../core/permission';
import { theme } from './theme';

export function PermissionArea({
  affordance,
  onAct,
  /**
   * Minimum height for a `block`. The number is the point: a permission prompt
   * that shrinks to fit its text is a permission prompt nobody sees.
   */
  minHeight = 168,
}: {
  affordance: Affordance;
  onAct: (effect: ActionEffect) => void;
  minHeight?: number;
}) {
  if (affordance.kind === 'none') return null;

  const isBlock = affordance.kind === 'block';
  const { action } = affordance;

  return (
    <View
      accessibilityRole="summary"
      // Headline and body read as one announcement. Hearing "Allow access to
      // your photos" without "we ask only when you attach one" is the version
      // that sounds like a demand.
      accessibilityLabel={`${affordance.headline}. ${affordance.body}`}
      style={[
        styles.base,
        {
          backgroundColor: isBlock ? theme.surface : theme.surfaceAlt,
          borderColor: isBlock ? theme.border : theme.warn,
          padding: isBlock ? theme.space * 2 : theme.space,
          gap: isBlock ? theme.space : theme.space / 2,
        },
        isBlock ? { minHeight, justifyContent: 'center' } : styles.notice,
      ]}
    >
      <View style={styles.words}>
        <Text style={[isBlock ? styles.blockHeadline : styles.noticeHeadline, { color: theme.text }]}>
          {affordance.headline}
        </Text>
        <Text style={[styles.body, { color: theme.textDim }]}>{affordance.body}</Text>
      </View>

      {action !== null && (
        <Pressable
          onPress={() => onAct(action.effect)}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          // 48pt tall, and full width inside a block. A permission button that
          // is merely tappable is not the same as one that is obviously the
          // thing to tap.
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: theme.accent,
              opacity: pressed ? 0.8 : 1,
              alignSelf: isBlock ? 'stretch' : 'flex-start',
              paddingHorizontal: isBlock ? theme.space : theme.space * 1.5,
            },
          ]}
        >
          <Text style={styles.buttonText}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { borderWidth: 1, width: '100%', borderRadius: theme.radius },
  // A notice is short and full width — a bar, not a card, so it reads as
  // attached to the region below it rather than as a thing of its own.
  notice: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  words: { gap: 4, flexShrink: 1 },
  blockHeadline: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  noticeHeadline: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  body: { fontSize: 13, lineHeight: 18 },
  button: {
    minHeight: 48,
    borderRadius: theme.radiusSm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: '#0b1220', fontSize: 15, fontWeight: '600' },
});
