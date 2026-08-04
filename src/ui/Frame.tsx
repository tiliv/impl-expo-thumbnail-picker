/**
 * Draws a frame, whatever its provenance.
 *
 * `synthetic://` frames paint themselves from the clip's profile at that
 * timestamp, so a fade-in clip really does render black at 0ms. That is the
 * difference between the README claiming the first frame is a bad guess and
 * you watching it be one.
 */

import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';

import { frameAppearance } from '../experiment/fakeProvider';
import { theme } from './theme';

export function Frame({
  uri,
  style,
  radius = 6,
}: {
  uri: string | null;
  style?: StyleProp<ViewStyle>;
  radius?: number;
}) {
  if (!uri) {
    return (
      <View style={[styles.empty, { borderRadius: radius }, style]}>
        <Text style={styles.emptyGlyph}>∅</Text>
      </View>
    );
  }

  if (uri.startsWith('placeholder://')) {
    return (
      <View style={[styles.placeholder, { borderRadius: radius }, style]}>
        <Text style={styles.placeholderGlyph}>▶</Text>
      </View>
    );
  }

  const appearance = frameAppearance(uri);
  if (appearance) {
    // Contrast drives how much of the scene shows through; brightness drives
    // the base. A flat frame is flat on screen, which is the whole point.
    const { hue, brightness, contrast } = appearance;
    const base = `hsl(${hue}, ${Math.round(contrast * 55)}%, ${Math.round(brightness * 100)}%)`;
    const accent = `hsl(${(hue + 45) % 360}, ${Math.round(contrast * 70)}%, ${Math.round(
      Math.min(95, brightness * 100 + contrast * 30),
    )}%)`;
    return (
      <View style={[styles.frame, { backgroundColor: base, borderRadius: radius }, style]}>
        <View style={[styles.blob, { backgroundColor: accent, opacity: 0.25 + contrast * 0.7 }]} />
        <View
          style={[
            styles.band,
            { backgroundColor: accent, opacity: contrast * 0.5 },
          ]}
        />
      </View>
    );
  }

  // Wrapped rather than styled directly: expo-image takes an ImageStyle, and
  // the callers here pass ViewStyle (which allows `overflow: scroll`).
  return (
    <View style={[styles.frame, { borderRadius: radius }, style]}>
      <Image source={{ uri }} style={styles.fill} contentFit="cover" />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden', backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  blob: { width: '46%', aspectRatio: 1, borderRadius: 999 },
  band: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '22%' },
  placeholder: {
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.border,
    borderStyle: 'dashed',
  },
  placeholderGlyph: { color: theme.textFaint, fontSize: 20 },
  empty: {
    backgroundColor: theme.bg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.danger,
  },
  emptyGlyph: { color: theme.danger, fontSize: 20 },
});
