/**
 * Pick a frame off the timeline.
 *
 * The scrub maths lives in `core/filmstrip.ts`, not here — mapping a drag to a
 * time and snapping to nearby cached frames is the part that is easy to get
 * subtly wrong, and it should be testable without a gesture.
 *
 * Two details that separate this from a slider:
 *
 *  - **Snapping.** Dragging generates far more positions than we can extract
 *    frames for. Without snapping to the filmstrip's already-extracted times,
 *    the preview flickers between cached and fresh frames and reads as jitter.
 *  - **Debounced extraction.** Every position change would otherwise kick off
 *    a decode. The filmstrip is the immediate feedback; the sharp preview
 *    catches up.
 *
 * PanResponder rather than gesture-handler on purpose: it is in React Native
 * already, and one fewer native module is one fewer thing to reconcile when
 * this lands in the real app. Swap in gesture-handler and Reanimated if the
 * scrub needs to run off the JS thread.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { sampleTimes, snapToSample, timeAtOffset, offsetAtTime } from '../core/filmstrip';
import type { ThumbnailProvider } from '../core/strategy';
import type { ThumbnailSettings } from '../core/settings';
import { formatTimecode, type VideoAsset } from '../core/types';
import { Frame } from './Frame';
import { theme } from './theme';

interface Props {
  video: VideoAsset;
  provider: ThumbnailProvider;
  settings: ThumbnailSettings;
  onUse(choice: { uri: string; atMs: number }): void;
  onCancel(): void;
}

const PREVIEW_DEBOUNCE_MS = 120;

export function FrameScrubber({ video, provider, settings, onUse, onCancel }: Props) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [atMs, setAtMs] = useState(() => Math.floor(video.durationMs / 2));
  const [strip, setStrip] = useState<{ atMs: number; uri: string | null }[]>([]);
  const [preview, setPreview] = useState<{ uri: string; atMs: number } | null>(null);
  const [extracting, setExtracting] = useState(false);

  const times = useMemo(
    () => sampleTimes(video.durationMs, settings.filmstripFrames.value),
    [video.durationMs, settings.filmstripFrames],
  );

  /** Half the filmstrip spacing: close enough to be the same frame. */
  const snapTolerance = useMemo(
    () => (times.length > 1 ? Math.abs(times[1] - times[0]) / 2 : 500),
    [times],
  );

  // The filmstrip itself. Extracted once, then reused as the scrub cache.
  useEffect(() => {
    let cancelled = false;
    setStrip(times.map((t) => ({ atMs: t, uri: null })));

    (async () => {
      for (const t of times) {
        const result = await provider.frameAt(video, t, settings);
        if (cancelled) return;
        setStrip((current) =>
          current.map((f) => (f.atMs === t ? { ...f, uri: result.ok ? result.uri : null } : f)),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [video, provider, settings, times]);

  const cached = useCallback(
    (target: number) => strip.find((f) => f.atMs === target && f.uri)?.uri ?? null,
    [strip],
  );

  // Sharp preview, debounced. The filmstrip covers the gap.
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const hit = cached(atMs);
    if (hit) {
      setPreview({ uri: hit, atMs });
      setExtracting(false);
      return;
    }

    setExtracting(true);
    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(async () => {
      const result = await provider.frameAt(video, atMs, settings);
      setExtracting(false);
      if (result.ok) setPreview({ uri: result.uri, atMs });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current);
    };
  }, [atMs, cached, provider, video, settings]);

  const widthRef = useRef(0);
  widthRef.current = trackWidth;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => seek(e.nativeEvent.locationX),
        onPanResponderMove: (e, gesture) => {
          // locationX is unreliable mid-drag on Android, so track from the
          // grant point plus the accumulated dx instead.
          seek(gesture.moveX - trackOriginRef.current);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [video.durationMs, snapTolerance, times],
  );

  const trackOriginRef = useRef(0);

  function seek(offsetX: number) {
    const raw = timeAtOffset(video.durationMs, offsetX, widthRef.current);
    setAtMs(snapToSample(times, raw, snapTolerance));
  }

  const onTrackLayout = (e: LayoutChangeEvent) => {
    setTrackWidth(e.nativeEvent.layout.width);
  };

  const playhead = offsetAtTime(video.durationMs, atMs, trackWidth);

  return (
    <View style={styles.root}>
      <View style={styles.previewWrap}>
        <Frame uri={preview?.uri ?? null} style={styles.preview} radius={12} />
        {extracting && (
          <View style={styles.spinner}>
            <ActivityIndicator color={theme.accent} />
          </View>
        )}
        <View style={styles.timecodeBadge}>
          <Text style={styles.timecode}>{formatTimecode(atMs)}</Text>
        </View>
      </View>

      <View
        style={styles.track}
        onLayout={onTrackLayout}
        onTouchStart={(e) => {
          trackOriginRef.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
        }}
        {...responder.panHandlers}
      >
        {strip.map((frame) => (
          <Frame
            key={frame.atMs}
            uri={frame.uri}
            style={[styles.stripFrame, { width: trackWidth / Math.max(1, strip.length) }]}
            radius={0}
          />
        ))}
        <View pointerEvents="none" style={[styles.playhead, { left: Math.max(0, playhead - 1) }]} />
      </View>

      <Text style={styles.hint}>
        Drag the filmstrip. Positions snap to extracted frames so the preview does not flicker.
      </Text>

      <View style={styles.actions}>
        <Pressable style={styles.cancel} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.use, !preview && styles.useDisabled]}
          disabled={!preview}
          onPress={() => preview && onUse(preview)}
        >
          <Text style={styles.useText}>Use this frame</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  previewWrap: { position: 'relative' },
  preview: { width: '100%', aspectRatio: 16 / 9 },
  spinner: { position: 'absolute', right: 10, top: 10 },
  timecodeBadge: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: '#000000bb',
  },
  timecode: { color: '#fff', fontSize: 12, fontVariant: ['tabular-nums'] },
  track: {
    flexDirection: 'row',
    height: 54,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: theme.surfaceAlt,
  },
  stripFrame: { height: 54 },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: theme.accent },
  hint: { color: theme.textFaint, fontSize: 11, fontStyle: 'italic', lineHeight: 15 },
  actions: { flexDirection: 'row', gap: 10 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: theme.surfaceAlt },
  cancelText: { color: theme.textDim, fontSize: 14, fontWeight: '600' },
  use: { flex: 2, paddingVertical: 12, borderRadius: 10, alignItems: 'center', backgroundColor: theme.accentDim },
  useDisabled: { opacity: 0.4 },
  useText: { color: theme.text, fontSize: 14, fontWeight: '700' },
});
