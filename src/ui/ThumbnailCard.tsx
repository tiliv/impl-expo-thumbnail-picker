/**
 * One video, its resolved thumbnail, and the full attempt log.
 *
 * The log is the reason this screen exists. "Why is this video showing a grey
 * placeholder" should be answerable by looking, not by adding print
 * statements — and here the most likely answer is not a bug but a missing
 * platform capability.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { describeAttempt } from '../core/strategy';
import { formatTimecode, type ThumbnailResolution, type VideoAsset } from '../core/types';
import { Frame } from './Frame';
import { theme } from './theme';

export function ThumbnailCard({
  video,
  resolution,
  canPick,
  onPick,
  onClearPick,
  hasPick,
}: {
  video: VideoAsset;
  resolution: ThumbnailResolution | undefined;
  canPick: boolean;
  onPick(): void;
  onClearPick(): void;
  hasPick: boolean;
}) {
  const candidate = resolution?.candidate ?? null;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Frame uri={candidate?.uri ?? null} style={styles.thumb} />
        <View style={styles.meta}>
          <Text style={styles.filename} numberOfLines={1}>
            {video.filename ?? video.id}
          </Text>
          <Text style={styles.duration}>{formatTimecode(video.durationMs)}</Text>

          {candidate ? (
            <>
              <View style={[styles.badge, resolution?.degraded && styles.badgeDegraded]}>
                <Text style={styles.badgeText}>{candidate.strategy}</Text>
              </View>
              <Text style={styles.detail}>
                {candidate.atMs !== null ? `frame at ${formatTimecode(candidate.atMs)}` : 'no frame position'}
                {candidate.score !== undefined ? ` · score ${candidate.score}` : ''}
              </Text>
            </>
          ) : (
            <View style={[styles.badge, styles.badgeNone]}>
              <Text style={styles.badgeText}>no thumbnail</Text>
            </View>
          )}

          {resolution && (
            <Text style={styles.timing}>resolved in {resolution.totalElapsedMs}ms</Text>
          )}
        </View>
      </View>

      {canPick && (
        <View style={styles.pickRow}>
          <Pressable style={styles.pickButton} onPress={onPick}>
            <Text style={styles.pickText}>{hasPick ? 'Choose a different frame' : 'Pick a frame'}</Text>
          </Pressable>
          {hasPick && (
            <Pressable style={styles.clearButton} onPress={onClearPick}>
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          )}
        </View>
      )}

      <Text style={styles.logTitle}>ATTEMPTS</Text>
      {resolution ? (
        resolution.attempts.map((attempt, i) => (
          <View key={`${attempt.strategy}-${i}`} style={styles.logRow}>
            <Text style={[styles.logStrategy, outcomeStyle(attempt.outcome.status)]}>
              {attempt.strategy}
            </Text>
            <Text style={styles.logDetail}>{describeAttempt(attempt)}</Text>
            <Text style={styles.logMs}>{attempt.elapsedMs}ms</Text>
          </View>
        ))
      ) : (
        <Text style={styles.logDetail}>resolving…</Text>
      )}
    </View>
  );
}

const outcomeStyle = (status: string) =>
  status === 'ok'
    ? styles.logOk
    : status === 'failed'
      ? styles.logFailed
      : status === 'skipped'
        ? styles.logSkipped
        : styles.logUnavailable;

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    padding: 12,
    gap: 10,
  },
  head: { flexDirection: 'row', gap: 12 },
  thumb: { width: 116, aspectRatio: 16 / 9 },
  meta: { flex: 1, gap: 3 },
  filename: { color: theme.text, fontSize: 13, fontWeight: '600' },
  duration: { color: theme.textFaint, fontSize: 11, fontVariant: ['tabular-nums'] },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: theme.accentDim,
    marginTop: 3,
  },
  badgeDegraded: { backgroundColor: '#4a3a20' },
  badgeNone: { backgroundColor: '#4a2b30' },
  badgeText: { color: theme.text, fontSize: 10, fontWeight: '700' },
  detail: { color: theme.textDim, fontSize: 11 },
  timing: { color: theme.textFaint, fontSize: 10, fontVariant: ['tabular-nums'] },
  pickRow: { flexDirection: 'row', gap: 8 },
  pickButton: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: theme.accentDim,
  },
  pickText: { color: theme.text, fontSize: 12, fontWeight: '600' },
  clearButton: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8, backgroundColor: theme.surfaceAlt },
  clearText: { color: theme.textDim, fontSize: 12 },
  logTitle: { color: theme.textFaint, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  logRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  logStrategy: { fontSize: 10, fontWeight: '700', width: 92 },
  logDetail: { color: theme.textDim, fontSize: 10, flex: 1, lineHeight: 14 },
  logMs: { color: theme.textFaint, fontSize: 10, fontVariant: ['tabular-nums'] },
  logOk: { color: theme.ok },
  logFailed: { color: theme.danger },
  logSkipped: { color: theme.warn },
  logUnavailable: { color: theme.textFaint },
});
