/**
 * An item with its edit list applied.
 *
 * React Native 0.76+ ships a `filter` style prop backed by the platform's own
 * compositor — brightness, contrast, saturate, grayscale, sepia, hueRotate,
 * invert and blur. So the preview is not an approximation: it is the same
 * pipeline a browser would use, running on the GPU, with no extra dependency.
 *
 * Two things it does not do, both of which matter:
 *
 *  - **Warmth** has no primitive, so `toFilterOps` approximates it with a hue
 *    rotation. It is the one edit whose preview is a stand-in.
 *  - **It renders, it does not export.** Baking an edit list into pixels needs
 *    a capture pass (`react-native-view-shot`, Skia, or a server-side
 *    transform). See `adapters/index.ts` — that gap is why `bakeRequirement`
 *    returns a requirement rather than doing the work.
 */

import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { FilterFunction } from 'react-native';

import { toFilterOps, type EditList } from '../core/edits';
import { Frame } from './Frame';

/** Core speaks in plain data; this is the only place it becomes RN's shape. */
export function toRNFilter(edits: EditList): FilterFunction[] {
  return toFilterOps(edits).map((op): FilterFunction => {
    switch (op.fn) {
      case 'brightness':
        return { brightness: op.amount };
      case 'contrast':
        return { contrast: op.amount };
      case 'saturate':
        return { saturate: op.amount };
      case 'grayscale':
        return { grayscale: op.amount };
      case 'sepia':
        return { sepia: op.amount };
      case 'invert':
        return { invert: op.amount };
      case 'blur':
        return { blur: op.amount };
      case 'hueRotate':
        return { hueRotate: `${op.amount}deg` };
    }
  });
}

export function EditedImage({
  uri,
  edits,
  style,
  radius = 10,
}: {
  uri: string | null;
  edits: EditList;
  style?: StyleProp<ViewStyle>;
  radius?: number;
}) {
  const filter = toRNFilter(edits);

  // The filter goes on a wrapper rather than the image so a blur cannot bleed
  // past the rounded corners — blurring a view samples outside its own bounds,
  // and clipping after the fact is what keeps the edge clean.
  return (
    <View style={[styles.clip, { borderRadius: radius }, style]}>
      <View style={[styles.fill, filter.length > 0 ? { filter } : null]}>
        <Frame uri={uri} style={styles.fill} radius={0} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden', backgroundColor: '#000' },
  fill: { width: '100%', height: '100%' },
});
