/**
 * Filters, non-destructively.
 *
 * Presets across the top for the one-tap case, individual sliders underneath
 * for the fiddling. Every control writes into the same edit list, so a preset
 * is just a set of slider values and nudging one afterwards does not drop you
 * out of anything — there is no "custom" mode to fall into.
 *
 * The blur slider carries a warning above the redaction threshold. That is not
 * decoration: past that point the edit stops being a look and starts being a
 * privacy claim, and the send path treats it differently.
 */

import React from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  EDIT_SPECS,
  hasEdits,
  isRedactive,
  matchPreset,
  PRESETS,
  setEdit,
  valueOf,
  type EditKind,
  type EditList,
} from '../core/edits';
import { EditedImage } from './EditedImage';
import { theme } from './theme';

const SLIDER_KINDS: EditKind[] = ['brightness', 'contrast', 'saturate', 'warmth', 'grayscale', 'blur'];

export function FilterRail({
  uri,
  edits,
  onChange,
}: {
  uri: string;
  edits: EditList;
  onChange(next: EditList): void;
}) {
  const active = matchPreset(edits);

  return (
    <View style={styles.root}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>Adjust</Text>
        {hasEdits(edits) && (
          <Pressable onPress={() => onChange([])}>
            <Text style={styles.reset}>Reset</Text>
          </Pressable>
        )}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presets}>
        {PRESETS.map((preset) => (
          <Pressable key={preset.id} onPress={() => onChange(preset.edits)} style={styles.preset}>
            <EditedImage
              uri={uri}
              edits={preset.edits}
              style={[styles.presetThumb, active?.id === preset.id && styles.presetThumbActive]}
              radius={8}
            />
            <Text style={[styles.presetLabel, active?.id === preset.id && styles.presetLabelActive]}>
              {preset.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {SLIDER_KINDS.map((kind) => (
        <Slider
          key={kind}
          kind={kind}
          value={valueOf(edits, kind)}
          onChange={(value) => onChange(setEdit(edits, kind, value))}
        />
      ))}
    </View>
  );
}

function Slider({
  kind,
  value,
  onChange,
}: {
  kind: EditKind;
  value: number;
  onChange(value: number): void;
}) {
  const spec = EDIT_SPECS[kind];
  const [width, setWidth] = React.useState(0);
  const widthRef = React.useRef(0);
  widthRef.current = width;

  const fraction = (value - spec.min) / (spec.max - spec.min);
  const redacting = isRedactive({ kind, value });

  const responder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => seek(e.nativeEvent.locationX),
        onPanResponderMove: (e) => seek(e.nativeEvent.locationX),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind],
  );

  function seek(x: number) {
    if (widthRef.current <= 0) return;
    const f = Math.min(1, Math.max(0, x / widthRef.current));
    const raw = spec.min + f * (spec.max - spec.min);
    onChange(Math.round(raw / spec.step) * spec.step);
  }

  return (
    <View style={styles.slider}>
      <View style={styles.sliderHead}>
        <Text style={styles.sliderLabel}>{spec.label}</Text>
        {redacting && <Text style={styles.redactBadge}>hides detail · will be flattened</Text>}
        <Text style={styles.sliderValue}>
          {value === spec.neutral ? '—' : value.toFixed(kind === 'blur' ? 1 : 2)}
        </Text>
      </View>
      <View
        style={styles.sliderTrack}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        {...responder.panHandlers}
      >
        <View style={styles.sliderRail} />
        {/* A tick at neutral, so "back to nothing" is findable by eye. */}
        <View style={[styles.neutralTick, { left: `${((spec.neutral - spec.min) / (spec.max - spec.min)) * 100}%` }]} />
        <View
          style={[
            styles.sliderKnob,
            { left: `${fraction * 100}%` },
            redacting && styles.sliderKnobRedactive,
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { color: theme.text, fontSize: 13, fontWeight: '600' },
  reset: { color: theme.accent, fontSize: 12, fontWeight: '600' },
  presets: { gap: 8, paddingVertical: 2 },
  preset: { alignItems: 'center', gap: 4 },
  presetThumb: { width: 58, height: 58, borderWidth: 2, borderColor: 'transparent' },
  presetThumbActive: { borderColor: theme.accent },
  presetLabel: { color: theme.textFaint, fontSize: 10 },
  presetLabelActive: { color: theme.accent, fontWeight: '700' },
  slider: { gap: 5 },
  sliderHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sliderLabel: { color: theme.textDim, fontSize: 11, flexShrink: 0 },
  redactBadge: { color: theme.warn, fontSize: 9, flex: 1, textAlign: 'right' },
  sliderValue: {
    color: theme.textFaint,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
    minWidth: 34,
    textAlign: 'right',
  },
  sliderTrack: { height: 26, justifyContent: 'center' },
  sliderRail: { height: 3, borderRadius: 2, backgroundColor: theme.border },
  neutralTick: {
    position: 'absolute',
    width: 2,
    height: 9,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: theme.textFaint,
  },
  sliderKnob: {
    position: 'absolute',
    width: 16,
    height: 16,
    marginLeft: -8,
    borderRadius: 8,
    backgroundColor: theme.accent,
  },
  sliderKnobRedactive: { backgroundColor: theme.warn },
});
