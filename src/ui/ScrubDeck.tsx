/**
 * The scrubber.
 *
 * Explicitly not a player. No play button, no transport, no autoplay, no
 * timeline that runs on its own. The playhead moves while a finger is on it and
 * stays where it was left, because the task is finding one still and a player's
 * intention to keep moving is a second behaviour to fight.
 *
 * What replaces playback is precision. Drag down (or up) and the same
 * horizontal travel covers less time — full, half, quarter, fine. The maths is
 * in `core/scrub.ts`; what lives here is the feel:
 *
 *  - The filmstrip stays put and the **playhead** moves, so the frame under
 *    your thumb is the frame you get. A moving strip under a fixed marker reads
 *    as a slot machine.
 *  - Precision changes fire a haptic and animate the rail thicker. You should
 *    be able to feel the detent without looking, because you are looking at the
 *    preview.
 *  - The preview only re-extracts when the position moved at least one frame.
 *    Below that the decode returns a visually identical image.
 *
 * Animation is RN's `Animated`. Finger tracking is JS-bound either way (this is
 * `PanResponder`), so the win from Reanimated would be the settle animations,
 * not the drag. If the drag ever needs to leave the JS thread, this component
 * is the only thing that changes — the maths does not move.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { sampleTimes } from '../core/filmstrip';
import {
  beginScrub,
  extractionWorthwhile,
  jumpTo,
  PRECISION_LEVELS,
  stepFrame,
  updateScrub,
  type ScrubSession,
} from '../core/scrub';
import type { ThumbnailSettings } from '../core/settings';
import type { ThumbnailProvider } from '../core/strategy';
import { formatTimecode, type VideoAsset } from '../core/types';
import { Frame } from './Frame';
import { theme } from './theme';

const EXTRACT_DEBOUNCE_MS = 90;
const TRACK_HEIGHT = 60;

interface Props {
  video: VideoAsset;
  provider: ThumbnailProvider;
  settings: ThumbnailSettings;
  initialAtMs?: number;
  onChange(choice: { uri: string; atMs: number }): void;
}

export function ScrubDeck({ video, provider, settings, initialAtMs, onChange }: Props) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [atMs, setAtMs] = useState(initialAtMs ?? Math.floor(video.durationMs / 2));
  const [strip, setStrip] = useState<{ atMs: number; uri: string | null }[]>([]);
  const [preview, setPreview] = useState<{ uri: string; atMs: number } | null>(null);
  const [precisionId, setPrecisionId] = useState<string>('full');
  const [dragging, setDragging] = useState(false);

  const playheadX = useRef(new Animated.Value(0)).current;
  const railWeight = useRef(new Animated.Value(0)).current;

  const times = useMemo(
    () => sampleTimes(video.durationMs, settings.filmstripFrames.value),
    [video.durationMs, settings.filmstripFrames],
  );

  // --- filmstrip, extracted once and reused as the scrub cache ------------

  useEffect(() => {
    let cancelled = false;
    setStrip(times.map((t) => ({ atMs: t, uri: null })));
    (async () => {
      for (const t of times) {
        const result = await provider.frameAt(video, t, settings);
        if (cancelled) return;
        setStrip((current) => current.map((f) => (f.atMs === t ? { ...f, uri: result.ok ? result.uri : null } : f)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [video, provider, settings, times]);

  // --- preview ------------------------------------------------------------

  const nearestCached = useCallback(
    (target: number): { atMs: number; uri: string } | null => {
      let best: { atMs: number; uri: string } | null = null;
      let bestDistance = Infinity;
      for (const frame of strip) {
        if (!frame.uri) continue;
        const distance = Math.abs(frame.atMs - target);
        if (distance < bestDistance) {
          best = { atMs: frame.atMs, uri: frame.uri };
          bestDistance = distance;
        }
      }
      return best;
    },
    [strip],
  );

  const lastExtractedRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Something is always on screen while the sharp frame is on its way — the
    // nearest filmstrip tile stands in, so the preview never goes blank.
    const stand = nearestCached(atMs);
    if (stand && !preview) setPreview(stand);

    const last = lastExtractedRef.current;
    if (last !== null && !extractionWorthwhile(last, atMs)) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const result = await provider.frameAt(video, atMs, settings);
      if (!result.ok) return;
      lastExtractedRef.current = atMs;
      setPreview({ uri: result.uri, atMs });
      onChange({ uri: result.uri, atMs });
    }, EXTRACT_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atMs, video, provider, settings, nearestCached]);

  // --- gesture ------------------------------------------------------------

  const sessionRef = useRef<ScrubSession | null>(null);
  const widthRef = useRef(0);
  widthRef.current = trackWidth;
  const durationRef = useRef(video.durationMs);
  durationRef.current = video.durationMs;

  const commit = useCallback(
    (session: ScrubSession) => {
      sessionRef.current = session;
      setAtMs(session.atMs);

      if (session.precisionChanged) {
        setPrecisionId(session.precision.id);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        const index = PRECISION_LEVELS.findIndex((l) => l.id === session.precision.id);
        Animated.spring(railWeight, {
          toValue: index,
          useNativeDriver: false,
          speed: 20,
          bounciness: 6,
        }).start();
      }
    },
    [railWeight],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e, gesture) => {
          setDragging(true);
          // A tap is an absolute jump; a drag integrates from wherever it
          // started. Same surface, and the difference is which one you did.
          const startedOnTrack = e.nativeEvent.locationY >= 0 && e.nativeEvent.locationY <= TRACK_HEIGHT;
          if (startedOnTrack && widthRef.current > 0) {
            const fraction = Math.min(1, Math.max(0, e.nativeEvent.locationX / widthRef.current));
            const target = fraction * durationRef.current;
            const session = jumpTo(target, gesture.x0, durationRef.current);
            commit({ ...session, precisionChanged: false });
            setAtMs(session.atMs);
          } else {
            sessionRef.current = beginScrub(atMs, gesture.x0);
          }
        },
        onPanResponderMove: (_e, gesture) => {
          const current = sessionRef.current ?? beginScrub(atMs, gesture.x0);
          commit(
            updateScrub(current, gesture.moveX, gesture.dy, {
              durationMs: durationRef.current,
              trackWidth: widthRef.current,
            }),
          );
        },
        onPanResponderRelease: () => {
          setDragging(false);
          sessionRef.current = null;
          setPrecisionId('full');
          Animated.spring(railWeight, { toValue: 0, useNativeDriver: false, speed: 18, bounciness: 4 }).start();
          void Haptics.selectionAsync();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commit, atMs],
  );

  // Playhead follows state rather than the gesture directly, so a tap, a drag
  // and a frame-step all animate through the same path.
  useEffect(() => {
    if (trackWidth <= 0 || video.durationMs <= 0) return;
    const x = (atMs / video.durationMs) * trackWidth;
    if (dragging) playheadX.setValue(x);
    else Animated.spring(playheadX, { toValue: x, useNativeDriver: true, speed: 24, bounciness: 0 }).start();
  }, [atMs, trackWidth, video.durationMs, dragging, playheadX]);

  const railScale = railWeight.interpolate({ inputRange: [0, 3], outputRange: [1, 2.6] });
  const precision = PRECISION_LEVELS.find((l) => l.id === precisionId) ?? PRECISION_LEVELS[0];

  return (
    <View style={styles.root}>
      <View style={styles.stage}>
        <Frame uri={preview?.uri ?? null} style={styles.preview} radius={12} />

        <View style={styles.timecode}>
          <Text style={styles.timecodeText}>{formatTimecode(atMs)}</Text>
        </View>

        {dragging && precision.id !== 'full' && (
          <View style={styles.precisionPill}>
            <Text style={styles.precisionText}>{precision.label} speed</Text>
          </View>
        )}
      </View>

      <View style={styles.stepRow}>
        <Pressable
          style={styles.step}
          onPress={() => {
            setAtMs((current) => stepFrame(current, -1, video.durationMs));
            void Haptics.selectionAsync();
          }}
        >
          <Text style={styles.stepText}>◀ frame</Text>
        </Pressable>
        <Text style={styles.scrubHint}>
          {dragging ? 'Slide away from the strip for finer control' : 'Drag the strip'}
        </Text>
        <Pressable
          style={styles.step}
          onPress={() => {
            setAtMs((current) => stepFrame(current, 1, video.durationMs));
            void Haptics.selectionAsync();
          }}
        >
          <Text style={styles.stepText}>frame ▶</Text>
        </Pressable>
      </View>

      <View
        style={styles.track}
        onLayout={(e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width)}
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

        <Animated.View
          pointerEvents="none"
          style={[
            styles.playhead,
            { transform: [{ translateX: playheadX }, { scaleX: railScale }] },
          ]}
        />
      </View>

      <View style={styles.ladder}>
        {PRECISION_LEVELS.map((level) => (
          <View
            key={level.id}
            style={[styles.ladderPip, level.id === precision.id && dragging && styles.ladderPipActive]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  stage: { position: 'relative' },
  preview: { width: '100%', aspectRatio: 16 / 9 },
  timecode: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#000000cc',
  },
  timecodeText: { color: '#fff', fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '600' },
  precisionPill: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: theme.accent,
  },
  precisionText: { color: '#06121f', fontSize: 12, fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  step: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: theme.surfaceAlt },
  stepText: { color: theme.textDim, fontSize: 11, fontVariant: ['tabular-nums'] },
  scrubHint: { color: theme.textFaint, fontSize: 11, fontStyle: 'italic', flexShrink: 1, textAlign: 'center' },
  track: {
    flexDirection: 'row',
    height: TRACK_HEIGHT,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: theme.surfaceAlt,
  },
  stripFrame: { height: TRACK_HEIGHT },
  playhead: {
    position: 'absolute',
    left: -1.5,
    top: 0,
    bottom: 0,
    width: 3,
    borderRadius: 2,
    backgroundColor: theme.accent,
  },
  ladder: { flexDirection: 'row', gap: 5, justifyContent: 'center' },
  ladderPip: { width: 16, height: 3, borderRadius: 2, backgroundColor: theme.border },
  ladderPipActive: { backgroundColor: theme.accent },
});
